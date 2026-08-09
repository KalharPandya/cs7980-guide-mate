"""The rclpy double-init race (Context.init() must only be called once).

telemetry's daemon thread and the armed-mode motion-sink builder both need the
global rclpy context; whoever loses the race used to throw and (worst case)
silently kill the telemetry thread -> docked=None forever, dock-guard
default-denies, action results lost. ensure_rclpy_init must be safe under
concurrency: exactly one real init, no exceptions.
"""
import sys
import threading
import types


def _fake_rclpy():
    fake = types.ModuleType("rclpy")
    fake.calls = []
    fake._ok = False

    def ok():
        return fake._ok

    def init(args=None):
        # Mirrors real rclpy: second init raises.
        if fake._ok:
            raise RuntimeError("Context.init() must only be called once")
        fake.calls.append("init")
        fake._ok = True

    fake.ok = ok
    fake.init = init
    return fake


def test_concurrent_ensure_init_initializes_exactly_once():
    fake = _fake_rclpy()
    sys.modules["rclpy"] = fake
    try:
        import importlib
        from guide_mate_bridge import ros_init
        importlib.reload(ros_init)

        errors = []

        def worker():
            try:
                ros_init.ensure_rclpy_init()
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads: t.start()
        for t in threads: t.join()

        assert errors == []            # nobody lost a race
        assert fake.calls == ["init"]  # exactly one real init
    finally:
        del sys.modules["rclpy"]
