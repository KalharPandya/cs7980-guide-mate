#!/usr/bin/env bash
# Tear down the production host. Releases the EIP unless --keep-eip is passed.
# DESTRUCTIVE: requires an explicit --yes to actually terminate/delete.
#
# Usage:
#   ./teardown.sh --yes              # terminate instance, release EIP, delete SG
#   ./teardown.sh --yes --keep-eip   # ...but keep the Elastic IP
#   ./teardown.sh                    # dry run: print what WOULD be deleted, exit 1
set -euo pipefail
AWS="${AWS:-aws}"
REGION="${AWS_REGION:-us-west-2}"
KEEP_EIP=0
YES=0
for arg in "$@"; do
  case "${arg}" in
    --keep-eip) KEEP_EIP=1 ;;
    --yes)      YES=1 ;;
    *) echo "!! unknown arg: ${arg}" >&2; exit 2 ;;
  esac
done
q() { $AWS --region "$REGION" "$@"; }

IID="$(q ec2 describe-instances \
  --filters "Name=tag:Name,Values=guidemate-poc-ec2" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"

if [ "${YES}" -ne 1 ]; then
  echo "== DRY RUN: teardown would delete the following (re-run with --yes to proceed) =="
  echo "   Instance      : ${IID:-<none found>} (terminate)"
  if [ "${KEEP_EIP}" -eq 0 ]; then
    echo "   Elastic IP    : tag Name=guidemate-poc-eip (release)"
  else
    echo "   Elastic IP    : kept (--keep-eip)"
  fi
  echo "   Security group: guidemate-poc-sg / tag project=guidemate-poc (delete)"
  echo "!! Nothing deleted. Re-run with --yes to actually tear down." >&2
  exit 1
fi

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

SG_ID="$(q ec2 describe-security-groups \
  --filters "Name=group-name,Values=guidemate-poc-sg" "Name=tag:project,Values=guidemate-poc" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ -n "${SG_ID}" ] && [ "${SG_ID}" != "None" ]; then
  echo ">> Deleting SG ${SG_ID}"
  q ec2 delete-security-group --group-id "${SG_ID}" || echo "   (SG still in use; retry after instance fully gone)"
fi
echo ">> Teardown done. CloudWatch dashboard/alarms/log-groups are left in place (delete via setup_observability.sh --clean)."
