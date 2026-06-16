#!/bin/bash

# Setup Okta SAML Integration Script
# This script configures Okta SAML Identity Provider in Cognito User Pool

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🔐 Setting up Okta SAML Integration${NC}"

# Get product name from cdk.json and convert to PascalCase (remove spaces)
if [ -f "cdk.json" ]; then
    PASCAL_CASE_NAME=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')" 2>/dev/null || echo "MediaResourceManager")
else
    echo -e "${RED}❌ Error: cdk.json not found. Run from project root directory.${NC}"
    exit 1
fi

echo -e "${YELLOW}📋 Using parameter prefix: /${PASCAL_CASE_NAME}${NC}"

# Check if okta-metadata.xml exists
if [ ! -f "okta-metadata.xml" ]; then
    echo -e "${RED}❌ Error: okta-metadata.xml not found${NC}"
    echo "Please download the SAML metadata from your Okta application and save it as 'okta-metadata.xml'"
    exit 1
fi

# Get User Pool ID, Client ID, and Frontend URL from SSM
echo -e "${YELLOW}📋 Getting Cognito User Pool ID, Client ID, and Frontend URL...${NC}"
USER_POOL_ID=$(aws ssm get-parameter --name "/${PASCAL_CASE_NAME}/Auth/UserPoolId" --query "Parameter.Value" --output text 2>/dev/null)
USER_POOL_CLIENT_ID=$(aws ssm get-parameter --name "/${PASCAL_CASE_NAME}/Auth/UserPoolClientId" --query "Parameter.Value" --output text 2>/dev/null)
FRONTEND_URL=$(aws ssm get-parameter --name "/${PASCAL_CASE_NAME}/Frontend/Url" --query "Parameter.Value" --output text 2>/dev/null)

if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" == "None" ]; then
    echo -e "${RED}❌ Error: Could not retrieve User Pool ID from SSM${NC}"
    echo "Make sure the application is deployed with UseCognitoAuth=true"
    exit 1
fi

if [ -z "$USER_POOL_CLIENT_ID" ] || [ "$USER_POOL_CLIENT_ID" == "None" ]; then
    echo -e "${RED}❌ Error: Could not retrieve User Pool Client ID from SSM${NC}"
    exit 1
fi

if [ -z "$FRONTEND_URL" ] || [ "$FRONTEND_URL" == "None" ]; then
    echo -e "${RED}❌ Error: Could not retrieve Frontend URL from SSM${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Found User Pool ID: $USER_POOL_ID${NC}"
echo -e "${GREEN}✅ Found User Pool Client ID: $USER_POOL_CLIENT_ID${NC}"
echo -e "${GREEN}✅ Found Frontend URL: $FRONTEND_URL${NC}"

# Check if Okta provider already exists
echo -e "${YELLOW}🔍 Checking if Okta provider already exists...${NC}"
if aws cognito-idp describe-identity-provider --user-pool-id "$USER_POOL_ID" --provider-name "Okta" >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Okta provider already exists. Deleting and recreating...${NC}"
    aws cognito-idp delete-identity-provider --user-pool-id "$USER_POOL_ID" --provider-name "Okta"
    echo -e "${GREEN}✅ Deleted existing Okta provider${NC}"
    # Wait a moment for deletion to propagate
    sleep 2
fi

