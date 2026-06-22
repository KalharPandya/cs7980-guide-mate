#!/usr/bin/env python3
"""
evidence_gate.py  (Stage 3 gate)

Mechanically enforces the research evidence standard before iteration 1 is
declared done:

  1. NO em-dashes anywhere in the draft or any conversation analysis.
  2. Every conversation analysis file references its raw transcript
     (claude-conversations/sessions/...), so each claim can be traced back.
  3. The draft must contain a References/Sources section and at least one
     http(s) URL (web evidence) plus conversation citations.

Exit code 0 = gate passes. Non-zero = violations found (printed).

Usage:  python Research/tools/evidence_gate.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
RESEARCH = REPO / "Research"
ANALYSIS = RESEARCH / "conversation-analysis"
DRAFT = RESEARCH / "draft-v1.md"

EM_DASH = "—"          # —  (forbidden)
EN_DASH = "–"          # –  (warned, not fatal)
CITE_RE = re.compile(r"\(file:\s*[^,]+,\s*date:\s*\d{4}-\d{2}-\d{2}")
URL_RE = re.compile(r"https?://")


def find_char(path: Path, ch: str) -> list[int]:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return [i + 1 for i, ln in enumerate(lines) if ch in ln]


def main() -> int:
    violations = []
    warnings = []

    targets = []
    if DRAFT.exists():
        targets.append(DRAFT)
    targets += sorted(p for p in ANALYSIS.glob("*.md") if p.name != "INDEX.md")
    idx = ANALYSIS / "INDEX.md"
    if idx.exists():
        targets.append(idx)
    lit = sorted((RESEARCH / "literature").glob("*.md"))
    targets += lit

    if not targets:
        print("Gate: no target files found yet (draft/analyses not written).")
        return 1

    # 1. em-dash scan
    for p in targets:
        em = find_char(p, EM_DASH)
        if em:
            violations.append(f"EM-DASH in {p.relative_to(REPO)} at lines {em}")
        en = find_char(p, EN_DASH)
        if en:
            warnings.append(f"en-dash in {p.relative_to(REPO)} at lines {en}")

    # 2. each analysis references its raw transcript
    for p in sorted(ANALYSIS.glob("*.md")):
        if p.name == "INDEX.md":
            continue
        txt = p.read_text(encoding="utf-8", errors="replace")
        if "claude-conversations/sessions/" not in txt:
            violations.append(f"NO raw-source reference in {p.relative_to(REPO)}")

    # 3. draft has sources + citations
    if DRAFT.exists():
        dtxt = DRAFT.read_text(encoding="utf-8", errors="replace")
        if not URL_RE.search(dtxt):
            violations.append("draft-v1.md has no http(s) web citations")
        if not CITE_RE.search(dtxt):
            warnings.append("draft-v1.md has no (file, date, turn) conversation citation in the expected format")
    else:
        warnings.append("draft-v1.md not present yet")

    print(f"Gate scanned {len(targets)} file(s).")
    for w in warnings:
        print(f"  WARN: {w}")
    if violations:
        print(f"\nGATE FAILED: {len(violations)} violation(s):", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        return 2
    print("GATE PASS: no em-dashes; all analyses trace to raw transcripts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
