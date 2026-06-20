# Power & Battery

Robot 468 is battery-powered (iRobot Create 3 base battery feeds both the Create 3 *and* the Raspberry Pi 4 over the USB-C link). The full perception/SLAM stack runs continuously regardless of motion, so understanding — and reducing — idle draw matters for runtime.

## Index
- [Power consumption & saving](power-saving.md) — measured idle draw, what's always running and why, and the **one working way to park the robot** (stop SLAM → lidar auto-idles + CPU freed). Includes what does *not* work.

## Quick facts
- **Only power sensor on the robot:** `/turtlebot468/battery_state` (whole-pack, aggregate — no per-component metering exists on stock TB4).
- **Measured idle draw (undocked, stationary):** **~14 W** (−1.0 A @ ~14.15 V).
- **Pack:** ~1.968 Ah / ~14.4 V ≈ 28 Wh → roughly **2 h** idle runtime from full, before driving.
- **Battery current sign:** negative = discharging (real load, only visible **undocked**); positive = charging.
