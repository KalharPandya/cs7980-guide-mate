#!/usr/bin/env bash
# Local production-parity gate before deploy, and a printed post-deploy checklist.
set -euo pipefail
cd "$(dirname "$0")/.."

echo ">> 1. Full unit/integration suite (default-skipped tests stay skipped)"
.venv/bin/python -m pytest -q

echo ">> 2. Build + start the prod-shaped Compose stack (Caddy on http://localhost)"
cd agent_service
GUIDEMATE_DOMAIN=http://localhost sudo -E docker compose -f compose.yaml up -d --build
trap 'sudo docker compose -f compose.yaml down -v' EXIT
for _ in $(seq 1 60); do curl -sf http://localhost/healthz >/dev/null && break; sleep 2; done
curl -s http://localhost/healthz | grep -q '"ok":true'
echo "   OK: /healthz served through Caddy"
cd ..

cat <<'NEXT'

>> 3. Post-deploy (run AFTER launch_ec2.sh + setup_observability.sh):
     DOMAIN=echo.kalhar.ca
     # a) service health through prod Caddy TLS
     curl -sf https://$DOMAIN/healthz
     # b) full chat round-trip from EC2 -> IoT -> Pi bridge -> ack
     BASE_URL=https://$DOMAIN bash scripts/prod_slice_check.sh
     # c) the same Playwright e2e suite against the live URL (Phase 5 suite)
     BASE_URL=https://$DOMAIN .venv/bin/python -m pytest agent_service/tests/e2e -q
NEXT
echo ">> local gate PASSED"
