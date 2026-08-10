#!/usr/bin/env bash
# Redeploy the latest branch to the running production instance via SSM (no SSH key).
set -euo pipefail
AWS="${AWS:-aws}"
REGION="${AWS_REGION:-us-west-2}"
BRANCH="${GUIDEMATE_BRANCH:-kalhar/dog-agent-poc}"

IID="$($AWS --region "$REGION" ec2 describe-instances \
  --filters "Name=tag:Name,Values=guidemate-poc-ec2" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
[ -n "${IID}" ] && [ "${IID}" != "None" ] || { echo "no running instance" >&2; exit 1; }
echo ">> Redeploying ${BRANCH} on ${IID}"

# `docker system prune -f` runs before the compose build to reclaim space from
# old images / build cache: repeated builds filled the 8GB instance disk and a
# deploy failed with "No space left on device". -f only (no -a); NEVER --volumes,
# which would wipe the caddy_data named volume that holds the TLS certs.
CMD_ID="$($AWS --region "$REGION" ssm send-command \
  --instance-ids "${IID}" --document-name "AWS-RunShellScript" \
  --comment "guidemate redeploy" \
  --parameters commands="[
    \"set -euxo pipefail\",
    \"cd /opt/guidemate\",
    \"git fetch origin ${BRANCH}\",
    \"git checkout ${BRANCH}\",
    \"git reset --hard origin/${BRANCH}\",
    \"cd /opt/guidemate/agent_service\",
    \"docker system prune -f\",
    \"docker compose --env-file /etc/guidemate.env -f compose.yaml -f compose.prod.yaml up -d --build\"
  ]" --query 'Command.CommandId' --output text)"

echo ">> Waiting for SSM command ${CMD_ID}"
$AWS --region "$REGION" ssm wait command-executed --command-id "${CMD_ID}" --instance-id "${IID}" || true
$AWS --region "$REGION" ssm get-command-invocation --command-id "${CMD_ID}" --instance-id "${IID}" \
  --query '{Status:Status,Out:StandardOutputContent,Err:StandardErrorContent}' --output json
