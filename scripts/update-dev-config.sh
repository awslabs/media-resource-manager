#!/bin/bash

# Script to update development configuration with current API Gateway URL

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Change to project directory
cd "$PROJECT_DIR"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() {
    echo -e "${BLUE}$1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_status "🔄 Updating development configuration..."

# Get product name from cdk.json context and generate acronym
PRODUCT_NAME=$(node -p "require('./cdk.json').context.productName" 2>/dev/null || echo "Media Resource Manager")
ACRONYM=$(echo "$PRODUCT_NAME" | sed 's/[^a-zA-Z ]//g' | awk '{for(i=1;i<=NF;i++) printf toupper(substr($i,1,1))}')

print_status "📋 Product Name: $PRODUCT_NAME"
print_status "🏷️  Acronym: $ACRONYM"

# Get the frontend bucket name
FRONTEND_BUCKET=$(aws cloudformation describe-stacks --stack-name ${ACRONYM}-Frontend --query 'Stacks[0].Outputs[?OutputKey==`WebsiteBucketName`].OutputValue' --output text 2>/dev/null)

if [[ "$FRONTEND_BUCKET" == "None" ]] || [[ -z "$FRONTEND_BUCKET" ]]; then
    echo "❌ Could not retrieve Frontend bucket name. Make sure the stack is deployed."
    exit 1
fi

print_status "📦 Frontend bucket: $FRONTEND_BUCKET"

# Create public directory if it doesn't exist
mkdir -p frontend/public

# Download the production config from S3
print_status "📥 Downloading config from S3..."
aws s3 cp "s3://${FRONTEND_BUCKET}/config.json" frontend/public/config-dev.json

# Replace the apiUrl with the proxy path for local development
print_status "🔧 Updating apiUrl for local proxy..."
if command -v jq &> /dev/null; then
    # Use jq if available
    jq '.apiUrl = "/api"' frontend/public/config-dev.json > frontend/public/config-dev.json.tmp
    mv frontend/public/config-dev.json.tmp frontend/public/config-dev.json
else
    # Fallback to sed
    sed -i 's|"apiUrl": "[^"]*"|"apiUrl": "/api"|' frontend/public/config-dev.json
fi

# Get current API Gateway URL for vite proxy
API_URL=$(aws cloudformation describe-stacks --stack-name ${ACRONYM}-Api --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text 2>/dev/null)

if [[ "$API_URL" == "None" ]] || [[ -z "$API_URL" ]]; then
    echo "❌ Could not retrieve API Gateway URL. Make sure the stack is deployed."
    exit 1
fi

# Remove trailing slash
API_URL=${API_URL%/}

print_status "📡 API URL: $API_URL"

# Update vite.config.ts proxy target
sed -i "s|target: 'https://[^']*'|target: '$API_URL'|g" frontend/vite.config.ts

print_success "Development configuration updated!"
print_success "API proxy target: $API_URL"
print_success "Config file: frontend/public/config-dev.json"
