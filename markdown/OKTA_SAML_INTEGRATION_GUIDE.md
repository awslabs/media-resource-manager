# Okta SAML Integration Implementation Guide

## Overview

This guide outlines the implementation of Okta SAML 2.0 authentication for the Media Resource Manager application, replacing the current AWS Managed Active Directory authentication with Cognito User Pool SAML federation.

## Current vs Target Architecture

### Current Authentication Flow
```
User → Frontend → LDAP Auth → AWS Managed AD → Application
```

### Target Authentication Flow
```
User → Frontend → Cognito Hosted UI → Okta SAML → Cognito User Pool → Application
```

## Implementation Phases

> **⚠️ IMPORTANT: Code Review First**
> 
> Before modifying any file, **thoroughly read the entire file** to understand:
> - Existing authentication/authorization logic
> - Current user management functions
> - Group/role checking mechanisms
> - Workstation filtering logic
> 
> **Look for existing functions** that may already handle similar functionality before creating new ones. Update existing functions rather than duplicating logic.

### Phase 1: Infrastructure Setup ✅ COMPLETED
- [x] Add Cognito User Pool to infrastructure stack
- [x] Configure User Pool with required attributes
- [x] Create User Pool Client with OAuth settings
- [x] Set up Cognito Domain for hosted UI
- [x] Deploy infrastructure changes

### Phase 2: Okta Configuration ✅ COMPLETED
- [x] Create SAML 2.0 application in Okta
- [x] Configure Okta with Cognito endpoints
- [x] Set up attribute mappings (email, given_name, family_name, department)
- [x] Download Okta SAML metadata
- [x] Test Okta configuration

### Phase 3: Cognito SAML Integration ✅ COMPLETED
- [x] Add SAML Identity Provider to User Pool (via CLI script)
- [x] Configure attribute mappings in Cognito
- [x] Update User Pool Client settings to support Okta provider
- [x] Fix attribute mapping to match Okta output format
- [x] Script updated for future deployments

### Phase 4: Application Updates ✅ COMPLETED
- [x] Frontend authentication working with Cognito/Okta
- [x] User successfully authenticating via Okta SAML
- [x] Lambda functions updated for federated users
- [x] User management logic updated for JWT tokens
- [x] API Gateway CORS and authentication working
- [x] EventBridge automation for auth mode switching

### Phase 5: Testing & Validation ✅ COMPLETED
- [x] Test complete authentication flow
- [x] Verify user attribute mapping (department, isAdmin)
- [x] Test admin vs regular user access
- [x] Validate workstation assignment
- [x] Backend JWT authorizer correctly reading custom:isAdmin
- [x] Frontend correctly parsing custom:isAdmin from token
- [x] Admin UI elements showing correctly for admin users

### Phase 6: Dual Authentication Mode ✅ IMPLEMENTED
- [x] Maintain AWS Managed AD for backward compatibility
- [x] EventBridge automation for seamless auth switching
- [x] Parameter-driven authentication mode selection

## Phase 1: Infrastructure Setup

### 1.1 Update Infrastructure Stack

**File: `lib/stacks/infra-stack.ts`**

```typescript
// Add Cognito User Pool
const userPool = new cognito.UserPool(this, 'UserPool', {
  userPoolName: `${props.acronym}-UserPool`,
  signInAliases: { email: true },
  standardAttributes: {
    email: { required: true, mutable: true },
    givenName: { required: true, mutable: true },
    familyName: { required: true, mutable: true },
  },
  customAttributes: {
    department: new cognito.StringAttribute({ mutable: true }),
    isAdmin: new cognito.StringAttribute({ mutable: true }),
  },
});

```typescript
// Get frontend URL from parameter store
const frontendUrl = ssm.StringParameter.valueForStringParameter(
  this, 
  `/${props.acronym}/Frontend/Url`
);

const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
  userPool,
  generateSecret: false,
  authFlows: { userSrp: true, adminUserPassword: true },
  oAuth: {
    flows: { authorizationCodeGrant: true },
    scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
    callbackUrls: [frontendUrl, 'http://localhost:3000/'],
    logoutUrls: [frontendUrl, 'http://localhost:3000/'],
  },
});

const userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
  userPool,
  cognitoDomain: { domainPrefix: `${props.acronym.toLowerCase()}-${cdk.Stack.of(this).account.substring(0,8)}` },
});
```

## Phase 2: Okta Configuration

### 2.1 Okta SAML Settings ✅ COMPLETED

```
Single sign-on URL: https://mrm-31286568.auth.us-east-1.amazoncognito.com/saml2/idpresponse
Audience URI: urn:amazon:cognito:sp:us-east-1_EXAMPLE123
Name ID format: EmailAddress
Application username: Email

Attribute Statements:
- email → user.email
- given_name → user.firstName  
- family_name → user.lastName
- department → user.department

Group Attribute Statements:
- groups → Equals: MRM-Admins
```

## Phase 3: Cognito SAML Integration

### 3.1 Add SAML Identity Provider

```typescript
const oktaIdentityProvider = new cognito.UserPoolIdentityProviderSaml(this, 'OktaProvider', {
  userPool: userPool,
  name: 'Okta',
  metadata: cognito.UserPoolIdentityProviderSamlMetadata.file('./okta-metadata.xml'),
  attributeMapping: {
    email: cognito.ProviderAttribute.other('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'),
    givenName: cognito.ProviderAttribute.other('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'),
    familyName: cognito.ProviderAttribute.other('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'),
    'custom:department': cognito.ProviderAttribute.other('department'),
  },
});
```

## Phase 4: Application Updates

### 4.1 Frontend Authentication Service

**File: `frontend/src/services/auth.ts`**

```typescript
// Get config values (same pattern as existing app)
const getConfig = async () => {
  const response = await fetch('/config.json');
  return response.json();
};

export const signIn = async () => {
  const config = await getConfig();
  
  const params = new URLSearchParams({
    identity_provider: 'Okta',
    redirect_uri: window.location.origin,
    response_type: 'code',
    client_id: config.cognitoClientId,
    scope: 'email openid profile',
  });
  
  window.location.href = `${config.cognitoDomain}/oauth2/authorize?${params}`;
};

export const handleCallback = async (code: string) => {
  const config = await getConfig();
  
  const response = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.cognitoClientId,
      code,
      redirect_uri: window.location.origin,
    }),
  });
  
  const tokens = await response.json();
  localStorage.setItem('accessToken', tokens.access_token);
  localStorage.setItem('idToken', tokens.id_token);
  
  return tokens;
};
```

**Update config generation Lambda to include Cognito values:**

```typescript
// In your config generation Lambda
const config = {
  // ... existing config
  cognitoDomain: `https://${domainPrefix}.auth.${region}.amazoncognito.com`,
  cognitoClientId: userPoolClientId,
  cognitoUserPoolId: userPoolId,
};
```

### 4.2 Lambda Function Updates

**File: `lambda/workstation-manager.js`**

```javascript
const getUserFromToken = (event) => {
  const claims = event.requestContext.authorizer.claims;
  
  return {
    userId: claims.sub,
    email: claims.email,
    firstName: claims.given_name,
    lastName: claims.family_name,
    department: claims['custom:department'],
    isAdmin: isAdminUser(claims),
  };
};

const isAdminUser = (claims) => {
  // Option 1: Check Okta groups (recommended)
  const groups = claims['cognito:groups'] || [];
  if (groups.includes('MRM-Admins')) {
    return true;
  }
  
  // Option 2: Fallback to department
  const department = claims['custom:department'];
  return department === 'IT' || department === 'Admin';
};

const getUserGroups = (claims) => {
  // Extract all user groups from Okta
  return claims['cognito:groups'] || [];
};

