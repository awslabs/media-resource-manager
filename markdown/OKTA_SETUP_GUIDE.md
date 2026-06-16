# Okta SAML Setup Guide

**Use this guide for:**
- ✅ Setting up Okta SAML integration for the first time
- ✅ Reconfiguring with a new Okta account
- ✅ Troubleshooting existing Okta integration

**Time required:** ~15-20 minutes

This step-by-step guide walks you through configuring Okta SAML authentication for the application.

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

- ✅ New Okta Integrator account created
- ✅ AWS CLI configured
- ✅ Application already deployed

## Important: Dynamic Parameter Paths

This application uses dynamic SSM parameter paths based on the product name configured in `cdk.json`. Throughout this guide, you'll need to determine your parameter prefix first:

```bash
# Get the parameter prefix (e.g., MediaResourceManager)
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
echo "Parameter prefix: /${PARAM_PREFIX}"
```

All SSM parameters follow the pattern: `/${PARAM_PREFIX}/...`

## Step 1: Get Your Current Cognito Configuration

First, retrieve your existing Cognito User Pool details using the helper script:

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
Copy these values for Okta SAML setup:
============================================

Application ACS URL:
  https://<product-prefix>-31286568.auth.us-east-1.amazoncognito.com/saml2/idpresponse

Application SAML audience:
  urn:amazon:cognito:sp:us-east-1_EXAMPLE123

Application start URL:
  https://<product-prefix>-31286568.auth.us-east-1.amazoncognito.com/oauth2/authorize?...
```

**Save these values - you'll need them for Okta configuration!**

## Step 2: Create New SAML Application in Okta

1. **Log into your new Okta Integrator account**
   - Go to https://your-domain.okta.com/admin

2. **Create SAML 2.0 Application**
   - Navigate to: **Applications** → **Applications** → **Create App Integration**
   - Select: **SAML 2.0**
   - Click: **Next**

3. **General Settings**
   - **App name**: Your application name (from `productName` in `cdk.json`)
   - **App logo**: (optional)
   - Click: **Next**

4. **Configure SAML Settings**

   Use the URLs generated in Step 1:

   **Single sign-on URL:** (Application ACS URL from Step 1 output)

   **Audience URI (SP Entity ID):** (Application SAML audience from Step 1 output)

   **Name ID format**: `EmailAddress`
   
   **Application username**: `Email`

5. **Attribute Statements** (Add these exactly as shown)

   | Name | Name format | Value |
   |------|-------------|-------|
   | `email` | Unspecified | `user.email` |
   | `given_name` | Unspecified | `user.firstName` |
   | `family_name` | Unspecified | `user.lastName` |
   | `department` | Unspecified | `user.department` |
   | `custom_isAdmin` | Unspecified | `user.isAdmin` |

6. **Group Attribute Statements** (Optional - for group-based admin access)

   | Name | Name format | Filter | Value |
   |------|-------------|--------|-------|
   | `groups` | Unspecified | Matches regex | `.*` |

7. **Click Next** and select:
   - "I'm an Okta customer adding an internal app"
   - Click **Finish**

## Step 3: Configure User Attributes in Okta

1. **Go to Directory → Profile Editor**
2. **Find your SAML app** and click on it
3. **Add Custom Attributes** (if not already present):
   - `department` (String)
   - `isAdmin` (String)

4. **Assign values to your user:**
   - Go to **Directory → People**
   - Click on your user
   - Click **Profile** tab → **Edit**
   - Set `department` to your department (e.g., "IT")
   - Set `isAdmin` to `true` (for admin access) or `false`
   - Click **Save**

## Step 4: Download Okta Metadata

1. **In your SAML application**, go to the **Sign On** tab
2. **Scroll down** to "SAML Signing Certificates"
3. **Click** "View SAML setup instructions" or find the **Metadata URL**
4. **Download the metadata XML** and save it as `okta-metadata.xml` in your project root:

   ```bash
   # Option 1: Download directly from Okta metadata URL
   curl -o okta-metadata.xml "https://your-domain.okta.com/app/YOUR_APP_ID/sso/saml/metadata"
   
   # Option 2: Copy/paste the XML content
   # Copy the XML from Okta and save to okta-metadata.xml
   ```

## Step 5: Assign Users to the Application

1. **In Okta**, go to your SAML application
2. **Click the Assignments tab**
3. **Click Assign** → **Assign to People**
4. **Select your user** and click **Assign**
5. **Verify the user attributes** are correct
6. Click **Save and Go Back**
7. Click **Done**

## Step 6: Update Cognito with New Okta Configuration

Run the setup script to configure Cognito with your new Okta metadata:

```bash
cd <project-directory>

