#!/bin/bash
# Setup Microsoft Entra ID (Azure AD) SAML Identity Provider for Cognito
#
# Prerequisites:
#   1. An Enterprise Application configured in Microsoft Entra with SAML SSO
#   2. The App Federation Metadata URL from the Entra SAML configuration
#   3. The Cognito User Pool ID (from SSM or parameters.json)
#
# Usage:
#   ./scripts/setup-entra-saml.sh <metadata-url>
#   ./scripts/setup-entra-saml.sh <metadata-url> --pool-id <user-pool-id>
#
# If --pool-id is not provided, the script reads it from SSM using the product name in cdk.json.

set -e

METADATA_URL="$1"
PROVIDER_NAME="EntraID"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

if [ -z "$METADATA_URL" ]; then
    echo "Usage: $0 <entra-metadata-url> [--pool-id <user-pool-id>]"
    echo ""
    echo "The metadata URL is found in the Entra portal under:"
    echo "  Enterprise Applications → Your App → Single sign-on → SAML Certificates → App Federation Metadata Url"
    echo ""
    echo "Example:"
    echo "  $0 'https://login.microsoftonline.com/{tenant-id}/federationmetadata/2007-06/federationmetadata.xml?appid={app-id}'"
    exit 1
fi

# Parse optional arguments
shift
while [[ $# -gt 0 ]]; do
    case $1 in
        --pool-id)
            USER_POOL_ID="$2"
            shift 2
            ;;
        --provider-name)
            PROVIDER_NAME="$2"
            shift 2
            ;;
        --region)
            REGION="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Get User Pool ID from SSM if not provided
if [ -z "$USER_POOL_ID" ]; then
    PRODUCT_NAME=$(jq -r '.context.productName // "Media Resource Manager"' cdk.json 2>/dev/null || echo "Media Resource Manager")
    PASCAL_CASE=$(echo "$PRODUCT_NAME" | sed 's/ //g; s/[^a-zA-Z0-9]//g')
    
    echo "Looking up User Pool ID from SSM (/${PASCAL_CASE}/Auth/UserPoolId)..."
    USER_POOL_ID=$(aws ssm get-parameter --name "/${PASCAL_CASE}/Auth/UserPoolId" --query "Parameter.Value" --output text --region "$REGION" 2>/dev/null)
    
    if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
        echo "ERROR: Could not find User Pool ID in SSM. Provide it with --pool-id"
        exit 1
    fi
fi

echo "=== Entra ID SAML Setup ==="
echo "User Pool ID:    $USER_POOL_ID"
echo "Provider Name:   $PROVIDER_NAME"
echo "Metadata URL:    $METADATA_URL"
echo "Region:          $REGION"
echo ""

# Check if provider already exists
EXISTING=$(aws cognito-idp describe-identity-provider \
    --user-pool-id "$USER_POOL_ID" \
    --provider-name "$PROVIDER_NAME" \
    --region "$REGION" 2>/dev/null || echo "")

if [ -n "$EXISTING" ]; then
    echo "Provider '$PROVIDER_NAME' already exists. Updating..."
    aws cognito-idp update-identity-provider \
        --user-pool-id "$USER_POOL_ID" \
        --provider-name "$PROVIDER_NAME" \
        --provider-details "{\"MetadataURL\": \"$METADATA_URL\"}" \
        --attribute-mapping '{
            "email": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
            "given_name": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
            "family_name": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"
        }' \
        --region "$REGION" > /dev/null
    echo "✅ Provider updated"
else
    echo "Creating SAML Identity Provider..."
    aws cognito-idp create-identity-provider \
        --user-pool-id "$USER_POOL_ID" \
        --provider-name "$PROVIDER_NAME" \
        --provider-type "SAML" \
        --provider-details "{\"MetadataURL\": \"$METADATA_URL\"}" \
        --attribute-mapping '{
            "email": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
            "given_name": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
            "family_name": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"
        }' \
        --region "$REGION" > /dev/null
    echo "✅ Provider created"
fi

# Update the User Pool Client to include the new provider
echo ""
echo "Updating User Pool Client to include $PROVIDER_NAME..."