const canAccessWorkstation = (workstation, userClaims) => {
  const userId = userClaims.sub;
  const userGroups = getUserGroups(userClaims);
  
  // Admin can see all workstations
  if (isAdminUser(userClaims)) {
    return true;
  }
  
  // User can see workstations assigned to them
  if (workstation.assignedUserId === userId) {
    return true;
  }
  
  // User can see workstations assigned to their groups
  if (workstation.assignedGroups) {
    const assignedGroups = Array.isArray(workstation.assignedGroups) 
      ? workstation.assignedGroups 
      : [workstation.assignedGroups];
    
    return assignedGroups.some(group => userGroups.includes(group));
  }
  
  return false;
};
```

## EventBridge Automation

### Auth Mode Switching
The system includes EventBridge automation that monitors the `/{ProductName}/Auth/UseCognitoAuth` parameter (where ProductName is derived from `cdk.json`):

```typescript
const configUpdateRule = new events.Rule(this, 'ConfigUpdateRule', {
  eventPattern: {
    source: ['aws.ssm'],
    detailType: ['Parameter Store Change'],
    detail: {
      name: [`/${props.pascalCaseName}/Auth/UseCognitoAuth`],
      operation: ['Create', 'Update']
    }
  }
});
```

**How it works:**
1. Parameter change triggers EventBridge rule
2. Config generator Lambda updates frontend `config.json`
3. Frontend automatically switches authentication mode
4. No manual deployment or restart required

**Usage:**
```bash
# Get the parameter prefix from cdk.json
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")

# Switch to Cognito/Okta mode
aws ssm put-parameter --name "/${PARAM_PREFIX}/Auth/UseCognitoAuth" --value "true" --overwrite

# Switch back to LDAP mode  
aws ssm put-parameter --name "/${PARAM_PREFIX}/Auth/UseCognitoAuth" --value "false" --overwrite
```

## Configuration Reference

### Required Values ✅ DEPLOYED
- **User Pool ID**: `us-east-1_EXAMPLE123`
- **Client ID**: `EXAMPLE_CLIENT_ID_12345`
- **Cognito Domain**: `https://mrm-31286568.auth.us-east-1.amazoncognito.com`
- **Frontend URL**: `https://d29lubebd4b1xe.cloudfront.net`

### Deployment Commands

```bash
# Deploy infrastructure changes
cdk deploy MRM-Infra

# Get User Pool ID
aws cognito-idp list-user-pools --max-results 10

# Test authentication
curl -X GET "https://your-cognito-domain.auth.us-east-1.amazoncognito.com/oauth2/authorize?identity_provider=Okta&redirect_uri=https://dev.mrm.example.com&response_type=code&client_id=CLIENT_ID"
```

## Success Criteria

- [x] Users authenticate via Okta credentials
- [x] User attributes mapped correctly
- [ ] Admin/regular user roles work
- [ ] All app features function with new auth
- [ ] No AWS Managed AD dependencies

## Current Status: ✅ IMPLEMENTATION COMPLETE

**Completed:**
- ✅ Cognito User Pool and SAML provider configured
- ✅ Okta SAML application configured with correct attribute mapping
- ✅ Frontend successfully authenticating users via Okta
- ✅ Lambda functions handling Cognito JWT tokens
- ✅ API Gateway CORS and authentication working
- ✅ EventBridge automation for auth mode switching
- ✅ Dual authentication mode (LDAP + Cognito) implemented
- ✅ Backend JWT authorizer updated to prioritize custom:isAdmin attribute
- ✅ Frontend auth logic updated to read custom:isAdmin from Okta SAML tokens
- ✅ Admin functionality working correctly for Okta-authenticated users

**Key Implementation Details:**
- **Admin Detection**: Backend and frontend both check `custom:isAdmin` attribute from Okta SAML
- **Fallback Logic**: Maintains compatibility with group-based and department-based admin detection
- **Consistent User Experience**: Admin users see full navigation and functionality regardless of auth method

**Architecture:**
- **Flexible Authentication**: Parameter-driven switching between LDAP and Cognito modes
- **EventBridge Automation**: Automatic frontend config updates when auth mode changes
- **Backward Compatibility**: AWS Managed AD remains available for existing users

## Timeline: 6-9 days total

---

*Update this guide as implementation progresses. Check off completed items and add notes for any issues.*
