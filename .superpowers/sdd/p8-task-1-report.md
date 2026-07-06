# Phase-8 Task 1 report — Sim IoT identity (Turtlebot-Sim)

**Status:** DONE. Sim IoT identity provisioned FOR REAL against AWS (account 852373397000, us-west-2) and verified. Idempotency proven.

## Deliverables
- `scripts/create_sim_identity.sh` (chmod +x, `bash -n` clean, idempotent).
- `src/guide_mate_bridge/tests/test_sim_identity.py` — 3 tests, all pass.
- `docs/agent-poc/access-ground-truth.md` — appended "Sim identity (Turtlebot-Sim)" section.

## AWS resources created (verified ids)
- **Thing:** `Turtlebot-Sim`, thingId `28f0f996-6acf-4239-b180-9babae1b947a`, ARN `arn:aws:iot:us-west-2:852373397000:thing/Turtlebot-Sim`.
- **Policy:** `guidemate-sim-policy` (tag `project=guidemate-poc`) — client `guidemate-*`; pub/sub/receive scoped to `guidemate/turtlebotsim/*` + `$aws/things/Turtlebot-Sim/shadow/*` only.
- **Cert:** ARN `...:cert/e50b6fc6e1be8d2a29ec95166abcb53b080729b3a595e79083c7df23a3eaaefc` — active, attached to thing + policy. Local files `~/.aws/guidemate-sim.cert.pem` + `~/.aws/guidemate-sim.key.pem`, perms `600`, NOT committed (outside repo tree).
- **Classic shadow:** desired `{motion_enabled:false, max_speed:0.15, dry_run:true}` (default-deny) — confirmed via `get-thing-shadow`.

## Idempotency evidence
Re-run output: thing "already exists — skipping create", policy "already exists — skipping create", cert "already present — reusing (no new cert minted)". Post-re-run `list-thing-principals` → exactly **1** principal (no second cert). Shadow re-applied idempotently to same locked values.

## Safety
- No reference to the real robot's literal identity in the script (`grep turtlebot468/Turtlebot-468` clean). Robot 468 verified intact post-run (`describe-thing Turtlebot-468` → `Turtlebot-468`), untouched.
- Certs/keys live in `~/.aws` outside the repo; `git status` shows only the 3 intended files; no PEM/key material in the repo tree.

## Concerns / deviations
1. **Brief internal contradiction:** the verbatim script comment contained the literal `turtlebot468`, but the brief's own test asserts `"turtlebot468" not in text`. The test is the executable spec, so I reworded the two comment lines to "the real robot" (intent preserved, no behavior change). Test now passes.
2. **Thing tagging unsupported by AWS IoT:** `tag-resource` on an individual `thing` fails with `InvalidRequestException: Invalid resource type in ARN: thing` (IoT only tags thing-groups/types/billing-groups, not things). The script's `|| true` absorbs it by design; the **policy** carries the `project=guidemate-poc` tag instead. Documented in access-ground-truth.md.
