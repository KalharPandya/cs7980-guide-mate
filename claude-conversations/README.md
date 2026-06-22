# Claude Conversations Archive

Version-controlled, slimmed copies of the **Claude Code session transcripts**
("conversations with the cloud") for the GuideMate project, so the team's AI
working history is preserved in the repo and reproducible on any laptop.

```
claude-conversations/
  README.md                 # this file
  collect.config.json       # which directories to collect (edit this)
  sessions/                 # slimmed JSONL, one file per session
    YYYY-MM-DD_<id8>.jsonl
scripts/
  collect_claude_conversations.py        # the collector/stripper
  test_collect_claude_conversations.py   # test suite (stdlib unittest)
```

## What it does

Claude Code stores every session as a JSONL transcript under
`~/.claude/projects/<encoded-path>/<session-id>.jsonl`. The collector:

1. Scans every session under your Claude projects directory.
2. Keeps only sessions whose recorded working directory (`cwd`) matches a
   **configured include** (see below). It matches on `cwd` from inside the
   file, **not** on the per-machine encoded folder name — so it works the same
   on every laptop regardless of where the repo is checked out.
3. Writes a **slimmed JSONL** copy per session into `sessions/`.

### What is stripped vs kept

| Kept (conversation content)                              | Stripped (internal noise)                                   |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| user / assistant messages (full text)                    | `uuid`, `parentUuid`, `leafUuid`, `messageId`, `requestId`  |
| **images** (base64 attachments, untouched)               | `sessionId`, `promptId`, `version`, `entrypoint`            |
| tool results, file snapshots, `gitBranch`, `timestamp`   | `userType`, `isSidechain`, `isMeta`, attribution metadata   |
| `ai-title`                                               | whole `mode` / `permission-mode` / `system` / queue lines   |

By design this strips **internal metadata only** and **keeps images**, so size
reduction is modest (~90% of original). To shrink further, see the flags below.

## Security: no secrets reach git

These transcripts can contain credentials that were shown during a session, so
the collector has a multi-layer secret defense and **nothing sensitive is meant
to reach GitHub**:

1. **Redaction (on by default).** Every string value is scrubbed against a
   broad set of high-precision patterns — AWS keys/secrets/session tokens and
   SigV4 presigned signatures, private keys (RSA/EC/OpenSSH/PGP), GitHub /
   OpenAI / Stripe / Slack / Google tokens, JWTs, `Bearer`/`Basic` auth headers,
   credentials embedded in `scheme://user:pass@` URLs, generic
   `api_key=` / `secret:` / `password=` assignments, and backtick-quoted
   passwords. Image base64 data is never touched.
2. **Verification gate (on by default).** After writing, the output is
   re-scanned with the same patterns. If *anything* known slips through, the
   run prints `SECURITY GATE FAILED` and exits non-zero (3) — so a successful
   run provably contains no known secret.
3. **Standalone audit.** `--verify-only` scans the existing archive without
   collecting, for use in CI or a pre-commit hook.
4. **Pre-commit hook.** `scripts/git-hooks/pre-commit` runs the gate and blocks
   the commit on any hit. Enable it once per clone:
   ```bash
   git config core.hooksPath scripts/git-hooks
   ```

The redaction/verification patterns live in `SECRET_PATTERNS` at the top of
`scripts/collect_claude_conversations.py` — add project-specific patterns there.
Pattern-based scanning cannot guarantee detection of *every* conceivable secret
format, so still glance at new transcripts before pushing.

## Usage

```bash
# default: collect the directories listed in collect.config.json
python scripts/collect_claude_conversations.py

# preview without writing anything
python scripts/collect_claude_conversations.py --dry-run

# collect specific directories ad-hoc (absolute path OR bare folder name)
python scripts/collect_claude_conversations.py --include "P:/CS7980/Project-code"
python scripts/collect_claude_conversations.py --include cs7980-guide-mate --include Project-code

# optionally shrink large tool output / drop file snapshots
python scripts/collect_claude_conversations.py --trim-tool-results --drop-snapshots

# audit an already-collected archive for residual secrets (exit 3 if any)
python scripts/collect_claude_conversations.py --verify-only
```

| Flag | Effect |
| --- | --- |
| `--include PATH_OR_NAME` | Directory to collect (repeatable). Overrides config/env/defaults. |
| `--config FILE` | JSON config file with an `include` list. |
| `--out DIR` | Output directory (default `claude-conversations/sessions`). |
| `--projects-dir DIR` | Override the Claude projects dir to scan. |
| `--dry-run` | Report what would happen; write nothing. |
| `--trim-tool-results` | Shrink large tool output payloads. |
| `--drop-snapshots` | Drop file-history-snapshot lines. |
| `--no-redact` | Disable secret redaction (**not** for public repos). |
| `--no-verify` | Skip the post-write secret gate. |
| `--verify-only` | Only audit the output dir for secrets; exit 3 on any hit. |

The script is **idempotent** — re-run it any time to refresh the archive, then
commit the changes.

## Configuring which directories are collected

A human or a running agent picks the directories. Resolution priority:

1. `--include` CLI flags (repeatable) — highest priority
2. `--config <file>` (JSON with an `"include"` list)
3. `claude-conversations/collect.config.json` (auto-loaded if present) ← **edit this for the default**
4. `CLAUDE_COLLECT_INCLUDE` environment variable (`os.pathsep`-separated)
5. Built-in defaults (`Project-code`, `cs7980-guide-mate`)

Each include entry is either:
- an **absolute path** (`P:/CS7980/Project-code`) — matches that directory and
  anything beneath it, or
- a **bare folder name** (`cs7980-guide-mate`) — matches by folder basename,
  which is path-independent and the most portable across machines.

### `collect.config.json`

```json
{
  "include": ["Project-code", "cs7980-guide-mate"]
}
```

Add any other project directory name/path you want archived.

## Reusing on a different laptop

1. Clone this repo and ensure Python 3.8+ is installed (no third-party deps).
2. If your Claude config is in a non-standard place, set `CLAUDE_CONFIG_DIR`
   (or pass `--projects-dir`).
3. Edit `collect.config.json` if the folder names differ.
4. Run `python scripts/collect_claude_conversations.py` and commit the result.

## Tests

```bash
python scripts/test_collect_claude_conversations.py
```

Covers cwd matching (basename / absolute / subtree / case-insensitive),
metadata stripping, image preservation, snapshot & tool-result handling,
idempotency, dry-run, include resolution (CLI / config / env / default), and an
**extensive credential corpus** (~25 secret formats) proving each is detected,
redacted, gone after redaction, and that the end-to-end gate leaves zero secrets
on disk while benign prose is left untouched.
