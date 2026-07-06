#!/usr/bin/env bash
# Tear down the production host. Releases the EIP unless --keep-eip is passed.
set -euo pipefail
AWS="${AWS:-aws}"
REGION="${AWS_REGION:-us-west-2}"
KEEP_EIP=0
[ "${1:-}" = "--keep-eip" ] && KEEP_EIP=1
q() { $AWS --region "$REGION" "$@"; }

IID="$(q ec2 describe-instances \
  --filters "Name=tag:Name,Values=guidemate-poc-ec2" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"

if [ -n "${IID}" ] && [ "${IID}" != "None" ]; then
  echo ">> Terminating ${IID}"
  q ec2 terminate-instances --instance-ids "${IID}" >/dev/null
  q ec2 wait instance-terminated --instance-ids "${IID}"
fi

if [ "${KEEP_EIP}" -eq 0 ]; then
  ALLOC_ID="$(q ec2 describe-addresses --filters "Name=tag:Name,Values=guidemate-poc-eip" \
    --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)"
  if [ -n "${ALLOC_ID}" ] && [ "${ALLOC_ID}" != "None" ]; then
    echo ">> Releasing EIP ${ALLOC_ID}"
    q ec2 release-address --allocation-id "${ALLOC_ID}" || true
  fi
fi

SG_ID="$(q ec2 describe-security-groups --filters "Name=group-name,Values=guidemate-poc-sg" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ -n "${SG_ID}" ] && [ "${SG_ID}" != "None" ]; then
  echo ">> Deleting SG ${SG_ID}"
  q ec2 delete-security-group --group-id "${SG_ID}" || echo "   (SG still in use; retry after instance fully gone)"
fi
echo ">> Teardown done. CloudWatch dashboard/alarms/log-groups are left in place (delete via setup_observability.sh --clean)."
