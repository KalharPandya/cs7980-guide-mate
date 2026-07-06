# Phase-7 Task 6 report — observability plumbing

**Status:** COMPLETE. TDD for logship pure functions; setup_observability.sh RUN FOR REAL
against AWS (idempotent, re-run clean); Pi logship module + systemd unit/timer + installer
extension; teardown SSM-param nit. Committed in worktree (no push).

## Worktree / branch
- Worktree: `/home/khouryloaner/cs7980/cs7980-guide-mate/.claude/worktrees/agent-a942a58c18f3ee3e8`
- Branch: `worktree-agent-a942a58c18f3ee3e8` (off `kalhar/dog-agent-poc`)
- Base SHA: `4b81355` (merged in at start — worktree was behind at fe63d10)
- Head SHA: `abfbb9b`

## Tests
`PYTHONPATH=$PWD/shared/guidemate_msgs:$PWD/src/guide_mate_bridge .venv/bin/pytest src/guide_mate_bridge/tests/ -q`
→ **39 passed** (4 new logship tests: parse_journal_json ms-timestamp + byte-array decode,
chunk_events batching, heartbeat_event EMF shape; verified RED first via ModuleNotFoundError).

## AWS resources created & verified (us-west-2, acct 852373397000)
- **Dashboard** `guidemate-poc` — `list-dashboards` confirms (6 widgets).
- **Alarms** (`describe-alarms guidemate-poc*`): `guidemate-poc-service-errors` (OK — filter
  defaultValue=0), `-bedrock-throttle` (INSUFFICIENT_DATA), `-bridge-offline`
  (INSUFFICIENT_DATA). `-ec2-cpu` intentionally skipped (no running guidemate-poc-ec2
  instance yet — script re-adds it on re-run after launch_ec2.sh).
- **Bedrock invocation logging** ON → `/guidemate/bedrock`, role
  `guidemate-bedrock-logging-role` (`get-model-invocation-logging-configuration` confirms).
- **Log groups** @ 30-day retention: `/guidemate/agent-service`, `/guidemate/bedrock`,
  `/guidemate/bridge`, `/guidemate/caddy`.
- **Metric filters** on `/guidemate/agent-service`: `guidemate-service-errors`,
  `guidemate-bedrock-throttle`.
- Idempotency: ran the script twice; second run produced zero errors.
- Tagging: IAM role + all 4 alarms tagged `project=guidemate-poc`.

## Pi log-ship (NOT deployed — controller does Pi deploys)
- `src/guide_mate_bridge/guide_mate_bridge/logship.py` (verbatim from brief).
- systemd `guidemate-logship.service` (oneshot) + `.timer` (5 min).
- Installer: **extended the real `install_bridge_on_pi.sh` additively** (new unit+timer
  install steps) per controller direction, instead of a standalone install_logship_on_pi.sh.

## Adaptations / deviations
- Merged base `4b81355` first (worktree started at `fe63d10`).
- Installer: per controller instruction, extended existing
  `src/guide_mate_bridge/scripts/install_bridge_on_pi.sh` rather than creating the brief's
  separate `install_logship_on_pi.sh`. Doc references updated to match.
- teardown.sh `--yes` path now runs `aws ssm delete-parameter --name /guidemate/admin-password || true`.
- shellcheck not installed on this box; `bash -n` passed on all three scripts.

## Concerns
- 4th alarm (`-ec2-cpu`) only materializes once a running instance exists — documented and
  by design; re-run setup_observability.sh post-launch.
- Alarms are INSUFFICIENT_DATA until traffic/heartbeats flow — expected pre-launch.

## Report path
`.superpowers/sdd/p7-task-6-report.md`
