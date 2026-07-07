"""Named choreography primitives -> time-bounded twist sequences. Hard-capped."""
from __future__ import annotations

import math
from dataclasses import dataclass

from .messages import Command

MAX_LINEAR = 0.15    # m/s
MAX_ANGULAR = 1.5    # rad/s
MAX_TOTAL_S = 30.0   # s total per primitive

# Max radius for the "circle" primitive that still completes a full loop
# (2*pi*radius / vx) within MAX_TOTAL_S at vx=0.12 m/s. Above this radius
# _cap_total() would silently truncate the sequence mid-arc, leaving a
# partial arc instead of a closed circle. 30 * 0.12 / (2*pi) ~= 0.573,
# rounded down so the cap in _cap_total() stays authoritative (never binds).
CIRCLE_MAX_RADIUS = 0.57


@dataclass(frozen=True)
class TwistStep:
    vx: float
    wz: float
    duration: float


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _step(vx: float, wz: float, duration: float) -> TwistStep:
    """Every generator output flows through here — the single caps enforcer."""
    return TwistStep(
        vx=_clamp(vx, -MAX_LINEAR, MAX_LINEAR),
        wz=_clamp(wz, -MAX_ANGULAR, MAX_ANGULAR),
        duration=max(0.0, duration),
    )


def _cap_total(steps: list[TwistStep]) -> list[TwistStep]:
    """Defence in depth: truncate durations so the sequence never exceeds MAX_TOTAL_S."""
    total = 0.0
    out: list[TwistStep] = []
    for s in steps:
        if total >= MAX_TOTAL_S:
            break
        dur = min(s.duration, MAX_TOTAL_S - total)
        out.append(TwistStep(s.vx, s.wz, dur))
        total += dur
    return out


def _yes() -> list[TwistStep]:
    # forward/back nod x2, net displacement ~0
    steps: list[TwistStep] = []
    for _ in range(2):
        steps.append(_step(0.08, 0.0, 0.5))
        steps.append(_step(-0.08, 0.0, 0.5))
    return steps


def _no() -> list[TwistStep]:
    # rotate CW/CCW returning to start; net yaw 0
    return [
        _step(0.0, 0.9, 0.5),
        _step(0.0, -0.9, 1.0),
        _step(0.0, 0.9, 0.5),
    ]


def _happy() -> list[TwistStep]:
    # wiggle: alternate wz +/-1.2 @ 0.4 s with small vx 0.05, 3 cycles
    steps: list[TwistStep] = []
    for _ in range(3):
        steps.append(_step(0.05, 1.2, 0.4))
        steps.append(_step(0.05, -1.2, 0.4))
    return steps


def _circle(params: dict) -> list[TwistStep]:
    radius = _clamp(float(params.get("radius", 0.5)), 0.2, CIRCLE_MAX_RADIUS)
    vx = 0.12
    wz = vx / radius
    duration = 2 * math.pi / wz
    return [_step(vx, wz, duration)]


def _spin() -> list[TwistStep]:
    wz = 0.9
    return [_step(0.0, wz, 2 * math.pi / wz)]


def _forward(params: dict) -> list[TwistStep]:
    # Straight-ahead nudge: a short, bounded translation with no rotation.
    # Defaults to ~0.2 m (0.1 m/s for 2 s); both are hard-capped by _step/_cap_total.
    vx = _clamp(float(params.get("speed", 0.1)), 0.0, MAX_LINEAR)
    duration = _clamp(float(params.get("duration", 2.0)), 0.0, MAX_TOTAL_S)
    return [_step(vx, 0.0, duration)]


def build(command: Command, max_speed: float = MAX_LINEAR) -> list[TwistStep]:
    key = (command.type, command.name)
    if key == ("emote", "yes"):
        steps = _yes()
    elif key == ("emote", "no"):
        steps = _no()
    elif key == ("emote", "happy"):
        steps = _happy()
    elif key == ("motion", "circle"):
        steps = _circle(command.params)
    elif key == ("motion", "spin"):
        steps = _spin()
    elif key == ("motion", "forward"):
        steps = _forward(command.params)
    elif key == ("stop", "stop"):
        return [TwistStep(0.0, 0.0, 0.0)]
    else:
        raise ValueError(
            f"unknown choreography for type={command.type!r} name={command.name!r}"
        )
    # Optional per-call speed override (defaults to MAX_LINEAR -> no-op for primitives).
    steps = [
        TwistStep(_clamp(s.vx, -max_speed, max_speed), s.wz, s.duration) for s in steps
    ]
    return _cap_total(steps)
