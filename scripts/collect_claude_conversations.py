#!/usr/bin/env python3
"""
collect_claude_conversations.py

Collect Claude Code session transcripts ("conversations with the cloud") that
belong to one or more chosen project directories, strip internal-metadata
noise, and write slimmed JSONL copies into this repo so they are
version-controlled and portable across laptops.

Design goals (see claude-conversations/README.md):
  * Configurable: a human OR a running agent decides which directory/directories
    to include. Includes can be given as absolute paths or as bare folder names
    and are resolved (in priority order) from:
        1. --include CLI flags (repeatable)
        2. --config <file>            (JSON: {"include": [...], ...})
        3. claude-conversations/collect.config.json   (auto-loaded if present)
        4. CLAUDE_COLLECT_INCLUDE env var (os.pathsep separated)
        5. built-in DEFAULT_INCLUDES
  * Portable: works on Windows, WSL, Linux, macOS. It does NOT rely on the
    path-encoded project folder name (which differs per machine); it matches on
    the `cwd` recorded inside each session's JSONL.
  * Slimmed JSONL: keeps the full conversation (text + images + tool results +
    file snapshots) but drops internal plumbing keys (uuids, requestIds, etc.)
    and pure-metadata event lines (mode/permission-mode/etc.).
  * Idempotent & automatic: after configuration it does everything itself;
    re-running just refreshes the output. Safe to run on any laptop.

Examples:
  python scripts/collect_claude_conversations.py
  python scripts/collect_claude_conversations.py --include "P:/CS7980/Project-code"
  python scripts/collect_claude_conversations.py --include cs7980-guide-mate --include Project-code
  python scripts/collect_claude_conversations.py --dry-run
  python scripts/collect_claude_conversations.py --trim-tool-results --drop-snapshots

Defaults match the agreed design: strip internal metadata only, KEEP images.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------- #
# Configuration                                                               #
# --------------------------------------------------------------------------- #

# Default directories to collect when nothing else is configured. Each entry is
# matched against a session's recorded `cwd`: an absolute path matches that
# directory (or anything beneath it); a bare name matches by folder basename
# (path-independent across laptops).
DEFAULT_INCLUDES = [
    "Project-code",        # outer GuideMate working directory
    "cs7980-guide-mate",   # this subrepo
]

# Whole event-line `type`s that carry no conversation content -> dropped.
DROP_LINE_TYPES = {
    "mode",
    "permission-mode",
    "queue-operation",
    "last-prompt",
    "system",
}

# Internal-metadata keys stripped from every kept line. Conversation content
# (`message`, `attachment`, `snapshot`, `toolUseResult`, `timestamp`, `cwd`,
# `gitBranch`, `type`, `aiTitle`) is preserved.
STRIP_KEYS = {
    "uuid", "parentUuid", "leafUuid", "messageId", "requestId", "sessionId",
    "promptId", "promptSource", "sourceToolUseID", "sourceToolAssistantUUID",
    "toolUseID", "version", "entrypoint", "userType", "isSidechain", "isMeta",
    "isSnapshotUpdate",
}

# Max characters kept per tool_result / toolUseResult text when
# --trim-tool-results is enabled.
TOOL_RESULT_MAX_CHARS = 2000

AUTO_CONFIG_NAME = "collect.config.json"
ENV_INCLUDE = "CLAUDE_COLLECT_INCLUDE"

# High-precision secret patterns redacted from every string value before the
# transcript is written (these archives may be pushed to a public repo). Image
# base64 data is never touched. Redaction is ON by default; disable with
# --no-redact. The SAME patterns drive the post-write verification gate, so a
# clean (exit 0) run guarantees none of these appear in the output.
#
# Every replacement contains the literal token "REDACTED" — the verifier skips
# any match containing it, so redacted output never re-flags (convergence) while
# a genuinely missed secret still trips the gate.
SECRET_PATTERNS = [
    # --- AWS ---
    (re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b"),
     "[REDACTED_AWS_KEY_ID]"),
    (re.compile(r"(?i)(aws_secret_access_key|aws_session_token|aws_security_token)"
                r"(\s*[=:]\s*)[\"']?[A-Za-z0-9/+=]{20,}[\"']?"), r"\1\2[REDACTED]"),
    (re.compile(r"(?i)(X-Amz-Signature=)[0-9a-f]{16,}"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(X-Amz-Security-Token=)[^&\s\"']+"), r"\1[REDACTED]"),
    # --- private keys (RSA/EC/DSA/OpenSSH/PGP) ---
    (re.compile(r"(?is)-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----.*?"
                r"-----END [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----"), "[REDACTED_PRIVATE_KEY]"),
    # --- provider tokens ---
    (re.compile(r"\bgithub_pat_[0-9A-Za-z_]{20,}\b"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b"), "[REDACTED_STRIPE_KEY]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"), "[REDACTED_API_KEY]"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"), "[REDACTED_SLACK_TOKEN]"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"), "[REDACTED_GOOGLE_API_KEY]"),
    (re.compile(r"\bya29\.[0-9A-Za-z_-]{20,}\b"), "[REDACTED_GOOGLE_OAUTH]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
     "[REDACTED_JWT]"),
    # --- auth headers ---
    (re.compile(r"(?i)(Bearer\s+)[A-Za-z0-9._-]{20,}"), r"\1[REDACTED]"),
    (re.compile(r"(?i)(Authorization:\s*Basic\s+)[A-Za-z0-9+/=]{12,}"), r"\1[REDACTED]"),
    # --- credentials embedded in URLs (postgres://user:pass@, mongodb://, etc.) ---
    (re.compile(r"\b([a-z][a-z0-9+.-]*://[^:/\s\"']+):[^@/\s\"']+@"), r"\1:[REDACTED]@"),
    # --- generic secret assignments (key = value) ---
    (re.compile(r"(?i)\b(api[_-]?key|secret|secret[_-]?key|client[_-]?secret|"
                r"access[_-]?token|refresh[_-]?token|auth[_-]?token|passphrase|"
                r"passwd|password)\b(\s*[=:]\s*)[\"']?([^\s\"'`,;]{6,})[\"']?"),
     r"\1\2[REDACTED]"),
    # --- password quoted in backticks (prose) ---
    (re.compile(r"(?i)(password\s+)`[^`]+`"), r"\1`[REDACTED]`"),
]

# --------------------------------------------------------------------------- #
# Paths                                                                        #
# --------------------------------------------------------------------------- #


def claude_projects_dir() -> Path:
    """Locate the Claude Code projects directory in a portable way."""
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    if env:
        return Path(env) / "projects"
    return Path.home() / ".claude" / "projects"


def repo_root() -> Path:
    """Repo root = parent of the scripts/ directory holding this file."""
    return Path(__file__).resolve().parent.parent


def default_output_dir() -> Path:
    return repo_root() / "claude-conversations" / "sessions"


def auto_config_path() -> Path:
    return repo_root() / "claude-conversations" / AUTO_CONFIG_NAME


# --------------------------------------------------------------------------- #
# Include resolution                                                           #
# --------------------------------------------------------------------------- #


def resolve_includes(args) -> list[str]:
    """Resolve the include list from CLI > --config > auto-config > env > default."""
    if args.include:
        return list(args.include)

    cfg_file = args.config
    if not cfg_file and auto_config_path().is_file():
        cfg_file = str(auto_config_path())
    if cfg_file:
        data = json.loads(Path(cfg_file).read_text(encoding="utf-8"))
        inc = data.get("include")
        if inc:
            return list(inc)

    env = os.environ.get(ENV_INCLUDE)
    if env:
        return [p for p in env.split(os.pathsep) if p.strip()]

    return list(DEFAULT_INCLUDES)


def _norm(p: str) -> str:
    return str(p).replace("\\", "/").rstrip("/")


def cwd_matches(cwd: str | None, includes: list[str]) -> bool:
    """True if `cwd` matches any include entry (by full path, subtree, or basename)."""
    if not cwd:
        return False
    n = _norm(cwd)
    nl = n.casefold()
    base = n.rsplit("/", 1)[-1].casefold()
    for inc in includes:
        if not inc or not str(inc).strip():
            continue
        ni = _norm(inc)
        is_pathlike = ("/" in ni) or (":" in str(inc)) or ("\\" in str(inc))
        if is_pathlike:
            nil = ni.casefold()
            if nl == nil or nl.startswith(nil + "/"):
                return True
        if base == ni.rsplit("/", 1)[-1].casefold():
            return True
    return False


# --------------------------------------------------------------------------- #
# Stripping logic                                                              #
# --------------------------------------------------------------------------- #


def trim_content_block(block, trim_tool_results: bool):
    """Optionally shrink a single content block (used only with --trim-tool-results)."""
    if not trim_tool_results or not isinstance(block, dict):
        return block
    if block.get("type") == "tool_result":
        content = block.get("content")
        if isinstance(content, str) and len(content) > TOOL_RESULT_MAX_CHARS:
            block = dict(block)
            block["content"] = content[:TOOL_RESULT_MAX_CHARS] + "\n...[trimmed]"
        elif isinstance(content, list):
            new = []
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    t = c.get("text", "")
                    if len(t) > TOOL_RESULT_MAX_CHARS:
                        c = dict(c)
                        c["text"] = t[:TOOL_RESULT_MAX_CHARS] + "\n...[trimmed]"
                new.append(c)
            block = dict(block)
            block["content"] = new
    return block


def redact_text(s: str) -> str:
    for pat, repl in SECRET_PATTERNS:
        s = pat.sub(repl, s)
    return s


def find_secrets(text: str) -> list[str]:
    """Return any genuine secret matches in `text`.

    Matches that already contain the literal 'REDACTED' marker are ignored, so
    redacted output never re-flags while a missed secret still trips the gate.
    This is the engine behind the post-write verification gate.
    """
    hits = []
    for pat, _ in SECRET_PATTERNS:
        for m in pat.finditer(text):
            frag = m.group(0)
            if "REDACTED" in frag:
                continue
            hits.append(frag)
    return hits


def redact_obj(o):
    """Recursively redact secrets in all string values, never touching image data."""
    if isinstance(o, str):
        return redact_text(o)
    if isinstance(o, list):
        return [redact_obj(x) for x in o]
    if isinstance(o, dict):
        # Leave base64 image payloads (`source`) byte-for-byte intact.
        if o.get("type") == "base64" and "data" in o:
            return {k: (v if k == "data" else redact_obj(v)) for k, v in o.items()}
        return {k: redact_obj(v) for k, v in o.items()}
    return o


def slim_line(obj: dict, *, trim_tool_results: bool = False,
              drop_snapshots: bool = False, redact: bool = True):
    """Return a slimmed copy of a JSONL event, or None to drop the line."""
    ltype = obj.get("type")
    if ltype in DROP_LINE_TYPES:
        return None
    if drop_snapshots and ltype == "file-history-snapshot":
        return None

    out = {k: v for k, v in obj.items() if k not in STRIP_KEYS}

    if redact:
        out = redact_obj(out)

    if trim_tool_results:
        msg = out.get("message")
        if isinstance(msg, dict) and isinstance(msg.get("content"), list):
            msg = dict(msg)
            msg["content"] = [trim_content_block(b, True) for b in msg["content"]]
            out["message"] = msg
        tur = out.get("toolUseResult")
        if isinstance(tur, str) and len(tur) > TOOL_RESULT_MAX_CHARS:
            out["toolUseResult"] = tur[:TOOL_RESULT_MAX_CHARS] + "\n...[trimmed]"

    return out


# --------------------------------------------------------------------------- #
# Session handling                                                             #
# --------------------------------------------------------------------------- #


def iter_json_lines(jsonl_path: Path):
    """Yield parsed JSON objects from a JSONL file, skipping blank/bad lines."""
    with jsonl_path.open(encoding="utf-8") as fh:
        for ln in fh:
            ln = ln.strip()
            if not ln:
                continue
            try:
                yield json.loads(ln)
            except json.JSONDecodeError:
                continue


def session_cwd(jsonl_path: Path) -> str | None:
    """Return the first recorded `cwd` in a session, or None."""
    try:
        for obj in iter_json_lines(jsonl_path):
            cwd = obj.get("cwd")
            if cwd:
                return cwd
    except OSError:
        return None
    return None


def session_matches(jsonl_path: Path, includes: list[str]) -> bool:
    return cwd_matches(session_cwd(jsonl_path), includes)


def first_timestamp_date(jsonl_path: Path) -> str:
    """Return YYYY-MM-DD from the first timestamped line, else file mtime."""
    try:
        for obj in iter_json_lines(jsonl_path):
            ts = obj.get("timestamp")
            if ts:
                try:
                    return (datetime.fromisoformat(ts.replace("Z", "+00:00"))
                            .astimezone(timezone.utc).strftime("%Y-%m-%d"))
                except ValueError:
                    pass
    except OSError:
        pass
    mtime = datetime.fromtimestamp(jsonl_path.stat().st_mtime, tz=timezone.utc)
    return mtime.strftime("%Y-%m-%d")


def process_session(jsonl_path: Path, out_dir: Path, *, dry_run: bool = False,
                    trim_tool_results: bool = False, drop_snapshots: bool = False,
                    redact: bool = True):
    """Slim one session. Returns (out_path, lines_in, lines_out, bytes_out)."""
    date = first_timestamp_date(jsonl_path)
    sid8 = jsonl_path.stem[:8]
    out_path = out_dir / f"{date}_{sid8}.jsonl"

    lines_in = lines_out = 0
    buf = []
    for obj in iter_json_lines(jsonl_path):
        lines_in += 1
        slim = slim_line(obj, trim_tool_results=trim_tool_results,
                         drop_snapshots=drop_snapshots, redact=redact)
        if slim is None:
            continue
        buf.append(json.dumps(slim, ensure_ascii=False, separators=(",", ":")))
        lines_out += 1

    payload = "\n".join(buf) + ("\n" if buf else "")
    hits = find_secrets(payload)
    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path.write_text(payload, encoding="utf-8")
    return out_path, lines_in, lines_out, len(payload.encode("utf-8")), hits


def collect(projects_dir: Path, out_dir: Path, includes: list[str], *,
            dry_run: bool = False, trim_tool_results: bool = False,
            drop_snapshots: bool = False, redact: bool = True):
    """Find and slim all matching sessions. Returns a list of per-session stats dicts."""
    results = []
    for path in sorted(projects_dir.glob("**/*.jsonl")):
        if not session_matches(path, includes):
            continue
        bytes_in = path.stat().st_size
        out_path, lin, lout, bout, hits = process_session(
            path, out_dir, dry_run=dry_run,
            trim_tool_results=trim_tool_results, drop_snapshots=drop_snapshots,
            redact=redact)
        results.append({
            "source": path, "out": out_path, "lines_in": lin,
            "lines_out": lout, "bytes_in": bytes_in, "bytes_out": bout,
            "secret_hits": hits,
        })
    return results


def scan_dir_for_secrets(directory: Path) -> dict[Path, list[str]]:
    """Scan every .jsonl in `directory` and return {path: [secret fragments]}."""
    findings = {}
    for path in sorted(directory.glob("**/*.jsonl")):
        hits = find_secrets(path.read_text(encoding="utf-8", errors="replace"))
        if hits:
            findings[path] = hits
    return findings


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Collect & slim Claude Code session transcripts for chosen directories.")
    p.add_argument("--include", action="append", metavar="PATH_OR_NAME",
                   help="Directory to collect (absolute path or bare folder name). "
                        "Repeatable. Overrides config/env/defaults.")
    p.add_argument("--config", metavar="FILE",
                   help="JSON config file with an 'include' list.")
    p.add_argument("--out", metavar="DIR",
                   help="Output directory (default: claude-conversations/sessions).")
    p.add_argument("--projects-dir", metavar="DIR",
                   help="Override the Claude projects dir to scan.")
    p.add_argument("--dry-run", action="store_true",
                   help="Report what would be collected without writing files.")
    p.add_argument("--trim-tool-results", action="store_true",
                   help="Also shrink large tool_result / toolUseResult payloads.")
    p.add_argument("--drop-snapshots", action="store_true",
                   help="Also drop file-history-snapshot lines.")
    p.add_argument("--no-redact", dest="redact", action="store_false",
                   help="Disable secret redaction (NOT recommended for public repos).")
    p.add_argument("--no-verify", dest="verify", action="store_false",
                   help="Skip the post-write secret-verification gate.")
    p.add_argument("--verify-only", action="store_true",
                   help="Only scan the output dir for residual secrets and exit "
                        "non-zero if any are found. Collect nothing.")
    p.set_defaults(redact=True, verify=True)
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    projects = Path(args.projects_dir) if args.projects_dir else claude_projects_dir()
    if not projects.is_dir():
        print(f"ERROR: Claude projects dir not found: {projects}", file=sys.stderr)
        print("Set CLAUDE_CONFIG_DIR or pass --projects-dir.", file=sys.stderr)
        return 1

    includes = resolve_includes(args)
    out_dir = Path(args.out) if args.out else default_output_dir()

    # --verify-only: just audit the existing archive and exit.
    if args.verify_only:
        findings = scan_dir_for_secrets(out_dir)
        if findings:
            print(f"SECURITY GATE FAILED: residual secrets in {out_dir}",
                  file=sys.stderr)
            for path, hits in findings.items():
                print(f"  {path.name}: {len(hits)} hit(s) e.g. {hits[0][:12]}...",
                      file=sys.stderr)
            return 3
        print(f"Verify-only: no secrets found in {out_dir}. OK")
        return 0

    print(f"Scanning : {projects}")
    print(f"Output   : {out_dir}{'  (dry-run)' if args.dry_run else ''}")
    print(f"Includes : {includes}")
    print(f"Redact   : {'on' if args.redact else 'OFF'}\n")

    results = collect(projects, out_dir, includes, dry_run=args.dry_run,
                      trim_tool_results=args.trim_tool_results,
                      drop_snapshots=args.drop_snapshots, redact=args.redact)

    if not results:
        print("No matching sessions found for the configured includes.")
        return 0

    total_in = total_out = b_in = b_out = 0
    total_hits = 0
    for r in results:
        total_in += r["lines_in"]
        total_out += r["lines_out"]
        b_in += r["bytes_in"]
        b_out += r["bytes_out"]
        total_hits += len(r["secret_hits"])
        print(f"  {r['source'].name}")
        print(f"      -> {r['out'].name}  | lines {r['lines_in']}->{r['lines_out']}  | "
              f"{r['bytes_in']/1024:.0f} KB -> {r['bytes_out']/1024:.0f} KB")

    pct = (100 * b_out / b_in) if b_in else 0
    print(f"\nSessions collected : {len(results)}")
    print(f"Lines  {total_in} -> {total_out}")
    print(f"Bytes  {b_in/1024:.0f} KB -> {b_out/1024:.0f} KB ({pct:.0f}% of original)")
    if args.dry_run:
        print("\n(dry-run: no files written)")

    # Verification gate: refuse to report success if any secret slipped through.
    if args.verify:
        if total_hits:
            print(f"\nSECURITY GATE FAILED: {total_hits} residual secret(s) detected "
                  f"in output. NOT safe to commit/push.", file=sys.stderr)
            for r in results:
                if r["secret_hits"]:
                    print(f"  {r['out'].name}: {len(r['secret_hits'])} e.g. "
                          f"{r['secret_hits'][0][:12]}...", file=sys.stderr)
            return 3
        print("Security gate  : PASS (no known secrets in output)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
