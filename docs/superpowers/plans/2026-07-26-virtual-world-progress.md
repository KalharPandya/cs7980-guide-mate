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
| 5 | 1.1 Navmesh generation | **completed (impl), review pending** | commit 2e63430 (impl, 18/18 rooms path-reachable) + 0d72704 (patch-package fix for a real @recast-navigation/core|generators tsc/build break - bare extensionless .d.ts export specifiers don't resolve under NodeNext; fixed + verified via clean node_modules reinstall). Spec/quality review not yet dispatched - controller pivoted to building a minimal live-demo slice (Task 1.2/3.3 subset) for a requested architecture video; formal review of 1.1 to follow. |
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

## Architecture-video live-clip slice (2026-07-26, side excursion)

Kalhar asked for an architecture video and confirmed he wants "diagram + a live clip," not just
a diagram. Built the smallest real vertical slice that proves the pipeline, NOT a preview of
Tasks 1.2/3.2/3.3's real scope:
- `world/src/rooms/WorldRoom.ts` now seeds one demo agent and walks it to a random room's real
  navmesh-computed door path each tick, looping forever. Explicitly commented as scaffolding for
  Task 1.2 to extend/replace, not the finished Detour Crowd loop.
- `world-client/src/net/useWorldRoom.ts` + `world-client/src/scene/DemoAgents.tsx`: a Colyseus
  client connection + a plain colored box that lerps to the synced position. Explicitly
  commented as a stand-in for Task 3.2's real GLB models.
- Fixed a real bug found in the process, not a workaround: `useWorldRoom()` must be called
  outside `<Canvas>` (in the plain React DOM tree), not inside it -- react-three-fiber's own
  reconciler defers committing child components until it renders a frame, which never happens
  while the tab is hidden/backgrounded, so a hook called inside `<Canvas>` never even ran its
  effect. `App.tsx` now calls the hook itself and passes `agentIds`/`agents` down as props. This
  is the correct architecture regardless of the hidden-tab issue that surfaced it.
- Verified live end-to-end twice: once via a throwaway Node script (`@colyseus/sdk` client
  sampling the room every second, real changing x/z over a real WebSocket) and once via the
  actual browser client (a temporary `window.__DEBUG_AGENTS__` expose, removed before commit,
  polled with `javascript_tool` -- confirmed the browser genuinely receives continuously
  changing positions, not a static snapshot).
- Commits: `2e63430` (Task 1.1 impl), `0d72704` (Task 1.1 tsc/build fix), `ae830c1` (this slice).

**How to run it for the actual recording** (do this on your own machine, in a real browser --
this session's Browser pane cannot composite/screenshot frames, a separate, already-diagnosed
limitation unrelated to whether the app works):
```
cd world && npm run dev        # starts the Colyseus server on :2567
cd world-client && npm run dev # starts the Vite dev server, note the printed port
```
Open the printed `world-client` URL in a real browser. You'll see the grey placeholder floor and
one green box (the demo robot) walking a real path to a random room and back, forever, with
`MapControls` for drag/zoom. That's the live clip.

**Formal spec/quality review of Task 1.1 (navmesh generation) is still outstanding** -- this
excursion took priority once the video request came in. Resume subagent-driven-development
there when picking this back up: dispatch a spec-compliance reviewer for commits
`2e63430`+`0d72704` together (same two-stage process as every other task in this plan), then a
code-quality reviewer, before moving on to the real Task 1.2.

## Note on the harness task tracker
The TaskList/TaskCreate tracker used earlier in this session was reset (likely tied to the
session interruption) and no longer holds tasks #1-#15. This markdown file and
`2026-07-26-virtual-world-implementation-plan.md` are the durable source of truth going
forward -- don't assume the tracker has state; recreate it from this table if useful, but it's
not required to resume work.

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
