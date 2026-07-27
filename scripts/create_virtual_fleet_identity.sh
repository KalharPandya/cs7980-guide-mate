#!/usr/bin/env bash
# Mint the "virtual fleet" AWS IoT identity: ONE thing/cert/policy/shadow shared by every
# server-simulated virtual robot in the browser 3D world (Task 2.2 of the virtual-world guide
# fleet plan; see docs/superpowers/specs/2026-07-26-virtual-world-guide-fleet-design.md).
# Clone of scripts/create_sim_identity.sh (same structure/idempotency), widened for the fleet's
# topic scope. Never touches Turtlebot-468 (real robot) or Turtlebot-Sim (single Gazebo sim):
# this is a THIRD, separate identity.
#
# SAFE BY DEFAULT: with no flags this is a DRY RUN. It prints every AWS CLI call it would make
# and the exact policy JSON, but calls NO mutating AWS API (read-only "does this already exist"
# checks still run so the printed plan reflects reality). Pass --apply to actually create the
# thing/policy/cert/shadow. Idempotent either way: safe to re-run, skips what already exists.
set -euo pipefail

APPLY=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    -h|--help)
      echo "usage: $0 [--apply]"
      echo "  (no args)  dry run, print the AWS CLI calls + policy JSON, mutate nothing"
      echo "  --apply    actually create the thing/policy/cert/shadow (idempotent)"
      exit 0
      ;;
    *) echo "unknown arg: $arg (use --apply or --help)" >&2; exit 1 ;;
  esac
done

# Resolve an aws CLI: explicit $AWS env var wins, then the Pi/laptop convention
# ($HOME/.local/bin/aws), then whatever's on PATH (e.g. this Windows box).
if [[ -n "${AWS:-}" ]]; then
  AWS_BIN="$AWS"
elif [[ -x "$HOME/.local/bin/aws" ]]; then
  AWS_BIN="$HOME/.local/bin/aws"
else
  AWS_BIN="aws"
fi
REGION="${AWS_REGION:-us-west-2}"
THING="Virtual-Fleet"
POLICY="guidemate-fleet-policy"
CERT_PEM="$HOME/.aws/guidemate-fleet.cert.pem"
KEY_PEM="$HOME/.aws/guidemate-fleet.key.pem"
TAGS="Key=project,Value=guidemate-poc"

# NOTE on topic scope (flag for Task 2.3 / whoever builds the Node MQTT bridge):
# the design spec (docs/superpowers/specs/2026-07-26-virtual-world-guide-fleet-design.md,
# "IoT and command schema") writes the fleet scope as guidemate/virtual/+/*. The existing
# helper functions in shared/guidemate_msgs/guidemate_msgs/messages.py build topics as
# guidemate/{robot_id}/cmd and guidemate/{robot_id}/status (flat, no "virtual/" segment), so to
# land under the design's guidemate/virtual/... root with those SAME helpers unmodified, each
# virtual robot's robot_id must itself be namespaced like "virtual/1", "virtual/2", ...
# (e.g. cmd_topic("virtual/1") -> "guidemate/virtual/1/cmd"). This script assumes that scheme and
# scopes the policy to the topic ROOT guidemate/virtual/* (one trailing wildcard, exactly like
# the existing sim policy's guidemate/turtlebotsim/*: AWS IoT policy resource wildcards are
# glob-style and cross "/" boundaries, so this covers any robot id depth under that root).
# ASSUMPTION, Task 2.3 must confirm or correct this: if the bridge instead picks flat ids like
# "virtual-1" (topic "guidemate/virtual-1/cmd"), those do NOT fall under "guidemate/virtual/*"
# and the policy below would need a second statement (or a broader root) to match.
TOPIC_ROOT="guidemate/virtual"

echo "== virtual fleet IoT identity =="
if [[ "$APPLY" == "true" ]]; then
  echo "MODE: --apply (this WILL create/mutate real AWS IoT resources)"
else
  echo "MODE: dry run (default). Re-run with --apply to actually create anything."
fi
echo "region=$REGION thing=$THING policy=$POLICY topic-root=$TOPIC_ROOT"
echo

dry_run_echo() {
  printf '[DRY-RUN] would run:'
  printf ' %q' "$@"
  printf '\n'
}

echo "== 1. Thing ($THING) =="
if "$AWS_BIN" iot describe-thing --thing-name "$THING" --region "$REGION" >/dev/null 2>&1; then
  echo "thing $THING already exists, skipping create"
else
  if [[ "$APPLY" == "true" ]]; then
    "$AWS_BIN" iot create-thing --thing-name "$THING" --region "$REGION" >/dev/null
    ACCOUNT="$("$AWS_BIN" sts get-caller-identity --query Account --output text --region "$REGION")"
    "$AWS_BIN" iot tag-resource \
      --resource-arn "arn:aws:iot:${REGION}:${ACCOUNT}:thing/${THING}" \
      --tags "$TAGS" --region "$REGION" >/dev/null || true
    echo "created thing $THING"
  else
    dry_run_echo "$AWS_BIN" iot create-thing --thing-name "$THING" --region "$REGION"
    echo "  then tag-resource, wrapped in '|| true': AWS IoT can't tag a bare 'thing' resource," \
         "same quirk create_sim_identity.sh absorbs"
    dry_run_echo "$AWS_BIN" iot tag-resource \
      --resource-arn "arn:aws:iot:${REGION}:<ACCOUNT_ID>:thing/${THING}" \
      --tags "$TAGS" --region "$REGION"
  fi
