# Linux-Box Agent — Warm-up Instructions

Copy the **prompt** below into a fresh Claude Code session on the Linux machine. It assumes
the credential files were transferred out-of-band first (see the transfer list at the bottom
— they are secrets and must never enter the repo).

---

## The prompt

You are joining the **cs7980 guide-mate dog agent POC** as the Linux-box agent. Multiple
Claude sessions (Windows laptop, on-robot Pi, you) collaborate through the git repo — it is
the single source of ground truth. Work on branch **`kalhar/dog-agent-poc`**.

Do these steps in order and report the result of each verification:

1. **Credential files** (should already be on this machine, transferred out-of-band):
   - SSH key → `~/.ssh/guidemate_key`, run `chmod 600 ~/.ssh/guidemate_key`
   - AWS dev cert trio → `~/.aws/guidemate-dev.cert.pem`, `~/.aws/guidemate-dev.private.key`
     (`chmod 600`), `~/.aws/iot-credential-process.py`
   If any are missing, STOP and ask for the transfer.
2. **Repo:** `git clone https://github.com/KalharPandya/cs7980-guide-mate.git`
   (or `git pull` if it exists), then `git checkout kalhar/dog-agent-poc`.
3. **Read, in this order** (non-negotiable — they carry hard-won gotchas):
   `CLAUDE.md` (note the "ACTIVE: dog agent POC" section),
   `docs/agent-poc/HANDOFF-2026-07-05.md`,
   `docs/agent-poc/access-ground-truth.md`,
   `docs/superpowers/specs/2026-07-05-dog-agent-architecture-design.md`.
4. **SSH to the robot:** add to `~/.ssh/config`:
   ```
   Host guidemate
       HostName 10.247.204.21
       User ubuntu
       IdentityFile ~/.ssh/guidemate_key
       IdentitiesOnly yes
   ```
   Verify: `ssh guidemate 'hostname && sudo -n true && echo SUDO-OK'`
   → expect `turtlebot-van-468` + `SUDO-OK`. Host-key fingerprints to accept are listed in
   the handoff doc.
5. **AWS (permanent, cert-based):** edit `~/.aws/iot-credential-process.py` only if your
   paths differ; then write `~/.aws/config`:
   ```
   [default]
   region = us-west-2
   credential_process = python3 /home/YOURUSER/.aws/iot-credential-process.py
   ```
   Verify: `aws sts get-caller-identity` → Arn contains
   `assumed-role/guidemate-agent-role/`. Then verify Bedrock:
   `aws bedrock-runtime converse --model-id us.anthropic.claude-sonnet-4-6 --messages '[{"role":"user","content":[{"text":"Say OK"}]}]' --inference-config '{"maxTokens":10}'`
6. **On-robot Claude (optional relay):**
   `ssh guidemate 'cd ~/cs7980-guide-mate && claude -p "Reply READY"'` should print `READY`.

**Hard rules:**
- ⚠️ Robot 468 is **docked and unobserved: NO MOTION EVER** — no `cmd_vel`, no
  undock/dock/navigate, no motion primitives — until a human observer explicitly enables
  motion. Motion is default-deny by design (Device Shadow `motion_enabled=false` + dock
  guard); do not change those flags.
- On the Pi: read-only unless the task requires otherwise; never `pkill -f` (gotcha #6);
  ROS-side nodes must run from the robot's own terminal (Discovery-Server gotcha).
- Git: `Kalhar` in every commit message; **never** any Claude/AI co-author references. No
  credentials in the repo. Pull before working, push after committing — other sessions
  depend on it.
- AWS: us-west-2, pin Bedrock model `us.anthropic.claude-sonnet-4-6`. Shared sandbox
  account — treat cloud resources as rebuildable; source of truth stays in the repo.

When all verifications pass, report the results, then continue with the current state of
work in `docs/agent-poc/` (see "State of work" in the handoff; if an implementation plan
exists under `docs/superpowers/plans/`, follow it — otherwise coordinate via the repo).

---

## Files to transfer out-of-band (from the Windows laptop)

| File on laptop | Destination on Linux box | Mode |
|---|---|---|
| `P:\CS7980\Project-code\cs7980-guide-mate\ssh_keys\agent_ed25519` | `~/.ssh/guidemate_key` | 600 |
| `C:\Users\kalha\.aws\guidemate-dev.cert.pem` | `~/.aws/guidemate-dev.cert.pem` | 644 |
| `C:\Users\kalha\.aws\guidemate-dev.private.key` | `~/.aws/guidemate-dev.private.key` | 600 |
| `C:\Users\kalha\.aws\iot-credential-process.py` | `~/.aws/iot-credential-process.py` | 700 |

(Alternative to copying the cert trio: mint a fresh cert on the Linux box —
`aws iot create-keys-and-certificate --set-as-active` then
`aws iot attach-policy --policy-name guidemate-credentials-policy --target <new-cert-arn>` —
requires temporarily valid AWS creds there, e.g. one `aws login`.)
