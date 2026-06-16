#!/bin/bash

# Setup IAM Identity Center SAML Integration Script
# This script configures IAM Identity Center as a SAML Identity Provider in Cognito User Pool

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🔐 Setting up IAM Identity Center SAML Integration${NC}"

# Get product name from cdk.json and convert to PascalCase (remove spaces)
if [ -f "cdk.json" ]; then
    PASCAL_CASE_NAME=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')" 2>/dev/null || echo "MediaResourceManager")
else
    echo -e "${RED}❌ Error: cdk.json not found. Run from project root directory.${NC}"
    exit 1
fi

echo -e "${YELLOW}📋 Using parameter prefix: /${PASCAL_CASE_NAME}${NC}"

# Check if identity-center-metadata.xml exists
if [ ! -f "identity-center-metadata.xml" ]; then
    echo -e "${RED}❌ Error: identity-center-metadata.xml not found${NC}"
    echo ""
    echo "Please download the SAML metadata from IAM Identity Center:"
    echo "1. Go to IAM Identity Center → Applications → Your Application"
    echo "2. Download the 'IAM Identity Center SAML metadata file'"
    echo "3. Save it as 'identity-center-metadata.xml' in the project root"
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

# Try to discover Identity Store ID for user sync feature
echo -e "${YELLOW}🔍 Attempting to discover Identity Store ID for user sync...${NC}"
IDENTITY_STORE_ID=""
SSO_INSTANCE_ARN=""

