# Defense Brief: "Strong at the Code, Weak at the Body"

CS 7980 Capstone, Northeastern University Vancouver, GuideMate project.
Prepared 2026-08-02 for the viva / defense of `Research/draft-v1.md`.

Everything here is grounded in files in this repository. Claims about the paper cite
`draft-v1.md:LINE`; claims about the apparatus cite the tool or data file. Where the
paper and the underlying data disagree, this brief says so explicitly and gives you the
corrected number. That is deliberate: the fastest way to lose a viva is to be told a
number is wrong by someone who checked it after you did not.

---

## Part 0. How to use this document

Read in this order:

1. **Part 7 first.** That is the attack surface. It is the part that decides the outcome.
2. **Part 8**, the corrections list. Some of these you can fix in an hour and should.
3. **Part 1** for the framing you actually say out loud.
4. The rest is reference: use it to answer follow-ups, not to memorize.

The single most important strategic decision in this brief: **you are ahead if you open
with the limitations you found yourself.** The corpus has a real inflation problem
(Part 7, A1 and A2). If you surface it, you look like a careful researcher who audited
their own instrument. If the examiner surfaces it, every other number you quote becomes
suspect. Lead with it.

---

## Part 1. The answers you say out loud

### The 60-second version

"We asked whether AI and multi-agent systems can develop and debug robotics software.
The answer is an asymmetry, not a yes or no. They are strong at the software engineering
side, writing and repairing ROS 2 code through a closed write, run, read-error, fix loop.
They are weak as the runtime embodied brain, meaning sensorimotor control, spatial
reasoning, and recovery from physical failure. We tested this two ways. First, a
literature synthesis where every finding had its source URL adversarially fetched and
read by two independent skeptic agents before it counted; 91 candidates in, 78 kept, 13
dropped. Second, and this is the novel part, we analyzed our own working transcripts from
building a real TurtleBot 4 guide robot, with every interpretive claim cited back to a
specific turn in a committed raw transcript. Both streams agree. The places our agent
stalled were not random; they clustered exactly at the boundary the thesis names."

### The 3-minute version, add

- **What the boundary looks like concretely.** The agent built a BFS frontier explorer,
  fixed a namespaced-TF bug that would have silently broken every pose lookup, ported
  three Python nodes to C++ for a measured 15x aggregate CPU reduction, and root-caused a
  camera failure to a kernel USB buffer setting with a clean single-variable experiment.
  Then it drove the robot into a glass wall, needed a human to kill Nav2 to stop it,
  reported an aborted dock action honestly but attempted no retry or diagnosis, and could
  not verify whether a GUI had rendered or whether the robot had physically moved.
- **Why the split is structural, not a bad day.** Everything on the strong side has a
  feedback signal the agent can read: a compiler error, a stack trace, a test result, a
  measured CPU percentage. Everything on the weak side requires a sensor the agent does
  not have, or an actuator whose failure mode is not legible as text.
- **What we did not test.** We never put an LLM in the inner control loop. Our explorer is
  goal level and never publishes `cmd_vel`. So our evidence supports the weak-embodiment
  claim at the integration and verification boundary. The narrow "LLM as low-level
  sensorimotor controller fails" claim is carried by the literature, not by us.

### The 10-minute version

Add Part 5 (the evidence), then Part 7 (the limitations, offered as your own audit), then
Part 9 (iteration 2). Do not spend the time on the robot architecture unless asked. The
robot is the instrument, not the result.

---

## Part 2. What is actually claimed

**Research question** (`draft-v1.md:11`): Can AI and multi-agent systems develop and debug
robotics software?

**Thesis** (`draft-v1.md:13`), an asymmetry with two halves:

| Half | Claim | Tested by |
|---|---|---|
| Strong | Authoring ROS/ROS2 nodes, config, launch files; repairing and debugging through closed-loop write-run-read-error-fix | Literature and our corpus, both |
| Weak | Low-level sensorimotor control, spatial reasoning, multi-robot runtime coordination, recovery from physical execution error | Literature strongly; our corpus **partially** (see Part 7, A4 and A12) |

**Goal of iteration 1** (`draft-v1.md:15`): test whether the asymmetry survives contact
with two independent evidence types. If both agree, the boundary becomes a design
constraint. If they diverge, the divergence is the finding.

**What is not claimed.** Be precise about this under questioning, because the title
overstates the paper if read carelessly:

- Not claimed: that LLMs cannot ever act as controllers.
- Not claimed: a causal mechanism. The paper reports co-location of failure with the
  embodiment boundary, not a controlled manipulation.
- Not claimed: generalization beyond a single team, single robot model, single agent
  product (Claude Code), and a 20-day window.
- Not claimed: that the 30 sessions are a sample from any population. They are a census
  of one project's early phase.

### Title drift you should know about

Two titles exist:

- `Research/draft-v1.md` (yours, committed `d1d0631`, 2026-06-21): "Strong at the Code,
  Weak at the Body: A First-Iteration Study of **AI and Multi-Agent Systems** Developing
  and Debugging Robotics Software." 5,217 words.
- `Research/LLM_Robotics_WIP_Paper.pdf` (Sibgha, committed `5d86e01`, 2026-07-05, exists
  **only** on `origin/research-paper`): "Strong at the Code, Weak at the Body: A
  First-Iteration Study of **LLMs** in Robotics Development." 9 pages, 3,954 words, a
  Google Docs re-render and shortening of your draft. Byline is "CS 7980 Capstone,
  Northeastern University Vancouver GuideMate Project, Work-in-Progress Paper, Iteration
  1", with no individual author names.

The retitle narrows "AI and multi-agent systems" to "LLMs", which is a **stronger and
harder to defend** claim, because much of your corpus evidence is about a multi-agent
harness (subagents, worktrees, adversarial review) and not about a bare LLM. If the
submitted artifact is the PDF version, know which one the examiner is holding, and be
ready to say that the multi-agent framing is the accurate one.

---

## Part 3. Contributions, and non-contributions

**Claimed contributions:**

1. **A primary-evidence method**: using a development team's own agent transcripts as
   citable research data, with a deterministic digest pipeline and a per-claim
   `(file, date, turn)` citation format back to committed raw JSONL.
2. **An adversarial literature verification protocol**: two independent skeptic agents
   fetch each source URL and vote; one refute kills a finding. 91 candidates, 78 kept.
   The 13 drops are published with reasons, which most reviews do not do.
3. **A corroboration result**: the literature's predicted asymmetry and the project's own
   observed stall points fall on the same side of the same line.
4. **A reproducible pipeline**: raw transcripts, digests, stats, analyses, findings, and a
   pre-commit gate are all committed and re-runnable.

**Honest non-contributions.** Say these before you are asked:

- No controlled experiment. The compass artifact (`compass_artifact_wf-...md`) actually
  proposed one, with a falsification threshold: if an agentic loop resolves more than 50
  percent of held-out ROS2 bugs with passing tests, the "AI cannot debug robotics code"
  claim is falsified for that setting. **That experiment was never run.** It got demoted
  to future work.
- No baseline. There is no human-engineer control condition, no non-agentic condition.
- No new benchmark, dataset release, or algorithm.
- No inter-rater reliability on the qualitative coding.

---

## Part 4. Methodology, and how to defend each step

### 4.1 The single standard

