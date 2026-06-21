// bfs_explorer_node.cpp
//
// Faithful C++ port of guide_mate_explorer/bfs_explorer.py. Subscribes to the
// SLAM occupancy grid, runs BFS outward from the robot's cell through free
// space, detects frontiers (free cells touching unknown), clusters them, and
// sends the nearest reachable cluster to Nav2 as a NavigateToPose goal. Replans
// on success/failure, blacklists unreachable/bumped frontiers, autosaves the
// map, and declares done when no frontier remains for several cycles.
//
// The BFS + clustering are O(free cells) per tick; in C++ that is sub-ms and
// does not grow expensive as the map fills (the motivation for the port).
//
// Namespaced TF: the TransformListener subscribes to the GLOBAL /tf, so launch
// with ('/tf','tf'),('/tf_static','tf_static') remaps or lookups fail silently.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <pwd.h>
#include <sys/wait.h>
#include <unistd.h>

#include <rclcpp/rclcpp.hpp>
#include <rclcpp_action/rclcpp_action.hpp>

#include <geometry_msgs/msg/point_stamped.hpp>
#include <nav2_msgs/action/navigate_to_pose.hpp>
#include <nav_msgs/msg/occupancy_grid.hpp>
#include <std_msgs/msg/bool.hpp>
#include <visualization_msgs/msg/marker_array.hpp>

#include <tf2_ros/buffer.h>
#include <tf2_ros/transform_listener.h>

namespace
{
// 4-connectivity for traversal through free space, 8-connectivity for detecting
// adjacency to unknown cells and for clustering frontier cells together.
constexpr int N4[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
constexpr int N8[8][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1},
  {1, 1}, {1, -1}, {-1, 1}, {-1, -1}};
}  // namespace

using NavigateToPose = nav2_msgs::action::NavigateToPose;
using GoalHandle = rclcpp_action::ClientGoalHandle<NavigateToPose>;

class BfsExplorer : public rclcpp::Node
{
public:
  explicit BfsExplorer(std::shared_ptr<tf2_ros::Buffer> shared_buffer = nullptr)
  : Node("bfs_explorer")
  {
    map_topic_ = declare_parameter<std::string>("map_topic", "map");
    nav_action_ = declare_parameter<std::string>("nav_action", "navigate_to_pose");
    global_frame_ = declare_parameter<std::string>("global_frame", "map");
    robot_frame_ = declare_parameter<std::string>("robot_frame", "base_link");
    occ_thresh_ = declare_parameter<int>("occupied_thresh", 65);
    min_cells_ = declare_parameter<int>("min_frontier_cells", 8);
    plan_period_ = declare_parameter<double>("plan_period", 1.0);
    goal_timeout_ = declare_parameter<double>("goal_timeout", 60.0);
    blacklist_radius_ = declare_parameter<double>("blacklist_radius", 0.5);
    done_after_ = declare_parameter<int>("done_after_empty_cycles", 5);
    {
      const char * he = std::getenv("HOME");
      std::string home = (he && *he) ? he : "";
      if (home.empty()) {
        const struct passwd * pw = getpwuid(getuid());   // mirror expanduser passwd fallback
        if (pw && pw->pw_dir) {
          home = pw->pw_dir;
        }
      }
      map_save_path_ = declare_parameter<std::string>("map_save_path", home + "/maps/guide_mate_map");
    }
    map_topic_full_ = declare_parameter<std::string>("map_topic_full", "/turtlebot468/map");
    autosave_period_ = declare_parameter<double>("autosave_period", 30.0);

    rclcpp::QoS map_qos(rclcpp::KeepLast(1));
    map_qos.transient_local().reliable();
    map_sub_ = create_subscription<nav_msgs::msg::OccupancyGrid>(
      map_topic_, map_qos, std::bind(&BfsExplorer::mapCb, this, std::placeholders::_1));
    bump_sub_ = create_subscription<geometry_msgs::msg::PointStamped>(
      "bump_points", 10, std::bind(&BfsExplorer::bumpCb, this, std::placeholders::_1));

    nav_client_ = rclcpp_action::create_client<NavigateToPose>(this, nav_action_);
    marker_pub_ = create_publisher<visualization_msgs::msg::MarkerArray>("frontier_markers", 1);
    rclcpp::QoS done_qos(rclcpp::KeepLast(1));
    done_qos.transient_local().reliable();
    done_pub_ = create_publisher<std_msgs::msg::Bool>("exploration_complete", done_qos);

    if (shared_buffer) {
      tf_buffer_ = shared_buffer;   // container owns the single TransformListener
    } else {
      tf_buffer_ = std::make_shared<tf2_ros::Buffer>(get_clock());
      tf_listener_ = std::make_shared<tf2_ros::TransformListener>(*tf_buffer_);
    }

    // ROS-clock timers (honor use_sim_time), matching Python create_timer.
    tick_timer_ = rclcpp::create_timer(
      this, get_clock(), rclcpp::Duration::from_seconds(plan_period_),
      std::bind(&BfsExplorer::tick, this));
    if (autosave_period_ > 0.0) {
      autosave_timer_ = rclcpp::create_timer(
        this, get_clock(), rclcpp::Duration::from_seconds(autosave_period_),
        [this]() {saveMap("autosave");});
    }
    RCLCPP_INFO(
      get_logger(),
      "BFS explorer (C++) up. map='%s' action='%s' frames=(%s->%s). Waiting for map + Nav2...",
      map_topic_.c_str(), nav_action_.c_str(), global_frame_.c_str(), robot_frame_.c_str());
  }

private:
  enum State { IDLE, NAVIGATING, DONE };