fi

echo "== 2. Policy (scoped to ${TOPIC_ROOT}/* plus this thing's shadow) =="
POLICY_DOC='{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "iot:Connect",
      "Resource": "arn:aws:iot:'"$REGION"':*:client/guidemate-*" },
    { "Effect": "Allow", "Action": ["iot:Publish", "iot:Receive"],
      "Resource": [
        "arn:aws:iot:'"$REGION"':*:topic/'"$TOPIC_ROOT"'/*",
        "arn:aws:iot:'"$REGION"':*:topic/$aws/things/'"$THING"'/shadow/*" ] },
    { "Effect": "Allow", "Action": "iot:Subscribe",
      "Resource": [
        "arn:aws:iot:'"$REGION"':*:topicfilter/'"$TOPIC_ROOT"'/*",
        "arn:aws:iot:'"$REGION"':*:topicfilter/$aws/things/'"$THING"'/shadow/*" ] }
  ]
}'
echo "-- proposed policy document (for human/controller review before --apply) --"
echo "$POLICY_DOC"
echo "-- end policy document --"
if "$AWS_BIN" iot get-policy --policy-name "$POLICY" --region "$REGION" >/dev/null 2>&1; then
  echo "policy $POLICY already exists, skipping create"
else
  if [[ "$APPLY" == "true" ]]; then
    "$AWS_BIN" iot create-policy --policy-name "$POLICY" \
      --policy-document "$POLICY_DOC" \
      --tags "$TAGS" --region "$REGION" >/dev/null
    echo "created policy $POLICY"
  else
    echo "  would run: $AWS_BIN iot create-policy --policy-name $POLICY" \
         "--policy-document <the POLICY_DOC printed above> --tags $TAGS --region $REGION"
  fi
fi

echo "== 3. Certificate + private key =="
if [[ -f "$CERT_PEM" && -f "$KEY_PEM" ]]; then
  echo "local cert/key already present at $CERT_PEM, reusing (no new cert minted)"
  CERT_ARN="$("$AWS_BIN" iot list-thing-principals --thing-name "$THING" --region "$REGION" \
             --query 'principals[0]' --output text 2>/dev/null || echo None)"
  echo "existing principal: $CERT_ARN"
else
  if [[ "$APPLY" == "true" ]]; then
    OUT="$("$AWS_BIN" iot create-keys-and-certificate --set-as-active \
          --certificate-pem-outfile "$CERT_PEM" \
          --private-key-outfile "$KEY_PEM" \
          --region "$REGION" --output json)"
    CERT_ARN="$(echo "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["certificateArn"])')"
    chmod 600 "$CERT_PEM" "$KEY_PEM"
    echo "created cert $CERT_ARN and wrote $CERT_PEM / $KEY_PEM (chmod 600)"
    "$AWS_BIN" iot attach-policy --policy-name "$POLICY" --target "$CERT_ARN" --region "$REGION"
    "$AWS_BIN" iot attach-thing-principal --thing-name "$THING" --principal "$CERT_ARN" --region "$REGION"
    echo "attached policy and thing to cert"
  else
    echo "no local cert/key at $CERT_PEM yet, would mint one:"
    dry_run_echo "$AWS_BIN" iot create-keys-and-certificate --set-as-active \
      --certificate-pem-outfile "$CERT_PEM" \
      --private-key-outfile "$KEY_PEM" \
      --region "$REGION" --output json
    dry_run_echo "$AWS_BIN" iot attach-policy --policy-name "$POLICY" --target "<new-cert-arn>" --region "$REGION"
    dry_run_echo "$AWS_BIN" iot attach-thing-principal --thing-name "$THING" --principal "<new-cert-arn>" --region "$REGION"
    echo "  then: chmod 600 $CERT_PEM $KEY_PEM"
  fi
fi

echo "== 4. Classic shadow, DEFAULT-DENY (same posture as the real robot and Turtlebot-Sim) =="
SHADOW_PAYLOAD='{"state": {"desired": {"motion_enabled": false, "max_speed": 0.15, "dry_run": true}}}'
# NOTE: this reuses the real-robot/sim shadow field names verbatim for consistency with the
# existing default-deny contract. The virtual fleet has no physical motor, so "motion_enabled"/
# "max_speed" don't map to hardware here; they exist so any future fleet-wide kill-switch tooling
# (e.g. the admin panel) can reconcile ONE schema across real, sim, and virtual identities. If a
# future task needs different fields for the fleet, they should be added, not silently redefined.
if [[ "$APPLY" == "true" ]]; then
  "$AWS_BIN" iot-data update-thing-shadow --thing-name "$THING" --region "$REGION" \
    --cli-binary-format raw-in-base64-out \
    --payload "$SHADOW_PAYLOAD" \
    /dev/stdout >/dev/null
  echo "initialized $THING shadow desired = {motion_enabled: false, max_speed: 0.15, dry_run: true}"
else
  dry_run_echo "$AWS_BIN" iot-data update-thing-shadow --thing-name "$THING" --region "$REGION" \
    --cli-binary-format raw-in-base64-out \
    --payload "$SHADOW_PAYLOAD" \
    /dev/stdout
fi

echo
if [[ "$APPLY" == "true" ]]; then
  echo "DONE. Virtual fleet identity ready. Cert: $CERT_PEM  Policy: $POLICY  Shadow: locked."
else
  echo "DRY RUN complete, nothing was created. Review the policy JSON above, then re-run with --apply."
fi
