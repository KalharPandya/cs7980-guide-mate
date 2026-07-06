#!/usr/bin/env bash
# EC2 bootstrap for the guide-mate dog-agent (AL2023). Runs once at first boot.
# NOTE: no `x` in the shell flags on purpose — xtrace would echo the generated
# admin password into the world-readable bootstrap log.
set -euo pipefail
exec > >(tee /var/log/guidemate-bootstrap.log) 2>&1
# Belt+braces: keep the bootstrap log off world-readability from the first line.
chmod 640 /var/log/guidemate-bootstrap.log

REGION="@@REGION@@"
DOMAIN="@@DOMAIN@@"
REPO="@@REPO@@"
BRANCH="@@BRANCH@@"

# --- Docker + Compose v2 plugin ---
dnf install -y docker git
systemctl enable --now docker
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# --- CloudWatch agent: memory + disk (system metrics; containers log via awslogs) ---
dnf install -y amazon-cloudwatch-agent
cat > /opt/aws/amazon-cloudwatch-agent/etc/guidemate-cwagent.json <<'CWCFG'
{
  "agent": {"metrics_collection_interval": 60},
  "metrics": {
    "namespace": "GuideMate/EC2",
    "append_dimensions": {"InstanceId": "${aws:InstanceId}"},
    "metrics_collected": {
      "mem": {"measurement": [{"name": "mem_used_percent", "rename": "MemUsedPercent"}]},
      "disk": {"measurement": [{"name": "used_percent", "rename": "DiskUsedPercent"}], "resources": ["/"]}
    }
  }
}
CWCFG
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/guidemate-cwagent.json

# --- App: clone repo, write env, bring the prod stack up ---
install -d -m 755 /opt
git clone --branch "${BRANCH}" "${REPO}" /opt/guidemate
IOT_ENDPOINT="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --region "${REGION}" --query endpointAddress --output text)"

# Admin password is minted HERE, on the instance — never passed through user-data
# (which is readable for the instance lifetime via ec2:DescribeInstanceAttribute).
ADMIN_PW="$(openssl rand -hex 16)"
# Push it to SSM Parameter Store (SecureString) so operators can retrieve it without
# ever printing it to a log. The instance role has ssm:PutParameter.
aws ssm put-parameter --name /guidemate/admin-password --type SecureString \
  --value "${ADMIN_PW}" --overwrite --region "${REGION}" >/dev/null

# Write the env file mode-600 from the start, then append (no secret ever transits a
# world-readable heredoc temp state; install seeds an empty 600 file we own).
install -m 600 /dev/null /etc/guidemate.env
cat >> /etc/guidemate.env <<ENV
GUIDEMATE_DOMAIN=${DOMAIN}
GUIDEMATE_ROBOTS=turtlebot468
GUIDEMATE_MODEL_ID=us.anthropic.claude-sonnet-4-6
AWS_REGION=${REGION}
GUIDEMATE_IOT_ENDPOINT=${IOT_ENDPOINT}
GUIDEMATE_ADMIN_PASSWORD=${ADMIN_PW}
ENV

cd /opt/guidemate/agent_service
docker compose --env-file /etc/guidemate.env -f compose.yaml -f compose.prod.yaml up -d --build
echo "guidemate bootstrap complete"
