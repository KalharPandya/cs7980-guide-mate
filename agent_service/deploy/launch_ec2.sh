#!/usr/bin/env bash
# Launch the guide-mate production host on EC2. Idempotent-ish: reuses a tagged
# SG + EIP, refuses to double-launch if a tagged instance is already running.
#
# Usage:
#   ./launch_ec2.sh          # for real: create/reuse resources, launch, associate EIP
#   ./launch_ec2.sh --plan   # dry run: run the READ-ONLY discovery/idempotency
#                            # lookups for real, but only PRINT the mutations
#                            # (no create/run/allocate/associate; no secret generated)
set -euo pipefail
cd "$(dirname "$0")"

PLAN=0
[ "${1:-}" = "--plan" ] && PLAN=1

AWS="${AWS:-aws}"
REGION="${AWS_REGION:-us-west-2}"
REPO="${GUIDEMATE_REPO:-https://github.com/KalharPandya/cs7980-guide-mate.git}"
BRANCH="${GUIDEMATE_BRANCH:-kalhar/dog-agent-poc}"
TAG="project=guidemate-poc"
SG_NAME="guidemate-poc-sg"
INSTANCE_NAME="guidemate-poc-ec2"
EIP_NAME="guidemate-poc-eip"
PROFILE_NAME="guidemate-agent-profile"
INSTANCE_TYPE="t3.large"

q() { $AWS --region "$REGION" "$@"; }
# plan-aware mutation notice: prints the intended call in --plan mode
plan_note() { echo "   [PLAN] would run: aws --region ${REGION} $*"; }

[ "$PLAN" -eq 1 ] && echo "== PLAN MODE: read-only lookups run for real; mutations are printed, not executed =="

echo ">> Refuse double-launch: check for a running tagged instance"
EXISTING="$(q ec2 describe-instances \
  --filters "Name=tag:Name,Values=${INSTANCE_NAME}" "Name=instance-state-name,Values=pending,running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
if [ -n "${EXISTING}" ]; then
  echo "!! Instance ${EXISTING} already running. Use redeploy.sh to update, or teardown.sh first." >&2
  exit 1
fi

echo ">> Default VPC"
VPC_ID="$(q ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)"

echo ">> Security group ${SG_NAME}"
SG_ID="$(q ec2 describe-security-groups \
  --filters "Name=group-name,Values=${SG_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ "${SG_ID}" = "None" ] || [ -z "${SG_ID}" ]; then
  if [ "$PLAN" -eq 1 ]; then
    plan_note "ec2 create-security-group --group-name ${SG_NAME} --vpc-id ${VPC_ID} --tag-specifications ...project=guidemate-poc"
    SG_ID="<plan-sg-id>"
  else
    SG_ID="$(q ec2 create-security-group --group-name "${SG_NAME}" \
      --description "guide-mate POC (80/443 world, 22 from launcher)" --vpc-id "${VPC_ID}" \
      --tag-specifications "ResourceType=security-group,Tags=[{Key=project,Value=guidemate-poc}]" \
      --query GroupId --output text)"
  fi
fi
MYIP="$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')"
for pair in "80:0.0.0.0/0" "443:0.0.0.0/0" "22:${MYIP}/32"; do
  PORT="${pair%%:*}"; CIDR="${pair##*:}"
  if [ "$PLAN" -eq 1 ]; then
    plan_note "ec2 authorize-security-group-ingress --group-id ${SG_ID} --protocol tcp --port ${PORT} --cidr ${CIDR}"
  else
    q ec2 authorize-security-group-ingress --group-id "${SG_ID}" \
      --protocol tcp --port "${PORT}" --cidr "${CIDR}" 2>/dev/null || true
  fi
done

echo ">> Elastic IP (reuse tagged, else allocate)"
ALLOC_ID="$(q ec2 describe-addresses --filters "Name=tag:Name,Values=${EIP_NAME}" \
  --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)"
