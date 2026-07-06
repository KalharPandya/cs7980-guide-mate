#!/usr/bin/env bash
# Launch the guide-mate production host on EC2. Idempotent-ish: reuses a tagged
# SG + EIP, refuses to double-launch if a tagged instance is already running.
#
# Usage:
#   ./launch_ec2.sh          # for real: create/reuse resources, launch, associate EIP
#   ./launch_ec2.sh --plan   # dry run: run the READ-ONLY discovery/idempotency
#                            # lookups for real, but only PRINT the mutations
#                            # (no create/run/allocate/associate)
#
# The admin password is NEVER generated or handled here: user_data.sh mints it
# on the instance and stores it in SSM Parameter Store (/guidemate/admin-password,
# SecureString). Retrieve it with the command printed in the final banner.
set -euo pipefail
cd "$(dirname "$0")"

PLAN=0
[ "${1:-}" = "--plan" ] && PLAN=1

AWS="${AWS:-aws}"
REGION="${AWS_REGION:-us-west-2}"
REPO="${GUIDEMATE_REPO:-https://github.com/KalharPandya/cs7980-guide-mate.git}"
BRANCH="${GUIDEMATE_BRANCH:-kalhar/dog-agent-poc}"
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

echo ">> Resolve VPC (env override -> default VPC -> sole VPC -> fail)"
if [ -n "${GUIDEMATE_VPC_ID:-}" ]; then
  VPC_ID="${GUIDEMATE_VPC_ID}"
  echo "   using GUIDEMATE_VPC_ID=${VPC_ID}"
else
  VPC_ID="$(q ec2 describe-vpcs --filters Name=isDefault,Values=true \
    --query 'Vpcs[0].VpcId' --output text 2>/dev/null || true)"
  if [ "${VPC_ID}" = "None" ] || [ -z "${VPC_ID}" ]; then
    # No default VPC (this sandbox account has none). Use the sole VPC if unambiguous.
    ALL_VPCS="$(q ec2 describe-vpcs --query 'Vpcs[].VpcId' --output text)"
    VPC_COUNT="$(echo ${ALL_VPCS} | wc -w)"
    if [ "${VPC_COUNT}" -eq 1 ]; then
      VPC_ID="${ALL_VPCS}"
      echo "   no default VPC; using the only VPC ${VPC_ID}"
    else
      echo "!! No default VPC and ${VPC_COUNT} VPCs exist. Set GUIDEMATE_VPC_ID to one of:" >&2
      q ec2 describe-vpcs --query 'Vpcs[].{VpcId:VpcId,Cidr:CidrBlock,IsDefault:IsDefault}' \
        --output table >&2
      exit 1
    fi
  else
    echo "   using default VPC ${VPC_ID}"
  fi
fi

echo ">> Resolve PUBLIC subnet (env override -> 0.0.0.0/0->igw route, prefer MapPublicIpOnLaunch)"
if [ -n "${GUIDEMATE_SUBNET_ID:-}" ]; then
  SUBNET_ID="${GUIDEMATE_SUBNET_ID}"
  echo "   using GUIDEMATE_SUBNET_ID=${SUBNET_ID}"
else
  # Subnets with no explicit route-table association fall through to the VPC main table.
  MAIN_RTB="$(q ec2 describe-route-tables \
    --filters "Name=vpc-id,Values=${VPC_ID}" "Name=association.main,Values=true" \
    --query 'RouteTables[0].RouteTableId' --output text 2>/dev/null || true)"
  SUBNET_ID=""
  FALLBACK_SUBNET=""   # public route but MapPublicIpOnLaunch=false; used only if no better one
  for sn in $(q ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC_ID}" \
      --query 'Subnets[].SubnetId' --output text); do
    RTB="$(q ec2 describe-route-tables \
      --filters "Name=association.subnet-id,Values=${sn}" \
      --query 'RouteTables[0].RouteTableId' --output text 2>/dev/null || true)"
    if [ "${RTB}" = "None" ] || [ -z "${RTB}" ]; then RTB="${MAIN_RTB}"; fi
    [ -z "${RTB}" ] && continue
    IGW="$(q ec2 describe-route-tables --route-table-ids "${RTB}" \
      --query "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0'].GatewayId | [0]" \
      --output text 2>/dev/null || true)"
    case "${IGW}" in
      igw-*)
        MAPS="$(q ec2 describe-subnets --subnet-ids "${sn}" \
          --query 'Subnets[0].MapPublicIpOnLaunch' --output text)"
        if [ "${MAPS}" = "True" ]; then SUBNET_ID="${sn}"; break; fi
        [ -z "${FALLBACK_SUBNET}" ] && FALLBACK_SUBNET="${sn}"
        ;;
    esac
  done
  [ -z "${SUBNET_ID}" ] && SUBNET_ID="${FALLBACK_SUBNET}"
  if [ -z "${SUBNET_ID}" ]; then
    echo "!! No PUBLIC subnet (a 0.0.0.0/0 route to an igw-*) found in ${VPC_ID}." >&2
    echo "   Existing subnets in this VPC:" >&2
    q ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC_ID}" \
      --query 'Subnets[].{SubnetId:SubnetId,AZ:AvailabilityZone,MapPublicIpOnLaunch:MapPublicIpOnLaunch}' \
      --output table >&2
    echo "   Set GUIDEMATE_SUBNET_ID, or provision IGW + public subnet before launching." >&2
    exit 1
  fi
  echo "   public subnet ${SUBNET_ID}"
