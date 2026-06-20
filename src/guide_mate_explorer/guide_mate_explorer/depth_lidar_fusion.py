#!/usr/bin/env python3
"""Depth->lidar fusion: fold OAK-D depth obstacles into the lidar scan.

The 2D lidar is blind to glass, but the glass doors have a metal base BELOW the
lidar plane that the depth camera can see. This node does a fast vertical
*collapse* of the depth image into a 2D obstacle profile and *injects* it into a
copy of the lidar scan (range = min(lidar, depth) per beam). The fused scan is a
drop-in replacement for the raw lidar: feed it to slam_toolbox AND the Nav2
costmaps and the glass lands in the SLAM map, not just the runtime costmap.

How it works:
  * Collapse runs per depth column (each column ~= one bearing for a level,
    forward-facing camera): keep the nearest pixel whose height above the floor
    is inside [min_height, max_height] -- this drops the floor and keeps the
    metal base. One vectorised numpy pass (~16 ms/frame on the Pi).
  * The few hundred surviving points are back-projected and transformed into the
    lidar frame via a one-time static TF lookup. Working in x/y (not bearing) is
    what accounts for the ~2 cm lidar<->camera offset. They are then binned onto
    the lidar beam grid (min per beam).
  * Injection only ever LOWERS a beam's range (or fills an empty beam); it never
    erases a real lidar return.
  * Fully toggleable: the raw lidar stays on `scan_in` (default `scan`); the
    fused scan is published on `scan_out` (default `scan_fused`). If depth goes
    stale the output is just the raw lidar, so a camera dropout is graceful.

Namespaced TF: this node uses a TransformListener, so launch it with
`('/tf','tf'),('/tf_static','tf_static')` remaps or lookups fail silently.
"""
import math

import numpy as np
import rclpy
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data

from sensor_msgs.msg import CameraInfo, Image, LaserScan

import tf2_ros