Every claim must trace either to a literature source whose URL was fetched and confirmed,
or to a session cited `(file, date, turn)` with the raw transcript committed
(`draft-v1.md:21`). Corpus statistics come only from measured files, `INDEX.md` and
`stats.json`, not from prose.

**Defense:** this is a stricter traceability standard than a normal literature review,
and the artifacts to check it are in the repository. That is the honest strength here.

### 4.2 The literature pipeline

1. Preliminary review (`compass_artifact_wf-96c5cc40-...md`, 69 lines, 2026-06-21) as
   input, containing named-author attributions but no URL verification.
2. Finder agents searched per evidence cluster.
3. Every candidate went to **two independent skeptic agents** that fetched the cited URL
   and judged support.
4. Keep rule, implemented at `Research/tools/build_outputs.py:103-138`: keep if **at least
   one skeptic confirms support and none refutes**.
5. Result: 91 candidates, 78 kept, 13 dropped, 86 percent keep rate.

**What survived is meaningfully different from what went in.** The compass artifact's
headline RoboCoach numbers (0.391 to 0.730 versus a 0.602 human reference, Gemini 3.0 Pro
0.398 to 0.802) do **not** appear in `findings.md` at all; the nearest version was drop
number 4, refuted by both skeptics. All vendor and marketing figures in compass (Claude
Opus 4.5 at 80.9 percent, GPT-5.3 Codex at 85 percent, "Claude Mythos" marketing at 93.9
to 95.5 percent) were eliminated. That is a strong story: **the verification layer
demonstrably destroyed the most attractive numbers in the input.** Use it.

### 4.3 The conversation corpus pipeline

1. **Collect and redact.** `scripts/collect_claude_conversations.py` (515 lines, 400 lines
   of tests) matches sessions on the `cwd` recorded inside each JSONL rather than the
   path-encoded folder name, so it is portable across machines. It strips internal
   metadata keys and runs about 18 secret patterns (AWS key ids, PEM blocks, GitHub PATs,
   Stripe keys, Slack tokens, JWTs, bearer headers, credentials in URLs). A
   `scripts/git-hooks/pre-commit` runs `--verify-only` and blocks the commit on a hit.
   Design detail worth quoting: every replacement contains the literal `REDACTED` and the
   verifier skips matches containing it, so redacted output converges instead of
   re-flagging forever, while a genuinely missed secret still trips the gate.
2. **Digest.** `Research/tools/build_digests.py` produces a deterministic, model-free
   digest plus `stats.json` of measured counts. Per-turn caps: user 4,000 chars,
   assistant 1,600, tool summary 220. `thinking` blocks are replaced with
   `[thinking omitted]`, so reasoning traces are not in the citable record.
3. **Analyze.** Each digest analyzed into a fixed 11-key schema (`_analyses.json`):
   `file, date, motive, outcome, thesis_category, thesis_alignment, automation_level,
   user_input_count, tasks_done_n, tasks_failed_n, key_evidence[]`. 203 key-evidence items
   across 30 analyses, each with a `(file, date, turn)` citation.
4. **Synthesize** into `draft-v1.md`, then an adversarial citation audit.
5. **Gate.** `Research/tools/evidence_gate.py` must pass before commit.

### 4.4 The evidence gate: exactly what it does

Be precise here, because overclaiming it is an easy way to get caught.

**It checks three things**, and fails with exit 2 on any:

1. No em dash (U+2014) in any target file.
2. Every `conversation-analysis/*.md` other than `INDEX.md` contains the literal substring
   `claude-conversations/sessions/`.
3. `draft-v1.md` contains at least one `http://` or `https://`.

**It does not check**: that a cited turn number exists in the digest; that a cited file
exists; that a `findings.md` URL resolves; that a quoted evidence string appears at that
URL; that INDEX table cells are populated; that finding numbers in prose match
`findings.md`.

**And there is an awkward detail.** `build_outputs.py:32-37` (`desmart`) and
`sweep_dashes()` at `:218-226` rewrite em dashes to hyphens in the files immediately
before the gate checks for em dashes. So rule 1 is a property manufactured by the builder
and then verified by the gate. It is a formatting lint with a circular step, not an
integrity check.

**Correct framing to use:** "The gate enforces traceability *form*. The skeptic agents
enforce *content*. No automated check confirms that a cited turn exists; that is a known
gap and it is on the iteration 2 list."

**Verified live 2026-08-02:** `python Research/tools/evidence_gate.py` returns
`GATE PASS: no em-dashes; all analyses trace to raw transcripts`, 34 files scanned, exit 0.

### 4.5 Reproducibility

This is genuinely strong and you should push on it:

- 30 raw redacted session JSONLs, 21 MB, **committed** under
  `claude-conversations/sessions/`.
- Digests, `stats.json`, `_analyses.json`, per-session analyses, `INDEX.md` all committed.
- Both build tools and the gate committed and runnable.
- `Research/README.md` documents the five-step pipeline end to end.

A reviewer can re-derive every count independently. Offer this. Most self-study papers
cannot.

---

## Part 5. The evidence

### 5.1 Literature: what carries the argument

78 findings from **50 unique works / 57 unique URLs**, in five sections.

**Section vintage and quality**, which you will be asked about:

- 43 arXiv works: 4 from 2023, 11 from 2024, 17 from 2025, **11 from 2026**.
- **22 of 78 findings (28 percent) cite 2026 arXiv preprints**, none peer reviewed.
- Exactly **three peer-reviewed venue sources**: `openreview.net` (ICLR, SWE-bench),
  `aclanthology.org/2025.emnlp-main.921` (EMNLP 2025, UniDebugger), and
  `ieeexplore.ieee.org/document/10730448` (OperateLLM, the only IEEE item).
- **Three grey-literature items**: a GitHub README (finding 13, robotics-agent-skills), an
  Open Robotics Discourse thread (58, AgenticROS), a Medium post (72, the FAEA
  privileged-state caveat).
- One vendor blog (OpenAI, findings 65 and 73).
- **Finding 67 has no independent source at all**, labelled "cross-source observation" and
  pointed at CodeSim's URL. It is the weakest-sourced item in the file.

**The load-bearing numbers, by half of the thesis:**

*Strong-at-code half:*

| Claim | Number | Source |
|---|---|---|
| UniDebugger/FixAgent on Defects4J | 197 bugs correctly fixed, 286 plausible, beats ChatRepair by 25.48 percent | arxiv 2404.17153 |
| CodeSim pass@1 | HumanEval 95.1, MBPP 90.7 | arxiv 2502.05664 |
| UAV code, closed loop | 33.3 to 55 percent direct, rising to 85 to 93.3 percent with iterative error-fix | arxiv 2512.02002v1 |
| RoboCoach agentic loop | surpasses human-engineered baselines by 26.5 percent; real-robot 0.51 to 0.68 | arxiv 2601.21570 |
| FAEA, unmodified Claude Agent SDK | 84.9 / 85.7 / 96 percent on LIBERO / ManiSkill3 / MetaWorld, zero demos | arxiv 2601.20334 |

*Weak-at-body half:*

