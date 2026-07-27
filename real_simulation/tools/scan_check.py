#!/usr/bin/env python3
"""Validate the ground-truth map against live lidar, in the WORLD frame.

Stationary at spawn: the RPLIDAR is 360deg, so one scan sees all directions.
Collect a few scans, transform every beam endpoint to world coords via the
ground-truth pose, and overlay them (red) on the truth map. Red points should
sit exactly on the black walls. Red sticking PAST a wall => that wall is too
short/missing in the map (Shibo's west-wall question).

Run after: bash real_simulation/sim_start_headless.sh   (no SLAM needed)
"""
import os, math, numpy as np, yaml
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import Odometry
from PIL import Image

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'maps', 'maze_truth')
y = yaml.safe_load(open(BASE + '.yaml'))
res = y['resolution']; ox, oy = y['origin'][0], y['origin'][1]
gray = np.array(Image.open(BASE + '.pgm').convert('L'))
H, W = gray.shape

rclpy.init(); n = Node('scan_check'); buf = {'scans': []}
def on_scan(m): buf['scans'].append((m, buf.get('pose')))
def on_pose(m): buf['pose'] = m.pose.pose
n.create_subscription(LaserScan, '/robot_1/scan', on_scan, qos_profile_sensor_data)
n.create_subscription(Odometry, '/robot_1/sim_ground_truth_pose', on_pose, qos_profile_sensor_data)

# collect ~15 scans
n_wait = 0
while len([s for s in buf['scans'] if s[1] is not None]) < 15 and n_wait < 200:
    rclpy.spin_once(n, timeout_sec=0.1); n_wait += 1

scans = [s for s in buf['scans'] if s[1] is not None]
print(f'collected {len(scans)} scans with pose')
if not scans:
    print('NO scan+pose — is the sim up (software headless)?'); rclpy.shutdown(); exit()

rgb = np.stack([gray, gray, gray], axis=-1)
hit = tot = 0
p0 = scans[-1][1]
print(f'robot world pose x={p0.position.x:.2f} y={p0.position.y:.2f}')
# base_link -> lidar static TF (from tf2_echo): offset + 90deg yaw mount
LID_DX, LID_DY, LID_YAW = -0.04, 0.0, math.pi/2
for s, p in scans:
    q = p.orientation
    yaw = math.atan2(2*(q.w*q.z+q.x*q.y), 1-2*(q.y*q.y+q.z*q.z))
    # lidar origin in world = base pose + rotated mount offset
    px = p.position.x + LID_DX*math.cos(yaw) - LID_DY*math.sin(yaw)
    py = p.position.y + LID_DX*math.sin(yaw) + LID_DY*math.cos(yaw)
    for i, r in enumerate(s.ranges):
        if not math.isfinite(r) or r <= s.range_min or r >= s.range_max:
            continue
        a = yaw + LID_YAW + s.angle_min + i*s.angle_increment   # + lidar mount yaw
        wx = px + r*math.cos(a); wy = py + r*math.sin(a)
        c = int((wx-ox)/res); row = int(H-(wy-oy)/res)
        if 0 <= row < H and 0 <= c < W:
            tot += 1
            rgb[row, c] = [255, 0, 0]                    # scan return = red
            if (gray[max(0,row-2):row+3, max(0,c-2):c+3] < 50).any():
                hit += 1
# mark robot pose green
rc = int((p0.position.x-ox)/res); rr = int(H-(p0.position.y-oy)/res)
if 0 <= rr < H and 0 <= rc < W:
    rgb[max(0,rr-2):rr+3, max(0,rc-2):rc+3] = [0, 180, 0]

out = BASE + '_scancheck.png'
Image.fromarray(rgb, 'RGB').resize((W*2, H*2), Image.NEAREST).save(out)
print(f'scan endpoints on a truth wall (+-2 cells): {hit}/{tot} = {100*hit/max(tot,1):.0f}%')
print(f'overlay saved: {out}  (red=scan return, green=robot, black=map wall)')
rclpy.shutdown()
