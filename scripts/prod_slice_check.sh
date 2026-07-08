#!/usr/bin/env bash
# Chat round-trip against a running service (local compose or prod domain).
# Proves service -> IoT Core -> Pi bridge (dry-run) -> ack path end to end.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_URL="${BASE_URL:?set BASE_URL, e.g. https://echo.kalhar.ca}"

RESP="$(curl -sf -X POST "${BASE_URL}/api/chat" \
  -H 'Content-Type: application/json' -d '{"message":"do a happy wiggle"}')"
echo "response: ${RESP}"
echo "${RESP}" | .venv/bin/python -c '
import json, sys
from guidemate_agent.prodcheck import assert_chat_roundtrip
assert_chat_roundtrip(json.load(sys.stdin))
print("OK: chat round-trip verified (emote + simulated ack)")
'
