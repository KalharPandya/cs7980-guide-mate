# 2026-07-08: prod motion end-to-end — findings, fixes, open items

**TL;DR** — Robot 468 now moves from prod chat (echo.kalhar.ca) end-to-end: assignment
undocks + nudges, tricks/stop publish from chat, admin dock waits for its real result.
Root causes found this session: a dropped-command bug family in the WS pipeline (3
instances), a too-short admin ack window, FastDDS restart-order rot (twice), a dock-state
race, and a dock-telemetry blind spot after restarts. Robot **left ARMED** at user's order.

## What was broken → what shipped (branch `feat/kalhar-elevenlabs-voice`)

| Symptom | Root cause | Fix (commit) |
|---|---|---|
| Chat trick "worked" but robot never moved | WS-path agent runs on a non-publishing `CaptureRegistry`; only the emote was re-published — `run_motion` was captured and dropped | `afcf9a2` surface trick; **superseded by `758db95`** |
| Spoken "stop" did nothing (silently) | Same bug family, 3rd instance: agent `stop` tool captured, never forwarded (red Stop button was fine) | `758db95` — **single physical-command dispatch**: every command the agent runs lands on one ordered `captured["commands"]` list; ONE loop in `ws_chat` publishes them |
| Admin "send to dock" read as failed | dock/undock are 10–60 s Create 3 actions; `send_command` default 5 s window returned mid-action with no terminal ack | `c6e41dd` — 75 s window for dock/undock in the admin command route |
| Chat circle huge (~1.2 m sweep) | chat tool sent no params → choreography default r=0.5 | `cea346a` — chat circles pinned to r=0.1 (~0.4 m sweep); params flow through dispatch. Floor lowered 0.2→0.1 in `b72abe4` |
| Assignment undock+nudge missing | (built earlier today) `fdafd49` lifecycle: assign → undock → verified `done` → 0.2 m forward nudge; end/idle/abort → dock |

## Operational findings (the robot-side stuff)

1. **FastDDS restart ORDER (gotcha #9 extension):** after any ROS-stack restart the bridge
   must restart **LAST**: `discovery` → `turtlebot4` → `guidemate-bridge` → `ros2 daemon
   stop/start`. A bridge started before discovery becomes a stale participant → **every
   dock/undock fails `action server unavailable`** (that exact string in the admin
   assign-events log is the signature). Happened twice today.
2. **`docked=None` after restart blinds motion:** even with the `telemetry-topics.conf`
   overrides, the bridge can come up with `docked=None` (heartbeat `gates.docked: null`)
   and the dock-guard default-denies → all tricks refused "docked". Fix: bounce the bridge
   once more after the boot graph settles.
3. **Nudge race (OPEN):** immediately after undock's `done` ack the dock-guard can still
   hold stale `docked=true` and refuse the forward nudge (fail-closed, recorded in
   assign-events). Wet-validated earlier only by timing luck. **Fix needed:** short retry
   of the nudge in `robot_lifecycle.assign_actions` while refusal reason == "docked".
4. **Idle sweeper works in prod** — it ended a stale session mid-debugging (released lock,
   fired dock). Remember: a bound session idle >10 min loses the robot (re-approve after).
5. **Wiggle before a trick is the emote** — every reply publishes its mandatory emote
   physically on a bound session; `happy` = wiggle choreography, then the trick dispatches.
   Optional future tweak: suppress physical emote on turns that also ran a motion trick.

## Honesty gap (OPEN, user-facing)
On the WS path the model's tools are acked by `CaptureRegistry` with `simulated=True`
**before** the real dispatch, so replies say "we're in simulation mode / I held my spot"
even when the robot then physically moves. (Handoff's "Moses overclaims" is now
"underclaims".) Fix: describe the ack outcome from the REAL dispatch, or stop telling the
model it was simulated.

## Arming state (as of end of session)
**468 LEFT ARMED** on the user's explicit order. Switch 1 (code escape hatch) is a
**transient UNCOMMITTED Pi-local edit** to `bridge.py` (repo stays default-deny); switch 2
drop-in installed; switch 3 shadow armed. Disarm = runbook +
`git checkout -- src/guide_mate_bridge/guide_mate_bridge/bridge.py` on the Pi.
See `motion-toggle-runbook.md` (updated with this variant).

## Also open
- Pre-existing `test_index_served` failure ("Robert" vs the Moses UI redesign, `ec6f1ac`).
- Voice plan Tasks 6–7 (gated live loopback test, env-switch docs).
- Emote-suppression-on-trick-turns decision.
