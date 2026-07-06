#!/usr/bin/env bash
# Create all CloudWatch observability for the guide-mate POC (no console clicking):
# log groups, Bedrock invocation logging, metric filters, dashboard, 4 alarms.
# Usage:  scripts/setup_observability.sh            # create/update everything
#         scripts/setup_observability.sh --clean    # delete everything it created
set -euo pipefail
AWS="${AWS:-aws}"
REGION="${AWS_REGION:-us-west-2}"
ACCOUNT="852373397000"
NS="GuideMate"
DASH="guidemate-poc"
BEDROCK_GROUP="/guidemate/bedrock"
SVC_GROUP="/guidemate/agent-service"
BRIDGE_GROUP="/guidemate/bridge"
BEDROCK_ROLE="guidemate-bedrock-logging-role"
q() { $AWS --region "$REGION" "$@"; }

if [ "${1:-}" = "--clean" ]; then
  q cloudwatch delete-dashboards --dashboard-names "${DASH}" || true
  q cloudwatch delete-alarms --alarm-names \
    guidemate-poc-service-errors guidemate-poc-bedrock-throttle \
    guidemate-poc-bridge-offline guidemate-poc-ec2-cpu || true
  q logs delete-metric-filter --log-group-name "${SVC_GROUP}" --filter-name guidemate-service-errors || true
  q logs delete-metric-filter --log-group-name "${SVC_GROUP}" --filter-name guidemate-bedrock-throttle || true
  q bedrock delete-model-invocation-logging-configuration || true
  echo ">> cleaned"
  exit 0
fi

echo ">> Log groups"
for g in "${BEDROCK_GROUP}" "${SVC_GROUP}" "${BRIDGE_GROUP}" "/guidemate/caddy"; do
  q logs create-log-group --log-group-name "$g" 2>/dev/null || true
  q logs put-retention-policy --log-group-name "$g" --retention-in-days 30 || true
done

echo ">> Bedrock model-invocation logging role"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"bedrock.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
q iam create-role --role-name "${BEDROCK_ROLE}" \
  --assume-role-policy-document "${TRUST}" \
  --tags Key=project,Value=guidemate-poc 2>/dev/null || true
POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:'"${REGION}"':'"${ACCOUNT}"':log-group:'"${BEDROCK_GROUP}"':*"}]}'
q iam put-role-policy --role-name "${BEDROCK_ROLE}" \
  --policy-name guidemate-bedrock-logging --policy-document "${POLICY}"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${BEDROCK_ROLE}"
sleep 10  # let the new role/trust propagate before Bedrock validates it

echo ">> Enable Bedrock invocation logging"
q bedrock put-model-invocation-logging-configuration --logging-config '{
  "cloudWatchConfig": {"logGroupName": "'"${BEDROCK_GROUP}"'", "roleArn": "'"${ROLE_ARN}"'"},
  "textDataDeliveryEnabled": true,
  "imageDataDeliveryEnabled": false,
  "embeddingDataDeliveryEnabled": false
}'

echo ">> Metric filters on ${SVC_GROUP}"
q logs put-metric-filter --log-group-name "${SVC_GROUP}" \
  --filter-name guidemate-service-errors \
  --filter-pattern '{ $.level = "ERROR" }' \
  --metric-transformations metricName=AgentServiceErrors,metricNamespace="${NS}",metricValue=1,defaultValue=0
q logs put-metric-filter --log-group-name "${SVC_GROUP}" \
  --filter-name guidemate-bedrock-throttle \
  --filter-pattern '"ThrottlingException"' \
  --metric-transformations metricName=BedrockThrottles,metricNamespace="${NS}",metricValue=1,defaultValue=0

echo ">> Alarms (no SNS action — visible in console/dashboard state only)"
q cloudwatch put-metric-alarm --alarm-name guidemate-poc-service-errors \
  --namespace "${NS}" --metric-name AgentServiceErrors --statistic Sum \
  --period 300 --evaluation-periods 1 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
  --tags Key=project,Value=guidemate-poc
q cloudwatch put-metric-alarm --alarm-name guidemate-poc-bedrock-throttle \
  --namespace "${NS}" --metric-name BedrockThrottles --statistic Sum \
  --period 300 --evaluation-periods 1 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
  --tags Key=project,Value=guidemate-poc
q cloudwatch put-metric-alarm --alarm-name guidemate-poc-bridge-offline \
  --namespace "${NS}" --metric-name PiHeartbeat \
  --dimensions Name=robot_id,Value=turtlebot468 --statistic SampleCount \
  --period 300 --evaluation-periods 3 --threshold 1 \
  --comparison-operator LessThanThreshold --treat-missing-data breaching \
  --tags Key=project,Value=guidemate-poc

echo ">> EC2 CPU alarm (only if a tagged instance exists)"
IID="$(q ec2 describe-instances \
  --filters "Name=tag:Name,Values=guidemate-poc-ec2" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)"
if [ -n "${IID}" ] && [ "${IID}" != "None" ]; then
  q cloudwatch put-metric-alarm --alarm-name guidemate-poc-ec2-cpu \
    --namespace AWS/EC2 --metric-name CPUUtilization \
    --dimensions Name=InstanceId,Value="${IID}" --statistic Average \
    --period 300 --evaluation-periods 2 --threshold 85 \
    --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching \
    --tags Key=project,Value=guidemate-poc
else
  echo "   (no running instance — skipping CPU alarm; re-run after launch_ec2.sh)"
fi

echo ">> Dashboard ${DASH}"
DASHBODY="$(mktemp)"
cat > "${DASHBODY}" <<JSON
{"widgets":[
 {"type":"metric","x":0,"y":0,"width":12,"height":6,"properties":{
   "title":"Turn latency (ms)","region":"${REGION}","stat":"Average","period":300,
   "metrics":[["${NS}","TurnLatencyMs",{"stat":"Average"}],["${NS}","TurnLatencyMs",{"stat":"p90"}]]}},
 {"type":"metric","x":12,"y":0,"width":12,"height":6,"properties":{
   "title":"Ack round-trip (ms) by robot","region":"${REGION}","stat":"Average","period":300,
   "metrics":[["${NS}","AckRoundTripMs","robot_id","turtlebot468"]]}},
 {"type":"metric","x":0,"y":6,"width":12,"height":6,"properties":{
   "title":"Bedrock tokens / turn","region":"${REGION}","stat":"Sum","period":300,
   "metrics":[["${NS}","BedrockInputTokens"],["${NS}","BedrockOutputTokens"]]}},
 {"type":"metric","x":12,"y":6,"width":12,"height":6,"properties":{
   "title":"Errors & throttles","region":"${REGION}","stat":"Sum","period":300,
   "metrics":[["${NS}","AgentServiceErrors"],["${NS}","BedrockThrottles"]]}},
 {"type":"metric","x":0,"y":12,"width":12,"height":6,"properties":{
   "title":"Robot presence (PiHeartbeat count)","region":"${REGION}","stat":"SampleCount","period":300,
   "metrics":[["${NS}","PiHeartbeat","robot_id","turtlebot468"]]}},
 {"type":"metric","x":12,"y":12,"width":12,"height":6,"properties":{
   "title":"EC2 CPU %","region":"${REGION}","stat":"Average","period":300,
   "metrics":[["AWS/EC2","CPUUtilization"]]}}
]}
JSON
q cloudwatch put-dashboard --dashboard-name "${DASH}" --dashboard-body "file://${DASHBODY}"
rm -f "${DASHBODY}"
echo ">> observability ready — dashboard '${DASH}', 4 alarms, Bedrock logging on."