fi

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
if [ -z "${MYIP}" ]; then
  echo "!! checkip returned empty; SSH (22) ingress rule will be skipped." >&2
  echo "   Set the 22/32 rule manually or re-run once checkip resolves." >&2
fi
for pair in "80:0.0.0.0/0" "443:0.0.0.0/0" ${MYIP:+"22:${MYIP}/32"}; do
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
# Domain: prefer an explicit GUIDEMATE_DOMAIN (real DNS, e.g. echo.kalhar.ca);
# fall back to the <eip-dashes>.nip.io hostname when unset. Caddy obtains a
# Let's Encrypt cert for whichever name resolves to ${EIP} on ports 80/443.
DOMAIN="${GUIDEMATE_DOMAIN:-$(echo "${EIP}" | tr '.' '-').nip.io}"
echo "   EIP ${EIP} -> ${DOMAIN}"

echo ">> Admin password: generated ON THE INSTANCE by user_data.sh (never here)"
echo "   stored in SSM Parameter Store as /guidemate/admin-password (SecureString)"

echo ">> Latest AL2023 AMI"
AMI_ID="$(q ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)"
echo "   AMI ${AMI_ID}"

if [ "$PLAN" -eq 1 ]; then
  echo ">> Render user-data + launch ${INSTANCE_TYPE} (skipped in plan)"
  echo "   Resolved VPC    : ${VPC_ID}"
  echo "   Resolved subnet : ${SUBNET_ID} (public)"
  plan_note "ec2 run-instances --image-id ${AMI_ID} --instance-type ${INSTANCE_TYPE} --iam-instance-profile Name=${PROFILE_NAME} --security-group-ids ${SG_ID} --subnet-id ${SUBNET_ID} --associate-public-ip-address --user-data file://<rendered> --tag-specifications ...Name=${INSTANCE_NAME},project=guidemate-poc"
  plan_note "ec2 wait instance-running --instance-ids <new-iid>"
  plan_note "ec2 associate-address --instance-id <new-iid> --allocation-id ${ALLOC_ID}"
  echo ""
  echo "== PLAN complete: no resources created. Re-run without --plan to launch. =="
  exit 0
fi

echo ">> Render user-data"
UD="$(mktemp)"
sed -e "s#@@DOMAIN@@#${DOMAIN}#g" \
    -e "s#@@REGION@@#${REGION}#g" \
    -e "s#@@REPO@@#${REPO}#g" \
    -e "s#@@BRANCH@@#${BRANCH}#g" \
    user_data.sh > "${UD}"

echo ">> Launch ${INSTANCE_TYPE}"
IID="$(q ec2 run-instances --image-id "${AMI_ID}" --instance-type "${INSTANCE_TYPE}" \
  --iam-instance-profile "Name=${PROFILE_NAME}" \
  --security-group-ids "${SG_ID}" \
  --subnet-id "${SUBNET_ID}" --associate-public-ip-address \
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
  Admin PW : generated on-instance; stored in SSM Parameter Store.
             Retrieve (after bootstrap finishes, ~2-3 min) with:
               aws ssm get-parameter --name /guidemate/admin-password \\
                 --with-decryption --query Parameter.Value --output text --region ${REGION}
------------------------------------------------------------
  Next:
    scripts/setup_observability.sh          # dashboard + alarms (pass the instance id)
    Watch bootstrap:  aws ssm start-session --target ${IID}
                      sudo tail -f /var/log/guidemate-bootstrap.log
============================================================
DONE
