// depth_lidar_fusion_node.cpp
//
// Faithful C++ port of guide_mate_explorer/depth_lidar_fusion.py. Folds OAK-D
// depth obstacles into the lidar scan and republishes a fused LaserScan
// (range = min(lidar, depth) per beam) on `scan_out`. See the Python node's
// module docstring for the full algorithm rationale; this port mirrors its
// numerics -- including numpy's float32 precision on the decision-critical path
// (height bands, projection, beam binning) -- so the fused scan is behaviourally
// equivalent while costing far less CPU (no per-message Python TF/image
// deserialization).
//
// Pipeline: data-driven ground-line fit -> per-column vertical collapse (keep
// nearest pixel inside the height band, drop the floor) -> optional drop-edge
// detection -> back-project + static extrinsic into the lidar frame -> bin onto
// the beam grid (min) -> inject only where depth is NEARER than the lidar.
//
// Namespaced TF: the TransformListener subscribes to the GLOBAL /tf, so launch
// with ('/tf','tf'),('/tf_static','tf_static') remaps or lookups fail silently.
#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/camera_info.hpp>
#include <sensor_msgs/msg/image.hpp>
#include <sensor_msgs/msg/laser_scan.hpp>

#include <geometry_msgs/msg/transform_stamped.hpp>
#include <tf2_ros/buffer.h>
#include <tf2_ros/transform_listener.h>

namespace
{
constexpr float kInf = std::numeric_limits<float>::infinity();

// Median of a vector (mutates order via nth_element). Empty -> NaN.
double median_inplace(std::vector<double> & v)
{
  const size_t n = v.size();
  if (n == 0) {
    return std::numeric_limits<double>::quiet_NaN();
  }
  const size_t mid = n / 2;
  std::nth_element(v.begin(), v.begin() + mid, v.end());
  const double hi = v[mid];
  if (n % 2 == 1) {
    return hi;
  }
  // even: average of the two central order statistics (matches numpy.median)
  const double lo = *std::max_element(v.begin(), v.begin() + mid);
  return 0.5 * (lo + hi);
}

// Least-squares fit y = A*x + B. Returns false if < 2 points.
bool polyfit1(const std::vector<double> & x, const std::vector<double> & y,
  double & A, double & B)
{
  const size_t n = x.size();
  if (n < 2) {
    return false;
  }
  double sx = 0.0, sy = 0.0, sxx = 0.0, sxy = 0.0;
  for (size_t i = 0; i < n; ++i) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const double dn = static_cast<double>(n);
  const double denom = dn * sxx - sx * sx;
  if (std::abs(denom) < 1e-12) {
    return false;
  }
  A = (dn * sxy - sx * sy) / denom;
  B = (sy - A * sx) / dn;
  return true;
}

struct LineFit
{
  bool ok = false;
  double A = 0.0;
  double B = 0.0;
  int ninl = 0;
};

// Robust line fit y = A*x + B: least squares + 2x MAD outlier rejection.
// Mirrors DepthLidarFusion._robust_line.
LineFit robust_line(const std::vector<double> & x, const std::vector<double> & y)
{
  LineFit out;
  const size_t n = x.size();
  if (n < 2) {
    return out;
  }
  double A = 0.0, B = 0.0;
  if (!polyfit1(x, y, A, B)) {
    return out;
  }
  std::vector<bool> inl(n, true);
  int ninl = static_cast<int>(n);
  for (int it = 0; it < 2; ++it) {
    std::vector<double> r(n);
    for (size_t i = 0; i < n; ++i) {
      r[i] = y[i] - (A * x[i] + B);
    }
    std::vector<double> rc = r;
    const double med = median_inplace(rc);
    std::vector<double> ad(n);
    for (size_t i = 0; i < n; ++i) {
      ad[i] = std::abs(r[i] - med);
    }
    std::vector<double> adc = ad;
    const double mad = median_inplace(adc) + 1e-6;
    const double thr = 3.0 * 1.4826 * mad;
    int cnt = 0;
    for (size_t i = 0; i < n; ++i) {
      inl[i] = ad[i] < thr;
      if (inl[i]) {
        ++cnt;
      }
    }
    ninl = cnt;
    if (cnt < 2) {
      break;
    }
    std::vector<double> xi, yi;
    xi.reserve(cnt);
    yi.reserve(cnt);
    for (size_t i = 0; i < n; ++i) {
      if (inl[i]) {
        xi.push_back(x[i]);
        yi.push_back(y[i]);
      }
    }
    if (!polyfit1(xi, yi, A, B)) {
      // Degenerate (collinear-in-x) inliers: numpy.polyfit returns an ill-defined
      // min-norm solution that the downstream A-bounds gate rejects anyway. Mark
      // the fit untrustworthy so both ports fall back identically (coast/assumed).
      out.ok = false;
      return out;
    }
  }
  out.ok = true;
  out.A = A;
  out.B = B;
  out.ninl = ninl;
  return out;
}
}  // namespace

