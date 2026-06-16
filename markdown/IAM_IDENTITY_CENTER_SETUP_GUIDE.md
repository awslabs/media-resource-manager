# IAM Identity Center (AWS SSO) Setup Guide

**Use this guide for:**
- ✅ Integrating with AWS IAM Identity Center for SSO
- ✅ Adding the application to your organization's SSO portal
- ✅ Leveraging existing Identity Center users and groups

**Time required:** ~15-20 minutes

This guide walks you through configuring IAM Identity Center as a SAML Identity Provider for the application.

## Placeholder Values

Throughout this document, replace the following placeholders with your deployment-specific values:

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `<ProductPrefix>` | PascalCase version of `productName` from `cdk.json` (no spaces) | If `productName` is `"Media Resource Manager"`, use `MediaResourceManager` |
| `<product-prefix>` | lowercase-hyphenated version of `productName` from `cdk.json` | If `productName` is `"Media Resource Manager"`, use `media-resource-manager` |

**Note:** Most commands in this guide dynamically derive the prefix using:
```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
```

## Prerequisites

- ✅ AWS IAM Identity Center enabled in your organization's management account
- ✅ Identity Center users and groups already configured
- ✅ AWS CLI configured with appropriate permissions
- ✅ Application already deployed with `UseCognitoAuth=true`

## Architecture Overview

```
┌─────────────────────────────────────┐      ┌─────────────────────────────────────┐
│   Management Account (or Delegated) │      │         Workload Account            │
│                                     │      │                                     │
│   ┌─────────────────────────────────┐   │      │   ┌─────────────────────────────┐   │
│   │   IAM Identity Center       │   │ SAML │   │   Cognito User Pool         │   │
│   │   (SSO Portal)              │───┼──────┼──▶│   (SAML Consumer)           │   │
│   └─────────────────────────────┘   │      │   └─────────────────────────────┘   │
│                                     │      │                 │                   │
│   Users authenticate here           │      │                 ▼                   │
│                                     │      │   ┌─────────────────────────────┐   │
│                                     │      │   │   Application               │   │
│                                     │      │   │   (Frontend + API)          │   │
│                                     │      │   └─────────────────────────────┘   │
└─────────────────────────────────────┘      └─────────────────────────────────────┘
```

**Cross-Account Note:** This is the typical deployment pattern. Identity Center runs in your AWS Organization's management account (or delegated admin account), while the application is deployed in a separate workload account. SAML federation works seamlessly across accounts - no special cross-account IAM configuration is required.

Identity Center acts as the SAML Identity Provider, federating users into your Cognito User Pool.

## Important: Dynamic Parameter Paths

This application uses dynamic SSM parameter paths based on the product name configured in `cdk.json`. Throughout this guide, you'll need to determine your parameter prefix first:

```bash
# Get the parameter prefix (e.g., MediaResourceManager)
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
echo "Parameter prefix: /${PARAM_PREFIX}"
```

All SSM parameters follow the pattern: `/${PARAM_PREFIX}/...`

## Step 1: Get Your Cognito Configuration

**Run this command in the workload account** where the application is deployed:

> **Note:** Ensure your AWS CLI has a default region configured: `aws configure set region us-east-1`

```bash
# Run from the project root directory
./scripts/get-cognito-config.sh
```

**Expected output:**
```
📋 Using parameter prefix: /<ProductPrefix>
User Pool ID: us-east-1_EXAMPLE123
Client ID: EXAMPLE_CLIENT_ID_12345
Cognito Domain: https://<product-prefix>-31286568.auth.us-east-1.amazoncognito.com
Frontend URL: https://dev.example.com/

============================================
Copy these values for Identity Center setup:
============================================

Application ACS URL:
  https://<product-prefix>-31286568.auth.us-east-1.amazoncognito.com/saml2/idpresponse

Application SAML audience:
  urn:amazon:cognito:sp:us-east-1_EXAMPLE123

Application start URL:
  https://<product-prefix>-31286568.auth.us-east-1.amazoncognito.com/oauth2/authorize?...
```

**Save these values - you'll need them for Identity Center configuration!**

## Step 2: Create Custom SAML Application in Identity Center

**Perform these steps in the management account** (or delegated admin account) where Identity Center is configured:

1. **Sign in to the AWS Management Console** in your organization's management account (or delegated admin account)

2. **Navigate to IAM Identity Center** → Applications → Add application

3. **Select "Add custom SAML 2.0 application"**

4. **Configure Display Settings:**
   - **Display name**: Your application name (from `productName` in `cdk.json`)
   - **Description**: `EC2 Workstation Management Console`

5. **Download Identity Center SAML Metadata:**
   - Click "Download" next to "IAM Identity Center SAML metadata file"
   - Save as `identity-center-metadata.xml`
   - **Transfer this file to your workload account** where you'll run the setup script

