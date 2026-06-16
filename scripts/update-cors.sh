#!/bin/bash

# Script to invoke the CORS updater Lambda to update API Gateway CORS headers
# and Cognito callback URLs after route changes

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Change to project directory
cd "$PROJECT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() {
    echo -e "${BLUE}$1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_status "🔄 Updating CORS configuration..."

# Get product name from cdk.json context and generate acronym
PRODUCT_NAME=$(node -p "require('./cdk.json').context.productName" 2>/dev/null || echo "Media Resource Manager")
ACRONYM=$(echo "$PRODUCT_NAME" | sed 's/[^a-zA-Z ]//g' | awk '{for(i=1;i<=NF;i++) printf toupper(substr($i,1,1))}')
ACRONYM_LOWER=$(echo "$ACRONYM" | tr '[:upper:]' '[:lower:]')

print_status "📋 Product Name: $PRODUCT_NAME"
print_status "🏷️  Acronym: $ACRONYM"

# Lambda function name follows the pattern: ${acronym}-cors-updater
LAMBDA_NAME="${ACRONYM_LOWER}-cors-updater"

print_status "🔍 Looking for Lambda function: $LAMBDA_NAME"

# Check if the Lambda exists
if ! aws lambda get-function --function-name "$LAMBDA_NAME" >/dev/null 2>&1; then
    print_error "Lambda function '$LAMBDA_NAME' not found. Make sure the API stack is deployed."
    exit 1
fi

print_status "🚀 Invoking CORS updater Lambda..."

# Invoke the Lambda function (empty payload triggers SSM parameter lookup)
RESPONSE=$(aws lambda invoke \
    --function-name "$LAMBDA_NAME" \
    --payload '{}' \
    --cli-binary-format raw-in-base64-out \
    /dev/stdout 2>/dev/null)

# Check for errors in the response
if echo "$RESPONSE" | grep -q '"errorMessage"'; then
    print_error "Lambda invocation failed:"
    echo "$RESPONSE" | jq -r '.errorMessage' 2>/dev/null || echo "$RESPONSE"
    exit 1
fi

print_success "CORS configuration updated!"

# Show the CloudWatch logs tail for verification
print_status "📋 Recent Lambda logs:"
aws logs tail "/aws/lambda/$LAMBDA_NAME" --since 1m --format short 2>/dev/null || print_warning "Could not fetch logs"

echo ""
print_success "Done! API Gateway CORS headers and Cognito callback URLs have been updated."