# First, try to extract SSO Instance ID from the metadata file
# The entityID contains a base64-encoded string with format: {accountId}_{instanceId}
ENTITY_ID=$(python3 -c "
import xml.etree.ElementTree as ET
tree = ET.parse('identity-center-metadata.xml')
root = tree.getroot()
entity_id = root.get('entityID', '')
# Extract the encoded part after the last /
if '/' in entity_id:
    encoded = entity_id.split('/')[-1]
    import base64
    try:
        decoded = base64.b64decode(encoded).decode('utf-8')
        # Format is: accountId_instanceId (e.g., 402944637373_ins-7223003160ced685)
        if '_ins-' in decoded:
            instance_id = 'ins-' + decoded.split('_ins-')[1]
            print(instance_id)
    except:
        pass
" 2>/dev/null)

if [ -n "$ENTITY_ID" ]; then
    echo -e "${GREEN}✅ Extracted SSO Instance ID from metadata: $ENTITY_ID${NC}"
    
    # Use the instance ID to get the Identity Store ID
    IDENTITY_STORE_ID=$(aws sso-admin list-instances --query "Instances[?InstanceId=='$ENTITY_ID'].IdentityStoreId | [0]" --output text 2>/dev/null)
    
    if [ -z "$IDENTITY_STORE_ID" ] || [ "$IDENTITY_STORE_ID" == "None" ]; then
        # Try without filtering (in case we're in the same account)
        IDENTITY_STORE_ID=$(aws sso-admin list-instances --query "Instances[0].IdentityStoreId" --output text 2>/dev/null)
    fi
fi

# Fallback: try direct discovery if we're in the same account as Identity Center
if [ -z "$IDENTITY_STORE_ID" ] || [ "$IDENTITY_STORE_ID" == "None" ]; then
    if aws sso-admin list-instances --query "Instances[0]" --output json 2>/dev/null | grep -q "IdentityStoreId"; then
        IDENTITY_STORE_ID=$(aws sso-admin list-instances --query "Instances[0].IdentityStoreId" --output text 2>/dev/null)
        SSO_INSTANCE_ARN=$(aws sso-admin list-instances --query "Instances[0].InstanceArn" --output text 2>/dev/null)
    fi
fi

if [ -n "$IDENTITY_STORE_ID" ] && [ "$IDENTITY_STORE_ID" != "None" ]; then
    echo -e "${GREEN}✅ Found Identity Store ID: $IDENTITY_STORE_ID${NC}"
    
    # Store in SSM for the sync Lambda to use
    aws ssm put-parameter \
        --name "/${PASCAL_CASE_NAME}/Identity/IdentityStoreId" \
        --value "$IDENTITY_STORE_ID" \
        --type "String" \
        --overwrite > /dev/null 2>&1
    echo -e "${GREEN}✅ Stored Identity Store ID in SSM${NC}"
    
    if [ -n "$SSO_INSTANCE_ARN" ] && [ "$SSO_INSTANCE_ARN" != "None" ]; then
        aws ssm put-parameter \
            --name "/${PASCAL_CASE_NAME}/Identity/SSOInstanceArn" \
            --value "$SSO_INSTANCE_ARN" \
            --type "String" \
            --overwrite > /dev/null 2>&1
    fi
else
    echo -e "${YELLOW}⚠️  Could not auto-discover Identity Store ID${NC}"
    echo "   This is expected in cross-account deployments where Identity Center"
    echo "   is in a different account (management account)."
    echo ""
    echo "   To enable user sync from Identity Center, you can manually set the ID:"
    echo "   aws ssm put-parameter --name '/${PASCAL_CASE_NAME}/Identity/IdentityStoreId' --value '<your-identity-store-id>' --type String"
    echo ""
    echo "   To find your Identity Store ID, run this in the management account:"
    echo "   aws sso-admin list-instances --query 'Instances[0].IdentityStoreId' --output text"
fi

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

# Check if IdentityCenter provider already exists
PROVIDER_NAME="IdentityCenter"
echo -e "${YELLOW}🔍 Checking if $PROVIDER_NAME provider already exists...${NC}"
if aws cognito-idp describe-identity-provider --user-pool-id "$USER_POOL_ID" --provider-name "$PROVIDER_NAME" >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  $PROVIDER_NAME provider already exists. Deleting and recreating...${NC}"
    aws cognito-idp delete-identity-provider --user-pool-id "$USER_POOL_ID" --provider-name "$PROVIDER_NAME"
    echo -e "${GREEN}✅ Deleted existing $PROVIDER_NAME provider${NC}"
    # Wait a moment for deletion to propagate
    sleep 2
fi

# Convert XML to single line for JSON
echo -e "${YELLOW}📝 Processing metadata XML...${NC}"
METADATA_XML=$(python3 -c "
import xml.etree.ElementTree as ET
import json

# Parse and re-serialize to normalize the XML
tree = ET.parse('identity-center-metadata.xml')
root = tree.getroot()

# Register common SAML namespaces
ET.register_namespace('', 'urn:oasis:names:tc:SAML:2.0:metadata')
ET.register_namespace('ds', 'http://www.w3.org/2000/09/xmldsig#')
ET.register_namespace('saml', 'urn:oasis:names:tc:SAML:2.0:assertion')

xml_str = ET.tostring(root, encoding='unicode')
print(json.dumps(xml_str))
")

# Create provider details JSON
cat > identity-center-provider.json << EOF
{
  "MetadataFile": $METADATA_XML
}
EOF

# Create SAML Identity Provider
echo -e "${YELLOW}🔧 Creating $PROVIDER_NAME SAML Identity Provider...${NC}"
aws cognito-idp create-identity-provider \
  --user-pool-id "$USER_POOL_ID" \
  --provider-name "$PROVIDER_NAME" \
  --provider-type "SAML" \
  --provider-details file://identity-center-provider.json \
  --attribute-mapping email=email,given_name=given_name,family_name=family_name,custom:department=department,custom:isAdmin=custom_isAdmin,custom:groups=groups

echo -e "${GREEN}✅ $PROVIDER_NAME SAML Identity Provider created successfully${NC}"

# Clean up temporary file
rm -f identity-center-provider.json

# Get list of existing identity providers
echo -e "${YELLOW}🔍 Checking for existing identity providers...${NC}"
EXISTING_PROVIDERS=$(aws cognito-idp list-identity-providers --user-pool-id "$USER_POOL_ID" --query "Providers[].ProviderName" --output text)

# Build the list of supported providers (always include COGNITO)
SUPPORTED_PROVIDERS="COGNITO"
for provider in $EXISTING_PROVIDERS; do
    SUPPORTED_PROVIDERS="$SUPPORTED_PROVIDERS $provider"
done

echo -e "${YELLOW}📋 Supported providers: $SUPPORTED_PROVIDERS${NC}"

# Update User Pool Client to support Identity Center provider
# IMPORTANT: Must include --explicit-auth-flows to preserve local user login capability
echo -e "${YELLOW}🔧 Updating User Pool Client to support $PROVIDER_NAME provider...${NC}"
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

echo -e "${GREEN}✅ User Pool Client updated to support $PROVIDER_NAME provider${NC}"

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
echo -e "${GREEN}🎉 IAM Identity Center SAML integration setup complete!${NC}"
echo ""
echo -e "${YELLOW}Configuration Summary:${NC}"
echo "  User Pool ID: $USER_POOL_ID"
echo "  Provider Name: $PROVIDER_NAME"
echo "  Supported Providers: $SUPPORTED_PROVIDERS"
if [ -n "$IDENTITY_STORE_ID" ] && [ "$IDENTITY_STORE_ID" != "None" ]; then
    echo "  Identity Store ID: $IDENTITY_STORE_ID (for user sync)"
fi
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Assign users/groups to the application in IAM Identity Center"
echo "2. Test authentication via the Identity Center portal"
echo "3. Or navigate directly to: $FRONTEND_URL"
echo ""
echo -e "${YELLOW}User Sync Feature:${NC}"
echo "  After users log in via Identity Center, you can sync their details"
echo "  (first name, last name, email) to the local database for display"
echo "  in the 'Assigned To' column on the Workstation Management page."
echo ""
echo "  To sync users:"
echo "  - Go to User Management page in the application"
echo "  - Click 'Sync from Identity Center' button"
echo ""
if [ -z "$IDENTITY_STORE_ID" ] || [ "$IDENTITY_STORE_ID" == "None" ]; then
    echo -e "${YELLOW}  Note: For cross-account deployments, you may need to manually${NC}"
    echo -e "${YELLOW}  configure the Identity Store ID in SSM (see above).${NC}"
    echo ""
fi
echo -e "${YELLOW}To verify the provider was created:${NC}"
echo "  aws cognito-idp describe-identity-provider --user-pool-id $USER_POOL_ID --provider-name $PROVIDER_NAME"
