# OAK-D-LITE reliability scripts

Tooling that came out of the 2026-06-20 camera/depth deep-dive (full write-up:
[`docs/camera.md`](../docs/camera.md)). It fixes the daily camera wedge and supervises
the device so it can never silently stay dead.

## TL;DR — what was actually wrong
The camera's daily "boot loop / wedge" was **not** power starvation (the old docs were
wrong — under-voltage never once latched across the whole investigation). It is the
kernel default **`usbfs_memory_mb=16`**, which is too small for the OAK's USB bulk
transfers: the depthai driver throws `X_LINK_ERROR` reading the stereo stream and the
process aborts ~5 s after "Camera ready". Raising `usbfs_memory_mb` to 256 lets the
**exact same `SUPER`/USB3 config run indefinitely**. A second, independent failure is a
rare runtime drop in *one* mode only — the **heavy RGB+depth pipeline on USB3** — a
current-draw brownout on the camera's own 5 V rail (NOT CPU, NOT temperature, NOT Pi
under-voltage; depth-only survives a fully-saturated, thermally-throttling Pi with 0
drops). When it does drop, the stock driver sits wedged forever. Run depth-only and it's
rare; two params + this watchdog recover it: `i_restart_on_diagnostics_error` (driver
self-heal) plus `oak_watchdog` (backstop). The true fix for that mode is hardware power
delivery (short cable / powered hub / Y-adapter). See [`docs/camera.md`](../docs/camera.md).

## Files
| file | what it does |
|---|---|
| `oak_bringup.sh` | Hardened standalone camera bring-up. The single source of truth for the good config (usbfs ensured, `DEPTHAI_WATCHDOG`, shallow queues). Depth-only/USB2 by default; `OAK_USB_SPEED=SUPER` for full-rate USB3; driver self-heal is opt-in (`OAK_SELFHEAL=1`, off by default — prefer the watchdog). |
| `oak_watchdog.sh` | Supervises the OAK by **USB product-id** (`f63b`=healthy, `2485`/absent=wedged) + process liveness — frame-probing is impossible on this Discovery-Server box. On a confirmed wedge: kill → `usbreset` → relaunch, with a 30 s grace (so it never fights the driver's own self-heal) and burst back-off (so it never thrashes). |
| `oak-watchdog.service` | systemd unit that runs `oak_watchdog.sh` with `Restart=always`. |
| `install_oak_fixes.sh` | `sudo`-run installer: persists `usbfs_memory_mb=256` + `usbcore.autosuspend=-1` in `cmdline.txt` (with backup), installs the sudoers rule and the watchdog unit. Does **not** reboot or auto-enable anything. |

## Quick use (no install)
```bash
# bring the camera up the hardened way (depth-only, USB2):
scripts/oak_bringup.sh
# ...or full-rate USB3 (needs usbfs>=256, which the script ensures):
OAK_USB_SPEED=SUPER scripts/oak_bringup.sh
```

## Permanent install
```bash
sudo bash scripts/install_oak_fixes.sh   # review it first
sudo reboot                              # locks in the cmdline usbfs/autosuspend change
```

## Deployment — pick ONE owner of the camera
The OAK is a single device; only one driver may hold it.
- **Recommended (mapping runs):** take the camera OUT of `turtlebot4.service` and let the
  watchdog own a standalone `oak_bringup.sh`:
  ```bash
  sudo systemctl enable --now oak-watchdog.service
  ```
- **Keep it in `turtlebot4.service`:** then just apply fix #1 (usbfs) and add
  `i_enable_diagnostics:=true` + `i_restart_on_diagnostics_error:=true` to
  `/opt/ros/humble/share/turtlebot4_bringup/config/oakd_lite.yaml`. Don't also enable the
  watchdog's standalone bring-up, or two drivers will fight for the device.

`touch /tmp/oak_watchdog.pause` suspends watchdog recovery during maintenance.

## Manual recovery (if you ever need it by hand)
```bash
pkill -x camera_node                       # kill the wedged driver (NEVER `pkill -f camera_node`)
sudo usbreset "$(lsusb -d 03e7: | awk '{print $6}')"   # reset whichever id is current (f63b/2485)
scripts/oak_bringup.sh                      # relaunch
```