| Claim | Number | Source |
|---|---|---|
| Butter-Bench, real robot | best LLM 40 percent (Gemini 2.5 Pro) vs human mean 95 percent; Llama 4 Maverick 7 percent | arxiv 2510.21860v1 |
| PARTNR, 100k collaboration tasks | humans 93 percent, SoTA LLMs 30 percent non-privileged | arxiv 2411.00081 |
| BLINK, core spatial perception | humans 95.70, GPT-4V 51.26, Gemini 45.72 | arxiv 2404.12390 |
| EmbodiedBench manipulation subsets | GPT-4o spatial awareness 25.0, visual appearance 19.4 (vs 52 on EB-ALFRED) | arxiv 2502.09560v1 |
| ROSClaw replan loops | 19 percent overall, Llama 4 31 percent, Claude 4 percent, no loop breaker | arxiv 2603.26997v1 |
| DPBench simultaneous coordination | N=5 deadlock 25.0 percent (GPT-5.2) to 90.0 percent (Gemini 2.5 Flash), governed by protocol not model | arxiv 2602.13255 |

*The caveat half, which is what makes the review credible:*

| Claim | Number | Source |
|---|---|---|
| SWE-Bench Pro vs Verified | ~23 percent vs over 70 percent, roughly a 47-point gap | arxiv 2509.16941v1 |
| Re-evaluation of 11,041 patches | 19.78 percent of accepted solutions semantically incorrect; top agent 78.80 to 62.20 | arxiv 2603.00520 |
| OpenAI audit of Verified | 59.4 percent of 138 audited tasks had material test or description flaws | openai.com |
| SWE-Bench Illusion | Claude 4 Opus reproduces benchmark code verbatim in 31.6 percent of instances | arxiv 2506.12286 |
| MAST, 1,642 traces / 7 frameworks | 23.6 percent of failures are task verification; framework failure rates 41 to 86.7 percent | arxiv 2503.13657v3 |

**One internally contradictory cluster, and you should know it is deliberate.** The
perception-confound cluster contains finding 47 (oracle to learned perception costs 25.8
points) and finding 48 (privileged visual access gives 22.1 to 45.5 point gains under
occlusion), and then **finding 77, which inverts them**: on Lockbox, "agents perform best
under raw RGB input and worst under perfect ground-truth observations", with 40 percent
state-flip noise producing a 2.85x success improvement. If asked, the correct answer is
that the perception-versus-reasoning confound is unresolved in the literature and the
review reports the contradiction rather than selecting the convenient side.

### 5.2 The corpus: the published numbers and the corrected ones

**As published** (`INDEX.md:7-21`, `draft-v1.md:27,77-86`):

- 30 sessions, 2,153 user turns, 4,192 assistant turns, 1,697 tool calls
- 178 tasks done, 46 failed or abandoned
- Outcome: reached 16, partial 12, not-reached 2
- Category: software-engineering 21, mixed 4, non-technical 4, embodied-hardware 1
- Automation: high 22, medium 6, not-determinable 2

The arithmetic reconciles exactly against `stats.json`. The counts are correct as counts.

**The corrections you must be ready with:**

| Published | Actual | Why |
|---|---|---|
| "2,153 user turns" as a scale claim | ~**456 actual human prompts** | `build_digests.py:128` counts every `role == "user"` record, **including tool results**. The identity `user_turns - tool_calls = user_input_count` holds exactly on `agent-a1` (28-27=1), `agent-a6` (25-24=1), `agent-ac` (17-16=1), `agent-ad` (12-11=1). Corpus-wide, 2,153 - 1,697 = ~456. |
| "30 sessions" | 30 transcripts, of which **15 are subagent transcripts** | `agent-a0` through `agent-af` (no `ab`), all dated 2026-06-20, all spawned inside the same day's camera investigation. |
| "16 reached" | **13 of the 16 are subagents.** Only 3 human sessions reached. | Doc-audit and web-research delegations are one-shot and terminate cleanly by construction. |
| "21 software-engineering sessions" | **15 of 21 are subagents**, several of which audited a single markdown file and touched no robotics code | e.g. `agent-a0`, `agent-a9`, `agent-af` |
| "22 high automation" | Subagents are non-interactive by construction | "High automation" is partly a property of the harness, not a finding |
| "the heaviest robotics-code session" = `69022496` at 457/1,025/379 (`draft-v1.md:90`) | **`29aff2bd` is larger at 535/1,112/401** (`stats.json:142-144`) | An `.md` vs `.jsonl` key mismatch at `build_outputs.py:142` blanks 9 of 30 INDEX rows, including this one, so the largest session was invisible when the draft was written |
| "28 non-empty sessions" | `stats.json` marks **all 30 records `"empty": false`** | The `empty` flag is `user_turns + assistant_turns == 0`; the two stubs have 3 and 2 user turns. "Non-empty" is an analyst judgment, not the deterministic field |
| "78 verified findings" | ~**60 to 65 independent claims** from 50 works | Seven duplicate clusters: 14/29, 22/28, 25/41, 37/44/51, 62/66/75, 11/30, 63/64 |

**The nine blanked INDEX rows** (join bug at `build_outputs.py:142`):
`2026-06-13_67626b7d`, `2026-06-20_29aff2bd`, `2026-06-20_6fb45153`, `agent-a2`,
`agent-a3`, `agent-a8`, `agent-aa`, `agent-ae`, `agent-af`. The data is intact in
`stats.json`; only the rendered table is wrong. This is a one-line fix.

**The human-only cut, which is what you should actually report.** Strip the 15 subagents:
15 human sessions, of which 2 are empty stubs, leaving **13 substantive human sessions**,
all from one team on one robot (`turtlebot468`), spanning 2026-06-03 to 2026-06-22.
Outcomes: 3 reached, 10 partial. Every one of the 13 that touched robot software supported
the strong half, and every stall was at the embodiment boundary. **This weaker-sounding
version is far more defensible and it still supports the thesis.**

### 5.3 The load-bearing sessions

**1. `2026-06-19_69022496`** (457 / 1,025 / 379; mixed; partial; 10 key-evidence items).
The most valuable session because it carries **both halves at once**.

*Strong side:* BFS explorer built and validated with a read-only dry run finding 19
frontier clusters with zero motion (turn 167). Namespaced-TF `/tf` to `tf` remap
diagnosed and fixed, without which every pose lookup fails silently (turn 158). Create 3
hazard stream proven event-only by showing 96 messages in 5 seconds on odom while hazard
stayed silent (turn 349). The `camera_info` 1280x720 versus depth 640x480 mismatch found
and the corrected forward wedge verified (turn 1073). Hardware fusion validation: depth
saw the glass base on 205 beams over 0.37 to 1.63 m where the lidar was blind, fusion
injected 195 and raised 0 (turn 1158). SLAM on fused scan held localization at 0.0 cm and
0.00 degrees in motion (turn 1255).

*Weak side:* first autonomous run drove the robot into the glass wall and the emergency
stop required killing all of Nav2 (turn 257). The glass-aware re-run still tapped the
glass repeatedly because reactive mark-and-blacklist did not block the path fast enough
(turn 428). The user had to correct the agent's spatial reasoning about the camera mount,
which is parallel with no downward tilt (turn 456). The final run never launched because
of low battery (turn 1327).

**2. `2026-06-20_6fb45153`** (16 / 15 / 7; the **only** `embodied-hardware` session;
partial). The cleanest single embodied-failure datum in the corpus: the agent fluently
read battery as 23 percent and discharging and dispatched the Dock action with the correct
message type, the action finished **ABORTED with `is_docked` false**, and the agent gave an
honest but non-recovering report with no `dock_status` diagnosis and no retry (turns 25,
27, 28). **This 31-turn session is the entire `embodied-hardware = 1` category.** See
Part 7, A4.

