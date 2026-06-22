#!/usr/bin/env python3
"""
build_digests.py  (Stage 0 of the research pipeline)

Render each slimmed Claude session transcript in claude-conversations/sessions/
into a compact, citable text digest under Research/conversation-analysis/_digests/.

This step is fully deterministic (no model), so it introduces no hallucination.
Every digest carries the raw source path, date, and per-turn numbering so that a
downstream analysis can cite evidence as (file, date, turn N) and trace it back.

It also writes Research/conversation-analysis/stats.json with real, counted
metrics (user turns, assistant turns, tool calls) for aggregate tables, so those
numbers are measured, not guessed.

Usage:  python Research/tools/build_digests.py
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
SESSIONS = REPO / "claude-conversations" / "sessions"
OUT = REPO / "Research" / "conversation-analysis" / "_digests"
STATS = REPO / "Research" / "conversation-analysis" / "stats.json"

# Per-turn text caps keep digests bounded but citable.
USER_CAP = 4000
ASSISTANT_CAP = 1600
TOOL_SUMMARY_CAP = 220


def iso_date(ts: str | None) -> str | None:
    if not ts:
        return None
    try:
        return (datetime.fromisoformat(ts.replace("Z", "+00:00"))
                .astimezone(timezone.utc).strftime("%Y-%m-%d"))
    except ValueError:
        return None


def clip(s: str, n: int) -> str:
    s = s.replace("\r", "")
    if len(s) <= n:
        return s
    return s[:n] + f"\n...[clipped {len(s) - n} chars]"


def summarize_tool_input(inp) -> str:
    try:
        s = json.dumps(inp, ensure_ascii=False)
    except (TypeError, ValueError):
        s = str(inp)
    s = re.sub(r"\s+", " ", s)
    return clip(s, TOOL_SUMMARY_CAP)


def render_content(content) -> tuple[str, int, int, list[str]]:
    """Return (text, n_tool_use, n_images, tool_names) for a message content."""
    if isinstance(content, str):
        return content, 0, 0, []
    if not isinstance(content, list):
        return "", 0, 0, []
    parts, n_tool, n_img, names = [], 0, 0, []
    for b in content:
        if not isinstance(b, dict):
            parts.append(str(b))
            continue
        t = b.get("type")
        if t == "text":
            parts.append(b.get("text", ""))
        elif t == "tool_use":
            name = b.get("name", "tool")
            names.append(name)
            n_tool += 1
            parts.append(f"[tool_use: {name} {summarize_tool_input(b.get('input'))}]")
        elif t == "tool_result":
            c = b.get("content")
            if isinstance(c, list):
                txt = " ".join(x.get("text", "") for x in c
                               if isinstance(x, dict) and x.get("type") == "text")
            else:
                txt = c if isinstance(c, str) else ""
            parts.append(f"[tool_result: {len(txt)} chars] {clip(txt, TOOL_SUMMARY_CAP)}")
        elif t == "image":
            n_img += 1
            parts.append("[image]")
        elif t == "thinking":
            parts.append("[thinking omitted]")
    return "\n".join(p for p in parts if p), n_tool, n_img, names


def process(path: Path):
    user_turns = assistant_turns = tool_uses = images = 0
    tool_names: dict[str, int] = {}
    first_date = None
    turn = 0
    lines_out = []

    with path.open(encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                o = json.loads(raw)
            except json.JSONDecodeError:
                continue
            d = iso_date(o.get("timestamp"))
            if d and not first_date:
                first_date = d
            t = o.get("type")
            if t not in ("user", "assistant"):
                continue
            msg = o.get("message")
            if not isinstance(msg, dict):
                continue
            role = msg.get("role", t)
            text, n_tool, n_img, names = render_content(msg.get("content"))
            if not text.strip():
                continue
            turn += 1
            if role == "user":
                user_turns += 1
                body = clip(text, USER_CAP)
            else:
                assistant_turns += 1
                body = clip(text, ASSISTANT_CAP)
            tool_uses += n_tool
            images += n_img
            for nm in names:
                tool_names[nm] = tool_names.get(nm, 0) + 1
            stamp = f" ({d})" if d else ""
            lines_out.append(f"### Turn {turn} [{role}]{stamp}\n{body}\n")

    if not first_date:
        mt = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        first_date = mt.strftime("%Y-%m-%d")

    top_tools = sorted(tool_names.items(), key=lambda kv: -kv[1])[:12]
    header = [
        f"# Digest: {path.name}",
        "",
        f"- raw_source: claude-conversations/sessions/{path.name}",
        f"- date: {first_date}",
        f"- raw_bytes: {path.stat().st_size}",
        f"- user_turns: {user_turns}",
        f"- assistant_turns: {assistant_turns}",
        f"- tool_calls: {tool_uses}",
        f"- images: {images}",
        f"- top_tools: {', '.join(f'{n}x{nm}' for nm, n in top_tools) or 'none'}",
        "",
        "Citation format for analysis: (file: " + path.name +
        f", date: {first_date}, turn: N).",
        "",
        "---",
        "",
    ]
    out_path = OUT / (path.stem + ".txt")
    out_path.write_text("\n".join(header) + "\n".join(lines_out), encoding="utf-8")

    return {
        "file": path.name,
        "raw_source": f"claude-conversations/sessions/{path.name}",
        "digest": f"Research/conversation-analysis/_digests/{out_path.name}",
        "date": first_date,
        "raw_bytes": path.stat().st_size,
        "user_turns": user_turns,
        "assistant_turns": assistant_turns,
        "tool_calls": tool_uses,
        "images": images,
        "top_tools": dict(top_tools),
        "empty": (user_turns + assistant_turns) == 0,
    }


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    sessions = sorted(SESSIONS.glob("*.jsonl"))
    stats = []
    for p in sessions:
        s = process(p)
        stats.append(s)
        flag = " (EMPTY)" if s["empty"] else ""
        print(f"{p.name}: u={s['user_turns']} a={s['assistant_turns']} "
              f"tools={s['tool_calls']}{flag}")
    STATS.write_text(json.dumps(stats, indent=2), encoding="utf-8")
    print(f"\n{len(stats)} digests -> {OUT}")
    print(f"stats -> {STATS}")
    # quick corpus totals
    tot_u = sum(s["user_turns"] for s in stats)
    tot_a = sum(s["assistant_turns"] for s in stats)
    tot_t = sum(s["tool_calls"] for s in stats)
    print(f"corpus: {len(stats)} sessions, {tot_u} user turns, "
          f"{tot_a} assistant turns, {tot_t} tool calls")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