class DepthLidarFusion : public rclcpp::Node
{
public:
  explicit DepthLidarFusion(std::shared_ptr<tf2_ros::Buffer> shared_buffer = nullptr)
  : Node("depth_lidar_fusion")
  {
    // --- topics ---
    depth_image_topic_ = declare_parameter<std::string>("depth_image_topic", "oakd/stereo/image_raw");
    camera_info_topic_ = declare_parameter<std::string>("camera_info_topic", "oakd/stereo/camera_info");
    scan_in_ = declare_parameter<std::string>("scan_in", "scan");
    scan_out_ = declare_parameter<std::string>("scan_out", "scan_fused");
    debug_depth_scan_topic_ = declare_parameter<std::string>("debug_depth_scan_topic", "");

    // --- geometry / filtering ---
    camera_height_ = declare_parameter<double>("camera_height", 0.244);
    min_h_ = declare_parameter<double>("min_height", 0.06);
    max_h_ = declare_parameter<double>("max_height", 0.50);
    range_min_ = declare_parameter<double>("range_min", 0.25);
    range_max_ = declare_parameter<double>("range_max", 5.0);
    max_depth_age_ = declare_parameter<double>("max_depth_age", 0.4);
    transform_tolerance_ = declare_parameter<double>("transform_tolerance", 0.2);
    lidar_trust_margin_ = declare_parameter<double>("lidar_trust_margin", 0.0);

    param_fx_ = declare_parameter<double>("fx", 0.0);
    param_fy_ = declare_parameter<double>("fy", 0.0);
    param_cx_ = declare_parameter<double>("cx", 0.0);
    param_cy_ = declare_parameter<double>("cy", 0.0);
    hfov_ = deg2rad(declare_parameter<double>("hfov_deg", 73.0));
    vfov_ = deg2rad(declare_parameter<double>("vfov_deg", 58.0));

    // --- ground (floor) detection ---
    ground_estimation_ = declare_parameter<bool>("ground_estimation", true);
    ground_row_margin_ = declare_parameter<int>("ground_row_margin", 10);
    ground_max_range_ = declare_parameter<double>("ground_max_range", 4.0);
    ground_min_row_px_ = declare_parameter<int>("ground_min_row_px", 40);
    ground_min_rows_ = declare_parameter<int>("ground_min_rows", 20);
    ground_ema_ = declare_parameter<double>("ground_ema", 0.3);
    ground_fail_max_ = declare_parameter<int>("ground_fail_max", 15);
    ground_h_lo_ = declare_parameter<double>("ground_h_lo", 0.10);
    ground_h_hi_ = declare_parameter<double>("ground_h_hi", 0.45);

    // --- drops (negative obstacles) ---
    drop_detection_ = declare_parameter<bool>("drop_detection", true);
    drop_max_depth_ = declare_parameter<double>("drop_max_depth", 0.50);
    drop_check_range_ = declare_parameter<double>("drop_check_range", 3.0);
    drop_floor_tol_abs_ = declare_parameter<double>("drop_floor_tol_abs", 0.10);
    drop_floor_tol_rel_ = declare_parameter<double>("drop_floor_tol_rel", 0.08);
    drop_gap_ = declare_parameter<double>("drop_gap", 0.20);
    drop_min_missing_rows_ = declare_parameter<int>("drop_min_missing_rows", 5);

    if (shared_buffer) {
      tf_buffer_ = shared_buffer;   // container owns the single TransformListener
    } else {
      tf_buffer_ = std::make_shared<tf2_ros::Buffer>(get_clock());
      tf_listener_ = std::make_shared<tf2_ros::TransformListener>(*tf_buffer_);
    }

    auto qos = rclcpp::SensorDataQoS();
    scan_pub_ = create_publisher<sensor_msgs::msg::LaserScan>(scan_out_, qos);
    if (!debug_depth_scan_topic_.empty()) {
      dbg_pub_ = create_publisher<sensor_msgs::msg::LaserScan>(debug_depth_scan_topic_, qos);
    }

    info_sub_ = create_subscription<sensor_msgs::msg::CameraInfo>(
      camera_info_topic_, qos,
      std::bind(&DepthLidarFusion::infoCb, this, std::placeholders::_1));
    depth_sub_ = create_subscription<sensor_msgs::msg::Image>(
      depth_image_topic_, qos,
      std::bind(&DepthLidarFusion::depthCb, this, std::placeholders::_1));
    scan_sub_ = create_subscription<sensor_msgs::msg::LaserScan>(
      scan_in_, qos,
      std::bind(&DepthLidarFusion::scanCb, this, std::placeholders::_1));

    RCLCPP_INFO(
      get_logger(),
      "depth_lidar_fusion (C++) up. depth='%s' + lidar='%s' -> fused '%s'. "
      "height band [%.2f,%.2f] m, range [%.2f,%.2f] m.",
      depth_image_topic_.c_str(), scan_in_.c_str(), scan_out_.c_str(),
      min_h_, max_h_, range_min_, range_max_);
  }

private:
  static double deg2rad(double d) {return d * M_PI / 180.0;}

