"""Choreography executor — dry-run in Phase 1 (never publishes twists)."""
from __future__ import annotations

import logging
from typing import Callable, Optional

from guidemate_msgs.choreography import TwistStep, build
from guidemate_msgs.jsonlog import log_extra
from guidemate_msgs.messages import Ack, Command

log = logging.getLogger(__name__)


class ChoreographyRunner:
    def __init__(
        self,
        publish_ack: Callable[[Ack], None],
        dry_run: bool = True,
        publish_twist: Optional[Callable[[TwistStep], None]] = None,
    ) -> None:
        self._publish_ack = publish_ack
        self._dry_run = dry_run
        self._publish_twist = publish_twist

    def handle(self, cmd: Command) -> None:
        self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="received"))
        try:
            steps = build(cmd)
        except ValueError as exc:
            self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="failed", reason=str(exc)))
            return
        self._publish_ack(Ack(cmd_id=cmd.cmd_id, state="running"))
        for step in steps:
            if self._dry_run:
                log.info(
                    "DRY-RUN twist vx=%.3f wz=%.3f dur=%.2fs",
                    step.vx,
                    step.wz,
                    step.duration,
                    extra=log_extra(cmd_id=cmd.cmd_id),
                )
                continue
            # Real cmd_vel publishing arrives in a later phase; not wired in Phase 1.
            if self._publish_twist is not None:
                self._publish_twist(step)
        self._publish_ack(
            Ack(cmd_id=cmd.cmd_id, state="done", simulated=self._dry_run)
        )