**3. `2026-06-20_29aff2bd`** (535 / 1,112 / 401; mixed; partial). The actual largest
session. C++ ports benchmarked: fusion 52.4 to 3.7 percent (~14x), bfs_explorer 95.8 to
5.7 (~17x), glass_guard 17.8 to 1.8 (~10x) (turn 1216). Shared-TF container validated at
`/tf` subscription count 1 and ~1.5 percent idle CPU (turn 1153). The root-cause insight
worth quoting: an empty rclpy node is 0 percent CPU, so the ~16 percent per node was each
node's own `TransformListener` parsing the 31 Hz `/tf` firehose (turns 723, 727). That is
why bundling the Python nodes into one process did not help and why the shared-buffer C++
container did. *Weak side:* the robot never moved autonomously because the Pi hit its
compute wall and Nav2 lifecycle never activated (turns 561, 575), and **the agent's own
monitoring consumed about 55 percent CPU, worsening the very saturation it was diagnosing**
(turn 553). That last one is a good line to deliver.

**4. `2026-06-20_7833e513`** (234 / 505 / 204; software-engineering; partial). The
falsifiable single-variable experiment: `usbfs_memory_mb=16` aborts in ~5 s with
`X_LINK_ERROR`, `usbfs=256` on the identical USB3 config runs 199 s with zero disconnects
and `throttled` stays `0x0` (turn 101). It overturned the project's own prior documented
root cause (turn 261). Its own `thesis_alignment` field concedes the limitation: "The
session does not directly test closed-loop motion control or multi-robot coordination, so
the embodiment-weakness claim is only indirectly supported."

**5. `2026-06-03_d29ce515`** (249 / 380 / 169). Supplies the "cannot verify the physical
world" pattern: could not observe the GUI or whether the robot moved, relied on user
images and reports for ground truth (turns 337, 369, 490, 543).

---

## Part 6. The system under study

You need enough of this to answer "what did you actually build", but do not lead with it.

### 6.1 The mapping stack, in one paragraph you can say

A TurtleBot 4 Lite (Raspberry Pi 4 running Ubuntu 22.04 and ROS 2 Humble, plus an iRobot
Create 3 base) that autonomously maps an indoor space. The novel piece is glass handling.
The RPLIDAR scans one horizontal plane at about 0.19 m and is transparent to glass, so a
glass wall reads as open floor, which is how the robot drove into one. We fold OAK-D-LITE
depth into the lidar scan: per-column vertical collapse of the nearest non-floor pixel,
transformed into the lidar frame through a cached static TF, then min-injected into a copy
of `/scan` to publish `scan_fused`. That fused topic is the **single** obstacle source for
both Nav2 costmaps and slam_toolbox, so glass enters the SLAM map and not just the runtime
costmap. A bumper-driven `glass_guard` writes persistent non-clearing costmap marks as the
last-resort backstop for fully transparent panes that even depth cannot see.

### 6.2 The three technical answers most likely to be asked

**"How does frontier selection actually work?"**
BFS from the robot's cell, **4-connected** through cells with `0 <= occupancy < 65`.
A popped cell is a frontier if **any of its 8** neighbours is `-1` (unknown). Frontier
cells are 8-connected clustered. Clusters smaller than 8 cells are dropped. Clusters whose
centroid is within 0.5 m of any blacklisted point are dropped. The rest sort by
`(minimum BFS hop count within the cluster ascending, cluster size descending)` and index 0
is sent to `NavigateToPose` with yaw facing it from the current pose. So "nearest frontier"
means nearest by 4-connected free-space hop count to the cluster's closest cell, not
centroid distance and not Euclidean distance. (`src/guide_mate_explorer/guide_mate_explorer/bfs_explorer.py:191-294`)

**"Why is the depth injection safe?"**
Because it is a one-sided minimum. Lidar no-returns are pre-set to `+inf`, then
`take = dmin < lidar - trust_margin` with the margin defaulting to 0.0. Depth can only
pull a beam nearer or fill an empty beam; it can never push a real lidar return farther
out. If depth goes stale past `max_depth_age = 0.4 s`, `scan_fused` is a byte-copy of the
raw lidar, header and geometry fields included, so it is a drop-in.

**"Why not just assume the camera height?"**
Because pitch and mounting height drift, and a wrong `cy` offset becomes a range-dependent
height error that either eats the whole floor into the obstacle band or drops the target
object out of it. For a level camera every floor pixel obeys `v = A*(1/z) + B` with
`A = camera_height * fy`. We take the per-row median inverse depth of the lower image
(the median is the obstacle rejector, since obstacle pixels are a minority within a floor
row), robustly fit with least squares plus two rounds of MAD outlier rejection, EMA-smooth
across frames, and bound `A` so the implied camera height must lie in 0.10 to 0.45 m, with
a 15-frame coast before falling back to the assumed model. **The discriminating test:**
with a deliberately wrong assumed height (0.35 m against a true 0.244 m), the fixed band
leaked the entire floor, 134k pixels, as fake obstacles, while the data-driven fit
recovered 0.244 m with zero floor leak and kept the target. Cost about 2 to 4 ms per frame.

### 6.3 What came after the corpus closed

This matters for Part 7, A13 and for Part 9. The corpus ends 2026-06-22. The project ran
to 2026-07-31, 311 commits total, 96.8 percent by one author.

| Phase | Dates | Scale |
|---|---|---|
| Network and bring-up docs | 06-12 | 4 commits |
| Mapping stack and perception | 06-19 to 06-21 | 17 commits, including the C++ port in a single commit |
| Conversation tooling and **the paper** | 06-21 | 10 commits; `d1d0631` is 33,123 lines, the largest in the repo |
| **Dog agent POC** (LLM agent driving the robot) | 07-05 to 07-07 | **176 commits**, 37 of them merges of parallel `worktree-agent-*` branches |
| ElevenLabs voice, Moses persona, live motion fixes | 07-08 | 44 commits in one day |
| Security workstream (Fazheng Han) | 07-16 to 07-21 | 6 commits, ~11,200 lines, the only PR-based flow in the repo |
| **Virtual world guide fleet** | 07-26 to 07-31 | 63 commits, Colyseus + Three.js, navmesh, Detour crowd, 95-agent load test |

Scale as of the superset branch: 656 tracked files, 16,179 lines of Python, 30,123 lines
of Markdown, 1,560 lines of C++, **64 test files and 445 Python test functions**.

**The uncomfortable and useful fact:** the ROS packages that the paper studies have
**zero tests** (`guide_mate_explorer` has no `test/` directory; `guide_mate_perception`
has no `BUILD_TESTING` block), while the later `agent_service` built by the same agent and
the same person has 445 test functions. Same agent, opposite testing discipline. Read
honestly, that says the agent did what it was asked and did not independently exercise
engineering judgment about test coverage. It is a finding, and it is one you should offer
rather than have extracted.

### 6.4 The design constraint, applied: what we built after the paper

This is the strongest material you have that is not in the paper, and it is what turns the
thesis from an observation into a contribution. After iteration 1 closed, we built a system
where a Bedrock Claude Sonnet 4.6 agent does drive a real robot. **We architected it around
the paper's own finding.**

