#!/usr/bin/env bash
# One guided walkthrough for the last mile of the virtual-world-guide-fleet project:
# apply the virtual-fleet IoT identity, deploy world-server to the live instance, push the
# observability config, then verify. Every AWS-mutating step is a separate, named, opt-in
# gate: nothing here runs without you typing "yes" at that specific step. Safe to Ctrl-C and
# rerun; every underlying script is idempotent.
#
# Kalhar runs this himself. No Claude session should invoke this script.
set -euo pipefail

AWS="${AWS:-aws}"
REGION="${AWS_REGION:-us-west-2}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BOLD='\033[1m'
GREEN='\033[32m'
YELLOW='\033[33m'
RESET='\033[0m'

step() { printf "\n${BOLD}== %s ==${RESET}\n" "$1"; }
confirm() {
  # $1 = prompt. Returns 0 (proceed) only on an exact "yes".
  local reply
  read -r -p "$(printf "${YELLOW}%s${RESET} [type yes to proceed, anything else to skip] " "$1")" reply
  [ "$reply" = "yes" ]
}

step "0. Sanity check: real AWS identity"
$AWS sts get-caller-identity --region "$REGION" --output table
if ! confirm "Is this the right account/role for the guidemate sandbox?"; then
  echo "Stopping here. Fix your AWS profile/credentials and rerun." >&2
  exit 1
fi

step "1. Virtual-fleet IoT identity (Task 2.2)"
echo "Dry run first, always. Review the printed plan and the exact IAM policy JSON carefully."
bash "$REPO_ROOT/scripts/create_virtual_fleet_identity.sh"
if confirm "Dry run looked right. Actually create the thing/policy/cert/shadow now (--apply)?"; then
  bash "$REPO_ROOT/scripts/create_virtual_fleet_identity.sh" --apply
  echo -e "${GREEN}Applied.${RESET} Cert/key are at \$HOME/.aws/guidemate-fleet.cert.pem / .key.pem on this machine."
else
  echo "Skipped --apply. The IoT bridge in world-server will stay gracefully disabled until this runs."
fi

step "2. Push feat/kalhar-virtual-world if it isn't already on origin"
CURRENT_BRANCH="$(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "feat/kalhar-virtual-world" ]; then
  echo "You're on branch '$CURRENT_BRANCH', not feat/kalhar-virtual-world. Switch to it first (this" >&2
  echo "script deploys whatever branch you're currently on)." >&2
  exit 1
fi
if ! git -C "$REPO_ROOT" ls-remote --exit-code --heads origin feat/kalhar-virtual-world >/dev/null 2>&1; then
  if confirm "feat/kalhar-virtual-world isn't on origin yet. Push it now?"; then
    git -C "$REPO_ROOT" push -u origin feat/kalhar-virtual-world
  else
    echo "Skipped. Deploy (step 3) will fail without this, since it fetches from origin." >&2
  fi
else
  echo "Already on origin, good."
fi

step "3. Deploy world-server + agent_service to the live instance"
echo "This rebuilds ALL THREE Compose services (app, world-server, caddy) on echo.kalhar.ca via"
echo "one SSM command: git fetch/checkout/reset --hard to this branch's tip, then docker compose up -d --build."
if confirm "Deploy feat/kalhar-virtual-world to the live instance now?"; then
  GUIDEMATE_BRANCH=feat/kalhar-virtual-world bash "$REPO_ROOT/agent_service/deploy/redeploy.sh"
else
  echo "Skipped deploy."
fi

step "4. Push the observability config (Node-process metric, alarm, dashboard widgets)"
if confirm "Push the updated CloudWatch agent config now (idempotent, safe to rerun)?"; then
  bash "$REPO_ROOT/scripts/setup_observability.sh"
else
  echo "Skipped."
fi

step "5. Verify"
echo "Real checks to run yourself now that the above is live:"
echo "  curl -s https://echo.kalhar.ca/healthz"
echo "  curl -s https://echo.kalhar.ca/world/healthz"
echo "  Point a world-client build's VITE_WORLD_SERVER_URL at wss://echo.kalhar.ca/world and join a room."
echo "  Watch the CloudWatch dashboard 'guidemate-poc' for the new world-server widgets (~5 min to populate)."
echo
echo -e "${GREEN}Done.${RESET} Full checklist, including the physical-robot and rehearsal steps, is in:"
echo "  docs/superpowers/specs/2026-07-31-virtual-world-risk-register.md"