  struct Cluster { double mx, my; int size; int mind; };
  struct Cand { int mind; int size; double wx, wy; };

  // ------------------------------------------------------------------ map
  void mapCb(const nav_msgs::msg::OccupancyGrid::SharedPtr msg) {map_msg_ = msg;}

  void bumpCb(const geometry_msgs::msg::PointStamped::SharedPtr msg)
  {
    const double x = msg->point.x, y = msg->point.y;
    if (!isBlacklisted(x, y)) {
      blacklist_.push_back({x, y});
      RCLCPP_WARN(get_logger(), "bump reported at (%.2f, %.2f) -> frontier blacklisted.", x, y);
      if (have_goal_xy_ &&
        std::hypot(x - goal_x_, y - goal_y_) < 1.0 && goal_handle_)
      {
        nav_client_->async_cancel_goal(goal_handle_);
        state_ = IDLE;
      }
    }
  }

  // --------------------------------------------------------------- helpers
  bool robotCell(const nav_msgs::msg::MapMetaData & info, int & cx, int & cy)
  {
    geometry_msgs::msg::TransformStamped tf;
    try {
      tf = tf_buffer_->lookupTransform(
        global_frame_, robot_frame_, tf2::TimePointZero, tf2::durationFromSec(0.5));
    } catch (const tf2::TransformException & e) {
      RCLCPP_WARN_THROTTLE(
        get_logger(), *get_clock(), 5000, "TF %s->%s unavailable: %s",
        global_frame_.c_str(), robot_frame_.c_str(), e.what());
      return false;
    }
    const double wx = tf.transform.translation.x;
    const double wy = tf.transform.translation.y;
    cx = static_cast<int>((wx - info.origin.position.x) / info.resolution);
    cy = static_cast<int>((wy - info.origin.position.y) / info.resolution);
    return true;
  }

  void cellToWorld(const nav_msgs::msg::MapMetaData & info, double cx, double cy,
    double & wx, double & wy)
  {
    wx = info.origin.position.x + (cx + 0.5) * info.resolution;
    wy = info.origin.position.y + (cy + 0.5) * info.resolution;
  }

  bool isBlacklisted(double x, double y)
  {
    for (const auto & b : blacklist_) {
      if (std::hypot(x - b.first, y - b.second) < blacklist_radius_) {
        return true;
      }
    }
    return false;
  }

