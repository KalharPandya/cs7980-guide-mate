#!/usr/bin/env bash
# Phase 1 exit test (checklist items 1 & 3): chat -> agent -> MQTT -> Pi bridge dry-run.
# Prereq: bridge installed on the Pi (install_bridge_on_pi.sh) and running.
# Run from the Linux box repo root: bash scripts/slice_check.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ROBOT_ID="${ROBOT_ID:-turtlebot468}"
PORT="${PORT:-8080}"

echo ">> Discovering IoT endpoint"
export GUIDEMATE_IOT_ENDPOINT="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)"
export GUIDEMATE_ROBOTS="${ROBOT_ID}"

echo ">> Starting uvicorn (service connects to IoT via SigV4)"
.venv/bin/python -m uvicorn guidemate_agent.app:app --app-dir agent_service --port "${PORT}" &
UVICORN_PID=$!
trap 'kill ${UVICORN_PID} 2>/dev/null || true' EXIT

# Wait for /healthz
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null; then break; fi
  sleep 1
done

echo ">> Sending chat: 'do a happy wiggle'"
RESP="$(curl -sf -X POST "http://127.0.0.1:${PORT}/api/chat" \
  -H 'Content-Type: application/json' -d '{"message":"do a happy wiggle"}')"
echo "   response: ${RESP}"

echo "${RESP}" | .venv/bin/python -c '
import json, sys
d = json.load(sys.stdin)
assert d.get("emote") is not None, "no emote captured"
acks = d.get("robot") or []
assert any(a.get("simulated") is True for a in acks), "no simulated ack"
print("   OK: emote =", d["emote"], "| acks =", [a["state"] for a in acks])
'

echo ">> Confirming the Pi bridge logged DRY-RUN twists"
ssh guidemate "journalctl -u guidemate-bridge -n 50 --no-pager | grep 'DRY-RUN twist'" \
  && echo "   OK: DRY-RUN twist lines present on the Pi" \
  || { echo "   FAIL: no DRY-RUN twist lines"; exit 1; }

echo ">> Phase 1 slice check PASSED (checklist items 1 & 3)"