## Step 3: Configure Application SAML Settings

**Still in the management account** - configure the SAML settings in your Identity Center application.

Use the URLs generated in Step 1:

**Application ACS URL:** (from Step 1 output)

**Application SAML audience:** (from Step 1 output)

**Application start URL:** (from Step 1 output) - This URL allows users to launch the app directly from the Identity Center portal.

**Note:** Without the Application start URL, users clicking the app tile in Identity Center will get an "Invalid samlResponse" error.

Click **Save**.

## Step 4: Configure Attribute Mappings

**Still in the management account** - in your Identity Center application, go to **Attribute mappings** and add:

| User attribute in the application | Maps to this string value or user attribute in IAM Identity Center |
|-----------------------------------|-------------------------------------------------------------------|
| `Subject` | `${user:email}` (Format: `emailAddress`) |
| `email` | `${user:email}` |
| `given_name` | `${user:givenName}` |
| `family_name` | `${user:familyName}` |

**Important:** Do NOT add `department` or `custom_isAdmin` mappings unless those attributes exist on your Identity Center users. Missing attributes will cause "Bad input" errors during login.

## Step 5: Configure Admin Detection via Groups (Recommended)

The application determines admin access by checking if the user belongs to a specific group.

**⚠️ Critical:** Identity Center's `${user:groups}` attribute **only works for users who are in at least one group**. If you add the groups attribute mapping, users without any group membership will get a "Bad input" error during login.

**Important:** Identity Center sends group **IDs** (GUIDs), not group names, in the SAML assertion. You'll need to configure the group ID in your deployment.

**To set up group-based admin detection:**

1. **Create groups in Identity Center:**
   - Go to **Identity Center → Groups → Create group**
   - Create `App-Users` - a default group for ALL application users
   - Create `App-Admins` - for admin users only
   - **Note the Group IDs** (GUIDs like `14b814d8-0051-70ce-abfc-e94bf1852946`)

2. **Assign ALL users to at least one group:**
   - Add all users who need app access to `App-Users`
   - Add admin users to both `App-Users` AND `App-Admins`
   - **This is required** - users without groups will fail to login if the groups mapping is configured

3. **Add the groups attribute mapping to your SAML application:**
   - Go to your SAML application → **Attribute mappings**
   - Add a new mapping:
   
   | User attribute in the application | Maps to this string value or user attribute |
   |-----------------------------------|---------------------------------------------|
   | `groups` | `${user:groups}` |

4. **Get your admin group ID:**
   
   In Identity Center, go to **Groups** → click your admin group → copy the **Group ID** from the details.
   
   Alternatively, use the AWS CLI (requires Identity Center admin access):
   ```bash
   # List groups to find the ID
   aws identitystore list-groups --identity-store-id <your-identity-store-id>
   ```

5. **Update the AdminGroupName parameter with the group ID:**
   
   The `AdminGroupName` parameter supports both group names (for Okta) and group IDs (for Identity Center). You can specify multiple values separated by commas.
   
   ```bash
   # Get the parameter prefix
   PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
   
   # Update SSM parameter to include the group ID
   aws ssm put-parameter \
     --name "/${PARAM_PREFIX}/Auth/AdminGroupName" \
     --value "App-Admins,<your-group-id>" \
     --overwrite
   ```
   
   Example with a real group ID:
   ```bash
   PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
   aws ssm put-parameter \
     --name "/${PARAM_PREFIX}/Auth/AdminGroupName" \
     --value "App-Admins,14b814d8-0051-70ce-abfc-e94bf1852946" \
     --overwrite
   ```

6. **Verify the configuration:**
   ```bash
   PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
   aws ssm get-parameter --name "/${PARAM_PREFIX}/Auth/AdminGroupName" --query "Parameter.Value" --output text
   ```

**Why Group IDs?** Identity Center's `${user:groups}` attribute sends group IDs (GUIDs) rather than group names. This is a limitation of Identity Center's SAML implementation. The application supports both formats, so you can use group names for Okta and group IDs for Identity Center simultaneously.

## Step 6: Assign Users and Groups

1. In your Identity Center application, go to **Assigned users and groups**
2. Click **Assign users and groups**
3. Select the users or groups that should have access
4. Click **Assign**

## Step 7: Configure Cognito with Identity Center

**Switch to the workload account** where the application is deployed.

Copy the `identity-center-metadata.xml` file (downloaded in Step 2) to your project root, then run the setup script:

```bash
cd <project-directory>

# Ensure identity-center-metadata.xml is in the project root
ls -la identity-center-metadata.xml

# Run the setup script
./scripts/setup-identity-center-saml.sh
```

