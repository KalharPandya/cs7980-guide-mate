#!/usr/bin/env bash
# Upload robot 468's most-recent saved SLAM map to S3 for the admin Maps tab.
# OPERATOR-RUN from the Linux box (needs SSH to the Pi + AWS creds). ADDITIVE / read-only:
# it only scp's files off the Pi and writes nothing there. Not runnable from the service.
set -euo pipefail

ROBOT_ID="${1:-turtlebot468}"
BUCKET="guidemate-maps-852373397000"
REGION="us-west-2"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
VENV_PY="${REPO}/.venv/bin/python"
AWS="${HOME}/.local/bin/aws"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "[1/5] Probing the Pi for the newest saved map (.pgm)..."
# bfs_explorer auto-saves the map; probe the likely locations, newest first.
PGM_REMOTE="$(ssh guidemate 'ls -t ~/maps/*.pgm ~/*.pgm 2>/dev/null | head -n1' || true)"
if [ -z "${PGM_REMOTE}" ]; then
  echo "    ...not in ~/maps or ~; widening the search under \$HOME (maxdepth 3)..."
  PGM_REMOTE="$(ssh guidemate 'find ~ -maxdepth 3 -name "*.pgm" -printf "%T@ %p\n" 2>/dev/null | sort -rn | head -n1 | cut -d" " -f2-' || true)"
fi
if [ -z "${PGM_REMOTE}" ]; then
  echo "ERROR: no .pgm map found on the Pi. Has a mapping run saved a map yet?" >&2
  echo "       (probe manually: ssh guidemate 'ls -t ~/*.pgm ~/maps/ 2>/dev/null')" >&2
  exit 1
fi
YAML_REMOTE="${PGM_REMOTE%.pgm}.yaml"
echo "    found: ${PGM_REMOTE}"

echo "[2/5] Copying map files to a scratch dir..."
scp "guidemate:${PGM_REMOTE}" "${WORK}/map.pgm"
scp "guidemate:${YAML_REMOTE}" "${WORK}/map.yaml" 2>/dev/null \
  || echo "    (no sidecar .yaml alongside the .pgm; continuing with the image only)"

echo "[3/5] Converting .pgm -> .png locally (Pillow)..."
"${VENV_PY}" -c "from guidemate_agent.maps import pgm_to_png; pgm_to_png('${WORK}/map.pgm', '${WORK}/latest.png')"

echo "[4/5] Writing meta.json..."
CAPTURED_TS="$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"
"${VENV_PY}" - "${WORK}/meta.json" "${PGM_REMOTE}" "${CAPTURED_TS}" <<'PY'
import json, sys
out, source, ts = sys.argv[1], sys.argv[2], sys.argv[3]
with open(out, "w") as f:
    json.dump({"captured_ts": ts, "source": source}, f)
PY

echo "[5/5] Uploading to s3://${BUCKET}/maps/${ROBOT_ID}/ ..."
"${AWS}" s3 cp "${WORK}/latest.png" "s3://${BUCKET}/maps/${ROBOT_ID}/latest.png" \
  --region "${REGION}" --content-type image/png
"${AWS}" s3 cp "${WORK}/meta.json" "s3://${BUCKET}/maps/${ROBOT_ID}/meta.json" \
  --region "${REGION}" --content-type application/json
echo "Done. Refresh the admin Maps tab."