# Get the client ID
CLIENT_ID=$(aws cognito-idp list-user-pool-clients \
    --user-pool-id "$USER_POOL_ID" \
    --query "UserPoolClients[0].ClientId" \
    --output text --region "$REGION")

# Get current client config to preserve settings
CLIENT_CONFIG=$(aws cognito-idp describe-user-pool-client \
    --user-pool-id "$USER_POOL_ID" \
    --client-id "$CLIENT_ID" \
    --region "$REGION" \
    --query "UserPoolClient")

# Extract current providers and add the new one
CURRENT_PROVIDERS=$(echo "$CLIENT_CONFIG" | jq -r '.SupportedIdentityProviders // ["COGNITO"] | join(" ")')
if ! echo "$CURRENT_PROVIDERS" | grep -qw "$PROVIDER_NAME"; then
    CURRENT_PROVIDERS="$CURRENT_PROVIDERS $PROVIDER_NAME"
fi

# Extract current callback/logout URLs
CALLBACK_URLS=$(echo "$CLIENT_CONFIG" | jq -c '.CallbackURLs // []')
LOGOUT_URLS=$(echo "$CLIENT_CONFIG" | jq -c '.LogoutURLs // []')

aws cognito-idp update-user-pool-client \
    --user-pool-id "$USER_POOL_ID" \
    --client-id "$CLIENT_ID" \
    --supported-identity-providers $CURRENT_PROVIDERS \
    --allowed-o-auth-flows code \
    --allowed-o-auth-scopes email openid profile \
    --allowed-o-auth-flows-user-pool-client \
    --callback-urls "$CALLBACK_URLS" \
    --logout-urls "$LOGOUT_URLS" \
    --region "$REGION" > /dev/null

echo "✅ Client updated with providers: $CURRENT_PROVIDERS"

# Print summary
DOMAIN=$(aws cognito-idp describe-user-pool --user-pool-id "$USER_POOL_ID" \
    --query "UserPool.Domain" --output text --region "$REGION")

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Entra ID SAML provider '$PROVIDER_NAME' is now configured."

# Regenerate config.json to include the new identity provider
echo ""
echo "Regenerating frontend config.json..."
PASCAL_CASE_FOR_CONFIG=$(echo "${PRODUCT_NAME:-Media Resource Manager}" | sed 's/ //g; s/[^a-zA-Z0-9]//g')
CONFIG_GENERATOR_ARN=$(aws ssm get-parameter --name "/${PASCAL_CASE_FOR_CONFIG}/Frontend/ConfigGeneratorArn" --query "Parameter.Value" --output text --region "$REGION" 2>/dev/null || echo "")

if [ -n "$CONFIG_GENERATOR_ARN" ] && [ "$CONFIG_GENERATOR_ARN" != "None" ]; then
    aws lambda invoke \
      --function-name "$CONFIG_GENERATOR_ARN" \
      --payload '{"RequestType": "Update"}' \
      --cli-binary-format raw-in-base64-out \
      /tmp/entra-config-response.json --region "$REGION" > /dev/null 2>&1
    
    if [ $? -eq 0 ]; then
        echo "✅ config.json regenerated (frontend will show EntraID login option)"
    else
        echo "⚠️  Could not regenerate config.json automatically. Redeploy frontend stack to update."
    fi
    rm -f /tmp/entra-config-response.json
else
    echo "⚠️  Config generator not found. Redeploy frontend stack to update config.json."
fi

echo ""
echo "To test, navigate to:"
echo "  https://${DOMAIN}.auth.${REGION}.amazoncognito.com/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=https://YOUR_FRONTEND_URL&scope=email+openid+profile&identity_provider=${PROVIDER_NAME}"
echo ""
echo "Or use the application login page — it will show the EntraID option automatically."
echo ""
echo "=== Entra ID Configuration Reference ==="
echo "These values should already be configured in your Entra Enterprise Application:"
echo "  Entity ID:   urn:amazon:cognito:sp:${USER_POOL_ID}"
echo "  Reply URL:   https://${DOMAIN}.auth.${REGION}.amazoncognito.com/saml2/idpresponse"
echo "  Logout URL:  https://${DOMAIN}.auth.${REGION}.amazoncognito.com/saml2/logout"