**Expected output:**
```
🔐 Setting up IAM Identity Center SAML Integration
📋 Using parameter prefix: /<ProductPrefix>
📋 Getting Cognito User Pool ID, Client ID, and Frontend URL...
✅ Found User Pool ID: us-east-1_EXAMPLE123
✅ Found User Pool Client ID: EXAMPLE_CLIENT_ID_12345
✅ Found Frontend URL: https://dev.example.com/
🔍 Checking if IdentityCenter provider already exists...
📝 Processing metadata XML...
🔧 Creating Identity Center SAML Identity Provider...
✅ Identity Center SAML Identity Provider created successfully
🔧 Updating User Pool Client to support Identity Center provider...
✅ User Pool Client updated to support Identity Center provider

🎉 IAM Identity Center SAML integration setup complete!
```

**Important:** Copy the "Application start URL" from the script output and configure it in your Identity Center application (see Step 3).

## Step 8: Enable Cognito Authentication Mode

Ensure your application is set to use Cognito authentication:

```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
aws ssm put-parameter \
  --name "/${PARAM_PREFIX}/Auth/UseCognitoAuth" \
  --value "true" \
  --overwrite
```

## Step 9: Test the Integration

1. **Go to your Identity Center portal** (e.g., `https://d-xxxxxxxxxx.awsapps.com/start`)
2. **Find the application tile**
3. **Click to launch** - you should be redirected through SAML to the application
4. **Verify you're logged in** with correct user attributes

**Alternative: Direct Application Access**
1. Navigate directly to your application URL
2. Click "Sign In" - you'll be redirected to Identity Center
3. Authenticate and return to the application

## Step 10: Configure User Sync (Optional but Recommended)

The application can sync users from Identity Center groups to enable:
- **Pre-populating users** before they log in
- **Assigning workstations proactively** to users who haven't authenticated yet
- **Displaying user names** in the "Assigned To" column instead of email addresses

### Configure Sync Groups

1. **Update `parameters.json`** with the groups to sync:

   ```json
   {
     "ParameterKey": "IdentityCenterSyncGroups",
     "ParameterValue": "App-Users,App-Admins"
   }
   ```

   You can use either group names or group IDs. The Lambda will resolve names to IDs automatically.

2. **Deploy the infrastructure stack** to update the SSM parameter:

   ```bash
   npx cdk deploy <ProductPrefix>-Infrastructure --require-approval never
   ```

3. **Run the Identity Center setup script** (if not already done):

   ```bash
   ./scripts/setup-identity-center-saml.sh
   ```

   This script extracts the Identity Store ID from your metadata file and stores it in SSM.

### Sync Users

1. **Navigate to User Management** in the application
2. **Click "Sync from Identity Center"** button
3. Users from the configured groups will be synced to the local database
4. Synced users appear with "PENDING" status until they log in

### How It Works

- The sync reads users from configured Identity Center groups
- User details (name, email) are stored in DynamoDB
- Users appear in the User Management list before they log in
- When a user logs in via Cognito, they're deduplicated automatically
- The "Assigned To" column shows the user's name instead of their email

### Verify Sync Configuration

```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")

# Check Identity Store ID is configured
aws ssm get-parameter --name "/${PARAM_PREFIX}/Identity/IdentityStoreId" --query "Parameter.Value" --output text

# Check sync groups are configured
aws ssm get-parameter --name "/${PARAM_PREFIX}/Identity/SyncGroups" --query "Parameter.Value" --output text
```

## Troubleshooting

### Issue: "Bad input" error during login for new users

**Cause:** The `groups` attribute mapping (`${user:groups}`) fails for users who aren't in any Identity Center groups. Identity Center cannot resolve this attribute if the user has no group memberships.

**Solution (Choose one):**

**Option A - Remove groups mapping (simplest):**
1. Go to Identity Center → Applications → Your app → Attribute mappings
2. Remove the `groups` → `${user:groups}` mapping
3. Admin detection won't work until you add users to groups and re-add the mapping

**Option B - Ensure all users are in at least one group (recommended):**
1. Create a default group in Identity Center (e.g., `App-Users`)
2. Add ALL users who need app access to this group
3. The `${user:groups}` attribute will now resolve correctly
4. Admin users should also be in the `App-Admins` group

**Why this happens:** Unlike Okta, Identity Center's `${user:groups}` attribute is undefined (not empty) when a user has no group memberships. This causes the SAML assertion to fail with "Bad input".

### Issue: "Bad input" or "No access" error during login (general)

**Cause:** Attribute mappings reference attributes that don't exist on the user.

**Solution:** 
1. Remove optional attribute mappings (`department`, `custom_isAdmin`) from your Identity Center application
2. Keep only the essential mappings: `Subject`, `email`, `given_name`, `family_name`
3. Add `groups` mapping only if ALL users are in at least one Identity Center group

