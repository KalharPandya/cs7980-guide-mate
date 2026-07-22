#!/usr/bin/env python3
"""Stage 1 (+4) — isolated DDS loopback: pure transport loss/latency/jitter.

Publishes seq-numbered, timestamped messages on a private topic and receives
them in the same process, so the SIM is out of the picture — this isolates the
DDS transport itself. Sweep rate/size/QoS; set FASTDDS_BUILTIN_TRANSPORTS in the
environment (see run_comm_suite.sh) to compare transports (Stage 4).

Usage: comm_loopback.py --rate 50 --size 0 --qos best_effort --secs 8
  --size = extra float64 padding elements (0 = tiny Twist-like; 8192 ~= 64KB scan-ish)
"""
import argparse, os, time, statistics
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSHistoryPolicy
from std_msgs.msg import Float64MultiArray

ap = argparse.ArgumentParser()
ap.add_argument('--rate', type=float, default=50)
ap.add_argument('--size', type=int, default=0)
ap.add_argument('--qos', choices=['best_effort', 'reliable'], default='best_effort')
ap.add_argument('--secs', type=float, default=8)
a = ap.parse_args()

rel = QoSReliabilityPolicy.BEST_EFFORT if a.qos == 'best_effort' else QoSReliabilityPolicy.RELIABLE
qos = QoSProfile(depth=50, reliability=rel, history=QoSHistoryPolicy.KEEP_LAST)

rclpy.init()
n = Node('comm_loopback')
rx = {'seqs': [], 'lat': []}
t0 = time.monotonic()

def on_msg(m):
    seq = m.data[0]; tsend = m.data[1]
    rx['seqs'].append(int(seq)); rx['lat'].append((time.monotonic() - t0) - tsend)

n.create_subscription(Float64MultiArray, '/comm_loop', on_msg, qos)
pub = n.create_publisher(Float64MultiArray, '/comm_loop', qos)
pad = [0.0] * a.size
seq = {'i': 0}

def tick():
    m = Float64MultiArray()
    m.data = [float(seq['i']), time.monotonic() - t0] + pad
    pub.publish(m); seq['i'] += 1

n.create_timer(1.0 / a.rate, tick)
# let discovery settle
e = time.monotonic() + 1.0
while time.monotonic() < e:
    rclpy.spin_once(n, timeout_sec=0.02)
seq['i'] = 0; rx['seqs'].clear(); rx['lat'].clear()

e = time.monotonic() + a.secs
while time.monotonic() < e:
    rclpy.spin_once(n, timeout_sec=0.002)
sent = seq['i']
got = len(rx['seqs'])
# loss by seq coverage
uniq = sorted(set(rx['seqs']))
loss = 100 * (1 - got / max(sent, 1))
lat_ms = [x * 1000 for x in rx['lat'] if x >= 0]
def pctl(v, p):
    return sorted(v)[min(len(v) - 1, int(len(v) * p))] if v else float('nan')
# jitter: stdev of inter-arrival (approx via seq gaps not available; use latency spread)
print(f"rate={a.rate:>5.0f}Hz size={a.size:>5d} qos={a.qos:<10s} "
      f"transport={os.environ.get('FASTDDS_BUILTIN_TRANSPORTS','default'):<10s} "
      f"sent={sent:>5d} recv={got:>5d} loss={loss:5.1f}%  "
      f"lat_ms p50={pctl(lat_ms,0.5):6.2f} p95={pctl(lat_ms,0.95):6.2f} max={max(lat_ms) if lat_ms else float('nan'):6.2f}")
rclpy.shutdown()
