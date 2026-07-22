#!/usr/bin/env python3
"""GuideMate — chat -> mission intent parser (the "LLM" front of the demo).

Turns free text ("lead me from the kitchen to the bathroom") into the dispatcher's
mission JSON: {"origin": "kitchen", "destination": "bathroom"}.

Two backends, auto-selected:
  1. Anthropic Claude API (preferred; matches the design). Used when the `anthropic`
     package is importable AND a credential is available (ANTHROPIC_API_KEY or an
     `ant auth login` profile). The model is constrained to emit ONLY the mission JSON.
  2. Zero-dependency keyword fallback. Matches known location names in the text.
     Lets the whole chat->dispatcher pipeline run with no API key / no install.

Both return the same shape:
    {"understood": bool, "origin": str|None, "destination": str|None, "reply": str}

Enable the LLM path:  pip install anthropic  &&  export ANTHROPIC_API_KEY=sk-...
Override the model:   export GUIDEMATE_MODEL=claude-opus-4-8   (default)
"""
from __future__ import annotations
import os, re, json

# Known user-facing destinations (must exist in dispatcher.py LOCATIONS).
LOCATIONS = ["kitchen", "bathroom"]
MODEL = os.environ.get("GUIDEMATE_MODEL", "claude-opus-4-8")

_SYSTEM = (
    "You are the intent parser for a two-robot guide system. Your ONLY job is to turn the "
    "user's message into a navigation mission. Known locations: " + ", ".join(LOCATIONS) + ". "
    "Identify the origin (where they start) and the destination (where they want to go). "
    "If the message clearly names a destination but no origin, leave origin null. "
    "If you cannot identify a destination from the known locations, set understood=false and "
    "put a short clarifying question in reply. Never invent locations outside the known list."
)

_SCHEMA = {
    "type": "object",
    "properties": {
        "understood": {"type": "boolean"},
        "origin": {"type": ["string", "null"], "enum": LOCATIONS + [None]},
        "destination": {"type": ["string", "null"], "enum": LOCATIONS + [None]},
        "reply": {"type": "string"},
    },
    "required": ["understood", "origin", "destination", "reply"],
    "additionalProperties": False,
}


def _llm_available():
    try:
        import anthropic  # noqa: F401
    except Exception:
        return False
    # a credential must be resolvable; the SDK also reads `ant` profiles, but the simplest
    # signal is the env var. If unset, we still try (profile may exist) and fall back on error.
    return True


def parse_with_llm(text: str):
    import anthropic
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=MODEL,
        max_tokens=512,
        system=_SYSTEM,
        messages=[{"role": "user", "content": text}],
        output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
    )
    raw = next(b.text for b in resp.content if b.type == "text")
    return json.loads(raw)


def parse_with_keywords(text: str):
    t = text.lower()
    found = [loc for loc in LOCATIONS if re.search(r"\b" + re.escape(loc) + r"\b", t)]
    origin = destination = None
    if len(found) >= 2:
        # order by appearance; "from X to Y" -> X origin, Y destination
        found_sorted = sorted(found, key=lambda w: t.index(w))
        origin, destination = found_sorted[0], found_sorted[1]
    elif len(found) == 1:
        destination = found[0]  # a single named place is the destination
    if destination is None:
        return {"understood": False, "origin": None, "destination": None,
                "reply": f"Sorry, I can guide you to: {', '.join(LOCATIONS)}. Where would you like to go?"}
    if origin is None:
        origin = "kitchen" if destination != "kitchen" else "bathroom"
    return {"understood": True, "origin": origin, "destination": destination,
            "reply": f"On it — guiding you from the {origin} to the {destination}."}


def parse_mission(text: str) -> dict:
    """Parse free text into a mission. Tries the LLM, falls back to keywords."""
    if _llm_available():
        try:
            out = parse_with_llm(text)
            out.setdefault("origin", None)
            out.setdefault("destination", None)
            return out
        except Exception as e:
            # any LLM/credential/network error -> graceful fallback
            res = parse_with_keywords(text)
            res["reply"] += f"  (LLM unavailable: {type(e).__name__}; used keyword parser)"
            return res
    return parse_with_keywords(text)


if __name__ == "__main__":
    import sys
    msg = " ".join(sys.argv[1:]) or "lead me from the kitchen to the bathroom"
    print(f"backend: {'LLM' if _llm_available() else 'keyword'}")
    print(f"input:   {msg}")
    print("output: ", json.dumps(parse_mission(msg)))