# Make sure okta-metadata.xml is in the project root
ls -la okta-metadata.xml

# Run the setup script
./scripts/setup-okta-saml.sh
```

**Expected output:**
```
🔐 Setting up Okta SAML Integration
📋 Using parameter prefix: /<ProductPrefix>
📋 Getting Cognito User Pool ID, Client ID, and Frontend URL...
✅ Found User Pool ID: us-east-1_EXAMPLE123
✅ Found User Pool Client ID: EXAMPLE_CLIENT_ID_12345
✅ Found Frontend URL: https://dev.example.com/
🔍 Checking if Okta provider already exists...
⚠️  Okta provider already exists. Deleting and recreating...
✅ Deleted existing Okta provider
📝 Processing metadata XML...
🔧 Creating Okta SAML Identity Provider...
✅ Okta SAML Identity Provider created successfully
🔧 Updating User Pool Client to support Okta provider...
✅ User Pool Client updated to support Okta provider
🎉 Okta SAML integration setup complete!
```

## Step 7: Enable Cognito Authentication Mode

Switch your application to use Cognito/Okta authentication:

```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
aws ssm put-parameter \
  --name "/${PARAM_PREFIX}/Auth/UseCognitoAuth" \
  --value "true" \
  --overwrite
```

**Note:** The EventBridge automation will automatically update your frontend configuration within a few minutes.

## Step 8: Test the Integration

1. **Clear your browser cache** or use an incognito window
2. **Navigate to your application URL**
3. **You should be redirected to Okta login**
4. **Sign in with your Okta credentials**
5. **Verify you're redirected back** to the application
6. **Check that admin features are visible** (if you set `isAdmin=true`)

## Troubleshooting

### Issue: "Invalid SAML Response"

**Solution:** Verify your Okta attribute mappings match exactly:
- `email` → `user.email`
- `given_name` → `user.firstName`
- `family_name` → `user.lastName`
- `department` → `user.department`
- `custom_isAdmin` → `user.isAdmin`

### Issue: "User not assigned to application"

**Solution:** 
1. Go to Okta → Applications → Your App → Assignments
2. Assign your user to the application

### Issue: "Not seeing admin features"

**Solution:**
1. Verify `isAdmin` attribute is set to `true` in Okta user profile
2. Check the JWT token contains `custom:isAdmin` claim
3. Clear browser cache and re-login

### Issue: "Redirect URI mismatch"

**Solution:**
1. Verify Frontend URL in SSM matches your actual URL
2. Re-run the setup script: `./scripts/setup-okta-saml.sh`
3. Check Okta callback URLs include your frontend URL

## Verify Configuration

Check that everything is configured correctly:

```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")

# Verify Cognito Identity Provider exists
aws cognito-idp describe-identity-provider \
  --user-pool-id $(aws ssm get-parameter --name "/${PARAM_PREFIX}/Auth/UserPoolId" --query "Parameter.Value" --output text) \
  --provider-name "Okta"

# Verify auth mode is set to Cognito
aws ssm get-parameter \
  --name "/${PARAM_PREFIX}/Auth/UseCognitoAuth" \
  --query "Parameter.Value" \
  --output text
```

## Switch Back to LDAP (If Needed)

If you need to temporarily switch back to LDAP authentication:

```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
aws ssm put-parameter \
  --name "/${PARAM_PREFIX}/Auth/UseCognitoAuth" \
  --value "false" \
  --overwrite
```

## Additional Resources

- **Detailed Guide**: `markdown/OKTA_SAML_INTEGRATION_GUIDE.md`
- **Okta SAML Documentation**: https://developer.okta.com/docs/guides/build-sso-integration/saml2/main/
- **AWS Cognito SAML**: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html

## Support

If you encounter issues:
1. Check CloudWatch Logs for Lambda errors
2. Review Okta system logs for SAML errors
3. Verify all attribute mappings are correct
4. Ensure user is assigned to the application in Okta
