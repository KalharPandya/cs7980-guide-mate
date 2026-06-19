# Camera

This section documents the robot's depth/RGB camera (Luxonis **OAK-D-LITE**).

## Documents
- [OAK-D-LITE camera — test, findings, fixes, pending issues](oak-d-camera-test.md)

## Quick facts
- The OAK-D-LITE provides **both** the RGB "webcam" and the stereo **depth** camera —
  there is no separate USB webcam (`/dev/video*` are the Pi's internal codec/ISP nodes).
- It is driven through ROS 2 via `depthai_ros_driver` (`ros-humble-depthai`), **not** as a
  UVC device. There is no standalone Python `depthai`.
- Topics: `/camera/rgb/image_raw` (`bgr8`) and `/camera/stereo/image_raw` (`16UC1`),
  both published with **`BEST_EFFORT`** sensor QoS.
- **Known issue:** on default settings the camera enters a USB 3 boot/disconnect loop
  caused by **power starvation** on the Pi 4. Workaround is to force USB 2
  (`-p camera.i_usb_speed:=HIGH`), which is stable but bandwidth-limited (~80 % frame
  drops at 30 fps). Proper fix — independent camera power — is **pending**. See the
  document above.