The rule the architecture enforces: **the LLM can only ever emit named primitives from a
closed vocabulary, and cloud latency never touches motion control.** Raw `cmd_vel`
passthrough and cloud teleop were considered and rejected on exactly those grounds
(`docs/superpowers/specs/2026-07-05-dog-agent-architecture-design.md:148-149, 213`).

**Eight independent gates sit between a token and a wheel:**

| Gate | What it is | Default |
|---|---|---|
| A | Session holds the robot lock (DynamoDB conditional write) | no lock, no robot |
| B | Tool visibility: a virtual session never even sees `run_motion`, `stop`, `get_status` | withheld |
| C | Admin flags read fresh from DynamoDB per turn | operator controlled |
| D | Closed vocabulary: the tool accepts only `circle` and `spin`; `Command` re-validates at construction | `dock`, `undock`, `forward` are **never LLM-reachable** |
| E | Effective dry-run, re-read live at dispatch, `env OR shadow` so the shadow can only tighten | **true** |
| F | Fail-closed: a real command with an unwired motion gate publishes a zero twist and acks `failed` | deny |
| G | AWS IoT device shadow lock plus dock guard, where **unknown dock state counts as docked** | motion **false**, deny |
| H | Speed clamp re-read live from the shadow, itself bounded so the shadow can never raise the cap | `MAX_LINEAR` 0.15 m/s |

Plus a hard identity ban: `assert_motion_identity_safe()` raises `SystemExit` if motion is
enabled while the robot id is `turtlebot468`, which is also the unset default, so unset is
refused too. The systemd unit template forbids the motion directive, the Pi installer
aborts if the line ever appears, and a unit test greps the rendered unit to assert it did
not.

**Say this in the viva if asked what the work is for:** "The paper's finding is that the
agent is unreliable exactly where physical consequence lives. So when we later put an LLM
in the actuation path, we did not give it velocity. We gave it a vocabulary of two tricks,
put eight independent default-deny gates between the token and the wheel, and made the
choreography a bounded local primitive the cloud only names. The thesis is not a complaint
about models. It is a design constraint, and we then designed to it."

**And the later system produced more on-thesis evidence, unprompted.** Three bugs from the
2026-07-08 live session are the same failure class the paper names, now in our own
production code:

- **A family of dropped-command bugs.** The chat-path agent ran on a capture registry that
  acked commands as successful and published nothing. The model was told its trick ran, told
  the user it ran, and the robot never moved. It recurred once per new tool until it was
  fixed with a single dispatch contract. One instance was the **`stop` tool**, silently dead.
- **The agent narrating the wrong reality.** The capture registry reported `simulated=True`,
  so Moses said "simulation mode" out loud while the robot was physically spinning.
- **A silent thread death producing a safe-but-wrong state.** An `rclpy` double-init race
  killed the telemetry thread inside a bare daemon thread with no handler. `docked` stayed
  `None` forever, the dock guard treats unknown as docked, and every motion command was
  default-denied. Everything looked healthy. Nothing moved.

All three are the agent unable to verify its own physical effect. That is iteration 1's
thesis, reproduced in the system built after it, and it is much better evidence than the
single aborted dock the paper currently leans on.

---

## Part 7. The attack surface

This is the core of the brief. Each item: the question as an examiner would ask it, an
honest assessment of whether it lands, and what you say.

### Tier 1: attacks that land. Concede, do not fight.

---

**A1. "You say 2,153 user turns. How many times did a human actually type something?"**

**Lands. This is the most dangerous single question in the brief.**

Say: "About 456. That number in the paper counts every record with a user role, and in
the Claude Code transcript format tool results are recorded with a user role. The identity
`user_turns minus tool_calls equals actual human prompts` holds exactly on four sessions I
can show you. It is a mislabel in the paper, not a fabrication, and it is mechanically
auditable from the committed `stats.json`. The correct scale metrics are 1,697 tool calls
and 4,192 assistant turns, which are unaffected. I am relabelling it."

Do not try to defend 2,153. It is off by roughly 4.7x as a measure of human input and any
examiner with `stats.json` open can break it in one subtraction.

---

**A2. "Fifteen of your thirty sessions are subagents you spawned on a single day. Is your
sample really n=30?"**

**Lands.**

Say: "No, and the paper should have said so in the abstract. Fifteen of the thirty are
subagent transcripts, all dated 2026-06-20, all spawned inside two parent investigations.
Thirteen of my sixteen `reached` outcomes are those subagents, which is unsurprising
because a one-shot doc audit terminates cleanly by construction. The defensible unit is
the **13 substantive human sessions**. On that cut, 3 reached and 10 partial, every
robotics session supported the strong half, and every stall was at the embodiment
boundary. The thesis survives the stricter cut; the distribution headline does not. I am
reporting both cuts."

The recovery here is genuinely good: your conclusion does not depend on the inflated
number. Say that plainly.

---

**A3. "Every single one of your thirty sessions is coded as evidence for your thesis. Not
one against, not one null. What would have counted as disconfirming?"**

**Lands hardest conceptually.** Zero disconfirming cases in 30 trials is a property of the
coding scheme, not of the world.

Say: "That is the strongest methodological criticism available and I accept it. Three
things follow. First, the corpus was assembled and coded after the thesis was formed, so
the labels are interpretive, and there is no second coder and no kappa. Second, I can
state what disconfirmation would have looked like: a session where the agent
autonomously recovered from a physical execution failure without human intervention, or
where it verified a physical state change through its own sensing, or where it failed at
pure code work with a legible error signal available. None occurred, but the absence was
not preregistered. Third, the compass artifact proposed a falsification test with a stated
threshold, more than 50 percent of held-out ROS2 bugs resolved with passing tests, and
that experiment was never run. It is the first item of iteration 2."

**Do not** claim the coding was blind. It was not.

---

**A4. "Your embodied-hardware category has n=1, and it is a 31-turn session about one
aborted dock command. Is that your evidence for half the thesis?"**

**Lands as stated, but you have a real recovery.**

Say: "The category label undersells the evidence and that is a taxonomy error on my part.
`embodied-hardware = 1` counts sessions whose *primary* purpose was hardware, but embodied
stalls appear inside `mixed` sessions too. There are at least six independent embodied
stalls in the corpus: the glass-wall collision requiring a manual Nav2 kill
(`69022496` turn 257), the repeated glass tapping after the fix (turn 428), the aborted
dock with no retry (`6fb45153` turns 27, 28), the Nav2 lifecycle never activating under Pi
saturation (`29aff2bd` turns 561, 575), the GUI and motion verification dependency
(`d29ce515` turns 337, 369, 490, 543), and the camera-rail brownout that is hardware-side
and not fixable in software (`7833e513` turn 470). The right metric is 'sessions containing
at least one embodied stall', not the primary-purpose category, and I am adding it."

---

**A5. "Your gaps section cites finding numbers that do not exist, and one of the claims it
makes was refuted in your own verification log."**

**Lands, and it is embarrassing if you have not pre-empted it.**

The facts: `verification-log.md:193-199` cross-references findings by a pre-publication
numbering. In the published `findings.md`, 56 is ROSA not ROSClaw, 40 is BLINK, 42 is
ROSClaw, 8 is CodeSim. **Every cross-reference in the gaps section is wrong.** Worse, gap
1 asserts "ROSClaw (finding 56) explicitly states NO multi-robot coordination was tested",
and that exact assertion is **drop number 8**, refuted by both skeptics on the grounds
that "the claim fabricates an explicit disclaimer that the source does not contain".