class DepthLidarFusion(Node):
    def __init__(self):
        super().__init__('depth_lidar_fusion')

        # --- topics ---------------------------------------------------------
        self.declare_parameter('depth_image_topic', 'oakd/stereo/image_raw')
        self.declare_parameter('camera_info_topic', 'oakd/stereo/camera_info')
        self.declare_parameter('scan_in', 'scan')          # raw lidar in
        self.declare_parameter('scan_out', 'scan_fused')   # fused lidar out
        # Optional: publish the depth-only collapsed scan for debugging ('' = off)
        self.declare_parameter('debug_depth_scan_topic', '')

        # --- geometry / filtering ------------------------------------------
        # Camera height above the floor (m). The TB4 OAK is mounted level (no tilt).
        self.declare_parameter('camera_height', 0.244)
        # Height band above the floor to keep (drops floor, keeps the metal base).
        self.declare_parameter('min_height', 0.06)
        self.declare_parameter('max_height', 0.50)
        # Depth range gate (m).
        self.declare_parameter('range_min', 0.25)
        self.declare_parameter('range_max', 5.0)
        # Ignore depth older than this when fusing (s) -> graceful camera dropout.
        self.declare_parameter('max_depth_age', 0.4)
        self.declare_parameter('transform_tolerance', 0.2)
        # Trust the lidar by default: depth only overrides a beam when it is nearer
        # than the lidar by at least this margin (m). Raise to bias harder toward
        # the (more accurate) lidar in the rare case the two disagree on range.
        self.declare_parameter('lidar_trust_margin', 0.0)
        # Camera intrinsics. Runtime priority: explicit fx/fy/cx/cy params >
        # camera_info IF it matches the depth image size > a FOV-based pinhole
        # model. depthai's stereo/camera_info can report a DIFFERENT resolution
        # than the actual depth image (seen here: 1280x720 K for a 640x480 depth),
        # which skews the geometry -- hence the size check and the FOV fallback.
        self.declare_parameter('fx', 0.0)
        self.declare_parameter('fy', 0.0)
        self.declare_parameter('cx', 0.0)
        self.declare_parameter('cy', 0.0)
        # FOV fallback (OAK-D-LITE mono): used when no matching camera_info.
        self.declare_parameter('hfov_deg', 73.0)
        self.declare_parameter('vfov_deg', 58.0)

        # --- ground (floor) detection --------------------------------------
        # Data-driven: each frame robustly fit the floor line v = A*(1/z) + B
        # (A = camera_height*fy, B ~= cy) to the lower image, then remove points
        # near it. Self-calibrates camera height + pitch; falls back to the
        # assumed model (camera_height, cy) when the floor isn't reliably in view.
        self.declare_parameter('ground_estimation', True)
        self.declare_parameter('ground_row_margin', 10)   # start this many rows below cy
        self.declare_parameter('ground_max_range', 4.0)   # only fit floor within this (m)
        self.declare_parameter('ground_min_row_px', 40)   # valid px needed to use a row
        self.declare_parameter('ground_min_rows', 20)     # good rows needed to trust fit
        self.declare_parameter('ground_ema', 0.3)         # frame-to-frame smoothing
        self.declare_parameter('ground_fail_max', 15)     # coast frames before fallback
        self.declare_parameter('ground_h_lo', 0.10)       # accept camera_height in
        self.declare_parameter('ground_h_hi', 0.45)       #   [lo,hi] m (sanity on A)

        # --- drops (negative obstacles) ------------------------------------
        # Two layers: (a) below-floor returns flagged like positives (the
        # "convert negatives to positives" trick, catches visible step-downs),
        # and (b) a missing-floor edge check that flags the NEAR edge of a
        # ledge/stairs where the floor that should be in view returns nothing.
        # (The Create 3 cliff sensors cover the <0.4 m camera blind zone -- TODO.)
        self.declare_parameter('drop_detection', True)
        self.declare_parameter('drop_max_depth', 0.50)     # below-floor band depth (m)
        self.declare_parameter('drop_check_range', 3.0)    # hunt floor edges within (m)
        self.declare_parameter('drop_floor_tol_abs', 0.10) # |z-expected| floor tol (m) ...
        self.declare_parameter('drop_floor_tol_rel', 0.08) #   ... + this fraction of range
        self.declare_parameter('drop_gap', 0.20)           # extra margin to call floor "gone"
        self.declare_parameter('drop_min_missing_rows', 5) # consec missing rows -> a drop

        gp = self.get_parameter
        self.camera_height = float(gp('camera_height').value)
        self.min_h = float(gp('min_height').value)
        self.max_h = float(gp('max_height').value)
        self.range_min = float(gp('range_min').value)
        self.range_max = float(gp('range_max').value)
        self.max_depth_age = float(gp('max_depth_age').value)
        self.lidar_trust_margin = float(gp('lidar_trust_margin').value)
        self.tf_timeout = Duration(seconds=float(gp('transform_tolerance').value))

        self._param_fx = float(gp('fx').value)
        self._param_fy = float(gp('fy').value)
        self._param_cx = float(gp('cx').value)
        self._param_cy = float(gp('cy').value)
        self._hfov = math.radians(float(gp('hfov_deg').value))
        self._vfov = math.radians(float(gp('vfov_deg').value))
        self._ci = None              # (w,h,fx,fy,cx,cy) from camera_info, raw
        self._intr_src = None        # intrinsics source currently in use (log once)
        self.ground_estimation = bool(gp('ground_estimation').value)
        self.ground_row_margin = int(gp('ground_row_margin').value)
        self.ground_max_range = float(gp('ground_max_range').value)
        self.ground_min_row_px = int(gp('ground_min_row_px').value)
        self.ground_min_rows = int(gp('ground_min_rows').value)
        self.ground_ema = float(gp('ground_ema').value)
        self.ground_fail_max = int(gp('ground_fail_max').value)
        self.ground_h_lo = float(gp('ground_h_lo').value)
        self.ground_h_hi = float(gp('ground_h_hi').value)
        self.drop_detection = bool(gp('drop_detection').value)
        self.drop_max_depth = float(gp('drop_max_depth').value)
        self.drop_check_range = float(gp('drop_check_range').value)
        self.drop_floor_tol_abs = float(gp('drop_floor_tol_abs').value)
        self.drop_floor_tol_rel = float(gp('drop_floor_tol_rel').value)
        self.drop_gap = float(gp('drop_gap').value)
        self.drop_min_missing_rows = int(gp('drop_min_missing_rows').value)
        self._ground_A = None        # fitted floor-line slope (= camera_height*fy)
        self._ground_B = None        # fitted floor-line intercept (~= cy)
        self._ground_fail = 0        # consecutive frames the fit failed
        self._ground_src = None      # 'fit' | 'assumed' (log on change)

        # --- cached state ---------------------------------------------------
        self._grid_wh = None         # (width, height) the u/v grids were built for
        self._u = None               # (H,W) column-index grid
        self._vrow = None            # (H,1) row-index grid
        self._optical_frame = None   # depth image frame_id (TF source)
        self._scan_frame = None      # lidar scan frame_id (TF target + output)
        self._R = None               # 3x3 rotation scan<-optical
        self._t = None               # 3   translation scan<-optical
        self._depth_rng = None       # collapsed depth: range per surviving point
        self._depth_brg = None       # collapsed depth: bearing per surviving point
        self._depth_stamp = None     # ROS time of the last collapse
        self._warned_no_tf = False

        self.tf_buffer = tf2_ros.Buffer()
        self.tf_listener = tf2_ros.TransformListener(self.tf_buffer, self)

        self.scan_pub = self.create_publisher(
            LaserScan, gp('scan_out').value, qos_profile_sensor_data)
        dbg_topic = gp('debug_depth_scan_topic').value
        self.dbg_pub = (self.create_publisher(
            LaserScan, dbg_topic, qos_profile_sensor_data) if dbg_topic else None)

        self.create_subscription(CameraInfo, gp('camera_info_topic').value,
                                 self._info_cb, qos_profile_sensor_data)
        self.create_subscription(Image, gp('depth_image_topic').value,
                                 self._depth_cb, qos_profile_sensor_data)
        self.create_subscription(LaserScan, gp('scan_in').value,
                                 self._scan_cb, qos_profile_sensor_data)

        self.get_logger().info(
            f"depth_lidar_fusion up. depth='{gp('depth_image_topic').value}' + "
            f"lidar='{gp('scan_in').value}' -> fused '{gp('scan_out').value}'. "
            f"height band [{self.min_h:.2f},{self.max_h:.2f}] m, "
            f"range [{self.range_min:.2f},{self.range_max:.2f}] m.")

    # ------------------------------------------------------------------ info
    def _info_cb(self, msg):
        k = msg.k  # row-major 3x3 intrinsics
        if k[0] > 0.0 and k[4] > 0.0:
            self._ci = (msg.width, msg.height, k[0], k[4], k[2], k[5])

    def _resolve_intrinsics(self, w, h):
        """Pick intrinsics for a w x h depth image (priority: see __init__)."""
        if self._param_fx > 0.0 and self._param_fy > 0.0:
            src = 'params'
            fx, fy, cx, cy = (self._param_fx, self._param_fy,
                              self._param_cx, self._param_cy)
        elif self._ci is not None and self._ci[0] == w and self._ci[1] == h:
            src = 'camera_info'
            fx, fy, cx, cy = self._ci[2], self._ci[3], self._ci[4], self._ci[5]
        else:
            src = 'fov'
            cx, cy = w / 2.0, h / 2.0
            fx = (w / 2.0) / math.tan(self._hfov / 2.0)
            fy = (h / 2.0) / math.tan(self._vfov / 2.0)
        if self._intr_src != src:
            self.get_logger().info(
                f"intrinsics source={src}: fx={fx:.1f} fy={fy:.1f} "
                f"cx={cx:.1f} cy={cy:.1f} for depth {w}x{h}.")
            if src == 'fov' and self._ci is not None:
                self.get_logger().warn(
                    f"camera_info {self._ci[0]}x{self._ci[1]} != depth {w}x{h}; "
                    f"using FOV model (hfov={math.degrees(self._hfov):.0f} "
                    f"vfov={math.degrees(self._vfov):.0f} deg).")
            self._intr_src = src
        return fx, fy, cx, cy

    # ---------------------------------------------------------------- ground
    @staticmethod
    def _robust_line(x, y):
        """Fit y = A*x + B robustly (least squares + 2x MAD outlier rejection)."""
        if len(x) < 2:
            return None, None, 0
        A, B = np.polyfit(x, y, 1)
        inl = np.ones(len(x), dtype=bool)
        for _ in range(2):
            r = y - (A * x + B)
            med = np.median(r)
            mad = np.median(np.abs(r - med)) + 1e-6
            inl = np.abs(r - med) < 3.0 * 1.4826 * mad
            if inl.sum() < 2:
                break
            A, B = np.polyfit(x[inl], y[inl], 1)
        return float(A), float(B), int(inl.sum())

    def _ground_plane(self, z, fy, cy):
        """Estimate the floor line v = A*(1/z) + B from this frame.

        For a level camera every floor pixel obeys this (A = camera_height*fy,
        B ~= cy), independent of column. We fit it to the per-row median inverse
        depth of the lower image (the median rejects the minority of obstacle
        pixels in each row), EMA-smooth it, and fall back to the assumed model
        when the floor isn't reliably visible. Returns (A, B) for the height calc.
        """
        A0, B0 = self.camera_height * fy, float(cy)
        if not self.ground_estimation:
            return A0, B0
        rows = z.shape[0]
        v0 = max(0, min(int(cy) + self.ground_row_margin, rows - 2))
        sub = z[v0:, :]
        valid = (sub > self.range_min) & (sub < self.ground_max_range)
        idx = np.nonzero(valid.sum(axis=1) >= self.ground_min_row_px)[0]
        good = False
        if idx.size >= self.ground_min_rows:
            sg = sub[idx].astype(np.float32)
            sg[(sg <= self.range_min) | (sg >= self.ground_max_range)] = np.nan
            xx = np.nanmedian(1.0 / sg, axis=1).astype(np.float32)   # median 1/z/row
            yy = (v0 + idx).astype(np.float32)
            ok = np.isfinite(xx)
            if ok.sum() >= self.ground_min_rows:
                A, B, ninl = self._robust_line(xx[ok], yy[ok])
                good = (A is not None and ninl >= self.ground_min_rows * 0.5 and
                        self.ground_h_lo * fy < A < self.ground_h_hi * fy)
        if good:
            if self._ground_A is None:
                self._ground_A, self._ground_B = A, B
            else:
                a = self.ground_ema
                self._ground_A = (1 - a) * self._ground_A + a * A
                self._ground_B = (1 - a) * self._ground_B + a * B
            self._ground_fail = 0
            if self._ground_src != 'fit':
                self.get_logger().info(
                    f"ground: data-driven fit ON (h_cam~{self._ground_A/fy:.3f} m, "
                    f"B~{self._ground_B:.0f} px)")
                self._ground_src = 'fit'
            return self._ground_A, self._ground_B
        # fit failed this frame: coast on last good for a while, else fall back
        self._ground_fail += 1
        if self._ground_A is not None and self._ground_fail <= self.ground_fail_max:
            return self._ground_A, self._ground_B
        if self._ground_src != 'assumed':
            self.get_logger().warn(
                "ground: floor not reliably visible -> assumed model "
                f"(h_cam={self.camera_height:.3f}, cy={cy:.0f})")
            self._ground_src = 'assumed'
        return A0, B0

    def _drop_edges(self, z, valid, A, B):
        """Detect ledge/stair edges: where the expected floor returns nothing.

        Walk each column near->far along the fitted floor (expected depth
        z_exp(v) = A/(v-B)). While the floor is present, track its near edge; if
        it then goes MISSING (no return, or a return well beyond the floor) for
        several consecutive rows before any nearer surface occludes the view,
        flag that column's near edge as an obstacle. Returns (cols, rows, depths)
        float arrays for the detected edges, ready to merge into the collapse.
        """
        H, W = z.shape
        seen = np.zeros(W, dtype=bool)        # floor seen yet in this column
        done = np.zeros(W, dtype=bool)        # column resolved (drop found / occluded)
        miss = np.zeros(W, dtype=np.int32)    # consecutive missing-floor rows
        lastv = np.full(W, -1, dtype=np.int32)   # near edge: last present floor row
        edge = np.full(W, -1, dtype=np.int32)    # detected drop-edge row
        gap = self.drop_gap
        for v in range(H - 1, 0, -1):
            denom = v - B
            if denom <= 1.0:                  # at/above the floor horizon
                break
            zexp = A / denom                  # expected floor depth at this row
            if zexp <= self.range_min:
                continue
            if zexp >= self.drop_check_range:  # past our drop horizon (only farther up)
                break
            row = z[v]
            vok = valid[v]
            tol = self.drop_floor_tol_abs + self.drop_floor_tol_rel * zexp
            present = vok & (np.abs(row - zexp) <= tol)
            nearer = vok & (row < zexp - tol)               # occluder in front of floor
            missing = (~vok) | (vok & (row > zexp + tol + gap))   # floor gone / fell away
            # an occluder (wall/obstacle nearer than the floor) ends the search
            done |= nearer & ~done
            active = ~done
            p = present & active
            miss[p] = 0
            lastv[p] = v
            seen |= p
            m = missing & active & seen
            miss[m] += 1
            trig = (miss >= self.drop_min_missing_rows) & active & seen & (lastv >= 0)
            edge[trig] = lastv[trig]
            done |= trig
        cols = np.nonzero(edge >= 0)[0]
        if cols.size == 0:
            e = np.empty(0, dtype=np.float32)
            return e, e, e
        dv = edge[cols].astype(np.float32)
        dz = (A / (dv - B)).astype(np.float32)   # floor depth at the edge row
        return cols.astype(np.float32), dv, dz

    # ----------------------------------------------------------------- depth
    def _ensure_grids(self, width, height):
        if self._grid_wh == (width, height):
            return
        u = np.arange(width, dtype=np.float32)
        self._u = np.broadcast_to(u, (height, width))         # (H,W)
        self._vrow = np.arange(height, dtype=np.float32).reshape(height, 1)
        self._grid_wh = (width, height)

    def _ensure_extrinsics(self):
        """One-time static lookup of the scan_frame <- optical_frame transform."""
        if self._R is not None:
            return True
        if self._optical_frame is None or self._scan_frame is None:
            return False
        try:
            tf = self.tf_buffer.lookup_transform(
                self._scan_frame, self._optical_frame, rclpy.time.Time(),
                timeout=self.tf_timeout)
        except tf2_ros.TransformException as e:
            if not self._warned_no_tf:
                self.get_logger().warn(
                    f"waiting for TF {self._scan_frame}<-"
                    f"{self._optical_frame}: {e}")
                self._warned_no_tf = True
            return False
        q = tf.transform.rotation
        x, y, z, w = q.x, q.y, q.z, q.w
        self._R = np.array([
            [1 - 2*(y*y + z*z), 2*(x*y - z*w),     2*(x*z + y*w)],
            [2*(x*y + z*w),     1 - 2*(x*x + z*z), 2*(y*z - x*w)],
            [2*(x*z - y*w),     2*(y*z + x*w),     1 - 2*(x*x + y*y)],
        ], dtype=np.float32)
        tr = tf.transform.translation
        self._t = np.array([tr.x, tr.y, tr.z], dtype=np.float32)
        self.get_logger().info(
            f"extrinsics {self._scan_frame}<-{self._optical_frame} cached "
            f"(t=[{tr.x:.3f},{tr.y:.3f},{tr.z:.3f}]).")
        return True

    def _depth_cb(self, msg):
        self._optical_frame = msg.header.frame_id
        if not self._ensure_extrinsics():
            return

        w, h = msg.width, msg.height
        self._ensure_grids(w, h)
        fx, fy, cx, cy = self._resolve_intrinsics(w, h)
        # 16UC1 millimetres -> metres (the Pi is little-endian; depthai matches).
        buf = np.frombuffer(msg.data, dtype=np.uint16)
        if msg.is_bigendian:
            buf = buf.byteswap()
        z = buf.reshape(h, msg.step // 2)[:, :w].astype(np.float32) * 0.001

        # Data-driven floor: fit the ground line this frame (falls back to the
        # assumed model). Height above the FITTED floor = (A + (B - v)*z)/fy,
        # which reduces to h_cam - (v-cy)*z/fy when A=h_cam*fy, B=cy.
        A, B = self._ground_plane(z, fy, cy)
        height = (A + (B - self._vrow) * z) / fy
        valid = (z > self.range_min) & (z < self.range_max)
        pos = (height > self.min_h) & (height < self.max_h)          # above the floor
        if self.drop_detection:
            # below-floor returns (visible step-downs) flagged like positives
            neg = (height < -self.min_h) & (height > -self.drop_max_depth)
            keep = valid & (pos | neg)
        else:
            keep = valid & pos

        # Nearest kept pixel per column = the vertical collapse.
        z_masked = np.where(keep, z, np.inf)
        col_min = z_masked.min(axis=0)            # (W,)
        rows = z_masked.argmin(axis=0)            # (W,) row of the nearest kept pixel
        cols = np.nonzero(np.isfinite(col_min))[0]
        uc = cols.astype(np.float32)
        vc = rows[cols].astype(np.float32)
        zc = col_min[cols]

        # Drops: flag the NEAR edge of a ledge where the expected floor vanishes.
        if self.drop_detection:
            du, dv, dz = self._drop_edges(z, valid, A, B)
            if du.size:
                uc = np.concatenate((uc, du))
                vc = np.concatenate((vc, dv))
                zc = np.concatenate((zc, dz))

        if uc.size == 0:
            self._depth_rng = None
            return
        # Back-project to the optical frame.
        xo = (uc - cx) * zc / fx
        yo = (vc - cy) * zc / fy
        # Into the lidar frame (only x,y matter for a planar scan).
        R, t = self._R, self._t
        xl = R[0, 0]*xo + R[0, 1]*yo + R[0, 2]*zc + t[0]
        yl = R[1, 0]*xo + R[1, 1]*yo + R[1, 2]*zc + t[1]
        self._depth_rng = np.hypot(xl, yl).astype(np.float32)
        self._depth_brg = np.arctan2(yl, xl).astype(np.float32)
        self._depth_stamp = rclpy.time.Time.from_msg(msg.header.stamp)

    # ------------------------------------------------------------------ scan
    def _scan_cb(self, msg):
        self._scan_frame = msg.header.frame_id
        n = len(msg.ranges)
        orig = np.asarray(msg.ranges, dtype=np.float32)
        fused = orig.copy()

        dmin = self._depth_profile(msg, n)
        if dmin is not None:
            lid = orig.copy()
            # Lidar no-returns (inf/NaN, or <= range_min incl. 0.0) -> "empty beam".
            lid[~np.isfinite(lid) | (lid <= msg.range_min)] = np.inf
            # Trust the lidar: depth overrides a beam ONLY when it is nearer than the
            # lidar (by >= lidar_trust_margin), or the lidar beam is empty. If the
            # depth collapse reads FARTHER than the lidar on the same beam -- the rare
            # case -- we keep the lidar. Depth only ever pulls an obstacle nearer or
            # fills an empty beam; it never pushes a real lidar return farther away.
            take = dmin < (lid - self.lidar_trust_margin)
            fused[take] = dmin[take]
            if self.dbg_pub is not None:
                self._publish_like(msg, dmin, self.dbg_pub)

        self._publish_like(msg, fused, self.scan_pub)

    def _depth_profile(self, scan, n):
        """Bin the cached collapsed depth onto this scan's beam grid (min)."""
        if self._depth_rng is None or self._depth_stamp is None:
            return None
        age = (rclpy.time.Time.from_msg(scan.header.stamp) -
               self._depth_stamp).nanoseconds * 1e-9
        if abs(age) > self.max_depth_age:
            return None
        brg, rng = self._depth_brg, self._depth_rng
        inb = ((brg >= scan.angle_min) & (brg <= scan.angle_max) &
               (rng >= scan.range_min) & (rng <= scan.range_max))
        if not inb.any():
            return None
        idx = np.round((brg[inb] - scan.angle_min) /
                       scan.angle_increment).astype(np.int64)
        np.clip(idx, 0, n - 1, out=idx)
        dmin = np.full(n, np.inf, dtype=np.float32)
        np.minimum.at(dmin, idx, rng[inb])        # min per beam over duplicates
        return dmin

    def _publish_like(self, src, ranges, pub):
        out = LaserScan()
        out.header = src.header                   # same frame_id + stamp as lidar
        out.angle_min = src.angle_min
        out.angle_max = src.angle_max
        out.angle_increment = src.angle_increment
        out.time_increment = src.time_increment
        out.scan_time = src.scan_time
        out.range_min = src.range_min
        out.range_max = src.range_max
        out.ranges = ranges.astype(np.float32).tolist()
        pub.publish(out)


def main():
    rclpy.init()
    node = DepthLidarFusion()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
