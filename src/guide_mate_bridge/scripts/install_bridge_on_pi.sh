#!/usr/bin/env bash
# Install/refresh the guidemate-bridge systemd service on the Pi (robot 468).
# ADDITIVE ONLY: touches nothing but ~/guidemate-venv, ~/certs, and the new unit.
# Never kills or restarts existing bringup. Run from the Linux box.
set -euo pipefail

SSH_HOST="${SSH_HOST:-guidemate}"
ROBOT_ID="${ROBOT_ID:-turtlebot468}"
PI_REPO="/home/ubuntu/cs7980-guide-mate"
PI_VENV="/home/ubuntu/guidemate-venv"
CERT="${PI_REPO}/Turtlebot-468.cert.pem"
KEY="${PI_REPO}/Turtlebot-468.private.key"
CA="/home/ubuntu/certs/AmazonRootCA1.pem"
UNIT_SRC="$(cd "$(dirname "$0")/.." && pwd)/systemd/guidemate-bridge.service"

echo ">> Discovering IoT data endpoint (local AWS creds)"
ENDPOINT="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)"
echo "   endpoint: ${ENDPOINT}"

echo ">> git pull on the Pi (repo is the transport)"
ssh "${SSH_HOST}" "cd ${PI_REPO} && git pull --ff-only"

echo ">> Ensure venv (idempotent) + install bridge + shared msgs editable"
# Some Pi images ship python3 without ensurepip (no python3-venv apt pkg); fall back to
# --without-pip over the system-site pip, then bootstrap pip into the venv. Additive only.
ssh "${SSH_HOST}" "test -x ${PI_VENV}/bin/python || \
  python3 -m venv --system-site-packages ${PI_VENV} 2>/dev/null || \
  python3 -m venv --without-pip --system-site-packages ${PI_VENV}"
ssh "${SSH_HOST}" "${PI_VENV}/bin/python -m pip install --upgrade pip && \
  ${PI_VENV}/bin/python -m pip install -e ${PI_REPO}/shared/guidemate_msgs -e ${PI_REPO}/src/guide_mate_bridge"

echo ">> Ensure Amazon Root CA on the Pi"
ssh "${SSH_HOST}" "mkdir -p /home/ubuntu/certs && \
  ([ -f ${CA} ] || curl -fsSL https://www.amazontrust.com/repository/AmazonRootCA1.pem -o ${CA})"

echo ">> Render + install the systemd unit via sudo tee"
sed -e "s#@ROBOT_ID@#${ROBOT_ID}#g" \
    -e "s#@IOT_ENDPOINT@#${ENDPOINT}#g" \
    -e "s#@CERT@#${CERT}#g" \
    -e "s#@KEY@#${KEY}#g" \
    -e "s#@CA@#${CA}#g" \
    "${UNIT_SRC}" \
  | ssh "${SSH_HOST}" "sudo tee /etc/systemd/system/guidemate-bridge.service >/dev/null"

echo ">> daemon-reload + enable --now (additive; no other service touched)"
ssh "${SSH_HOST}" "sudo systemctl daemon-reload && sudo systemctl enable --now guidemate-bridge.service"

echo ">> Recent logs (expect 'connected' + online event)"
ssh "${SSH_HOST}" "journalctl -u guidemate-bridge -n 30 --no-pager"
