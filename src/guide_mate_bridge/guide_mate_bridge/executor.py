"""Choreography executor — gate-aware. No cmd_vel publisher exists in Phase 2."""
from __future__ import annotations

import logging
from typing import Callable, Optional

from guidemate_msgs.choreography import TwistStep, build
from guidemate_msgs.jsonlog import log_extra
from guidemate_msgs.messages import Ack, Command

from guide_mate_bridge.safety import SafetyState

log = logging.getLogger(__name__)


class ChoreographyRunner:
    def __init__(
        self,
        publish_ack: Callable[[Ack], None],
        safety: SafetyState,
        publish_twist: Optional[Callable[[TwistStep], None]] = None,
    ) -> None:
        self._publish_ack = publish_ack
        self._safety = safety
        self._publish_twist = publish_twist

    def handle(self, cmd: Command) -> None:
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
            # Real cmd_vel publishing arrives in Phase 8 (sim); publish_twist is
            # never wired in this phase — nothing can move.
            if self._publish_twist is not None:
                self._publish_twist(step)
        ack("done")
