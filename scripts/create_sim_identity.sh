#!/usr/bin/env bash
# Mint the Gazebo sim's AWS IoT identity — a SEPARATE thing/cert/policy/shadow from the real robot.
# Idempotent: safe to re-run. Never touches the real robot's identity, shadow, or policy.
set -euo pipefail

AWS="${AWS:-$HOME/.local/bin/aws}"
REGION="${AWS_REGION:-us-west-2}"
THING="Turtlebot-Sim"
POLICY="guidemate-sim-policy"
CERT_PEM="$HOME/.aws/guidemate-sim.cert.pem"
KEY_PEM="$HOME/.aws/guidemate-sim.key.pem"
TAGS="Key=project,Value=guidemate-poc"

echo "== 1. Thing =="
if "$AWS" iot describe-thing --thing-name "$THING" --region "$REGION" >/dev/null 2>&1; then
  echo "thing $THING already exists — skipping create"
else
  "$AWS" iot create-thing --thing-name "$THING" --region "$REGION" >/dev/null
  "$AWS" iot tag-resource \
    --resource-arn "arn:aws:iot:${REGION}:$("$AWS" sts get-caller-identity --query Account --output text):thing/${THING}" \
    --tags "$TAGS" --region "$REGION" >/dev/null || true
  echo "created thing $THING"
fi

echo "== 2. Policy (scoped to guidemate/turtlebotsim/* + this thing's shadow) =="
POLICY_DOC='{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "iot:Connect",
      "Resource": "arn:aws:iot:'"$REGION"':*:client/guidemate-*" },
    { "Effect": "Allow", "Action": ["iot:Publish", "iot:Receive"],
      "Resource": [
        "arn:aws:iot:'"$REGION"':*:topic/guidemate/turtlebotsim/*",
        "arn:aws:iot:'"$REGION"':*:topic/$aws/things/Turtlebot-Sim/shadow/*" ] },
    { "Effect": "Allow", "Action": "iot:Subscribe",
      "Resource": [
        "arn:aws:iot:'"$REGION"':*:topicfilter/guidemate/turtlebotsim/*",
        "arn:aws:iot:'"$REGION"':*:topicfilter/$aws/things/Turtlebot-Sim/shadow/*" ] }
  ]
}'
if "$AWS" iot get-policy --policy-name "$POLICY" --region "$REGION" >/dev/null 2>&1; then
  echo "policy $POLICY already exists — skipping create"
else
  "$AWS" iot create-policy --policy-name "$POLICY" \
    --policy-document "$POLICY_DOC" \
    --tags "$TAGS" --region "$REGION" >/dev/null
  echo "created policy $POLICY"
fi

echo "== 3. Certificate + private key =="
if [[ -f "$CERT_PEM" && -f "$KEY_PEM" ]]; then
  echo "local cert/key already present at $CERT_PEM — reusing (no new cert minted)"
  CERT_ARN="$("$AWS" iot list-thing-principals --thing-name "$THING" --region "$REGION" \
             --query 'principals[0]' --output text 2>/dev/null || echo None)"
else
  OUT="$("$AWS" iot create-keys-and-certificate --set-as-active \
        --certificate-pem-outfile "$CERT_PEM" \
        --private-key-outfile "$KEY_PEM" \
        --region "$REGION" --output json)"
  CERT_ARN="$(echo "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["certificateArn"])')"
  chmod 600 "$CERT_PEM" "$KEY_PEM"
  echo "created cert $CERT_ARN and wrote $CERT_PEM / $KEY_PEM (chmod 600)"
  "$AWS" iot attach-policy --policy-name "$POLICY" --target "$CERT_ARN" --region "$REGION"
  "$AWS" iot attach-thing-principal --thing-name "$THING" --principal "$CERT_ARN" --region "$REGION"
  echo "attached policy + thing to cert"
fi

echo "== 4. Classic shadow — DEFAULT-DENY (identical to the real robot) =="
"$AWS" iot-data update-thing-shadow --thing-name "$THING" --region "$REGION" \
  --cli-binary-format raw-in-base64-out \
  --payload '{"state": {"desired": {"motion_enabled": false, "max_speed": 0.15, "dry_run": true}}}' \
  /dev/stdout >/dev/null
echo "initialized $THING shadow desired = {motion_enabled: false, max_speed: 0.15, dry_run: true}"

echo "DONE. Sim identity ready. Cert: $CERT_PEM  Policy: $POLICY  Shadow: locked."