  // Spiral out to the nearest free cell so BFS has a valid seed.
  bool nearestFree(const std::vector<int8_t> & grid, int h, int w, int cx, int cy,
    int & ox, int & oy, int max_r = 15)
  {
    auto freecell = [&](int v) {return v >= 0 && v < occ_thresh_;};
    if (cx >= 0 && cx < w && cy >= 0 && cy < h &&
      freecell(grid[static_cast<size_t>(cy) * w + cx]))
    {
      ox = cx; oy = cy; return true;
    }
    for (int r = 1; r <= max_r; ++r) {
      for (int dy = -r; dy <= r; ++dy) {
        for (int dx = -r; dx <= r; ++dx) {
          const int nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h &&
            freecell(grid[static_cast<size_t>(ny) * w + nx]))
          {
            ox = nx; oy = ny; return true;
          }
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------- frontiers
  // BFS through free space from (sx,sy); return frontier cells (free cell with
  // >=1 unknown 8-neighbour) as cell-index -> bfs distance.
  std::unordered_map<long, int> findFrontiers(
    const std::vector<int8_t> & grid, int h, int w, int sx, int sy,
    std::vector<long> & order)
  {
    std::vector<int32_t> dist(static_cast<size_t>(h) * w, -1);
    std::unordered_map<long, int> frontier;
    std::deque<std::pair<int, int>> q;
    q.push_back({sx, sy});
    dist[static_cast<size_t>(sy) * w + sx] = 0;
    while (!q.empty()) {
      const int x = q.front().first, y = q.front().second;
      q.pop_front();
      const int d = dist[static_cast<size_t>(y) * w + x];
      bool is_frontier = false;
      for (const auto & n : N8) {
        const int nx = x + n[0], ny = y + n[1];
        if (nx >= 0 && nx < w && ny >= 0 && ny < h &&
          grid[static_cast<size_t>(ny) * w + nx] == -1)
        {
          is_frontier = true;
          break;
        }
      }
      if (is_frontier) {
        const long key = static_cast<long>(y) * w + x;
        frontier[key] = d;
        order.push_back(key);   // BFS-insertion order (matches Python dict order)
      }
      for (const auto & n : N4) {
        const int nx = x + n[0], ny = y + n[1];
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          const size_t idx = static_cast<size_t>(ny) * w + nx;
          const int8_t v = grid[idx];
          if (dist[idx] < 0 && v >= 0 && v < occ_thresh_) {
            dist[idx] = d + 1;
            q.push_back({nx, ny});
          }
        }
      }
    }
    return frontier;
  }

  // Group frontier cells into 8-connected clusters -> (centroid, size, min dist).
  std::vector<Cluster> cluster(
    const std::unordered_map<long, int> & frontier, const std::vector<long> & order,
    int h, int w)
  {
    std::unordered_set<long> seen;
    std::vector<Cluster> clusters;
    for (const long cell : order) {   // BFS-insertion order, like Python dict iteration
      if (seen.count(cell)) {
        continue;
      }
      std::deque<long> dq;
      dq.push_back(cell);
      seen.insert(cell);
      std::vector<long> comp;
      while (!dq.empty()) {
        const long c = dq.front();
        dq.pop_front();
        comp.push_back(c);
        const int cx = static_cast<int>(c % w), cy = static_cast<int>(c / w);
        for (const auto & n : N8) {
          const int nx = cx + n[0], ny = cy + n[1];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
            continue;   // bounds-check before linear index (avoid row wrap)
          }
          const long nn = static_cast<long>(ny) * w + nx;
          if (frontier.count(nn) && !seen.count(nn)) {
            seen.insert(nn);
            dq.push_back(nn);
          }
        }
      }
      const int size = static_cast<int>(comp.size());
      double sx = 0.0, sy = 0.0;
      int mind = std::numeric_limits<int>::max();
      for (const long c : comp) {
        sx += static_cast<double>(c % w);
        sy += static_cast<double>(c / w);
        mind = std::min(mind, frontier.at(c));
      }
      clusters.push_back({sx / size, sy / size, size, mind});
    }
    return clusters;
  }

  // -------------------------------------------------------------- planning
  void tick()
  {
    if (state_ == NAVIGATING) {
      if (have_nav_start_ &&
        (now() - nav_start_) > rclcpp::Duration::from_seconds(goal_timeout_))
      {
        RCLCPP_WARN(get_logger(), "Goal timed out; cancelling and blacklisting.");
        if (have_goal_xy_) {
          blacklist_.push_back({goal_x_, goal_y_});
        }
        if (goal_handle_) {
          nav_client_->async_cancel_goal(goal_handle_);
        }
        state_ = IDLE;
      }
      return;
    }
    if (state_ == DONE) {
      return;
    }
    if (!map_msg_) {
      return;
    }
    if (!nav_client_->action_server_is_ready()) {
      RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 5000, "Nav2 action server not ready yet...");
      return;
    }

    const auto & info = map_msg_->info;
    const int w = static_cast<int>(info.width), h = static_cast<int>(info.height);
    const auto & grid = map_msg_->data;

    int rcx, rcy;
    if (!robotCell(info, rcx, rcy)) {
      return;
    }
    int sx, sy;
    if (!nearestFree(grid, h, w, rcx, rcy, sx, sy)) {
      RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 5000, "No free cell near robot; cannot seed BFS.");
      return;
    }

    std::vector<long> frontier_order;
    const auto frontier = findFrontiers(grid, h, w, sx, sy, frontier_order);
    const auto clusters = cluster(frontier, frontier_order, h, w);