Say: "That is a build defect and I have fixed it. The gaps text was written against a
pre-publication numbering and never renumbered when `build_outputs.py` renumbered the
findings sequentially. The ROSClaw sentence is worse: it survived into the gaps prose after
being refuted in the drop list, which is a process failure in my own pipeline. The
substance behind it, that ROSClaw only tests single-robot platforms, TurtleBot3, Unitree
Go2, Unitree G1, was confirmed by both skeptics; what was refuted was the word 'explicitly
states'. I have deleted the sentence and renumbered."

**Fix this before you present.** See Part 8.

---

**A6. "Your evidence gate. What does it actually verify?"**

**Lands if you overclaim it. Trivial if you do not.**

Say: "Three lints: no em dash, one required substring per analysis file, one URL in the
draft. It enforces traceability *form*. It does not verify that a cited turn exists, that
a URL resolves, or that a quoted excerpt appears at the source. The adversarial skeptic
step is the content verifier. I will also note a circularity I found auditing my own
pipeline: `build_outputs.py` rewrites em dashes to hyphens immediately before the gate
checks for em dashes, so rule 1 verifies a property the builder just manufactured. Turn-
number validation is a straightforward addition and is on the iteration 2 list."

---

### Tier 2: attacks with good answers

---

**A7. "You verified your literature with LLM agents. Who verifies the verifiers?"**

Say: "Nobody, and that is why the rule is asymmetric. One `refutes` vote kills a finding
regardless of how many support it, which is what happened to four of the thirteen drops.
The failures are disclosed rather than smoothed: drops 3 and 10 are direct
skeptic-versus-skeptic contradictions on the same PDF, and in drop 10 one skeptic
demonstrated by deterministic PDF text extraction that the other's confirmation came from
a hallucinated fetch summary. That is exactly the failure mode people worry about, and my
protocol caught it and threw the finding away. What I have not published is the kept-side
vote tally, so some of the 78 may rest on a single unreplicated support vote. Publishing
those tallies is a one-line change to `build_outputs.py`."

The drop-10 story is your best single answer in this whole section. It is a documented case
of your own method catching an LLM hallucination. Lead with it.

---

**A8. "Twenty-eight percent of your findings cite 2026 preprints. Three are a GitHub
README, a forum thread, and a Medium post. Is this a literature review?"**

Say: "The recency skew is a consequence of the question. There is essentially no
peer-reviewed literature on 2026-era agentic coding tools in robotics, and my preliminary
review concluded exactly that: if you want defensible evidence about a specific named tool,
you will largely have to generate it yourself, which is what the primary-evidence half of
this paper does. The three grey-literature items are labelled as grey literature in the
finding text. What I should add, and will, is an evidence-tier column, and the check that
matters is whether any load-bearing claim rests only on a preprint. For the weak-embodiment
half it does not: BLINK, PARTNR, and EmbodiedBench are all established venue work. For the
strong-robotics half, it partly does, and RoboCoach and FAEA are the exposure."

---

**A9. "Your strongest positive robotics results, RoboCoach and FAEA, are both 2026
preprints. How much weight can they carry?"**

**Know the exposure precisely.** RoboCoach: four of the 78 findings come from
`2601.21570`, and the *other* headline numbers from that same paper were refuted twice in
your own verification (drop 4). Your skeptics recorded the benchmark name as
"EmboCoach-Bench" while findings 16 and 57 say "RoboCoach-Bench". FAEA: 2026 preprint,
privileged state access, and the essential caveat (finding 72) is sourced to a **Medium
post, not the paper**. The compass artifact additionally records that FAEA is a
self-described hobby project and that precision-contact tasks still fail (PegInsertion 0
percent, PlugCharger 0 to 60 percent), neither of which made it into the draft.

Say: "Limited, and I would not rest the argument on them. The surviving RoboCoach number
is 26.5 percent over human-engineered baselines and 0.51 to 0.68 on hardware transfer;
the more attractive numbers from the same paper were refuted by my own verification. FAEA
matters mostly as a *counterweight*: it shows an unmodified coding agent reaching 85 to 96
percent in simulation **with privileged ground-truth state via `get_obs` rather than raw
RGB**, which is the paper's own architecture argument, keep the LLM out of the perception
loop. I should have carried its failure cases into the draft and I will."

---

**A10. "Your PARTNR coordination number: 31 percent more steps, 3295 versus 2519. Which
baseline is that?"**

Say: "3295 is decentralized-partial and 2519 is single-agent ReAct. The paper's own
decentralized-versus-centralized comparison is 3295 against 2298, which is about 1.43x, and
the abstract quotes 1.5x versus human-human and 1.1x versus a single human. My verification
log already shows a skeptic rejecting a sibling claim over exactly this denominator
confusion, drop 12. The robust statement is the direction and the qualitative finding, that
decentralized two-agent LLM coordination is worse than a single agent and incurs a
documented 300 percent increase in extraneous effort, not the specific percentage."

---

**A11. "Multi-robot coordination is a named pillar of your thesis and you have zero
evidence for it."**

Say: "Correct, and it is stated in the paper's own limitations and in the completeness
critic's gap list. All substantive corpus work is on a single robot, 468. That pillar is
carried entirely by the literature, PARTNR and DPBench. We have a second unit, robot 436,
and a deliberate two-robot task is the clearest single addition for iteration 2. I would
rather report the pillar as untested by us than launder literature evidence as ours."

---

**A12. "You claim LLMs are weak at low-level sensorimotor control, but you never put one
in a control loop. What did you actually test?"**

**This is the sharpest conceptual attack and the paper half-concedes it at
`draft-v1.md:118`.**

Say: "We tested the integration and verification boundary, not the inner loop. That is
deliberate: our explorer is goal level and never publishes `cmd_vel`, and the no-motion
configuration zeroes the velocity smoother as a final gate. So the honest scope of my
primary evidence is: the agent cannot verify physical state it cannot sense, cannot
recover from a physical execution failure, and hits hardware limits it cannot route
around in software. The narrow sensorimotor claim is carried by the literature. And the
literature agrees with the architecture: the strongest embodied results, FAEA and
RoboCoach, also keep the LLM out of the tightest loop and fence execution to classical or
learned controllers. I would narrow the title's implied claim rather than overstate what I
measured."

---

**A13. "Your project ran to July 31. Your evidence stops June 22. Why does your paper only
cover the first fifth of your own work?"**

**Lands, and it is also your best answer about future work.**

Say: "Because iteration 1 closed on 2026-06-21 and the project kept going. What came after
is exactly the evidence the paper is missing: a 176-commit LLM agent POC where an LLM
actually drives the robot through AWS IoT with a device shadow, a dock guard, and dry-run
gating; a day of live on-robot motion debugging; and a virtual-world fleet running a
95-agent load test. That later work contains the inner-loop and multi-robot evidence
iteration 1 lacks, and the transcripts for all of it already exist in the same collectable
format. Iteration 2 writes itself."

---

**A14. "Isn't 'weak at the body' just a claim that the agent lacks sensors and actuators?
That is not a claim about intelligence."**

