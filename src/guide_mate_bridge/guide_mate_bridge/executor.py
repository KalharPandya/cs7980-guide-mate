"""Choreography executor.

Two construction styles are supported, chosen by whether a ``SafetyState`` is
passed:

* **Phase-2 legacy path** (``safety=<SafetyState>``): the gate truth lives in the
  SafetyState; every ack carries the ``gates`` snapshot + ``simulated``. Dry-run
  logs the would-be twists and never publishes. This is what ``bridge.py`` wires
  today and it is preserved byte-for-byte.
* **Phase-8 real-drive path** (``dry_run=<bool>`` + ``motion_gate`` + ``run_action``,
  no SafetyState): the ONLY real cmd_vel drive path — a fixed-rate, abort-aware
  loop — plus dock/undock dispatched as Create 3 ROS ACTIONS via ``run_action``
  (never twists), and a command-aware motion gate (the dock-guard exemption matrix
  lives upstream in ``bridge.command_permitted``: while docked only undock/dock/stop
  pass). Task 4 rewires ``bridge.py`` onto this path.

A shared ``threading.Event`` lets a ``stop`` command or a shadow kill-switch
interrupt an in-flight choreography between publishes and zero the wheels within
one publish period.

SAFETY: dry-run (effective) NEVER publishes a twist and NEVER runs a real action.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Optional, Tuple

from guidemate_msgs.choreography import TwistStep, build
from guidemate_msgs.jsonlog import log_extra
from guidemate_msgs.messages import Ack, Command

from guide_mate_bridge.safety import SafetyState

log = logging.getLogger(__name__)

_ZERO = TwistStep(0.0, 0.0, 0.0)
_ACTION_NAMES = ("undock", "dock")   # Create 3 ROS actions, never twist choreographies


def _is_action(cmd: Command) -> bool:
    return cmd.type == "motion" and cmd.name in _ACTION_NAMES


class ChoreographyRunner:
    def __init__(
        self,
        publish_ack: Callable[[Ack], None],
        safety: Optional[SafetyState] = None,
        dry_run: bool = True,
        publish_twist: Optional[Callable[[TwistStep], None]] = None,
        publish_hz: float = 10.0,
        sleep: Callable[[float], None] = time.sleep,
        motion_gate: Optional[Callable[[Command], "Tuple[bool, str]"]] = None,
        run_action: Optional[Callable[[str], "Tuple[bool, str]"]] = None,
    ) -> None:
        self._publish_ack = publish_ack
        self._safety = safety
        self._dry_run = dry_run
        self._publish_twist = publish_twist
        self._publish_hz = publish_hz
        self._sleep = sleep
        self._motion_gate = motion_gate
        self._run_action = run_action
        self._abort = threading.Event()
        self._abort_reason = "aborted"

    # ---- kill-switch -------------------------------------------------------
    def abort(self, reason: str = "aborted") -> None:
        """Interrupt an in-flight choreography (thread-safe: stop path + shadow kill-switch)."""
        self._abort_reason = reason
        self._abort.set()

    def _drive_step(self, step: TwistStep) -> bool:
        """Publish `step` at publish_hz for its duration. Returns False if aborted."""
        period = 1.0 / self._publish_hz
        ticks = max(1, int(round(step.duration * self._publish_hz)))
        for _ in range(ticks):
            if self._abort.is_set():
                return False
            self._publish_twist(step)
            self._sleep(period)
        return True

    # ---- dispatch ----------------------------------------------------------
    def handle(self, cmd: Command) -> None:
        if self._safety is not None:
            self._handle_legacy(cmd)
        else:
            self._handle_realdrive(cmd)

    # ---- Phase-2 legacy path (SafetyState-gated, gates in every ack) -------
    def _handle_legacy(self, cmd: Command) -> None:
        gates = self._safety.gates()
        dry = gates["dry_run"]

        def ack(state: str, reason: Optional[str] = None) -> None:
            # Every ack carries simulated + the gate snapshot (Phase-2 fix: previously
            # only the terminal 'done' ack carried simulated).
            self._publish_ack(
                Ack(cmd_id=cmd.cmd_id, state=state, reason=reason,
                    simulated=dry, gates=gates)
            )

        ack("received")

        if not dry and cmd.type in ("emote", "motion"):
            # Refusal paths (spec checklist item 4). Dock unknown counts as docked
            # (default-deny). "stop" is always accepted, so it skips this block.
            if gates["docked"] is not False:
                ack("failed", reason="docked")
                return
            if not gates["motion_enabled"]:
                ack("failed", reason="motion_disabled")
                return

        try:
            # max_speed is read here, intentionally outside the gates() snapshot above:
            # it's safe at any read time because the shadow can only clamp it monotonically
            # down (never above MAX_LINEAR), so a concurrent update can only make it stricter.
            steps = build(cmd, max_speed=self._safety.max_speed)
        except ValueError as exc:
            ack("failed", reason=str(exc))
            return

        ack("running")
        for step in steps:
            if dry:
                log.info(
                    "DRY-RUN twist vx=%.3f wz=%.3f dur=%.2fs",
                    step.vx,
                    step.wz,
                    step.duration,
                    extra=log_extra(cmd_id=cmd.cmd_id),
                )
                continue
            # Real cmd_vel publishing on this legacy path only fires if a sink was
            # wired; Task 4 migrates bridge.py onto the abort-aware real-drive path.
            if self._publish_twist is not None:
                self._publish_twist(step)
        ack("done")

    # ---- Phase-8 real-drive path (dry_run flag + motion_gate + run_action) --
    def _handle_realdrive(self, cmd: Command) -> None:
        self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="received"))
        is_action = _is_action(cmd)
        steps: Optional[list] = None
        if not is_action:
            try:
                steps = build(cmd)
            except ValueError as exc:
                self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="failed", reason=str(exc)))
                return
        self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="running"))
        # A prior stop/kill only kills the command that was in flight when it fired;
        # every fresh command starts un-aborted.
        self._abort.clear()

        # ---- dry-run path: log, never publish / never act ----
        if self._dry_run:
            if is_action:
                log.info(
                    "DRY-RUN action %s", cmd.name, extra=log_extra(cmd_id=cmd.cmd_id)
                )
            else:
                for step in steps:
                    log.info(
                        "DRY-RUN twist vx=%.3f wz=%.3f dur=%.2fs",
                        step.vx, step.wz, step.duration,
                        extra=log_extra(cmd_id=cmd.cmd_id),
                    )
            self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="done", simulated=True))
            return

        # ---- command-aware gate (shadow lock + dock-guard exemption matrix) ----
        if self._motion_gate is not None:
            permitted, reason = self._motion_gate(cmd)
            if not permitted:
                if self._publish_twist is not None:
                    self._publish_twist(_ZERO)   # safety: make sure the wheels are stopped
                self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="failed", reason=reason))
                return

        # ---- Create 3 ROS action path (undock/dock) — never twists ----
        if is_action:
            if self._run_action is None:
                self._publish_ack(
                    Ack(cmd_id=cmd.cmd_id, state="failed", reason="no action client")
                )
                return
            ok, reason = self._run_action(cmd.name)
            if ok:
                self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="done", simulated=False))
            else:
                self._publish_ack(
                    Ack(
                        cmd_id=cmd.cmd_id,
                        state="failed",
                        reason=reason or f"{cmd.name} action failed",
                    )
                )
            return

        # ---- real cmd_vel path ----
        if self._publish_twist is None:
            self._publish_ack(
                Ack(cmd_id=cmd.cmd_id, state="failed", reason="no cmd_vel sink")
            )
            return

        aborted = False
        for step in steps:
            if not self._drive_step(step):
                aborted = True
                break
        # Always zero the wheels — clean finish OR interrupt.
        self._publish_twist(_ZERO)
        if aborted:
            self._publish_ack(
                Ack(cmd_id=cmd.cmd_id, state="failed", reason=self._abort_reason)
            )
        else:
            self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="done", simulated=False))
