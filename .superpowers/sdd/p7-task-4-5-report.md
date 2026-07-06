# Phase 7 Tasks 4 & 5 — EC2 launch/bootstrap + redeploy/teardown scripts

**Status:** COMPLETE (scripts only; no real AWS mutations performed).

## Deliverables
- `agent_service/deploy/user_data.sh` — verbatim from Task-4 brief (Docker + Compose v2 plugin, CloudWatch agent for mem/disk, clone repo, write `/etc/guidemate.env` under `umask 077`, `docker compose ... up -d --build`).
- `agent_service/deploy/launch_ec2.sh` — Task-4 brief + a `--plan` dry-run flag (adaptation, see below).
- `agent_service/deploy/redeploy.sh` — verbatim from Task-5 brief (single SSM `send-command`, no SSH key).
- `agent_service/deploy/teardown.sh` — verbatim from Task-5 brief (`--keep-eip` opt-out).
- `docs/agent-poc/access-ground-truth.md` — appended `## Phase 7 — production (EC2 + observability)` section (brief table + `--plan` note + no-default-VPC warning).
- All four scripts `chmod +x`.

## Verification (per contract)
- **`bash -n`** all four → `bash -n OK` for user_data.sh, launch_ec2.sh, redeploy.sh, teardown.sh.
- **shellcheck** — NOT installed on this box (`command -v shellcheck` → none). Manual review done: only known warning is unused `TAG` var in launch_ec2.sh (kept verbatim per brief; SC2034, cosmetic).
- **`--plan` dry run** against real AWS (account 852373397000, role `guidemate-agent-role`, us-west-2). Read-only lookups executed for real; every mutation printed only:
  - double-launch guard: `describe-instances` → no running tagged instance.
  - `describe-vpcs isDefault=true` → **None** (see concern).
  - `describe-security-groups guidemate-poc-sg` → not found → `[PLAN] would create-security-group` + 3 `authorize-ingress` (80/443 world, 22 from launcher IP 207.102.87.218/32).
  - `describe-addresses Name=guidemate-poc-eip` → not found → `[PLAN] would allocate-address`.
  - `ssm get-parameter` AL2023 AMI → **ami-0b0b27dd5c039480f** (real).
  - `run-instances` / `wait` / `associate-address` → printed, not executed. Exit 0, "no resources created".
  - No secret printed in plan mode (password shown as `<generated-at-launch:openssl rand -hex 16>` placeholder).

## Adaptations
1. **`--plan` flag on launch_ec2.sh** (required by the verification contract). Read-only discovery/idempotency lookups run for real; mutating calls print `[PLAN] would run: aws ...` and the script exits before render/run. In plan mode the admin password is a placeholder (never generates/prints a real secret). Real mode is byte-faithful to the brief's flow.
2. Added two `echo` lines confirming resolved AMI id and EIP→domain for operator visibility (non-functional).

## Secret handling
- `GUIDEMATE_ADMIN_PASSWORD` generated via `openssl rand -hex 16` in real mode only; written solely to the instance's `/etc/guidemate.env` (via user-data, `umask 077`) and surfaced ONCE in the launcher's final banner. Never committed, never printed in `--plan`.

## Concerns (for Task-7 launch operator)
- **NO DEFAULT VPC in us-west-2** (verified): account has only `vpc-0657dd5b506f043a9` (non-default), so `describe-vpcs Name=isDefault,Values=true` returns empty → `VPC_ID=None`. As written (verbatim per brief) `create-security-group --vpc-id None` and `run-instances` (no subnet) **will fail**. Before the real launch, the script needs a `--vpc-id`/`--subnet-id` for that VPC (or a default VPC created). Flagged in access-ground-truth.md. Not fixed here to stay faithful to the "scripts verbatim" mandate.
- shellcheck unavailable — could not machine-lint; `bash -n` + manual review only.

## Not done (out of scope per task)
- No real EC2 launch (Task 7, controller-run).
- `scripts/setup_observability.sh` referenced by the launch banner is a separate task's deliverable.
