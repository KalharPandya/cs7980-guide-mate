#!/usr/bin/env python3
"""Assemble the self-contained Floor-14 glass-marking tool.

Embeds ONLY the static handbook drawing (PNG, as a base64 data URI) into
`glass-marker.html`. It deliberately does NOT embed the plan: the tool loads
floor-14.json at runtime (fetch with a small candidate list, plus a "Load JSON
file..." fallback), so it stays correct no matter what edits land in the data.

The PNG never changes, so you only re-run this if the source drawing itself is
replaced:  python tools/build-glass-marker.py   (from world-client/)
"""
import base64
import pathlib

TOOLS = pathlib.Path(__file__).resolve().parent          # world-client/tools
CLIENT = TOOLS.parent                                     # world-client
REPO = CLIENT.parent                                      # repo root

PNG = (REPO / "world/data/source/floor-14-plan-hires.png").read_bytes()
PNG_B64 = "data:image/png;base64," + base64.b64encode(PNG).decode("ascii")

template = (TOOLS / "_glass-marker-template.html").read_text(encoding="utf-8")
if "__PNG_DATA_URI__" not in template:
    raise SystemExit("template is missing the __PNG_DATA_URI__ placeholder")
html = template.replace("__PNG_DATA_URI__", PNG_B64)

out = TOOLS / "glass-marker.html"
out.write_text(html, encoding="utf-8")
print(f"wrote {out.relative_to(REPO)} ({len(html)} bytes; png {len(PNG)} bytes)")