Say: "Partly, and I think that is the actual finding rather than an objection to it. The
mechanism I can evidence is informational: every task on the strong side has a feedback
signal legible as text, a compiler error, a stack trace, a measured CPU percentage, a topic
frequency. Every task on the weak side requires either a sensor the agent does not have or
an actuator whose failure is not legible as text. That is why the aborted dock produced an
honest report and no retry: `ABORTED` with `is_docked` false is legible as a *fact* but not
as a *next action*. If the correct conclusion is 'give the agent a legible feedback channel
for physical state and the boundary moves', that is a design constraint, which is what the
paper says the finding is for."

---

**A15. "You analyzed your own project. Confirmation bias."**

Say: "Yes, and the paper says so at line 124. Three mitigations. The raw digests and
transcripts are committed, so a third party can re-code from the same artifacts without
trusting my labels. Every interpretive claim carries a `(file, date, turn)` citation to a
specific point in a specific transcript. And the counts are mechanical, produced by a
model-free script. What is missing is a second coder, and handing five digests to an
outside coder and reporting agreement is a cheap and obvious fix. I would also reframe the
work as a preregistered-hypothesis case study rather than a sample, because that is what it
is."

---

**A16. "Your headline software-engineering numbers, SWE-bench and friends, are known to be
contaminated. Doesn't that undercut the strong half?"**

**This one you should welcome.** Say: "It does, and Section 4.5 is the paper arguing
against its own strong half. SWE-Bench Pro scores about 23 percent where Verified scores
over 70. A re-evaluation of 11,041 patches found 19.78 percent of accepted solutions
semantically incorrect. OpenAI stopped reporting Verified after finding 59.4 percent of 138
audited tasks had material flaws. Claude 4 Opus reproduces benchmark code verbatim in 31.6
percent of instances. That is why my primary evidence matters: our sessions are not a
benchmark and cannot be contaminated by one. The agent fixed bugs in code that did not
exist before we wrote it."

---

**A17. "The agent that did the work also wrote the analysis. Circular."**

Say: "The analysis stage is an LLM reading a deterministic digest, but the digest and every
count come from a model-free script, and every claim is citable to a raw turn. The circle
is in the interpretive labels, not the measurements. And the digest deliberately drops
reasoning traces, `thinking` blocks are replaced with `[thinking omitted]`, so the analysis
is over what the agent *did* and *said*, not over its self-narration."

---

**A18. "What is your unit of analysis and why?"**

Say: "A session, defined as one Claude Code transcript. That unit is imperfect because
sessions vary from 2 to 535 user-role records, and because 15 of them are subagents with a
different character. If I redid it I would use the task episode rather than the session,
and report subagent and human episodes separately."

---

**A19. "178 tasks done, 46 failed. What is a task?"**

**Weak point.** These are LLM-assigned list lengths from `tasks_done` and `tasks_failed` in
each analysis, with no operational definition and no per-session normalization.
`agent-a0` records 7 done from 6 tool calls.

Say: "Undefined, and I would drop those two numbers rather than defend them. They are
list lengths assigned by the analysis stage without an operational definition. The
mechanical counts, tool calls and assistant turns, are the ones that survive scrutiny."

---

**A20. "Your findings file has five section headings and twelve cluster tags that do not
match."**

Say: "Two taxonomies, one from the binning code and one from the finder agents, with no
mapping between them, so some findings are visibly mis-shelved. Finding 33, a multi-agent
software framework result, sits under 'Embodied control'. It is a presentation defect that
does not change any conclusion, and the fix is a mapping table."

---

**A27. "You concluded LLMs are weak at the body, and then you built a system where an LLM
drives a real robot. Doesn't that refute your own paper?"**

**Expect this if the examiner has seen the demo. It is the best question you will get, and
you should want it.**

Say: "The opposite. It is the finding applied. We did not give the model velocity. The
agent can emit exactly two named tricks, `circle` and `spin`; `dock`, `undock`, and
`forward` exist in the schema but are structurally unreachable from any LLM tool. The
choreography is a bounded local primitive, hard-capped at 0.15 m per second and 30 seconds,
executed on the Pi, and the cloud only names it. Eight independent gates sit between a
token and a wheel, every one of them defaulting to deny, including a dock guard where
unknown state counts as docked. There is a hard identity ban that exits the process if
motion is ever enabled for robot 468, enforced in the code, in the systemd template, in the
installer, and in a unit test.

That architecture is not caution for its own sake. It is what the paper's finding tells you
to build. And the system then reproduced the finding on its own: we shipped three bugs where
the agent reported physical success that never happened, including a dead `stop` tool and a
silently killed telemetry thread that left the dock guard blind. Those are better evidence
for the thesis than anything in iteration 1, because they came from a system built by
someone who already believed the thesis and still could not close the verification loop."

---

### Tier 3: framing and viva-craft

---

**A21. "What is the one thing you would do differently?"**

Best answer: "Preregister the coding scheme and the disconfirmation criteria before
assembling the corpus, and have a second coder. Every other defect in this paper is a
build bug I can fix in an afternoon. That one is structural and I cannot fix it
retroactively."

**A22. "What surprised you?"**

Good honest answers, pick one:
- "That the agent's own monitoring consumed 55 percent of the CPU it was diagnosing.
  The observer was part of the system under observation, and nothing in the agent noticed."
- "That the same agent shipped the ROS packages with zero tests and the later web service
  with 445 test functions. It did what it was asked, precisely, in both cases. That is a
  claim about delegation, not capability."
- "That my own verification protocol caught one of its own skeptics hallucinating a source."

**A23. "If you had to defend one number, which?"**

"1,697 tool calls. It is mechanically counted from committed raw transcripts by a
model-free script, and anyone can re-derive it in one command."

**A24. "Where does this go next?"** See Part 9.

**A25. "Why should we believe the corpus is representative of anything?"**

Do not oversell. "It is not a sample and I do not claim external validity. It is a census
of one project's early phase, and its value is that the failure locations are *predicted*
by an independent literature synthesis. Corroboration across two very different evidence
types is the claim; generalization is not."

**A26. "Is your thesis falsifiable?"**

"As stated in the paper, weakly, because the coding was post hoc. Operationally it is
falsifiable and the compass artifact wrote the test: if an agentic loop resolves more than
50 percent of held-out ROS2 bugs with passing tests while also autonomously recovering from
physical execution failures, the asymmetry is falsified for that setting. That experiment
was specified and not run. That is the honest state of it."

---

## Part 8. Fix these before you present

Ordered by ratio of damage prevented to effort.

1. **Relabel "2,153 user turns"** to "user-role records, includes tool results" and add
   "human prompts: approximately 456 (`user_turns - tool_calls`)". Three places:
   abstract, `:27`, `:77`. **Ten minutes, prevents the worst question.**
2. **Delete the refuted ROSClaw sentence** from `verification-log.md` gap 1, and renumber
   every finding cross-reference in the gaps section to match published `findings.md`
   numbering. **Twenty minutes.**
3. **Fix the INDEX join** at `build_outputs.py:142`, normalize the key to a stem so `.md`
   and `.jsonl` match, and rebuild. This un-blanks 9 rows. Then **correct "the heaviest
   robotics-code session"** at `draft-v1.md:90` to `29aff2bd` (535/1,112/401), or say "one
   of the two heaviest". **Thirty minutes.**
