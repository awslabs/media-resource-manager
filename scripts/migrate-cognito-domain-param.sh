#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-time migration: remove AuthSsoCognitoDomainParameterB2B616F6 from the
# MRM-Infrastructure CloudFormation stack state.
#
# Background
# ----------
# Commit eacb17c renamed the CDK construct ID for the SSO Cognito domain SSM
# parameter from 'SsoCognitoDomainParameter' to 'CognitoDomainParameter'.
# Environments deployed before that commit have the old logical ID
# (AuthSsoCognitoDomainParameterB2B616F6) in their stack state. The new CDK
# template generates AuthCognitoDomainParameter594586D0 for the same SSM path,
# causing a CloudFormation conflict on the next deploy.
#
# This script performs a two-step CloudFormation update to cleanly remove the
# old logical ID from the stack state without deleting the SSM parameter:
#
#   Step 1 — Add DeletionPolicy: Retain to the old resource, then update the
#             stack. CloudFormation now knows to keep the SSM param if removed.
#
#   Step 2 — Remove the resource from the template entirely, then update the
#             stack. CloudFormation drops it from state; SSM param is untouched.
#
# After this script completes, run: cdk deploy MRM-Infrastructure
# ---------------------------------------------------------------------------

set -euo pipefail

STACK_NAME="MRM-Infrastructure"
LOGICAL_ID="AuthSsoCognitoDomainParameterB2B616F6"
TEMPLATE_FILE="/tmp/infra-template.json"
RETAIN_TEMPLATE="/tmp/infra-retain.json"
REMOVED_TEMPLATE="/tmp/infra-removed.json"

echo "==> Fetching current deployed template..."
aws cloudformation get-template \
  --stack-name "$STACK_NAME" \
  --output json \
  | python3 -c "
import json, sys
response = json.load(sys.stdin)
body = response['TemplateBody']
template = body if isinstance(body, dict) else json.loads(body)
print(json.dumps(template, indent=2))
" > "$TEMPLATE_FILE"

echo "==> Verifying target resource exists..."
python3 -c "
import json, sys
with open('$TEMPLATE_FILE') as f:
    t = json.load(f)
if '$LOGICAL_ID' not in t.get('Resources', {}):
    print('ERROR: $LOGICAL_ID not found in template. Migration may already be complete.')
    sys.exit(1)
print('Found $LOGICAL_ID — proceeding.')
"

# ── Step 1: add DeletionPolicy: Retain ──────────────────────────────────────
echo ""
echo "==> Step 1: Adding DeletionPolicy: Retain to $LOGICAL_ID..."
python3 -c "
import json
with open('$TEMPLATE_FILE') as f:
    t = json.load(f)
t['Resources']['$LOGICAL_ID']['DeletionPolicy'] = 'Retain'
with open('$RETAIN_TEMPLATE', 'w') as f:
    json.dump(t, f, indent=2)
print('Written to $RETAIN_TEMPLATE')
"

# Upload retain template to S3 (required for large templates) or use --template-body
TEMPLATE_SIZE=$(wc -c < "$RETAIN_TEMPLATE")
echo "Template size: $TEMPLATE_SIZE bytes"

CDK_BUCKET="cdk-hnb659fds-assets-$(aws sts get-caller-identity --query Account --output text)-$(aws ec2 describe-availability-zones --output text --query 'AvailabilityZones[0].[RegionName]')"

echo "==> Uploading retain template to S3 ($CDK_BUCKET)..."
aws s3 cp "$RETAIN_TEMPLATE" "s3://$CDK_BUCKET/migrate-retain.json"
RETAIN_URL="https://$CDK_BUCKET.s3.amazonaws.com/migrate-retain.json"

echo "==> Updating stack with Retain policy..."
aws cloudformation update-stack \
  --stack-name "$STACK_NAME" \
  --template-url "$RETAIN_URL" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND

echo "==> Waiting for stack update to complete..."
aws cloudformation wait stack-update-complete --stack-name "$STACK_NAME"
echo "Step 1 complete."

# ── Step 2: remove the resource entirely ────────────────────────────────────
echo ""
echo "==> Step 2: Removing $LOGICAL_ID from template..."
python3 -c "
import json
with open('$RETAIN_TEMPLATE') as f:
    t = json.load(f)
del t['Resources']['$LOGICAL_ID']
with open('$REMOVED_TEMPLATE', 'w') as f:
    json.dump(t, f, indent=2)
print('Written to $REMOVED_TEMPLATE')
"

echo "==> Uploading removed template to S3..."
aws s3 cp "$REMOVED_TEMPLATE" "s3://$CDK_BUCKET/migrate-removed.json"
REMOVED_URL="https://$CDK_BUCKET.s3.amazonaws.com/migrate-removed.json"

echo "==> Updating stack with resource removed..."
aws cloudformation update-stack \
  --stack-name "$STACK_NAME" \
  --template-url "$REMOVED_URL" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND

echo "==> Waiting for stack update to complete..."
aws cloudformation wait stack-update-complete --stack-name "$STACK_NAME"
echo "Step 2 complete."

echo ""
echo "==> Migration complete. $LOGICAL_ID has been removed from stack state."
echo "    The SSM parameter /MediaResourceManager/Auth/CognitoDomain is retained in AWS."
echo ""
echo "    Now run: cdk deploy MRM-Infrastructure"
