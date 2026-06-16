#!/bin/bash

# Get Cognito configuration for Identity Center SAML setup
# This script outputs the values needed to configure Identity Center

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get product name from cdk.json and convert to PascalCase (remove spaces)
if [ -f "cdk.json" ]; then
    PASCAL_CASE_NAME=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')" 2>/dev/null || echo "MediaResourceManager")
else
    echo -e "${RED}❌ Error: cdk.json not found. Run from project root directory.${NC}"
    exit 1
fi

echo -e "${YELLOW}📋 Using parameter prefix: /${PASCAL_CASE_NAME}${NC}"
echo ""

# Get User Pool ID
USER_POOL_ID=$(aws ssm get-parameter --name "/${PASCAL_CASE_NAME}/Auth/UserPoolId" --query "Parameter.Value" --output text 2>/dev/null)
if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" == "None" ]; then
    echo -e "${RED}❌ Error: Could not retrieve User Pool ID from SSM${NC}"
    echo "Make sure the application is deployed with UseCognitoAuth=true"
    exit 1
fi
echo "User Pool ID: $USER_POOL_ID"

# Get User Pool Client ID  
CLIENT_ID=$(aws ssm get-parameter --name "/${PASCAL_CASE_NAME}/Auth/UserPoolClientId" --query "Parameter.Value" --output text 2>/dev/null)
if [ -z "$CLIENT_ID" ] || [ "$CLIENT_ID" == "None" ]; then
    echo -e "${RED}❌ Error: Could not retrieve User Pool Client ID from SSM${NC}"
    exit 1
fi
echo "Client ID: $CLIENT_ID"

# Get Cognito Domain
COGNITO_DOMAIN=$(aws ssm get-parameter --name "/${PASCAL_CASE_NAME}/Auth/CognitoDomain" --query "Parameter.Value" --output text 2>/dev/null)
if [ -z "$COGNITO_DOMAIN" ] || [ "$COGNITO_DOMAIN" == "None" ]; then
    echo -e "${RED}❌ Error: Could not retrieve Cognito Domain from SSM${NC}"
    exit 1
fi
echo "Cognito Domain: $COGNITO_DOMAIN"

# Get Frontend URL
FRONTEND_URL=$(aws ssm get-parameter --name "/${PASCAL_CASE_NAME}/Frontend/Url" --query "Parameter.Value" --output text 2>/dev/null)
if [ -z "$FRONTEND_URL" ] || [ "$FRONTEND_URL" == "None" ]; then
    echo -e "${RED}❌ Error: Could not retrieve Frontend URL from SSM${NC}"
    exit 1
fi
echo "Frontend URL: $FRONTEND_URL"

# Generate the URLs needed for Identity Center configuration
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}Copy these values for Identity Center setup:${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "${YELLOW}Application ACS URL:${NC}"
echo "  ${COGNITO_DOMAIN}/saml2/idpresponse"
echo ""
echo -e "${YELLOW}Application SAML audience:${NC}"
echo "  urn:amazon:cognito:sp:${USER_POOL_ID}"
echo ""
echo -e "${YELLOW}Application start URL:${NC}"
echo "  ${COGNITO_DOMAIN}/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${FRONTEND_URL}&scope=email+openid+profile&identity_provider=IdentityCenter"
echo ""
