// glass_guard_node.cpp
//
// Faithful C++ port of guide_mate_explorer/glass_guard.py. Turns Create 3 BUMP
// hazards into persistent costmap obstacles: on a bump it projects the triggered
// bumper into the global frame, accumulates the hit points, and continuously
// republishes them as a latched PointCloud2 for Nav2's non-clearing obstacle
// layer. Also publishes each fresh hit on `bump_points` (so the explorer
// blacklists it) and optionally emits a short reverse pulse to break contact.
//
// Namespaced TF: the TransformListener subscribes to the GLOBAL /tf, so launch
// with ('/tf','tf'),('/tf_static','tf_static') remaps or lookups fail silently.
#include <cmath>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <rclcpp/rclcpp.hpp>

#include <geometry_msgs/msg/point.hpp>
#include <geometry_msgs/msg/point_stamped.hpp>
#include <geometry_msgs/msg/twist.hpp>
#include <irobot_create_msgs/msg/hazard_detection_vector.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>
#include <sensor_msgs/point_cloud2_iterator.hpp>
#include <visualization_msgs/msg/marker_array.hpp>

#include <tf2_ros/buffer.h>
#include <tf2_ros/transform_listener.h>

namespace
{
constexpr int BUMP = 1;  // irobot_create_msgs/HazardDetection.BUMP
}

class GlassGuard : public rclcpp::Node
{
public:
  explicit GlassGuard(std::shared_ptr<tf2_ros::Buffer> shared_buffer = nullptr)
  : Node("glass_guard")
  {
    hazard_topic_ = declare_parameter<std::string>(
      "hazard_topic", "/turtlebot468/_do_not_use/hazard_detection");
    global_frame_ = declare_parameter<std::string>("global_frame", "map");
    const std::string cloud_topic = declare_parameter<std::string>("cloud_topic", "bump_obstacles");
    const std::string points_topic = declare_parameter<std::string>("points_topic", "bump_points");
    dedup_ = declare_parameter<double>("dedup_resolution", 0.05);
    fwd_ = declare_parameter<double>("forward_offset", 0.03);
    const double publish_rate = declare_parameter<double>("publish_rate", 5.0);
    reactive_backup_ = declare_parameter<bool>("reactive_backup", false);
    backup_speed_ = declare_parameter<double>("backup_speed", 0.05);
    backup_duration_ = declare_parameter<double>("backup_duration", 0.8);
    const std::string cmd_vel_topic = declare_parameter<std::string>("cmd_vel_topic", "/turtlebot468/cmd_vel");

    if (shared_buffer) {
      tf_buffer_ = shared_buffer;   // container owns the single TransformListener
    } else {
      tf_buffer_ = std::make_shared<tf2_ros::Buffer>(get_clock());
      tf_listener_ = std::make_shared<tf2_ros::TransformListener>(*tf_buffer_);
    }

    rclcpp::QoS latched(rclcpp::KeepLast(1));
    latched.transient_local().reliable();
    cloud_pub_ = create_publisher<sensor_msgs::msg::PointCloud2>(cloud_topic, latched);
    points_pub_ = create_publisher<geometry_msgs::msg::PointStamped>(points_topic, 10);
    marker_pub_ = create_publisher<visualization_msgs::msg::MarkerArray>("bump_markers", 1);
    cmd_pub_ = create_publisher<geometry_msgs::msg::Twist>(cmd_vel_topic, 10);

    hazard_sub_ = create_subscription<irobot_create_msgs::msg::HazardDetectionVector>(
      hazard_topic_, rclcpp::SensorDataQoS(),
      std::bind(&GlassGuard::hazardCb, this, std::placeholders::_1));

    publish_timer_ = rclcpp::create_timer(
      this, get_clock(), rclcpp::Duration::from_seconds(1.0 / publish_rate),
      std::bind(&GlassGuard::publish, this));
    if (reactive_backup_) {
      backup_timer_ = rclcpp::create_timer(
        this, get_clock(), rclcpp::Duration::from_seconds(0.05),
        std::bind(&GlassGuard::backupTick, this));
    }

    RCLCPP_INFO(get_logger(),
      "glass_guard (C++) up. hazards='%s' -> obstacles in '%s'. reactive_backup=%s",
      hazard_topic_.c_str(), global_frame_.c_str(), reactive_backup_ ? "true" : "false");
  }

private:
  void hazardCb(const irobot_create_msgs::msg::HazardDetectionVector::SharedPtr msg)
  {
    for (const auto & d : msg->detections) {
      if (d.type != BUMP) {
        continue;
      }
      mark(d.header.frame_id);
    }
  }

