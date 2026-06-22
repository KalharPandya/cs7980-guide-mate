---
name: collect-claude-conversations
description: Use when asked to collect, archive, snapshot, back up, or update the Claude Code conversation/session transcripts ("conversations with the cloud") for this repo — runs the configurable collector that slims the JSONL, redacts secrets, verifies no credentials leak, and commits the result.
---

# Collect Claude Conversations

Archive this project's Claude Code session transcripts into the repo as slimmed,
**secret-free** JSONL. Wraps `scripts/collect_claude_conversations.py`.

## When to use

- "collect / archive / back up / update our Claude conversations"
- "snapshot the AI sessions for this repo"
- "refresh the claude-conversations archive"
- Periodically, to keep `claude-conversations/sessions/` current.

## Where everything lives (the proper place)

Collected transcripts are committed to the repo here — always write them to this
location, never anywhere else:

```
cs7980-guide-mate/
├─ claude-conversations/
│  ├─ sessions/                      # ← OUTPUT: slimmed, redacted JSONL goes HERE
│  │   └─ <YYYY-MM-DD>_<id8>.jsonl   #    one file per Claude session
│  ├─ collect.config.json           # which directories to collect
│  └─ README.md                     # full reference
├─ scripts/
│  ├─ collect_claude_conversations.py        # the collector
│  ├─ test_collect_claude_conversations.py   # test suite
│  └─ git-hooks/pre-commit                   # secret gate hook
└─ .claude/skills/collect-claude-conversations/SKILL.md   # this skill
```

The default output dir (`claude-conversations/sessions/`) is resolved relative
to the script's own location, so it is correct on every laptop. Only override it
with `--out` for testing — committed archives must stay under
`claude-conversations/sessions/`.

## What it does

1. Scans `~/.claude/projects/**` (honors `CLAUDE_CONFIG_DIR`).
2. Keeps sessions whose recorded `cwd` matches the configured include
   directories (matched by path/basename, so it is laptop-independent).
3. Writes slimmed JSONL to `claude-conversations/sessions/<date>_<id8>.jsonl`:
   strips internal metadata, **keeps images and conversation content**.
4. **Redacts secrets** (AWS keys/tokens, private keys, GitHub/OpenAI/Stripe/Slack/
   Google tokens, JWTs, auth headers, `user:pass@` URLs, `key=secret`
   assignments, etc.) and runs a **verification gate** that exits non-zero if
   any known secret remains.

## Steps

Run from the repo root.

1. **Preview** what will be collected:
   ```bash
   python scripts/collect_claude_conversations.py --dry-run
   ```

2. **Collect** (writes + redacts + verifies). A clean run prints
   `Security gate  : PASS` and exits 0:
   ```bash
   python scripts/collect_claude_conversations.py
   ```
   If it prints `SECURITY GATE FAILED` (exit 3), DO NOT commit — investigate the
   reported file/fragment and extend `SECRET_PATTERNS` in the script, then re-run.

3. **Run the tests** (must stay green; they include the credential corpus):
   ```bash
   python scripts/test_collect_claude_conversations.py
   ```

4. **Final independent audit** before committing:
   ```bash
   python scripts/collect_claude_conversations.py --verify-only
   ```

5. **Commit & push.** Per the repo owner's global rule, the commit message MUST
   include "Kalhar" and MUST NOT reference Claude/AI:
   ```bash
   git add -A
   git commit -m "Kalhar: Update Claude conversation archive"
   git push origin main
   ```

## Configuring which directories are collected

Edit `claude-conversations/collect.config.json`:
```json
{ "include": ["Project-code", "cs7980-guide-mate"] }
```
Or override ad-hoc: `--include "<abs path or folder name>"` (repeatable).
Resolution priority: `--include` > `--config` > `collect.config.json` >
`CLAUDE_COLLECT_INCLUDE` env > built-in defaults.

## Useful flags

| Flag | Effect |
| --- | --- |
| `--include PATH_OR_NAME` | Directory to collect (repeatable). |
| `--dry-run` | Report only; write nothing. |
| `--trim-tool-results` | Shrink large tool-output payloads. |
| `--drop-snapshots` | Drop file-history-snapshot lines. |
| `--verify-only` | Audit existing archive for secrets (exit 3 on hit). |
| `--no-redact` / `--no-verify` | Disable defenses — **never** for the public repo. |

## Guardrails

- Never commit with `--no-redact`/`--no-verify` output to this public repo.
- If the verify gate fails, fix `SECRET_PATTERNS` and re-run; do not bypass it.
- Pattern matching can't catch every secret format — glance at new transcripts
  before pushing.
- Enable the blocking hook once per clone: `git config core.hooksPath scripts/git-hooks`.

See `claude-conversations/README.md` for full details.