  // ------------------------------------------------------------------ info
  void infoCb(const sensor_msgs::msg::CameraInfo::SharedPtr msg)
  {
    const auto & k = msg->k;  // row-major 3x3
    if (k[0] > 0.0 && k[4] > 0.0) {
      ci_w_ = static_cast<int>(msg->width);
      ci_h_ = static_cast<int>(msg->height);
      ci_fx_ = k[0]; ci_fy_ = k[4]; ci_cx_ = k[2]; ci_cy_ = k[5];
      have_ci_ = true;
    }
  }

  // Pick intrinsics for a w x h depth image (priority: params > matching
  // camera_info > FOV pinhole). Mirrors _resolve_intrinsics.
  void resolveIntrinsics(int w, int h, double & fx, double & fy, double & cx, double & cy)
  {
    std::string src;
    if (param_fx_ > 0.0 && param_fy_ > 0.0) {
      src = "params";
      fx = param_fx_; fy = param_fy_; cx = param_cx_; cy = param_cy_;
    } else if (have_ci_ && ci_w_ == w && ci_h_ == h) {
      src = "camera_info";
      fx = ci_fx_; fy = ci_fy_; cx = ci_cx_; cy = ci_cy_;
    } else {
      src = "fov";
      cx = w / 2.0; cy = h / 2.0;
      fx = (w / 2.0) / std::tan(hfov_ / 2.0);
      fy = (h / 2.0) / std::tan(vfov_ / 2.0);
    }
    if (intr_src_ != src) {
      RCLCPP_INFO(
        get_logger(), "intrinsics source=%s: fx=%.1f fy=%.1f cx=%.1f cy=%.1f for depth %dx%d.",
        src.c_str(), fx, fy, cx, cy, w, h);
      if (src == "fov" && have_ci_) {
        RCLCPP_WARN(
          get_logger(), "camera_info %dx%d != depth %dx%d; using FOV model (hfov=%.0f vfov=%.0f deg).",
          ci_w_, ci_h_, w, h, hfov_ * 180.0 / M_PI, vfov_ * 180.0 / M_PI);
      }
      intr_src_ = src;
    }
  }

