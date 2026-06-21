cmake_minimum_required(VERSION 3.8)
project(guide_mate_perception)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
endif()
if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic -O2)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(rclcpp_action REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(nav_msgs REQUIRED)
find_package(nav2_msgs REQUIRED)
find_package(std_msgs REQUIRED)
find_package(visualization_msgs REQUIRED)
find_package(irobot_create_msgs REQUIRED)
find_package(tf2 REQUIRED)
find_package(tf2_ros REQUIRED)

add_executable(depth_lidar_fusion src/depth_lidar_fusion_node.cpp)
ament_target_dependencies(depth_lidar_fusion
  rclcpp sensor_msgs geometry_msgs tf2 tf2_ros)

add_executable(bfs_explorer src/bfs_explorer_node.cpp)
ament_target_dependencies(bfs_explorer
  rclcpp rclcpp_action nav_msgs nav2_msgs std_msgs visualization_msgs
  geometry_msgs tf2 tf2_ros)

add_executable(glass_guard src/glass_guard_node.cpp)
ament_target_dependencies(glass_guard
  rclcpp sensor_msgs geometry_msgs visualization_msgs irobot_create_msgs
  std_msgs tf2 tf2_ros)

# Single-process container: includes the three node .cpp files (their main()s
# suppressed via GUIDE_MATE_CONTAINER) and runs them with ONE shared TF listener.
add_executable(guide_mate_container src/container_node.cpp)
ament_target_dependencies(guide_mate_container
  rclcpp rclcpp_action sensor_msgs geometry_msgs nav_msgs nav2_msgs std_msgs
  visualization_msgs irobot_create_msgs tf2 tf2_ros)

install(TARGETS depth_lidar_fusion bfs_explorer glass_guard guide_mate_container
  DESTINATION lib/${PROJECT_NAME})

install(DIRECTORY launch
  DESTINATION share/${PROJECT_NAME}
  OPTIONAL)

ament_package()
