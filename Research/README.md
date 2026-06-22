# Research: Can AI and Multi-Agent Systems Develop and Debug Robotics Software?

This folder holds research iteration 1 for the CS7980 question above. The whole
output is held to one evidence standard: every factual claim traces either to a
literature source whose URL was adversarially fetched and confirmed, or to a
specific conversation cited as `(file, date, turn)` and backed by a raw
transcript. There are no em-dashes and no unevidenced claims.

## Read this first

- `draft-v1.md` is the first researched output (goal, methodology, literature
  review, our-conversations-as-evidence, discussion, limitations, references).

## Layout

```
Research/
  draft-v1.md                       # the iteration-1 report
  compass_artifact_...md            # preliminary literature review (input)
  literature/
    findings.md                     # 78 verified findings, each with a source URL
    verification-log.md             # 13 dropped findings (failed URL check) + gaps
  conversation-analysis/
    INDEX.md                        # aggregate metrics + per-conversation roll-up
    <session>.md                    # one analysis per conversation, cited to raw turns
    _digests/<session>.txt          # deterministic, citable digest of each transcript
    _analyses.json                  # compact machine-readable analyses
    stats.json                      # measured counts (turns, tool calls) per session
  tools/
    build_digests.py                # Stage 0: transcript -> citable digest + stats
    build_outputs.py                # parse workflow result -> findings/INDEX
    evidence_gate.py                # fails if any em-dash or untraceable analysis
```

## How it was produced (reproducible)

1. Collect and redact transcripts: `python scripts/collect_claude_conversations.py`
   (see the `collect-claude-conversations` skill). Raw transcripts live in
   `claude-conversations/sessions/`.
2. Build digests and measured stats: `python Research/tools/build_digests.py`.
3. Multi-agent analysis and adversarially-verified internet research produced
   the per-conversation analyses and `literature/findings.md`.
4. Synthesis wrote `draft-v1.md`, then an adversarial citation audit checked
   every claim.
5. Gate: `python Research/tools/evidence_gate.py` (must pass before commit).

## The evidence gate

`evidence_gate.py` scans the report files and fails the build if it finds any
em-dash, any conversation analysis that does not reference its raw transcript,
or a draft with no web citations. Run it before committing changes here.

## Headline finding (iteration 1)

The literature and our own 30 sessions agree: AI and agent systems are strong at
the software-engineering side of robotics (write, run, read error, fix on real
ROS2 code) and weak at the embodied runtime (verifying motion, docking, surviving
hardware power limits). Of 30 sessions, 21 are software-engineering work, 22 ran
at high automation, and 26 of 28 non-empty sessions reached or partially reached
their goal, while the stalls cluster exactly at the embodiment boundary. See
`draft-v1.md` for the full argument with citations.