  // ---------------------------------------------------------------- ground
  // Estimate the floor line v = A*(1/z) + B from this frame (A = h_cam*fy,
  // B ~= cy). Per-row median inverse depth -> robust line -> EMA -> coast ->
  // assumed-model fallback. Mirrors _ground_plane. z is row-major h*w (metres).
  void groundPlane(const std::vector<float> & z, int h, int w, double fy, double cy,
    double & outA, double & outB)
  {
    const double A0 = camera_height_ * fy;
    const double B0 = cy;
    if (!ground_estimation_) {
      outA = A0; outB = B0;
      return;
    }
    const int rows = h;
    int v0 = static_cast<int>(cy) + ground_row_margin_;
    v0 = std::max(0, std::min(v0, rows - 2));

    // candidate rows: >= ground_min_row_px valid pixels in [range_min, ground_max_range)
    std::vector<int> idx;          // absolute row indices (v0..rows-1)
    std::vector<double> xx;        // per-row median(1/z)
    for (int v = v0; v < rows; ++v) {
      const float * row = &z[static_cast<size_t>(v) * w];
      std::vector<double> inv;
      inv.reserve(w);
      for (int u = 0; u < w; ++u) {
        const float zz = row[u];
        if (zz > range_min_ && zz < ground_max_range_) {
          inv.push_back(static_cast<double>(1.0f / zz));  // float32 reciprocal (numpy)
        }
      }
      if (static_cast<int>(inv.size()) >= ground_min_row_px_) {
        double m = median_inplace(inv);
        m = static_cast<double>(static_cast<float>(m));   // float32 median (numpy nanmedian)
        if (std::isfinite(m)) {
          idx.push_back(v);
          xx.push_back(m);
        }
      }
    }

    bool good = false;
    LineFit lf;
    if (static_cast<int>(idx.size()) >= ground_min_rows_) {
      std::vector<double> yy(idx.size());
      for (size_t i = 0; i < idx.size(); ++i) {
        yy[i] = static_cast<double>(idx[i]);
      }
      lf = robust_line(xx, yy);
      good = lf.ok &&
        (lf.ninl >= ground_min_rows_ * 0.5) &&   // float threshold, matches Python (no int trunc)
        (ground_h_lo_ * fy < lf.A) && (lf.A < ground_h_hi_ * fy);
    }

    if (good) {
      if (!have_ground_) {
        ground_A_ = lf.A; ground_B_ = lf.B; have_ground_ = true;
      } else {
        const double a = ground_ema_;
        ground_A_ = (1.0 - a) * ground_A_ + a * lf.A;
        ground_B_ = (1.0 - a) * ground_B_ + a * lf.B;
      }
      ground_fail_ = 0;
      if (ground_src_ != "fit") {
        RCLCPP_INFO(
          get_logger(), "ground: data-driven fit ON (h_cam~%.3f m, B~%.0f px)",
          ground_A_ / fy, ground_B_);
        ground_src_ = "fit";
      }
      outA = ground_A_; outB = ground_B_;
      return;
    }
    // fit failed this frame: coast on last good, else fall back to assumed model
    ++ground_fail_;
    if (have_ground_ && ground_fail_ <= ground_fail_max_) {
      outA = ground_A_; outB = ground_B_;
      return;
    }
    if (ground_src_ != "assumed") {
      RCLCPP_WARN(
        get_logger(), "ground: floor not reliably visible -> assumed model (h_cam=%.3f, cy=%.0f)",
        camera_height_, cy);
      ground_src_ = "assumed";
    }
    outA = A0; outB = B0;
  }