4. **Add the subagent disclosure** to the abstract and to Section 5.1: 15 of 30 are
   subagent transcripts, and report the distribution twice, all-30 and human-only-13.
   **One hour, and it converts your biggest vulnerability into evidence of rigor.**
5. **Add a "sessions containing at least one embodied stall" count** alongside the
   `embodied-hardware = 1` category, listing the six stalls from A4.
6. **Add an evidence-tier column** to `findings.md`: peer-reviewed / preprint / grey /
   vendor. Or at minimum state the tier counts in the methodology section.
7. **State the deduplicated finding count** alongside 78: approximately 60 to 65
   independent claims across 50 works, with the seven duplicate clusters named.
8. **Drop or define** "178 tasks done, 46 failed".
9. Optional if time: publish kept-side skeptic vote tallies; add a cluster-to-section
   mapping table; carry FAEA's failure cases (PegInsertion 0 percent) into the draft.

**Do not** attempt to re-run the literature verification or re-code the corpus before the
defense. There is no version of that which finishes, and the current artifacts plus honest
framing beat a half-finished revision.

---

## Part 9. Iteration 2, the answer to "what next"

Have this ready as a concrete plan, not a wish list. It is also the strongest possible
response to A3, A11, A12, and A13.

**Study 1: the controlled ROS2 bug-repair experiment.** The one the compass artifact
specified and nobody ran. Held-out ROS2 bugs, passing-test criterion, stated falsification
threshold at 50 percent. This directly measures the SWE-for-robotics ceiling instead of
inferring it, and it is the only item that makes the thesis properly falsifiable.

**Study 2: the perception-confound ablation.** Replicate a draft-debug-improve policy loop
in simulation with privileged state, then degrade to raw RGB, and measure the drop. This
localizes how much of "weak at the body" is a perception bottleneck versus a reasoning
one. The literature is currently self-contradictory here, findings 47 and 48 against
finding 77, so a clean ablation is a real contribution.

**Study 3: the two-robot coordination task.** Robot 436 exists and has never been used.
This fills the pillar that is currently 100 percent literature.

**Study 4: extend the corpus past 2026-06-22.** This is the cheapest and highest-yield
item, because the data already exists in the same collectable format. Three specific
additions:

- *The LLM actually in the actuation path.* The dog agent POC (176 commits, 2026-07-05 to
  07-07) puts a Bedrock agent behind a closed command vocabulary, a device shadow, a dock
  guard, and a dry-run gate. Iteration 1 has no session where an LLM emits a command that
  moves a robot. This corpus is nothing but that.
- *Three on-thesis failures already recorded.* The dropped-command family (agent reports
  success, publishes nothing, recurring once per new tool, including a silently dead `stop`
  tool), the simulated-ack honesty bug (the agent narrating "simulation mode" while the
  robot physically spun), and the `rclpy` double-init race (silent telemetry thread death
  leaving `docked` unknown, so the dock guard default-denied everything while all health
  checks looked green). All three are the agent unable to verify its own physical effect,
  which is the paper's exact claim, observed in a system built after the paper.
- *Multi-robot at scale, in simulation.* The virtual-world fleet (63 commits, 2026-07-26 to
  07-31) has the same Moses agent commanding roughly 50 virtual guide robots through the
  same IoT topics, with a measured 95-agent load test. That is the coordination pillar,
  currently 100 percent literature, becoming primary evidence. Pair it with Study 3 on
  physical robot 436 and the pillar is covered at both scales.

State the design principle this yields, because it is the contribution the whole project
points at: **one command, two executors.** The agent publishes a bounded named command; the
on-robot bridge turns it into Nav2, and the world server turns it into a crowd target. The
LLM never learns which one it is talking to, which is precisely why it cannot hurt either.

**Method fixes to carry into iteration 2**, stated as method contributions rather than
apologies: preregistered coding scheme with disconfirmation criteria; second coder with
reported agreement; turn-existence validation in the evidence gate; published skeptic vote
tallies; evidence-tier tagging.

---

## Part 10. Quick reference

### Numbers you must have cold

| Quantity | Value | Caveat |
|---|---|---|
| Literature candidates / kept / dropped | 91 / 78 / 13 | 86 percent keep rate; ~60-65 independent claims |
| Unique works / URLs | 50 / 57 | 3 peer-reviewed venues, 22 findings from 2026 preprints, 3 grey lit |
| Sessions | 30 | **15 are subagents**; 13 substantive human sessions |
| User-role records | 2,153 | **~456 actual human prompts** |
| Assistant turns | 4,192 | solid |
| Tool calls | 1,697 | solid, mechanically counted |
| Outcomes | 16 reached / 12 partial / 2 not-reached | 13 of 16 reached are subagents |
| Categories | 21 SWE / 4 mixed / 4 non-technical / 1 embodied-hardware | 15 of 21 SWE are subagents |
| Key-evidence items | 203 across 30 analyses | each with a turn citation |
| Corpus span | 2026-06-03 to 2026-06-22 | project ran to 2026-07-31 |
| Raw corpus | 30 JSONL, 21 MB, committed | `claude-conversations/sessions/` |
| Gate status | PASS, 34 files, exit 0 | verified 2026-08-02 |

### One-line rebuttals

- *"Self-study."* Raw artifacts committed, anyone can re-code. Concede the missing second coder.
- *"n=30."* n=13 human sessions, and the conclusion survives the stricter cut.
- *"LLM-verified literature."* One refute kills a finding; the protocol caught its own skeptic hallucinating (drop 10).
- *"SWE-bench is contaminated."* Agreed, Section 4.5 argues it; our corpus cannot be contaminated by a benchmark.
- *"You never tested control."* Correct. Scope is the integration and verification boundary. The literature carries the inner loop.
- *"No coordination evidence."* Correct, and robot 436 is iteration 2.
- *"Zero disconfirming cases."* The strongest criticism. Concede, state the criteria, cite the unrun falsification test.

### Glossary for a non-robotics examiner

- **Frontier**: a free grid cell adjacent to unknown space. Driving to frontiers is how a
  robot decides where to explore next.
- **Nav2 / slam_toolbox**: the ROS 2 navigation stack and the SLAM package. SLAM builds the
  map and localizes; Nav2 plans and executes paths.
- **`scan_fused`**: our fused laser scan, lidar with depth-camera obstacles min-injected,
  used by both the costmap and SLAM.
- **Costmap versus SLAM map**: the costmap is transient runtime obstacle state; the SLAM
  map is the persistent artifact. Putting glass in the SLAM map means it survives a restart.
- **Device shadow / dock guard**: the AWS IoT state document and the safety gate that
  refuse motion unless the robot is explicitly armed and undocked.
- **Privileged state**: an agent reading ground-truth simulator state instead of raw
  sensor data. It is the central confound in embodied benchmark results.

---

*Sources: `Research/draft-v1.md`, `Research/literature/findings.md`,
`Research/literature/verification-log.md`, `Research/conversation-analysis/INDEX.md`,
`stats.json`, `_analyses.json`, `Research/tools/{build_digests,build_outputs,evidence_gate}.py`,
`Research/compass_artifact_wf-96c5cc40-*.md`, `docs/camera.md`, `docs/mapping/`,
`docs/network/`, `docs/superpowers/specs/2026-07-06-motion-bringup-bisection-ladder.md`,
`src/guide_mate_explorer/`, `src/guide_mate_perception/`, and repository git history.*