# Convert XML to single line for JSON
echo -e "${YELLOW}📝 Processing metadata XML...${NC}"
METADATA_XML=$(python3 -c "
import xml.etree.ElementTree as ET
import json
tree = ET.parse('okta-metadata.xml')
root = tree.getroot()
ET.register_namespace('', 'urn:oasis:names:tc:SAML:2.0:metadata')
ET.register_namespace('ds', 'http://www.w3.org/2000/09/xmldsig#')
xml_str = ET.tostring(root, encoding='unicode')
print(json.dumps(xml_str))
")

# Create provider details JSON
cat > okta-provider.json << EOF
{
  "MetadataFile": $METADATA_XML
}
EOF

# Create SAML Identity Provider
echo -e "${YELLOW}🔧 Creating Okta SAML Identity Provider...${NC}"
aws cognito-idp create-identity-provider \
  --user-pool-id "$USER_POOL_ID" \
  --provider-name "Okta" \
  --provider-type "SAML" \
  --provider-details file://okta-provider.json \
  --attribute-mapping email=email,given_name=given_name,family_name=family_name,custom:department=department,custom:isAdmin=custom_isAdmin

echo -e "${GREEN}✅ Okta SAML Identity Provider created successfully${NC}"

# Clean up temporary file
rm -f okta-provider.json

# Get list of existing identity providers
echo -e "${YELLOW}🔍 Checking for existing identity providers...${NC}"
EXISTING_PROVIDERS=$(aws cognito-idp list-identity-providers --user-pool-id "$USER_POOL_ID" --query "Providers[].ProviderName" --output text)

# Build the list of supported providers (always include COGNITO)
SUPPORTED_PROVIDERS="COGNITO"
for provider in $EXISTING_PROVIDERS; do
    SUPPORTED_PROVIDERS="$SUPPORTED_PROVIDERS $provider"
done

echo -e "${YELLOW}📋 Supported providers: $SUPPORTED_PROVIDERS${NC}"

# Update User Pool Client to support Okta provider
# IMPORTANT: Must include --explicit-auth-flows to preserve local user login capability
echo -e "${YELLOW}🔧 Updating User Pool Client to support Okta provider...${NC}"
aws cognito-idp update-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$USER_POOL_CLIENT_ID" \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH ALLOW_USER_SRP_AUTH \
  --supported-identity-providers $SUPPORTED_PROVIDERS \
  --allowed-o-auth-flows-user-pool-client \
  --allowed-o-auth-flows "code" \
  --allowed-o-auth-scopes "email" "openid" "profile" \
  --callback-urls "http://localhost:3000/" "$FRONTEND_URL" \
  --logout-urls "http://localhost:3000/" "$FRONTEND_URL"

echo -e "${GREEN}✅ User Pool Client updated to support Okta provider${NC}"

# Regenerate config.json to include the new identity provider
echo ""
echo -e "${YELLOW}🔄 Regenerating config.json to include identity providers...${NC}"
CONFIG_GENERATOR_ARN=$(aws ssm get-parameter --name "/${PASCAL_CASE_NAME}/Frontend/ConfigGeneratorArn" --query "Parameter.Value" --output text 2>/dev/null)

if [ -n "$CONFIG_GENERATOR_ARN" ] && [ "$CONFIG_GENERATOR_ARN" != "None" ]; then
    # Invoke the config generator Lambda
    aws lambda invoke \
      --function-name "$CONFIG_GENERATOR_ARN" \
      --payload '{"RequestType": "Update"}' \
      --cli-binary-format raw-in-base64-out \
      /tmp/config-generator-response.json > /dev/null 2>&1
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ config.json regenerated successfully${NC}"
    else
        echo -e "${YELLOW}⚠️  Could not regenerate config.json automatically${NC}"
        echo "   You may need to redeploy the frontend stack or manually trigger the config generator"
    fi
    rm -f /tmp/config-generator-response.json
else
    echo -e "${YELLOW}⚠️  Config generator Lambda ARN not found in SSM${NC}"
    echo "   You may need to redeploy the frontend stack to update config.json"
fi

echo ""
echo -e "${GREEN}🎉 Okta SAML integration setup complete!${NC}"
echo ""
echo -e "${YELLOW}Configuration Summary:${NC}"
echo "  User Pool ID: $USER_POOL_ID"
echo "  Provider Name: Okta"
echo "  Supported Providers: $SUPPORTED_PROVIDERS"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Assign users to the application in Okta"
echo "2. Test authentication via the Okta portal"
echo "3. Or navigate directly to: $FRONTEND_URL"
echo ""
echo -e "${YELLOW}To verify the provider was created:${NC}"
echo "  aws cognito-idp describe-identity-provider --user-pool-id $USER_POOL_ID --provider-name Okta"
