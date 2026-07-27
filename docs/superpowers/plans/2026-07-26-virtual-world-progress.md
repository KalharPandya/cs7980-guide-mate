# Virtual World Guide Fleet — Progress

Living status doc. Update this after every task completes or changes state. Task IDs below
match the harness task tracker (TaskList) AND the task numbers in
`2026-07-26-virtual-world-implementation-plan.md` (e.g. tracker #1 = plan Task 0.1).

Worktree: `.claude/worktrees/feat+kalhar-virtual-world`, branch `feat/kalhar-virtual-world`.

## Status as of 2026-07-26 (session start)

| Tracker # | Plan task | Status | Notes |
|---|---|---|---|
| 1 | 0.1 Colyseus world-server scaffold | **completed** | commits 55542ad + 98a7674 (packaging fix). Spec + quality review both clean, "ready to merge: yes". Note for Task 1.2: `Room<{ state: WorldState }>` generic form is correct/required for this Colyseus version, not `Room<WorldState>` as the plan literally said. |
| 2 | 0.2 Three.js/R3F client scaffold | **completed** | commit 23f4c53. Spec + quality review both clean, "ready to merge: yes". **Screenshot proof still outstanding** (environment/session constraint, not a code bug - see log). Forward notes for Task 3.1/3.2: (a) floor-14.json's real footprint spans roughly x:[0,36] z:[0,21], centroid ~(18,10), NOT centered on origin like the placeholder plane - Task 3.1 must recenter the floor-plan geometry or recompute the camera/MapControls target from the floor plan's actual bounds; (b) the directionalLight's default shadow-camera frustum (~10x10 centered on target) is too small for the real ~36x21 floor - Task 3.2 (first shadow-casting agents) will need to widen `shadow-camera` bounds. |
| 3 | 0.3 Floor-plan data | **completed** | controller-authored, `world/data/floor-14.json` |
| 4 | 0.4 CC0 asset fetch script | **completed** | commit 7cf481d; spec + quality review both passed, "ready to merge: yes". Minor nice-to-have not required: add `*.part` to .gitignore for interrupted-download cleanup. |
| 5 | 1.1 Navmesh generation | pending | blocked by #1 |
| 6 | 1.2 Crowd simulation loop | pending | blocked by #5 |
| 7 | 1.3 Load test ~95 agents | pending | blocked by #6 |
| 8 | 2.1 navigate command schema | **completed** | commit 477006a; spec review + quality review both clean, no fixes needed |
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
  Worktree created. Foundation commit made (98831ba).
- 2026-07-26: Dispatched 4 implementer subagents in parallel (disjoint files, all Sonnet 5):
  #1 (0.1 Colyseus scaffold), #2 (0.2 R3F client scaffold), #4 (0.4 asset fetch script),
  #8 (2.1 navigate command schema). Awaiting completion; each gets spec-compliance review then
  code-quality review before being marked completed here and in the tracker.
- 2026-07-26: Phase 0 complete (#1, #2, #3, #4 all done) plus #8 (2.1) done early since it was
  independent. Task 0.1 needed one fix round (unused zod dep, undeclared @colyseus/core import
  fixed to import from the declared `colyseus` package) - re-reviewed clean after. Task 0.2's
  screenshot verification hit a real environment limit: the Browser pane isn't compositing frames
  in this session (confirmed independently by the controller via direct JS eval - document.hidden
  is true, canvas stuck at un-laid-out default size). This affects ANY future task needing a
  screenshot in this session, not just 0.2 - retry when a session has the pane actually visible.
  All non-visual verification (tsc, build, dev server, console, network, WebGL context) passed for
  0.2. Starting Task 1.1 (navmesh generation), now unblocked.