  // Detect ledge/stair edges where the expected floor returns nothing. Appends
  // (u,v,z) edge points to the out vectors. Mirrors _drop_edges. `valid` is the
  // per-pixel (z>range_min && z<range_max) mask, row-major h*w.
  void dropEdges(const std::vector<float> & z, const std::vector<uint8_t> & valid,
    int h, int w, double A, double B,
    std::vector<float> & out_u, std::vector<float> & out_v, std::vector<float> & out_z)
  {
    std::vector<uint8_t> seen(w, 0), done(w, 0);
    std::vector<int> miss(w, 0), lastv(w, -1), edge(w, -1);
    const double gap = drop_gap_;
    for (int v = h - 1; v >= 1; --v) {
      const double denom = static_cast<double>(v) - B;
      if (denom <= 1.0) {       // at/above the floor horizon
        break;
      }
      const double zexp = A / denom;
      if (zexp <= range_min_) {
        continue;
      }
      if (zexp >= drop_check_range_) {  // past the drop horizon (only farther up)
        break;
      }
      const double tol = drop_floor_tol_abs_ + drop_floor_tol_rel_ * zexp;
      // float32 thresholds mirroring numpy's NEP weak promotion: array-scalar
      // (row-zexp, <=tol) narrows the scalar first; scalar-scalar (zexp-tol,
      // zexp+tol+gap) computes in float64 then narrows to float32.
      const float zexpf = static_cast<float>(zexp);
      const float tolf = static_cast<float>(tol);
      const float nearer_thr = static_cast<float>(zexp - tol);
      const float missing_thr = static_cast<float>(zexp + tol + gap);
      const float * row = &z[static_cast<size_t>(v) * w];
      const uint8_t * vrow = &valid[static_cast<size_t>(v) * w];
      for (int u = 0; u < w; ++u) {
        if (done[u]) {
          continue;
        }
        const bool vok = vrow[u] != 0;
        const float rv = row[u];
        const bool present = vok && (std::abs(rv - zexpf) <= tolf);
        const bool nearer = vok && (rv < nearer_thr);
        const bool missing = (!vok) || (vok && (rv > missing_thr));
        if (nearer) {           // occluder in front of floor ends the search
          done[u] = 1;
          continue;
        }
        // active (== !done) is implied here
        if (present) {
          miss[u] = 0;
          lastv[u] = v;
          seen[u] = 1;
        } else if (missing && seen[u]) {
          ++miss[u];
          if (miss[u] >= drop_min_missing_rows_ && lastv[u] >= 0) {
            edge[u] = lastv[u];
            done[u] = 1;
          }
        }
      }
    }
    for (int u = 0; u < w; ++u) {
      if (edge[u] >= 0) {
        const double dv = static_cast<double>(edge[u]);
        const double dz = A / (dv - B);
        out_u.push_back(static_cast<float>(u));
        out_v.push_back(static_cast<float>(dv));
        out_z.push_back(static_cast<float>(dz));
      }
    }
  }

