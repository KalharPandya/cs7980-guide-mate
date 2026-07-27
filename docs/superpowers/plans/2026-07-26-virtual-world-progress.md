# Virtual World Guide Fleet — Progress

Living status doc. Update this after every task completes or changes state. Task IDs below
match the harness task tracker (TaskList) AND the task numbers in
`2026-07-26-virtual-world-implementation-plan.md` (e.g. tracker #1 = plan Task 0.1).

Worktree: `.claude/worktrees/feat+kalhar-virtual-world`, branch `feat/kalhar-virtual-world`.

## Status as of 2026-07-26 (session start)

| Tracker # | Plan task | Status | Notes |
|---|---|---|---|
| 1 | 0.1 Colyseus world-server scaffold | pending | dispatching now |
| 2 | 0.2 Three.js/R3F client scaffold | pending | dispatching now |
| 3 | 0.3 Floor-plan data | **completed** | controller-authored, `world/data/floor-14.json` |
| 4 | 0.4 CC0 asset fetch script | pending | dispatching now |
| 5 | 1.1 Navmesh generation | pending | blocked by #1 |
| 6 | 1.2 Crowd simulation loop | pending | blocked by #5 |
| 7 | 1.3 Load test ~95 agents | pending | blocked by #6 |
| 8 | 2.1 navigate command schema | pending | blocked by nothing, not yet dispatched |
| 9 | 2.2 Virtual fleet IoT identity | pending | AWS-mutating, controller reviews before apply |
| 10 | 2.3 Node MQTT bridge | pending | blocked by #6, #8, #9 |
| 11 | 3.1 Floor/wall geometry | pending | blocked by #2 |
| 12 | 3.2 Animated agents | pending | blocked by #2, #4 |
| 13 | 3.3 Colyseus client + route line | pending | blocked by #11, #12, #6 |
| 14 | Phase 4 (undetailed) | pending | blocked by #10, #13 |
| 15 | Phase 5 (undetailed) | pending | blocked by #14 |

## Decisions made this session (don't re-litigate)
- Branch `feat/kalhar-virtual-world` in an isolated worktree (this repo has multiple concurrent
  Claude sessions sharing the main tree — see memory `multi-agent-shared-worktree-git-discipline`).
- All subagents dispatched on Sonnet 5, per user instruction.
- `world/data/floor-14.json` coordinates are eyeballed from the pasted floor plan images, not
  survey-accurate. This is accepted as good-enough for a demo (per the design spec).
- Parallel dispatch only for tasks with disjoint file sets (see "Parallelization notes" at the
  bottom of the implementation plan). Never parallelize two tasks touching the same file.

## How to resume if this session ends mid-flight
1. `EnterWorktree` with `path: .claude/worktrees/feat+kalhar-virtual-world` (or cd there).
2. Run `TaskList` to see current status (source of truth for what's done/in-flight/blocked).
3. Read this file's table for the narrative version + any notes below.
4. Pick the lowest-ID pending, unblocked task and dispatch its implementer subagent using the
   full task text from `2026-07-26-virtual-world-implementation-plan.md`.

## Log
- 2026-07-26: Design spec + implementation plan + task tracker created. floor-14.json authored.
  Worktree created. About to dispatch tasks #1, #2, #4 in parallel (Phase 0, disjoint files).