### Issue: "Invalid samlResponse or relayState" when clicking app in SSO portal

**Cause:** The Application start URL is not configured, causing IdP-initiated SAML to fail.

**Solution:**
1. Go to Identity Center → Applications → Your app → Edit configuration
2. Set the **Application start URL** to the URL output by the setup script
3. This URL looks like: `https://{cognito-domain}/oauth2/authorize?response_type=code&client_id={client-id}&redirect_uri={frontend-url}&scope=email+openid+profile&identity_provider=IdentityCenter`

### Issue: "Invalid SAML Response"

**Solution:** Verify attribute mappings in Identity Center match exactly:
- `Subject` → `${user:email}` (Format: `emailAddress`)
- `email` → `${user:email}`
- `given_name` → `${user:givenName}`
- `family_name` → `${user:familyName}`

### Issue: "User not authorized"

**Solution:**
1. Verify user is assigned to the application in Identity Center
2. Check that the user's group has access

### Issue: "Application not appearing in SSO portal"

**Solution:**
1. Ensure the application is enabled in Identity Center
2. Verify user/group assignment
3. Check that the application status is "Active"

### Issue: "Admin features not visible"

**Cause:** Identity Center sends group IDs (GUIDs) instead of group names.

**Solution:**
1. Check your ID token to see what group value is being sent:
   ```javascript
   // In browser console after login
   JSON.parse(atob(sessionStorage.getItem('auth-token').split('.')[1]))
   ```
2. Look for `custom:groups` - it will contain a GUID like `14b814d8-0051-70ce-abfc-e94bf1852946`
3. Update the `AdminGroupName` SSM parameter to include this group ID:
   ```bash
   PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
   aws ssm put-parameter \
     --name "/${PARAM_PREFIX}/Auth/AdminGroupName" \
     --value "App-Admins,<your-group-id>" \
     --overwrite
   ```
4. Clear browser session storage and re-login

### Issue: "Redirect URI mismatch"

**Solution:**
1. Verify the ACS URL in Identity Center matches your Cognito domain
2. Re-run the setup script: `./scripts/setup-identity-center-saml.sh`

## Verify Configuration

```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")

# Verify Identity Center provider exists in Cognito
USER_POOL_ID=$(aws ssm get-parameter --name "/${PARAM_PREFIX}/Auth/UserPoolId" --query "Parameter.Value" --output text)
aws cognito-idp describe-identity-provider \
  --user-pool-id "$USER_POOL_ID" \
  --provider-name "IdentityCenter"

# Verify auth mode is set to Cognito
aws ssm get-parameter \
  --name "/${PARAM_PREFIX}/Auth/UseCognitoAuth" \
  --query "Parameter.Value" \
  --output text
```

## Using Both Okta and Identity Center

You can have both identity providers configured simultaneously. Users will see both options on the Cognito hosted UI, or you can configure your application to redirect to a specific provider.

To check configured providers:
```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
aws cognito-idp list-identity-providers \
  --user-pool-id $(aws ssm get-parameter --name "/${PARAM_PREFIX}/Auth/UserPoolId" --query "Parameter.Value" --output text)
```

## Cross-Account Deployment (Typical Scenario)

Most organizations deploy with this pattern:

| Component | Account | Notes |
|-----------|---------|-------|
| IAM Identity Center | Management Account | Or delegated admin account |
| SAML Application Config | Management Account | Steps 2-6 of this guide |
| Cognito User Pool | Workload Account | Created by CDK deployment |
| Application | Workload Account | Steps 1, 7-9 of this guide |

**Why this works:**
- SAML is a standard protocol that works across AWS accounts
- The metadata XML contains Identity Center's public signing certificate
- Cognito validates SAML assertions using this certificate
- No cross-account IAM roles or resource policies needed

**Workflow Summary:**
1. Get Cognito details from **workload account** (Step 1)
2. Configure Identity Center in **management account** (Steps 2-6)
3. Download metadata from **management account**
4. Run setup script in **workload account** (Steps 7-9)

## Switching Between Identity Providers

The application supports multiple SAML providers. To switch the default:

```bash
# The frontend will use the configured identity_provider parameter
# Update your config-generator Lambda or frontend config as needed
```

## Additional Resources

- [IAM Identity Center Documentation](https://docs.aws.amazon.com/singlesignon/latest/userguide/)
- [Adding SAML Applications to Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/samlapps.html)
- [Cognito SAML Federation](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html)

## Support

If you encounter issues:
1. Check CloudWatch Logs for Lambda errors
2. Review Identity Center audit logs
3. Verify all attribute mappings are correct
4. Ensure user is assigned to the application
