#!/bin/bash
# One-time migration script for v0.1.1
# Migrates the macOS Image Builder stack from cross-stack subnet export to SSM parameter.
# Run this ONCE per existing deployment before running deploy.sh with the new code.
#
# Usage: ./scripts/migrate-macos-subnet.sh
#
# Works from CloudShell or any environment with AWS CLI, Node.js, and CDK installed.

set -e

# Ensure we're in the project root
if [[ ! -f "package.json" ]]; then
    echo "ERROR: Run this from the project root directory (where package.json is)."
    exit 1
fi

# Install dependencies if needed
if [[ ! -d "node_modules" ]]; then
    echo "Installing CDK dependencies..."
    npm install --silent
fi

# Build frontend if dist doesn't exist (CDK synth needs it even for non-frontend stacks)
if [[ ! -d "frontend/dist" ]]; then
    echo "Building frontend..."
    if [[ ! -d "frontend/node_modules" ]]; then
        (cd frontend && npm install --silent)
    fi
    (cd frontend && npm run build)
fi

# Build CDK
echo "Building CDK..."
npm run build --silent

# Restore cdk.json from SSM if missing (same logic as CodeBuild buildspec)
if [[ ! -f "cdk.json" ]]; then
    echo "cdk.json not found, attempting to restore from SSM..."

    # Try common PascalCase names from cdk.example.json default
    if [[ -f "cdk.example.json" ]]; then
        cp cdk.example.json cdk.json
        echo "Created cdk.json from template"
    fi

    # Try to find the cdk.json in SSM by scanning known parameter paths
    # The CodeBuild pipeline stores it at /{PascalCase}/DeploymentConfig/cdk-json
    for CANDIDATE in MediaResourceManager TegnaFleetCommand AMCCloudEdit AMCCloudEditManager; do
        SAVED=$(aws ssm get-parameter --name "/${CANDIDATE}/DeploymentConfig/cdk-json" \
            --query "Parameter.Value" --output text 2>/dev/null || echo "")
        if [[ -n "$SAVED" && "$SAVED" != "None" ]]; then
            echo "$SAVED" > cdk.json
            echo "Restored cdk.json from SSM (/${CANDIDATE}/DeploymentConfig/cdk-json)"
            break
        fi
    done

    if [[ ! -f "cdk.json" ]]; then
        echo "ERROR: Could not find cdk.json. Create it manually:"
        echo '  cp cdk.example.json cdk.json'
        echo '  # Then edit productName if needed'
        exit 1
    fi
fi

# Derive naming from cdk.json
PRODUCT_NAME=$(node -p "require('./cdk.json').context.productName" 2>/dev/null || echo "Media Resource Manager")
PASCAL=$(echo "$PRODUCT_NAME" | sed 's/ //g; s/[^a-zA-Z0-9]//g')
ACRONYM=$(node -p "'${PRODUCT_NAME}'.split(' ').map(w => w.charAt(0).toUpperCase()).join('')" 2>/dev/null)

echo "Product:    $PRODUCT_NAME"
echo "PascalCase: $PASCAL"
echo "Acronym:    $ACRONYM"
echo ""

INFRA_STACK="${ACRONYM}-Infrastructure"
MACOS_STACK="${ACRONYM}-Image-MacOS"
SSM_PARAM="/${PASCAL}/Network/MacBuildSubnetId"

# Check if the macOS stack exists (skip for fresh deploys)
if ! aws cloudformation describe-stacks --stack-name "$MACOS_STACK" >/dev/null 2>&1; then
    echo "Stack $MACOS_STACK does not exist — no migration needed."
    exit 0
fi

# Step 1: Seed the SSM parameter with the first private subnet ID
echo "Step 1: Seeding SSM parameter with current subnet ID..."
SUBNET=$(aws cloudformation describe-stacks --stack-name "$INFRA_STACK" \
    --query "Stacks[0].Outputs[?contains(OutputKey,'PrivateSubnet1')].OutputValue" \
    --output text 2>/dev/null | head -1)

if [[ -z "$SUBNET" ]]; then
    echo "ERROR: Could not find private subnet from ${INFRA_STACK} outputs."
    exit 1
fi

echo "  Subnet ID: $SUBNET"
aws ssm put-parameter --name "$SSM_PARAM" \
    --type String --value "$SUBNET" \
    --description "Migration: temp subnet for Image-MacOS" \
    --no-overwrite 2>/dev/null || echo "  SSM parameter already exists, skipping."

# Step 2: Deploy Image-MacOS exclusively to switch from cross-stack import to SSM
echo ""
echo "Step 2: Deploying ${MACOS_STACK} to release cross-stack subnet import..."
npx cdk deploy "$MACOS_STACK" --exclusively --require-approval never

# Step 3: Delete the manually created SSM parameter so CDK can own it
echo ""
echo "Step 3: Removing temporary SSM parameter (CDK will recreate it)..."
aws ssm delete-parameter --name "$SSM_PARAM" 2>/dev/null || true

echo ""
echo "✅ Migration complete. You can now run ./deploy.sh -y or trigger a CodeBuild build."
