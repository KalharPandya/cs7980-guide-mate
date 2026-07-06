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

---

## Follow-up (VPC-aware launch fix) — 2026-07-05

**Blocker:** account 852373397000 / us-west-2 has **NO default VPC** (only non-default
`vpc-0657dd5b506f043a9`). The original `describe-vpcs --filters Name=isDefault,Values=true`
returned nothing, so `VPC_ID` came back empty/`None` → `create-security-group` and
`run-instances` would have failed.

**Fix (launch_ec2.sh only; teardown.sh looks the SG up by group-name with no vpc-id filter,
so it does NOT reference SG-by-VPC and needed no change):**
1. **VPC resolution order:** `GUIDEMATE_VPC_ID` env override → default VPC if one exists →
   if exactly ONE VPC exists, use it → else fail listing all VPCs.
2. **Public-subnet resolution:** `GUIDEMATE_SUBNET_ID` env override → else scan the VPC's
   subnets for one whose route table (explicit association, else the VPC main table) has a
   `0.0.0.0/0` route to an `igw-*`; prefer `MapPublicIpOnLaunch=true` (a public-routed but
   non-auto-assign subnet is a fallback) → else fail with the subnet list + guidance.
3. Threaded through: `create-security-group --vpc-id ${VPC_ID}` (already present), and
   `run-instances --subnet-id ${SUBNET_ID} --associate-public-ip-address` (needed for the
   EIP association + outbound pulls in a non-default VPC).
4. `--plan` now prints the resolved VPC + subnet and the subnet/public-IP flags in the
   run-instances note.

**Real `--plan` dry run (read-only, verified):**
- Resolve VPC → `no default VPC; using the only VPC vpc-0657dd5b506f043a9`.
- Resolve PUBLIC subnet → `public subnet subnet-0e8b386d25f67d9a7`
  (both subnets in the VPC are explicitly associated to `rtb-0da8005ecb82217d9`, which has
  `0.0.0.0/0 -> igw-04987548bc6ed1c4c`, and both are `MapPublicIpOnLaunch=true`; the loop
  picks the first, `subnet-0e8b386d25f67d9a7` in us-west-2a).
- run-instances plan note now includes `--subnet-id subnet-0e8b386d25f67d9a7
  --associate-public-ip-address`. Exit 0, no resources created.

**`bash -n`:** `launch_ec2.sh` OK, `teardown.sh` OK.

---

## Security hardening (deploy secrets) — 2026-07-05

Security-review findings fixed in `agent_service/deploy/`.

**Critical — admin password was embedded in EC2 user-data** (API-readable via
`ec2:DescribeInstanceAttribute` for the instance lifetime). Fixed:
- `launch_ec2.sh` no longer generates a password or substitutes `@@ADMIN_PW@@` — the
  variable, the generation block, and the sed substitution are gone (grep `ADMIN` in
  `launch_ec2.sh` = 0 hits). Final banner now tells the operator to retrieve it via
  `aws ssm get-parameter --name /guidemate/admin-password --with-decryption ...`.
- `user_data.sh` mints it **on the instance** (`ADMIN_PW="$(openssl rand -hex 16)"`),
  seeds the env file with `install -m 600 /dev/null /etc/guidemate.env` then appends, and
  pushes it to **SSM Parameter Store** as a SecureString
  (`aws ssm put-parameter --name /guidemate/admin-password --type SecureString --overwrite`).

**Important — xtrace leaked the password to a world-readable log.** `user_data.sh`
`set -euxo pipefail` → `set -euo pipefail` (no `x`), plus `chmod 640
/var/log/guidemate-bootstrap.log` right after the `exec … tee` line.

**Important — `teardown.sh` terminated on bare invocation.** Now requires `--yes`; a bare
run (or `--keep-eip` alone) prints what WOULD be deleted and exits 1. Unknown args exit 2.

**Minors:** teardown SG lookup gained `Name=tag:project,Values=guidemate-poc`; `launch_ec2.sh`
warns (and skips the 22/32 rule) if `checkip` returns empty; unused `TAG` var removed.

**Docs:** `docs/agent-poc/access-ground-truth.md` Phase-7 section documents the SSM
SecureString parameter + retrieval command and the teardown `--yes` gate.

**Verification:**
- `bash -n`: `launch_ec2.sh` OK, `user_data.sh` OK, `teardown.sh` OK.
- `./launch_ec2.sh --plan` (real, read-only): resolves VPC `vpc-0657dd5b506f043a9` +
  public subnet `subnet-0e8b386d25f67d9a7`, exit 0, no password value anywhere in output
  (only the informational "generated ON THE INSTANCE / stored in SSM" lines).
- `grep '@@ADMIN' agent_service/deploy` = 0 hits; `grep ADMIN launch_ec2.sh` = 0 hits.
- `./teardown.sh` (bare) prints dry-run and exits 1; `--bogus` exits 2.
