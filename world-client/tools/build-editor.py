#!/usr/bin/env python3
"""Assemble the self-contained floor-plan editor.

Reads the shipped floor-14.json and the authoritative exit-map PNG, embeds both
(PNG as a base64 data URI, plan as inline JSON) into `floorplan-editor.html` so the
editor works offline as a plain double-click file with no server and no network.

Re-run this whenever floor-14.json changes and you want the editor's built-in
"Reset" baseline to match:  python tools/build-editor.py   (from world-client/)
"""
import base64
import json
import pathlib

TOOLS = pathlib.Path(__file__).resolve().parent          # world-client/tools
CLIENT = TOOLS.parent                                     # world-client
REPO = CLIENT.parent                                      # repo root

PLAN = (CLIENT / "public/data/floor-14.json").read_text(encoding="utf-8")
PNG = (REPO / "world/data/source/floor-14-plan-hires.png").read_bytes()
PNG_B64 = "data:image/png;base64," + base64.b64encode(PNG).decode("ascii")

json.loads(PLAN)  # fail fast if the plan is malformed

template = (TOOLS / "_editor_template.html").read_text(encoding="utf-8")
html = template.replace("__PNG_DATA_URI__", PNG_B64).replace("/*__PLAN_JSON__*/null", PLAN)

out = TOOLS / "floorplan-editor.html"
out.write_text(html, encoding="utf-8")
print(f"wrote {out.relative_to(REPO)} ({len(html)} bytes; png {len(PNG)} bytes)")