    std::vector<Cand> cands;
    for (const auto & cl : clusters) {
      if (cl.size < min_cells_) {
        continue;
      }
      double wx, wy;
      cellToWorld(info, cl.mx, cl.my, wx, wy);
      if (isBlacklisted(wx, wy)) {
        continue;
      }
      cands.push_back({cl.mind, cl.size, wx, wy});
    }

    // BFS manner: smallest BFS distance first; break ties by larger frontier.
    // stable_sort + insertion-order clusters => deterministic, matches Python's
    // stable list.sort over an insertion-ordered dict for equal (mind,size).
    std::stable_sort(cands.begin(), cands.end(), [](const Cand & a, const Cand & b) {
        return a.mind < b.mind || (a.mind == b.mind && a.size > b.size);
      });
    publishMarkers(cands);

    const double res = info.resolution;
    long known = 0;
    for (const int8_t v : grid) {
      if (v >= 0) {
        ++known;
      }
    }
    const double known_area = static_cast<double>(known) * res * res;
    RCLCPP_INFO(
      get_logger(), "progress: known~%.1f m^2, %zu frontiers left, goals sent=%d reached=%d",
      known_area, cands.size(), goals_sent_, goals_reached_);

    if (cands.empty()) {
      ++empty_cycles_;
      RCLCPP_INFO(get_logger(), "No reachable frontiers (%d/%d).", empty_cycles_, done_after_);
      if (empty_cycles_ >= done_after_) {
        RCLCPP_INFO(get_logger(), "Exploration COMPLETE -- map fully explored. Saving final map.");
        saveMap("final");
        std_msgs::msg::Bool b;
        b.data = true;
        done_pub_->publish(b);
        state_ = DONE;
      }
      return;
    }

