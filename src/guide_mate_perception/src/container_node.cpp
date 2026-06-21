// container_node.cpp
//
// Single-process component container for the three C++ guide_mate nodes. The
// whole point is ONE shared tf2_ros::Buffer + a SINGLE TransformListener feeding
// all three nodes -- so the busy /tf stream is deserialized ONCE instead of
// three times (the duplicate-TF cost that made running them as separate
// processes expensive). C++ (no GIL) also lets the MultiThreadedExecutor run
// their callbacks on separate cores.
//
// The three node classes are pulled in with GUIDE_MATE_CONTAINER defined, which
// suppresses each file's own main(); each node still builds as its own
// standalone executable (where the macro is NOT defined) and creates its own TF
// buffer/listener there.
//
// Launch namespaced with the /tf remaps so the single listener reads the robot's
// namespaced TF tree:
//   ros2 run guide_mate_perception guide_mate_container
//     --ros-args -r __ns:=/turtlebot468 -r /tf:=tf -r /tf_static:=tf_static
#define GUIDE_MATE_CONTAINER
#include "depth_lidar_fusion_node.cpp"  // class DepthLidarFusion (main suppressed)
#include "bfs_explorer_node.cpp"        // class BfsExplorer
#include "glass_guard_node.cpp"         // class GlassGuard

#include <memory>

#include <rclcpp/rclcpp.hpp>
#include <tf2_ros/buffer.h>
#include <tf2_ros/transform_listener.h>

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);

  // A dedicated node owns the ONE TransformListener; its Buffer is shared with
  // all three nodes, which therefore create NO listener of their own.
  auto tf_node = std::make_shared<rclcpp::Node>("guide_mate_perception_tf");
  auto buffer = std::make_shared<tf2_ros::Buffer>(tf_node->get_clock());
  auto listener = std::make_shared<tf2_ros::TransformListener>(*buffer, tf_node);

  auto fusion = std::make_shared<DepthLidarFusion>(buffer);
  auto bfs = std::make_shared<BfsExplorer>(buffer);
  auto guard = std::make_shared<GlassGuard>(buffer);

  rclcpp::executors::MultiThreadedExecutor executor;
  executor.add_node(tf_node);
  executor.add_node(fusion);
  executor.add_node(bfs);
  executor.add_node(guard);

  RCLCPP_INFO(rclcpp::get_logger("guide_mate_container"),
    "guide_mate container up: depth_lidar_fusion + bfs_explorer + glass_guard in "
    "ONE process sharing ONE TF listener.");

  executor.spin();
  rclcpp::shutdown();
  return 0;
}
