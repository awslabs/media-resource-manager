# Microsoft Entra ID (Azure AD) SAML Setup Guide

**Use this guide for:**
- ✅ Setting up Microsoft Entra ID SAML integration for the first time
- ✅ Configuring SSO for organizations using Entra ID
- ✅ Both new deployments (CDK-managed pool) and external pool imports

**Time required:** ~20-30 minutes

This guide covers two scenarios:
1. **New deployments** — CDK creates the Cognito User Pool, you configure Entra as a SAML IdP
2. **External pool import** — An identity team creates and manages their own Cognito User Pool with Entra, then provides the pool details to import

---

## Scenario 1: New Deployment (CDK-Managed Pool)

Use this when you deploy the full CDK app and want to add Entra ID as an identity provider.

### Prerequisites

- ✅ Application deployed with `UseCognitoAuth = true`
- ✅ Microsoft Entra ID tenant with Global Administrator or Application Administrator access
- ✅ AWS CLI configured
- ✅ Entra ID plan that supports Enterprise Applications (P1/P2 recommended for group assignment to apps)

### Step 1: Get Your Cognito Configuration

```bash
# Run from the project root directory
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")

USER_POOL_ID=$(aws ssm get-parameter --name "/${PARAM_PREFIX}/Auth/UserPoolId" --query "Parameter.Value" --output text)
COGNITO_DOMAIN=$(aws ssm get-parameter --name "/${PARAM_PREFIX}/Auth/CognitoDomain" --query "Parameter.Value" --output text)

echo "User Pool ID:  $USER_POOL_ID"
echo "Entity ID:     urn:amazon:cognito:sp:${USER_POOL_ID}"
echo "Reply URL:     ${COGNITO_DOMAIN}/saml2/idpresponse"
echo "Logout URL:    ${COGNITO_DOMAIN}/saml2/logout"
```

Save these values — you'll need them for the Entra configuration.

### Step 2: Create Enterprise Application in Entra

