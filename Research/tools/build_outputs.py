#!/usr/bin/env python3
"""
build_outputs.py

Turn the completed research workflow result into committed artifacts:
  - Research/literature/findings.md        (78 verified, URL-checked findings)
  - Research/literature/verification-log.md (dropped findings + gaps + method)
  - Research/conversation-analysis/_analyses.json (compact, for synthesis)
  - Research/conversation-analysis/INDEX.md (aggregate metrics + roll-up table)

It also normalizes em-dashes / en-dashes to plain hyphens in everything it
writes (and sweeps the agent-written analysis .md files), to satisfy the
evidence gate's no-em-dash rule.

Usage:  python Research/tools/build_outputs.py <workflow_output_file>
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
RESEARCH = REPO / "Research"
ANALYSIS = RESEARCH / "conversation-analysis"
LIT = RESEARCH / "literature"
STATS = ANALYSIS / "stats.json"


def desmart(s):
    if not isinstance(s, str):
        return s
    return (s.replace("—", " - ").replace("–", "-")
            .replace("―", "-").replace("−", "-"))


def find_result(o):
    if isinstance(o, dict):
        if "analyses" in o and "research" in o:
            return o
        for v in o.values():
            r = find_result(v)
            if r:
                return r
    return None


def base(file_field: str) -> str:
    return file_field.split("/")[-1]


def write_findings(kept):
    cats = [
        ("swe-code-strong", "General software engineering: code generation, repair, debugging"),
        ("robotics-code", "Robotics-specific code generation and debugging"),
        ("embodied-weak", "Embodied control: where LLMs and VLMs remain weak"),
        ("tooling", "Named agentic tools in robotics"),
        ("benchmark-caveat", "Benchmark inflation and reliability caveats"),
        ("other", "Other"),
    ]
    by_cat = {}
    for f in kept:
        by_cat.setdefault(f.get("category", "other"), []).append(f)

    out = ["# Literature Findings (verified)", "",
           "Each finding below was proposed by a research finder agent and then",
           "independently checked by skeptic agents that fetched the source URL.",
           "Only findings whose source page was confirmed to support the claim are kept.",
           "See verification-log.md for what was dropped and why.", "",
           f"Total verified findings: {len(kept)}.", ""]
    n = 0
    for key, title in cats:
        items = by_cat.get(key, [])
        if not items:
            continue
        out.append(f"## {title}")
        out.append("")
        for f in items:
            n += 1
            claim = desmart(f.get("claim", "")).strip()
            url = f.get("url", "").strip()
            st = desmart(f.get("source_title", "")).strip()
            yr = str(f.get("source_year", "")).strip()
            quote = desmart(f.get("quote", "")).strip()
            dim = f.get("dimension", "")
            src = st + (f", {yr}" if yr else "")
            out.append(f"{n}. {claim}")
            if src.strip():
                out.append(f"   - Source: {src}")
            if url:
                out.append(f"   - URL: {url}")
            if quote:
                out.append(f"   - Evidence: \"{quote}\"")
            out.append(f"   - Cluster: {dim}")
            out.append("")
    LIT.mkdir(parents=True, exist_ok=True)
    (LIT / "findings.md").write_text("\n".join(out), encoding="utf-8")
    return n


def write_verification_log(research):
    kept = research.get("kept", [])
    dropped = research.get("dropped", [])
    gaps = research.get("gaps", [])
    total = len(kept) + len(dropped)
    pct = round(100 * len(kept) / total) if total else 0
    out = ["# Verification Log", "",
           "## Method",
           "Finder agents searched the web and academic sources for each evidence",
           "cluster. Every candidate finding was then sent to two independent skeptic",
           "agents that fetched the cited URL and judged whether the page actually",
           "supports the claim. A finding is kept only if at least one skeptic",
           "confirmed support and none refuted it. This is an adversarial check, so a",
           "kept finding has a source URL that was actually retrieved and read.", "",
           f"Candidates: {total}. Verified kept: {len(kept)} ({pct}%). Dropped: {len(dropped)}.",
           "", "## Dropped findings (not confirmed by source fetch)", ""]
    if not dropped:
        out.append("None.")
    for f in dropped:
        claim = desmart(f.get("claim", "")).strip()
        url = f.get("url", "").strip()
        votes = f.get("votes", []) or []
        notes = "; ".join(desmart(v.get("note", "")).strip() for v in votes if v.get("note"))
        out.append(f"- {claim}")
        if url:
            out.append(f"  - URL tried: {url}")
        verdicts = ", ".join(v.get("verdict", "?") for v in votes)
        out.append(f"  - Verdicts: {verdicts or 'none'}")
        if notes:
            out.append(f"  - Notes: {desmart(notes)}")
    out.append("")
    out.append("## Gaps identified by the completeness critic")
    out.append("")
    for g in gaps:
        out.append(f"- {desmart(g)}")
    (LIT / "verification-log.md").write_text("\n".join(out), encoding="utf-8")


def write_index(analyses):
    stats = {base(s["file"]): s for s in json.loads(STATS.read_text(encoding="utf-8"))}
    rows = []
    out_dist = Counter()
    cat_dist = Counter()
    auto_dist = Counter()
    tot_done = tot_failed = 0
    for a in analyses:
        fb = base(a["file"])
        st = stats.get(fb, {})
        out_dist[a.get("outcome", "?")] += 1
        cat_dist[a.get("thesis_category", "?")] += 1
        auto_dist[a.get("automation_level", "?")] += 1
        nd = len(a.get("tasks_done", []) or [])
        nf = len(a.get("tasks_failed", []) or [])
        tot_done += nd
        tot_failed += nf
        rows.append((fb, a.get("date", st.get("date", "")), a.get("thesis_category", ""),
                     a.get("outcome", ""), a.get("automation_level", ""),
                     st.get("user_turns", ""), st.get("assistant_turns", ""),
                     st.get("tool_calls", ""), nd, nf,
                     desmart(a.get("motive", ""))[:140]))

    s_all = json.loads(STATS.read_text(encoding="utf-8"))
    tot_u = sum(s["user_turns"] for s in s_all)
    tot_a = sum(s["assistant_turns"] for s in s_all)
    tot_t = sum(s["tool_calls"] for s in s_all)

    out = ["# Conversation Analysis Index", "",
           "Aggregate of the per-conversation analyses. Each row links to a full",
           "analysis that cites evidence as (file, date, turn) and references the raw",
           "transcript under claude-conversations/sessions/.", "",
           "## Corpus totals (measured, deterministic)", "",
           f"- Sessions analyzed: {len(s_all)}",
           f"- User turns: {tot_u}",
           f"- Assistant turns: {tot_a}",
           f"- Tool calls: {tot_t}",
           f"- Tasks recorded done: {tot_done}; tasks recorded failed or abandoned: {tot_failed}",
           "",
           "## Distributions", "",
           "Outcome: " + ", ".join(f"{k}={v}" for k, v in out_dist.most_common()),
           "",
           "Thesis category: " + ", ".join(f"{k}={v}" for k, v in cat_dist.most_common()),
           "",
           "Automation level: " + ", ".join(f"{k}={v}" for k, v in auto_dist.most_common()),
           "",
           "## Per-conversation roll-up", "",
           "| Conversation | Date | Category | Outcome | Automation | User turns | Asst turns | Tool calls | Done | Failed | Motive |",
           "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in sorted(rows, key=lambda x: x[1]):
        fb = r[0]
        link = f"[{fb}]({fb.replace('.jsonl', '.md')})"
        motive = r[10].replace("|", "/")
        out.append(f"| {link} | {r[1]} | {r[2]} | {r[3]} | {r[4]} | {r[5]} | {r[6]} | {r[7]} | {r[8]} | {r[9]} | {motive} |")
    (ANALYSIS / "INDEX.md").write_text("\n".join(out), encoding="utf-8")
    return out_dist, cat_dist, auto_dist, tot_done, tot_failed


def write_compact(analyses):
    compact = []
    for a in analyses:
        compact.append({
            "file": base(a["file"]),
            "date": a.get("date"),
            "motive": desmart(a.get("motive", "")),
            "outcome": a.get("outcome"),
            "thesis_category": a.get("thesis_category"),
            "thesis_alignment": desmart(a.get("thesis_alignment", "")),
            "automation_level": a.get("automation_level"),
            "user_input_count": a.get("user_input_count"),
            "tasks_done_n": len(a.get("tasks_done", []) or []),
            "tasks_failed_n": len(a.get("tasks_failed", []) or []),
            "key_evidence": a.get("key_evidence", []),
        })
    (ANALYSIS / "_analyses.json").write_text(json.dumps(compact, indent=2), encoding="utf-8")


def sweep_dashes():
    n = 0
    for p in ANALYSIS.glob("*.md"):
        t = p.read_text(encoding="utf-8", errors="replace")
        d = desmart(t)
        if d != t:
            p.write_text(d, encoding="utf-8")
            n += 1
    return n


def main() -> int:
    src = Path(sys.argv[1])
    o = json.loads(src.read_text(encoding="utf-8"))
    res = find_result(o)
    if not res:
        print("could not find result", file=sys.stderr)
        return 1
    analyses = res["analyses"]
    research = res["research"]

    nfind = write_findings(research.get("kept", []))
    write_verification_log(research)
    write_compact(analyses)
    od, cd, ad, td, tf = write_index(analyses)
    swept = sweep_dashes()

    print(f"findings.md: {nfind} verified findings")
    print(f"verification-log.md: {len(research.get('dropped', []))} dropped, "
          f"{len(research.get('gaps', []))} gaps")
    print(f"INDEX.md written; outcome dist: {dict(od)}")
    print(f"thesis category dist: {dict(cd)}")
    print(f"automation dist: {dict(ad)}")
    print(f"tasks done={td} failed={tf}")
    print(f"dash-swept analysis files: {swept}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