if [ "${ALLOC_ID}" = "None" ] || [ -z "${ALLOC_ID}" ]; then
  if [ "$PLAN" -eq 1 ]; then
    plan_note "ec2 allocate-address --domain vpc --tag-specifications ...Name=${EIP_NAME},project=guidemate-poc"
    ALLOC_ID="<plan-alloc-id>"
  else
    ALLOC_ID="$(q ec2 allocate-address --domain vpc \
      --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=project,Value=guidemate-poc},{Key=Name,Value=${EIP_NAME}}]" \
      --query AllocationId --output text)"
  fi
fi
if [ "${ALLOC_ID}" = "<plan-alloc-id>" ]; then
  EIP="<plan-eip>"
else
  EIP="$(q ec2 describe-addresses --allocation-ids "${ALLOC_ID}" \
    --query 'Addresses[0].PublicIp' --output text)"
fi
DOMAIN="$(echo "${EIP}" | tr '.' '-').nip.io"
echo "   EIP ${EIP} -> ${DOMAIN}"

echo ">> Admin password (generated; printed once, never committed)"
if [ "$PLAN" -eq 1 ]; then
  ADMIN_PW="<generated-at-launch:openssl rand -hex 16>"
else
  ADMIN_PW="$(openssl rand -hex 16)"
fi

echo ">> Latest AL2023 AMI"
AMI_ID="$(q ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)"
echo "   AMI ${AMI_ID}"

if [ "$PLAN" -eq 1 ]; then
  echo ">> Render user-data + launch ${INSTANCE_TYPE} (skipped in plan)"
  plan_note "ec2 run-instances --image-id ${AMI_ID} --instance-type ${INSTANCE_TYPE} --iam-instance-profile Name=${PROFILE_NAME} --security-group-ids ${SG_ID} --user-data file://<rendered> --tag-specifications ...Name=${INSTANCE_NAME},project=guidemate-poc"
  plan_note "ec2 wait instance-running --instance-ids <new-iid>"
  plan_note "ec2 associate-address --instance-id <new-iid> --allocation-id ${ALLOC_ID}"
  echo ""
  echo "== PLAN complete: no resources created. Re-run without --plan to launch. =="
  exit 0
fi

echo ">> Render user-data"
UD="$(mktemp)"
sed -e "s#@@DOMAIN@@#${DOMAIN}#g" \
    -e "s#@@ADMIN_PW@@#${ADMIN_PW}#g" \
    -e "s#@@REGION@@#${REGION}#g" \
    -e "s#@@REPO@@#${REPO}#g" \
    -e "s#@@BRANCH@@#${BRANCH}#g" \
    user_data.sh > "${UD}"

echo ">> Launch ${INSTANCE_TYPE}"
IID="$(q ec2 run-instances --image-id "${AMI_ID}" --instance-type "${INSTANCE_TYPE}" \
  --iam-instance-profile "Name=${PROFILE_NAME}" \
  --security-group-ids "${SG_ID}" \
  --user-data "file://${UD}" \
  --tag-specifications \
    "ResourceType=instance,Tags=[{Key=project,Value=guidemate-poc},{Key=Name,Value=${INSTANCE_NAME}}]" \
  --query 'Instances[0].InstanceId' --output text)"
rm -f "${UD}"
echo "   Instance ${IID}"

echo ">> Wait for running, then associate EIP"
q ec2 wait instance-running --instance-ids "${IID}"
q ec2 associate-address --instance-id "${IID}" --allocation-id "${ALLOC_ID}" >/dev/null

cat <<DONE

============================================================
  guide-mate production launched
  Instance : ${IID}
  URL      : https://${DOMAIN}   (Caddy TLS provisions in ~1-2 min)
  Admin PW : ${ADMIN_PW}   <-- save this now; not stored anywhere else
------------------------------------------------------------
  Next:
    scripts/setup_observability.sh          # dashboard + alarms (pass the instance id)
    Watch bootstrap:  aws ssm start-session --target ${IID}
                      sudo tail -f /var/log/guidemate-bootstrap.log
============================================================
DONE