1. Navigate to [Microsoft Entra admin center](https://entra.microsoft.com)
2. Go to **Identity** → **Applications** → **Enterprise applications**
3. Click **+ New application**
4. Click **+ Create your own application**
5. Name it (e.g., `Media Resource Manager` or your product name)
6. Select **"Integrate any other application you don't find in the gallery (Non-gallery)"**
7. Click **Create**

### Step 3: Configure SAML Single Sign-On

1. In the new application, go to **Single sign-on** in the left sidebar
2. Select **SAML**
3. Click **Edit** on section **1. Basic SAML Configuration**
4. Enter the following values:

| Field | Value |
|-------|-------|
| **Identifier (Entity ID)** | `urn:amazon:cognito:sp:<USER_POOL_ID>` |
| **Reply URL (ACS URL)** | `https://<cognito-domain>.auth.<region>.amazoncognito.com/saml2/idpresponse` |
| **Sign on URL** | *(leave blank)* |
| **Relay State** | *(leave blank)* |
| **Logout URL** | `https://<cognito-domain>.auth.<region>.amazoncognito.com/saml2/logout` |

5. Click **Save**

### Step 4: Configure Attributes & Claims

#### 4a. Set Name Identifier to Email

1. Click on **Unique User Identifier (Name ID)** in the Required claim section
2. Set **Name identifier format** to `Email address`
3. Set **Source attribute** to `user.mail`
4. Click **Save**

#### 4b. Add Group Claim

1. Click **+ Add a group claim**
2. Select **"Groups assigned to the application"**
3. Set **Source attribute** to **"Cloud-only group display names"**
   - This sends group names (e.g., "Admin") instead of GUIDs
   - If this option is grayed out (free tier), select "All groups" with "Group ID" — you'll use the GUID as the `AdminGroupName` value
4. Click **Save**

#### 4c. Verify Additional Claims

Ensure these claims are present (they should be by default):

| Claim | Value |
|-------|-------|
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` | user.mail |
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname` | user.givenname |
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname` | user.surname |

### Step 5: Create Admin Group and Assign Users

#### 5a. Create a Security Group

1. Go to **Identity** → **Groups** → **All groups**
2. Click **+ New group**
3. Set **Group type** to `Security`
4. Set **Group name** to `Admin` (or your preferred admin group name)
5. Add your admin users as **Members**
6. Click **Create**

#### 5b. Assign Group to the Application

1. Go back to **Enterprise applications** → your app → **Users and groups**
2. Click **+ Add user/group**
3. Select the **Admin** group (and any other groups that should have access)
4. Click **Assign**

> **Note:** Assigning groups to applications requires Entra ID P1 or P2. On the free tier, assign individual users instead and use the group GUID as the `AdminGroupName`.

### Step 6: Get the Federation Metadata URL

1. Go to **Single sign-on** in your Enterprise Application
2. In section **3. SAML Certificates**, copy the **App Federation Metadata Url**
   - It looks like: `https://login.microsoftonline.com/<tenant-id>/federationmetadata/2007-06/federationmetadata.xml?appid=<app-id>`

### Step 7: Run the Setup Script

```bash
./scripts/setup-entra-saml.sh '<metadata-url>'
```

The script will:
- Create the SAML Identity Provider in Cognito with correct attribute mappings
- Update the app client to include EntraID as a supported provider
- Regenerate the frontend `config.json` to show the SSO login button

### Step 8: Configure AdminGroupName

Set `AdminGroupName` in `parameters.json` to match the group name that appears in the token:

- **With Entra P1/P2 (group display names):** Set to the group name (e.g., `Admin`)
- **With Entra Free (group GUIDs):** Set to the group's Object ID (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)

```json
{ "ParameterKey": "AdminGroupName", "ParameterValue": "Admin" }
```

Then update SSM and regenerate config:
```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
aws ssm put-parameter --name "/${PARAM_PREFIX}/Auth/AdminGroupName" --value "Admin" --overwrite

# Regenerate frontend config
CONFIG_ARN=$(aws ssm get-parameter --name "/${PARAM_PREFIX}/Frontend/ConfigGeneratorArn" --query "Parameter.Value" --output text)
aws lambda invoke --function-name "$CONFIG_ARN" --payload '{"RequestType": "Update"}' --cli-binary-format raw-in-base64-out /tmp/response.json

# Invalidate CloudFront cache
DIST_ID=$(aws cloudfront list-distributions --query "DistributionList.Items[0].Id" --output text)
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/config.json"
```

### Step 9: Test

1. Navigate to your application URL
2. You should see an **"EntraID"** sign-in button
3. Click it — you'll be redirected to Microsoft login
4. After authenticating, you should be redirected back with admin access

---

## Scenario 2: External Pool Import

Use this when a separate identity team creates and manages their own Cognito User Pool with Entra SAML integration, then provides the pool details for import into the CDK app.

### Prerequisites

The identity team must provide you with:

| Value | Description | Example |
|-------|-------------|---------|
| **UserPoolArn** | ARN of the Cognito User Pool | `arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_AbCdEfG` |
| **UserPoolClientId** | App client ID configured for your application | `1a2b3c4d5e6f7g8h9i0j` |
| **UserPoolDomain** | Cognito hosted UI domain URL | `https://my-app.auth.us-east-1.amazoncognito.com` |
| **Admin group name** | The group name or ID that appears in `cognito:groups` for admin users | `Admin` |

The identity team is responsible for:
- Creating and managing the Cognito User Pool (typically via CloudFormation)
- Configuring the Entra SAML integration (Entity ID, ACS URL, attribute mappings)
- Setting up AD groups and mapping them to Cognito groups
- Ensuring the app client has the correct callback/logout URLs pointing to your CloudFront distribution
- Managing user assignments in Entra

### Configuration

Once you have the values, set them in `parameters.json`:

```json
{ "ParameterKey": "SsoUserPoolArn", "ParameterValue": "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_AbCdEfG" },
{ "ParameterKey": "SsoUserPoolClientId", "ParameterValue": "1a2b3c4d5e6f7g8h9i0j" },
{ "ParameterKey": "SsoUserPoolDomain", "ParameterValue": "https://my-app.auth.us-east-1.amazoncognito.com" }
```

Set `AdminGroupName` to match the group name that appears in the token's `cognito:groups` claim:

```json
{ "ParameterKey": "AdminGroupName", "ParameterValue": "Admin" }
```

### Deploy

```bash
./deploy.sh
```

### What Happens on Deploy

- CDK **imports** the external User Pool instead of creating one
- SSM parameters are written with the external pool's ID, client ID, and domain
- The Identity Pool (for S3 access) is still created locally
- No local Cognito groups or admin users are created (`AdminEmails` is ignored)
- The Pre Token Generation Lambda trigger is **not** created (group mapping is managed in the external pool)
- All Lambda functions and the frontend work unchanged

---

## How Group Claims Work

The application checks the `cognito:groups` claim in the ID token against the `AdminGroupName` parameter to determine admin access.

### CDK-Managed Pool (Scenario 1)

The Pre Token Generation Lambda reads group membership from the `custom:groups` attribute (populated by the SAML assertion) and injects it into `cognito:groups`:

```
Entra AD Group → SAML assertion → custom:groups → Lambda → cognito:groups → Frontend
```

**With Entra P1/P2 (group display names):**
- Entra sends group names (e.g., `"Admin"`) in the SAML assertion
- Set `AdminGroupName = "Admin"`

**With Entra Free Tier (group GUIDs):**
- Entra sends Object IDs (e.g., `"a1b2c3d4-..."`) in the SAML assertion
- Set `AdminGroupName` to the group's Object ID

### External Pool Import (Scenario 2)

The identity team configures group mapping in their pool. The only requirement is that `AdminGroupName` matches whatever value appears in `cognito:groups` in the final token.

---

## Troubleshooting

### SSO button doesn't appear on login page

- Check `config.json` in S3: `aws s3 cp s3://<frontend-bucket>/config.json -`
- Verify `identityProviders` array contains `"EntraID"`
- If empty, run the config generator: `aws lambda invoke --function-name <config-generator-arn> --payload '{"RequestType":"Update"}' /tmp/out.json`
- Invalidate CloudFront: `aws cloudfront create-invalidation --distribution-id <id> --paths "/config.json"`

### User authenticates but doesn't get admin access

1. Check the Pre Token Generation Lambda logs:
   ```bash
   aws logs tail /aws/lambda/<acronym>-pre-token-generation --follow
   ```
2. Verify `custom:groups` contains the expected group name/GUID
3. Verify `AdminGroupName` in SSM matches what's in the token
4. Invalidate CloudFront cache for `/config.json`

### SAML error: "Invalid saml_response"

- Verify the Entity ID matches exactly: `urn:amazon:cognito:sp:<USER_POOL_ID>`
- Verify the Reply URL matches exactly (no trailing slash)
- Check that the Entra certificate hasn't expired (section 3 in Entra SAML config)

### Groups not appearing in token

- Verify the group claim is configured in Entra (Attributes & Claims → group claim exists)
- Verify the SAML attribute mapping in Cognito includes `custom:groups`
- Check that the user is actually a member of the group in Entra
- For "Groups assigned to the application" — verify the group is assigned to the Enterprise App

### "AttributeMapping contains invalid mapping: custom:groups"

- The User Pool doesn't have a `custom:groups` custom attribute
- For CDK-managed pools, this is created automatically
- For external pools, the identity team must add it to their pool:
  ```bash
  aws cognito-idp add-custom-attributes --user-pool-id <pool-id> \
    --custom-attributes '[{"Name":"groups","AttributeDataType":"String","Mutable":true}]'
  ```

---

## Reference: Entra SAML Configuration Values

| Field | Value |
|-------|-------|
| Entity ID | `urn:amazon:cognito:sp:<USER_POOL_ID>` |
| Reply URL (ACS) | `https://<domain>.auth.<region>.amazoncognito.com/saml2/idpresponse` |
| Logout URL | `https://<domain>.auth.<region>.amazoncognito.com/saml2/logout` |
| Name ID Format | Email address |
| Name ID Source | user.mail |

## Reference: SAML Attribute Mappings (Cognito Side)

| Cognito Attribute | SAML Claim URI |
|-------------------|---------------|
| email | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` |
| given_name | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname` |
| family_name | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname` |
| custom:groups | `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups` |