  void mark(const std::string & bumper_frame)
  {
    geometry_msgs::msg::TransformStamped tf;
    try {
      tf = tf_buffer_->lookupTransform(
        global_frame_, bumper_frame, tf2::TimePointZero, tf2::durationFromSec(0.3));
    } catch (const tf2::TransformException & e) {
      RCLCPP_WARN(get_logger(), "no TF %s<-%s: %s",
        global_frame_.c_str(), bumper_frame.c_str(), e.what());
      return;
    }
    // The bumper frame's x axis points outward; offset slightly forward to land
    // the obstacle on the surface that was actually touched.
    const auto & q = tf.transform.rotation;
    const double yaw = std::atan2(2.0 * (q.w * q.z + q.x * q.y),
        1.0 - 2.0 * (q.y * q.y + q.z * q.z));
    const double x = tf.transform.translation.x + fwd_ * std::cos(yaw);
    const double y = tf.transform.translation.y + fwd_ * std::sin(yaw);
    const std::pair<long, long> key{
      std::lrint(x / dedup_), std::lrint(y / dedup_)};   // round-half-even, like Python round()
    if (points_.find(key) == points_.end()) {
      points_[key] = {x, y};
      RCLCPP_INFO(get_logger(),
        "BUMP on %s -> obstacle (%.2f, %.2f). %zu glass points total.",
        bumper_frame.c_str(), x, y, points_.size());
    }
    // tell the explorer to blacklist this spot
    geometry_msgs::msg::PointStamped ps;
    ps.header.frame_id = global_frame_;
    ps.header.stamp = now();
    ps.point.x = x;
    ps.point.y = y;
    points_pub_->publish(ps);
    if (reactive_backup_) {
      backup_until_ = now() + rclcpp::Duration::from_seconds(backup_duration_);
    }
  }

  void publish()
  {
    std_msgs::msg::Header header;
    header.frame_id = global_frame_;
    header.stamp = now();

    sensor_msgs::msg::PointCloud2 cloud;
    cloud.header = header;
    sensor_msgs::PointCloud2Modifier mod(cloud);
    mod.setPointCloud2FieldsByString(1, "xyz");
    mod.resize(points_.size());
    sensor_msgs::PointCloud2Iterator<float> ix(cloud, "x"), iy(cloud, "y"), iz(cloud, "z");
    for (const auto & kv : points_) {
      *ix = static_cast<float>(kv.second.first);
      *iy = static_cast<float>(kv.second.second);
      *iz = 0.05f;
      ++ix; ++iy; ++iz;
    }
    cloud_pub_->publish(cloud);

    visualization_msgs::msg::MarkerArray arr;
    visualization_msgs::msg::Marker m;
    m.header = header;
    m.ns = "glass";
    m.id = 0;
    m.type = visualization_msgs::msg::Marker::CUBE_LIST;
    m.action = visualization_msgs::msg::Marker::ADD;
    m.scale.x = m.scale.y = m.scale.z = std::max(dedup_, 0.05);
    m.color.r = 1.0; m.color.g = 0.0; m.color.b = 0.0; m.color.a = 0.9;
    m.pose.orientation.w = 1.0;
    for (const auto & kv : points_) {
      geometry_msgs::msg::Point p;
      p.x = kv.second.first;
      p.y = kv.second.second;
      p.z = 0.05;
      m.points.push_back(p);
    }
    arr.markers.push_back(m);
    marker_pub_->publish(arr);
  }

  void backupTick()
  {
    if (!backup_until_.has_value()) {
      return;
    }
    if (now() >= backup_until_.value()) {
      backup_until_.reset();
      cmd_pub_->publish(geometry_msgs::msg::Twist());   // stop
      return;
    }
    geometry_msgs::msg::Twist t;
    t.linear.x = -std::abs(backup_speed_);
    cmd_pub_->publish(t);
  }

  // --- params / state ---
  std::string hazard_topic_, global_frame_;
  double dedup_, fwd_, backup_speed_, backup_duration_;
  bool reactive_backup_;
  std::map<std::pair<long, long>, std::pair<double, double>> points_;
  std::optional<rclcpp::Time> backup_until_;

  std::shared_ptr<tf2_ros::Buffer> tf_buffer_;   // shared in the component container
  std::shared_ptr<tf2_ros::TransformListener> tf_listener_;
  rclcpp::Publisher<sensor_msgs::msg::PointCloud2>::SharedPtr cloud_pub_;
  rclcpp::Publisher<geometry_msgs::msg::PointStamped>::SharedPtr points_pub_;
  rclcpp::Publisher<visualization_msgs::msg::MarkerArray>::SharedPtr marker_pub_;
  rclcpp::Publisher<geometry_msgs::msg::Twist>::SharedPtr cmd_pub_;
  rclcpp::Subscription<irobot_create_msgs::msg::HazardDetectionVector>::SharedPtr hazard_sub_;
  rclcpp::TimerBase::SharedPtr publish_timer_, backup_timer_;
};

#ifndef GUIDE_MATE_CONTAINER
int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<GlassGuard>());
  rclcpp::shutdown();
  return 0;
}
#endif