  // ---------------------------------------------------------------- extrinsics
  bool ensureExtrinsics()
  {
    if (have_extr_) {
      return true;
    }
    if (optical_frame_.empty() || scan_frame_.empty()) {
      return false;
    }
    geometry_msgs::msg::TransformStamped tf;
    try {
      tf = tf_buffer_->lookupTransform(
        scan_frame_, optical_frame_, tf2::TimePointZero,
        tf2::durationFromSec(transform_tolerance_));
    } catch (const tf2::TransformException & e) {
      if (!warned_no_tf_) {
        RCLCPP_WARN(get_logger(), "waiting for TF %s<-%s: %s",
          scan_frame_.c_str(), optical_frame_.c_str(), e.what());
        warned_no_tf_ = true;
      }
      return false;
    }
    const auto & q = tf.transform.rotation;
    const double x = q.x, y = q.y, zq = q.z, w = q.w;
    R_[0][0] = 1 - 2 * (y * y + zq * zq); R_[0][1] = 2 * (x * y - zq * w);     R_[0][2] = 2 * (x * zq + y * w);
    R_[1][0] = 2 * (x * y + zq * w);      R_[1][1] = 1 - 2 * (x * x + zq * zq); R_[1][2] = 2 * (y * zq - x * w);
    R_[2][0] = 2 * (x * zq - y * w);      R_[2][1] = 2 * (y * zq + x * w);      R_[2][2] = 1 - 2 * (x * x + y * y);
    t_[0] = tf.transform.translation.x;
    t_[1] = tf.transform.translation.y;
    t_[2] = tf.transform.translation.z;
    have_extr_ = true;
    RCLCPP_INFO(get_logger(), "extrinsics %s<-%s cached (t=[%.3f,%.3f,%.3f]).",
      scan_frame_.c_str(), optical_frame_.c_str(), t_[0], t_[1], t_[2]);
    return true;
  }

  // ----------------------------------------------------------------- depth
  void depthCb(const sensor_msgs::msg::Image::SharedPtr msg)
  {
    optical_frame_ = msg->header.frame_id;
    if (!ensureExtrinsics()) {
      return;
    }
    const int w = static_cast<int>(msg->width);
    const int h = static_cast<int>(msg->height);
    if (w <= 0 || h <= 0) {
      return;
    }
    double fx, fy, cx, cy;
    resolveIntrinsics(w, h, fx, fy, cx, cy);

    // 16UC1 millimetres -> metres. Row stride = msg->step bytes; take first w cols.
    const size_t step = msg->step;
    std::vector<float> z(static_cast<size_t>(h) * w);
    const uint8_t * data = msg->data.data();
    const bool swap = msg->is_bigendian != 0;
    for (int v = 0; v < h; ++v) {
      const uint8_t * rp = data + static_cast<size_t>(v) * step;
      float * zr = &z[static_cast<size_t>(v) * w];
      for (int u = 0; u < w; ++u) {
        uint16_t mm = static_cast<uint16_t>(rp[2 * u]) |
          (static_cast<uint16_t>(rp[2 * u + 1]) << 8);
        if (swap) {
          mm = static_cast<uint16_t>((mm >> 8) | (mm << 8));
        }
        zr[u] = mm * 0.001f;
      }
    }

    double A, B;
    groundPlane(z, h, w, fy, cy, A, B);

    // height above the FITTED floor = (A + (B - v)*z)/fy
    // keep/valid masks; per-column vertical collapse (nearest kept pixel).
    // float32 band constants (mirror numpy's float32 height arithmetic)
    const float Af = static_cast<float>(A), Bf = static_cast<float>(B);
    const float fyf = static_cast<float>(fy);
    const float minhf = static_cast<float>(min_h_), maxhf = static_cast<float>(max_h_);
    const float negdropf = static_cast<float>(drop_max_depth_);
    const float rminf = static_cast<float>(range_min_), rmaxf = static_cast<float>(range_max_);
    std::vector<uint8_t> valid(static_cast<size_t>(h) * w, 0);
    std::vector<float> col_min(w, kInf);
    std::vector<int> col_row(w, -1);
    for (int v = 0; v < h; ++v) {
      const float * zr = &z[static_cast<size_t>(v) * w];
      uint8_t * vr = &valid[static_cast<size_t>(v) * w];
      const float vf = static_cast<float>(v);
      for (int u = 0; u < w; ++u) {
        const float zz = zr[u];
        const bool vv = (zz > rminf) && (zz < rmaxf);   // float32 bounds (numpy parity)
        vr[u] = vv ? 1 : 0;
        // height above the fitted floor, in float32 to match numpy: (A+(B-v)*z)/fy
        const float height = ((Bf - vf) * zz + Af) / fyf;
        const bool pos = (height > minhf) && (height < maxhf);
        bool keep;
        if (drop_detection_) {
          const bool neg = (height < -minhf) && (height > -negdropf);
          keep = vv && (pos || neg);
        } else {
          keep = vv && pos;
        }
        if (keep && zz < col_min[u]) {   // strict < => first row wins ties (argmin)
          col_min[u] = zz;
          col_row[u] = v;
        }
      }
    }

    // surviving collapse points
    std::vector<float> uc, vc, zc;
    uc.reserve(w);
    vc.reserve(w);
    zc.reserve(w);
    for (int u = 0; u < w; ++u) {
      if (std::isfinite(col_min[u]) && col_row[u] >= 0) {
        uc.push_back(static_cast<float>(u));
        vc.push_back(static_cast<float>(col_row[u]));
        zc.push_back(col_min[u]);
      }
    }

    // drops: append the near edges of ledges
    if (drop_detection_) {
      dropEdges(z, valid, h, w, A, B, uc, vc, zc);
    }

    if (uc.empty()) {
      have_depth_ = false;
      return;
    }

    // back-project to optical frame, then static extrinsic into the lidar frame
    // (only x,y matter for a planar scan); store range/bearing of each point.
    const float cxf = static_cast<float>(cx), cyf = static_cast<float>(cy);
    const float fxf = static_cast<float>(fx);   // fyf already in scope from the collapse loop
    std::vector<float> rng(uc.size()), brg(uc.size());
    for (size_t i = 0; i < uc.size(); ++i) {
      // float32 throughout to mirror numpy (R_/t_ are float; zc/uc/vc float)
      const float zi = zc[i];
      const float xo = (uc[i] - cxf) * zi / fxf;
      const float yo = (vc[i] - cyf) * zi / fyf;
      const float xl = R_[0][0] * xo + R_[0][1] * yo + R_[0][2] * zi + t_[0];
      const float yl = R_[1][0] * xo + R_[1][1] * yo + R_[1][2] * zi + t_[1];
      rng[i] = std::hypot(xl, yl);
      brg[i] = std::atan2(yl, xl);
    }
    depth_rng_ = std::move(rng);
    depth_brg_ = std::move(brg);
    depth_stamp_ = rclcpp::Time(msg->header.stamp);
    have_depth_ = true;
  }

