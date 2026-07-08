import math
import os

import matplotlib
matplotlib.use("Agg")  # headless
import matplotlib.pyplot as plt  # noqa: E402
import pytest  # noqa: E402

from guidemate_msgs.choreography import (  # noqa: E402
    MAX_ANGULAR,
    MAX_LINEAR,
    MAX_TOTAL_S,
    TwistStep,
    build,
)
from guidemate_msgs.messages import Command  # noqa: E402

ARTIFACT_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
PRIMITIVES = {
    "happy": Command(type="emote", name="happy"),
    "yes": Command(type="emote", name="yes"),
    "no": Command(type="emote", name="no"),
    "circle": Command(type="motion", name="circle"),
    "spin": Command(type="motion", name="spin"),
    "stop": Command(type="stop", name="stop"),
}


def simulate(steps, dt=0.01):
    """Unicycle-model integrator -> (x, y, theta, points)."""
    x = y = theta = 0.0
    points = [(x, y)]
    for step in steps:
        n = int(round(step.duration / dt))
        for _ in range(n):
            x += step.vx * math.cos(theta) * dt
            y += step.vx * math.sin(theta) * dt
            theta += step.wz * dt
            points.append((x, y))
    return x, y, theta, points


def test_unknown_command_raises():
    class Fake:
        type = "emote"
        name = "moonwalk"
    with pytest.raises(ValueError):
        build(Fake())


def test_all_steps_within_caps_and_total_bounded():
    for cmd in PRIMITIVES.values():
        steps = build(cmd)
        total = sum(s.duration for s in steps)
        assert total <= MAX_TOTAL_S + 1e-9, cmd.name
        for s in steps:
            assert abs(s.vx) <= MAX_LINEAR + 1e-9, cmd.name
            assert abs(s.wz) <= MAX_ANGULAR + 1e-9, cmd.name
            assert s.duration >= 0.0, cmd.name


def test_stop_is_sentinel():
    assert build(PRIMITIVES["stop"]) == [TwistStep(0.0, 0.0, 0.0)]


def test_circle_closes_with_full_turn():
    x, y, theta, _ = simulate(build(PRIMITIVES["circle"]))
    assert math.hypot(x, y) < 0.05
    assert abs(abs(theta) - 2 * math.pi) < 0.1


@pytest.mark.parametrize("radius_param", [0.05, 0.57, 2.0])
def test_circle_closes_at_radius_clamp_boundaries(radius_param):
    cmd = Command(type="motion", name="circle", params={"radius": radius_param})
    steps = build(cmd)
    total = sum(s.duration for s in steps)
    assert total <= MAX_TOTAL_S + 1e-9
    x, y, theta, _ = simulate(steps)
    assert math.hypot(x, y) < 0.05
    assert abs(abs(theta) - 2 * math.pi) < 0.1


def test_circle_honors_tight_radius_0_1():
    # A 0.1 m radius must be honored (not floored): wz = vx/radius = 0.12/0.1 = 1.2,
    # which is within MAX_ANGULAR (1.5), and the loop still closes.
    steps = build(Command(type="motion", name="circle", params={"radius": 0.1}))
    assert len(steps) == 1
    assert abs(steps[0].wz - 1.2) < 1e-6           # radius respected, not clamped to 0.2
    assert abs(steps[0].wz) <= MAX_ANGULAR + 1e-9
    x, y, theta, _ = simulate(steps)
    assert math.hypot(x, y) < 0.05                 # returns to start
    assert abs(abs(theta) - 2 * math.pi) < 0.1     # full turn


def test_spin_no_displacement_full_turn():
    x, y, theta, _ = simulate(build(PRIMITIVES["spin"]))
    assert math.hypot(x, y) < 0.02
    assert abs(abs(theta) - 2 * math.pi) < 0.05


def test_no_returns_to_start_yaw():
    _, _, theta, _ = simulate(build(PRIMITIVES["no"]))
    assert abs(theta) < 0.02


def test_circle_turns_param_multiplies_revolutions():
    # turns=2 at r=0.1 -> theta ~= 4*pi, still closes, still under the time cap.
    steps = build(Command(type="motion", name="circle",
                          params={"radius": 0.1, "turns": 2.0}))
    total = sum(s.duration for s in steps)
    assert total <= MAX_TOTAL_S + 1e-9
    x, y, theta, _ = simulate(steps)
    assert math.hypot(x, y) < 0.05
    assert abs(abs(theta) - 4 * math.pi) < 0.1


def test_happy_returns_to_start():
    # The wiggle used to creep ~0.12 m forward and stay there; it must end where
    # it began (each +vx/+wz step is time-reversed by a -vx/-wz step).
    x, y, theta, _ = simulate(build(PRIMITIVES["happy"]))
    assert math.hypot(x, y) < 0.02
    assert abs(theta) < 0.05


def test_yes_small_net_displacement():
    x, y, _, _ = simulate(build(PRIMITIVES["yes"]))
    assert math.hypot(x, y) < 0.02


def test_renders_all_primitive_paths_to_png():
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    for name, cmd in PRIMITIVES.items():
        _, _, _, points = simulate(build(cmd))
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        fig, ax = plt.subplots()
        ax.plot(xs, ys, marker=".", markersize=1)
        ax.set_aspect("equal", "datalim")
        ax.set_title(name)
        path = os.path.join(ARTIFACT_DIR, f"{name}.png")
        fig.savefig(path)
        plt.close(fig)
        assert os.path.exists(path) and os.path.getsize(path) > 0