    empty_cycles_ = 0;
    sendGoal(cands[0].wx, cands[0].wy, cands[0].size);
  }

  void sendGoal(double wx, double wy, int size)
  {
    double yaw = 0.0;
    try {
      auto tf = tf_buffer_->lookupTransform(global_frame_, robot_frame_, tf2::TimePointZero);
      yaw = std::atan2(wy - tf.transform.translation.y, wx - tf.transform.translation.x);
    } catch (const tf2::TransformException &) {
      // leave yaw = 0
    }

    NavigateToPose::Goal goal;
    goal.pose.header.frame_id = global_frame_;
    goal.pose.header.stamp = now();
    goal.pose.pose.position.x = wx;
    goal.pose.pose.position.y = wy;
    goal.pose.pose.orientation.z = std::sin(yaw / 2.0);
    goal.pose.pose.orientation.w = std::cos(yaw / 2.0);

    goal_x_ = wx; goal_y_ = wy; have_goal_xy_ = true;
    state_ = NAVIGATING;
    nav_start_ = now();
    have_nav_start_ = true;
    ++goals_sent_;
    RCLCPP_INFO(get_logger(), "-> frontier #%d at (%.2f, %.2f), %d cells. Navigating.",
      goals_sent_, wx, wy, size);

    rclcpp_action::Client<NavigateToPose>::SendGoalOptions opts;
    opts.goal_response_callback = [this](GoalHandle::SharedPtr gh) {goalResponse(gh);};
    opts.result_callback = [this](const GoalHandle::WrappedResult & r) {goalResult(r);};
    nav_client_->async_send_goal(goal, opts);
  }

  void goalResponse(GoalHandle::SharedPtr gh)
  {
    if (!gh) {
      RCLCPP_WARN(get_logger(), "Goal REJECTED by Nav2; blacklisting.");
      if (have_goal_xy_) {
        blacklist_.push_back({goal_x_, goal_y_});
      }
      state_ = IDLE;
      return;
    }
    goal_handle_ = gh;
  }

  void goalResult(const GoalHandle::WrappedResult & r)
  {
    if (r.code == rclcpp_action::ResultCode::SUCCEEDED) {
      ++goals_reached_;
      RCLCPP_INFO(get_logger(), "Reached frontier. Replanning.");
    } else {
      // map rclcpp_action ResultCode -> action_msgs/GoalStatus numeric for log parity
      const int status = (r.code == rclcpp_action::ResultCode::ABORTED) ? 6 :
        (r.code == rclcpp_action::ResultCode::CANCELED) ? 5 : 0;
      RCLCPP_WARN(get_logger(), "Goal ended with status %d; blacklisting.", status);
      if (have_goal_xy_) {
        blacklist_.push_back({goal_x_, goal_y_});
      }
    }
    goal_handle_.reset();
    state_ = IDLE;
  }

  // -------------------------------------------------------------- map saving
  void saveMap(const std::string & tag)
  {
    if (!map_msg_) {
      return;
    }
    std::string path = map_save_path_, topic = map_topic_full_;
    std::thread([this, tag, path, topic]() {
        // RAII try-lock: releases on scope exit even if something throws,
        // mirroring Python's try/finally lock release.
        std::unique_lock<std::mutex> lk(save_mutex_, std::try_to_lock);
        if (!lk.owns_lock()) {
          return;   // a save is already in progress
        }
        // mirror Python os.makedirs(dirname(path), exist_ok=True)
        std::error_code ec;
        std::filesystem::create_directories(std::filesystem::path(path).parent_path(), ec);
        // `timeout 30` bounds a hung map_saver (Python uses subprocess timeout=30)
        // so the detached thread always releases save_mutex_.
        std::string cmd =
          "timeout 30 ros2 run nav2_map_server map_saver_cli -f '" + path +
          "' --ros-args -r map:=" + topic + " -p save_map_timeout:=10.0 >/dev/null 2>&1";
        const int raw = std::system(cmd.c_str());
        const int rc = (raw != -1 && WIFEXITED(raw)) ? WEXITSTATUS(raw) : -1;
        if (rc == 0) {
          RCLCPP_INFO(get_logger(), "[%s] map saved -> %s.pgm/.yaml", tag.c_str(), path.c_str());
        } else {
          RCLCPP_WARN(get_logger(), "[%s] map_saver failed (rc=%d)", tag.c_str(), rc);
        }
      }).detach();   // lk releases save_mutex_ here (RAII)
  }

  // ----------------------------------------------------------- visualisation
  void publishMarkers(const std::vector<Cand> & cands)
  {
    visualization_msgs::msg::MarkerArray arr;
    visualization_msgs::msg::Marker clear;
    clear.action = visualization_msgs::msg::Marker::DELETEALL;
    arr.markers.push_back(clear);
    for (size_t i = 0; i < cands.size(); ++i) {
      visualization_msgs::msg::Marker m;
      m.header.frame_id = global_frame_;
      m.header.stamp = now();
      m.ns = "frontiers";
      m.id = static_cast<int>(i);
      m.type = visualization_msgs::msg::Marker::SPHERE;
      m.action = visualization_msgs::msg::Marker::ADD;
      m.pose.position.x = cands[i].wx;
      m.pose.position.y = cands[i].wy;
      m.pose.position.z = 0.1;
      m.pose.orientation.w = 1.0;
      const double scale = std::min(0.6, 0.1 + cands[i].size * 0.01);
      m.scale.x = m.scale.y = m.scale.z = scale;
      m.color.r = 0.0;
      m.color.g = (i == 0) ? 1.0 : 0.4;
      m.color.b = (i == 0) ? 0.0 : 1.0;
      m.color.a = 0.9;
      arr.markers.push_back(m);
    }
    marker_pub_->publish(arr);
  }

  // --- params ---
  std::string map_topic_, nav_action_, global_frame_, robot_frame_, map_save_path_, map_topic_full_;
  int occ_thresh_, min_cells_, done_after_;
  double plan_period_, goal_timeout_, blacklist_radius_, autosave_period_;

  // --- state ---
  nav_msgs::msg::OccupancyGrid::SharedPtr map_msg_;
  State state_ = IDLE;
  GoalHandle::SharedPtr goal_handle_;
  rclcpp::Time nav_start_;
  bool have_nav_start_ = false;
  double goal_x_ = 0.0, goal_y_ = 0.0;
  bool have_goal_xy_ = false;
  std::vector<std::pair<double, double>> blacklist_;
  int empty_cycles_ = 0, goals_sent_ = 0, goals_reached_ = 0;
  std::mutex save_mutex_;

  // --- interfaces ---
  rclcpp::Subscription<nav_msgs::msg::OccupancyGrid>::SharedPtr map_sub_;
  rclcpp::Subscription<geometry_msgs::msg::PointStamped>::SharedPtr bump_sub_;
  rclcpp_action::Client<NavigateToPose>::SharedPtr nav_client_;
  rclcpp::Publisher<visualization_msgs::msg::MarkerArray>::SharedPtr marker_pub_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr done_pub_;
  std::shared_ptr<tf2_ros::Buffer> tf_buffer_;   // shared in the component container
  std::shared_ptr<tf2_ros::TransformListener> tf_listener_;
  rclcpp::TimerBase::SharedPtr tick_timer_, autosave_timer_;
};

#ifndef GUIDE_MATE_CONTAINER
int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<BfsExplorer>());
  rclcpp::shutdown();
  return 0;
}
#endif