  // ------------------------------------------------------------------ scan
  void scanCb(const sensor_msgs::msg::LaserScan::SharedPtr msg)
  {
    scan_frame_ = msg->header.frame_id;
    const size_t n = msg->ranges.size();
    std::vector<float> fused(msg->ranges.begin(), msg->ranges.end());

    std::vector<float> dmin;
    const bool have = depthProfile(*msg, n, dmin);
    if (have) {
      for (size_t i = 0; i < n; ++i) {
        float lid = fused[i];
        if (!std::isfinite(lid) || lid <= msg->range_min) {
          lid = kInf;   // lidar no-return -> empty beam
        }
        // depth overrides only when nearer than the lidar (by >= margin) or empty beam
        if (dmin[i] < lid - static_cast<float>(lidar_trust_margin_)) {
          fused[i] = dmin[i];
        }
      }
      if (dbg_pub_) {
        publishLike(*msg, dmin, dbg_pub_);
      }
    }
    publishLike(*msg, fused, scan_pub_);
  }

  // Bin the cached collapsed depth onto this scan's beam grid (min per beam).
  // Returns false (and leaves dmin untouched) if no fresh, in-band depth.
  bool depthProfile(const sensor_msgs::msg::LaserScan & scan, size_t n,
    std::vector<float> & dmin)
  {
    if (!have_depth_) {
      return false;
    }
    const double age =
      (rclcpp::Time(scan.header.stamp) - depth_stamp_).seconds();
    if (std::abs(age) > max_depth_age_) {
      return false;
    }
    const float amin = scan.angle_min, amax = scan.angle_max;
    const float rmin = scan.range_min, rmax = scan.range_max;
    const float ainc = scan.angle_increment;
    std::vector<float> out(n, kInf);
    bool any = false;
    for (size_t i = 0; i < depth_brg_.size(); ++i) {
      const float b = depth_brg_[i];
      const float r = depth_rng_[i];
      if (b >= amin && b <= amax && r >= rmin && r <= rmax) {
        // np.round = round-half-to-even; std::lrint matches (default FE_TONEAREST)
        long idx = std::lrint((b - amin) / ainc);
        if (idx < 0) {
          idx = 0;
        } else if (idx > static_cast<long>(n) - 1) {
          idx = static_cast<long>(n) - 1;
        }
        if (r < out[idx]) {
          out[idx] = r;
        }
        any = true;
      }
    }
    if (!any) {
      return false;
    }
    dmin = std::move(out);
    return true;
  }

  void publishLike(const sensor_msgs::msg::LaserScan & src,
    const std::vector<float> & ranges,
    const rclcpp::Publisher<sensor_msgs::msg::LaserScan>::SharedPtr & pub)
  {
    auto out = sensor_msgs::msg::LaserScan();
    out.header = src.header;
    out.angle_min = src.angle_min;
    out.angle_max = src.angle_max;
    out.angle_increment = src.angle_increment;
    out.time_increment = src.time_increment;
    out.scan_time = src.scan_time;
    out.range_min = src.range_min;
    out.range_max = src.range_max;
    out.ranges = ranges;
    pub->publish(out);
  }

  // --- params ---
  std::string depth_image_topic_, camera_info_topic_, scan_in_, scan_out_, debug_depth_scan_topic_;
  double camera_height_, min_h_, max_h_, range_min_, range_max_, max_depth_age_, transform_tolerance_, lidar_trust_margin_;
  double param_fx_, param_fy_, param_cx_, param_cy_, hfov_, vfov_;
  bool ground_estimation_;
  int ground_row_margin_, ground_min_row_px_, ground_min_rows_, ground_fail_max_;
  double ground_max_range_, ground_ema_, ground_h_lo_, ground_h_hi_;
  bool drop_detection_;
  double drop_max_depth_, drop_check_range_, drop_floor_tol_abs_, drop_floor_tol_rel_, drop_gap_;
  int drop_min_missing_rows_;

  // --- intrinsics (from camera_info) ---
  bool have_ci_ = false;
  int ci_w_ = 0, ci_h_ = 0;
  double ci_fx_ = 0, ci_fy_ = 0, ci_cx_ = 0, ci_cy_ = 0;
  std::string intr_src_;

  // --- ground state ---
  bool have_ground_ = false;
  double ground_A_ = 0, ground_B_ = 0;
  int ground_fail_ = 0;
  std::string ground_src_;

  // --- extrinsics ---
  bool have_extr_ = false;
  float R_[3][3] = {{0}};   // float32 to mirror numpy's np.float32 _R/_t
  float t_[3] = {0, 0, 0};
  std::string optical_frame_, scan_frame_;
  bool warned_no_tf_ = false;

  // --- cached depth collapse ---
  std::vector<float> depth_rng_, depth_brg_;
  bool have_depth_ = false;
  rclcpp::Time depth_stamp_{0, 0, RCL_ROS_TIME};

  std::shared_ptr<tf2_ros::Buffer> tf_buffer_;   // shared in the component container
  std::shared_ptr<tf2_ros::TransformListener> tf_listener_;
  rclcpp::Publisher<sensor_msgs::msg::LaserScan>::SharedPtr scan_pub_, dbg_pub_;
  rclcpp::Subscription<sensor_msgs::msg::CameraInfo>::SharedPtr info_sub_;
  rclcpp::Subscription<sensor_msgs::msg::Image>::SharedPtr depth_sub_;
  rclcpp::Subscription<sensor_msgs::msg::LaserScan>::SharedPtr scan_sub_;
};

#ifndef GUIDE_MATE_CONTAINER
int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<DepthLidarFusion>());
  rclcpp::shutdown();
  return 0;
}
#endif
