# S3 Watchfolder: Adding Federated Identity Provider Support

## Task
Add support for federated identity providers (Identity Center, Okta, Amazon Federate) to the S3 Watchfolder Electron app.

## Current State
The app currently supports native Cognito User Pool authentication where users enter username/password directly. This works by:

1. User enters credentials in the app
2. App authenticates directly with Cognito User Pool using `InitiateAuth` API
3. App receives ID token from Cognito
4. ID token is exchanged with Cognito Identity Pool for temporary AWS credentials
5. AWS credentials are used for S3 operations

## Goal
Add support for federated identity providers that are configured in Cognito User Pool, such as:

- AWS IAM Identity Center (formerly AWS SSO)
- Okta (SAML)
- Any other SAML/OIDC identity provider

## How Federated Auth Works
Federated users cannot authenticate with username/password directly to Cognito. Instead, they must go through an OAuth 2.0 / OIDC flow:

1. App opens Cognito Hosted UI in a browser window
2. User selects their identity provider (or is redirected automatically if specified)
3. User authenticates with their corporate IdP (Identity Center, Okta, etc.)
4. IdP redirects back to Cognito with SAML assertion
5. Cognito issues an authorization code and redirects to the app's redirect URI
6. App exchanges authorization code for tokens (ID token, access token, refresh token)
7. App uses ID token with Identity Pool to get AWS credentials (same as current flow)

## Implementation Approach

### 1. Add OAuth/PKCE Flow Support
Use Authorization Code flow with PKCE (Proof Key for Code Exchange):

- Generate code_verifier and code_challenge
- Build authorization URL with parameters:

```
https://{cognitoDomain}/oauth2/authorize?
  client_id={clientId}&
  response_type=code&
  scope=openid+email+profile&
  redirect_uri={redirectUri}&
  code_challenge={codeChallenge}&
  code_challenge_method=S256&
  identity_provider={providerName}  // Optional: skip provider selection screen
```

### 2. Handle the Redirect
Options for handling the OAuth callback in Electron:

- **Option A:** Register a custom protocol handler (e.g., `s3watchfolder://callback`)
- **Option B:** Start a local HTTP server to receive the callback
- **Option C:** Use Electron's `BrowserWindow` with `will-redirect` event

### 3. Exchange Code for Tokens
POST to `https://{cognitoDomain}/oauth2/token` with:

```
grant_type=authorization_code
client_id={clientId}
code={authorizationCode}
redirect_uri={redirectUri}
code_verifier={codeVerifier}
```

### 4. Use Tokens with Identity Pool
The ID token from OAuth flow works the same way as direct auth. Pass to `fromCognitoIdentityPool` with the same logins map:

```javascript
logins: {
  [`cognito-idp.${region}.amazonaws.com/${userPoolId}`]: idToken
}
```

## Configuration Requirements
The app needs these additional config values (which can be obtained from the Media Resource Manager Buckets page):

| Config Key | Description | Example |
|------------|-------------|---------|
| `cognitoDomain` | The Cognito Hosted UI domain | `mrm-12345.auth.us-east-1.amazoncognito.com` |
| `identityProviders` | List of available identity providers (optional) | `["Okta", "IdentityCenter"]` |

## UI Changes
Add a dropdown or buttons to select authentication method:

- "Sign in with Username/Password" (current flow)
- "Sign in with Corporate SSO" (opens browser for OAuth flow)
- Or specific provider buttons: "Sign in with Identity Center", "Sign in with Okta", etc.

## Reference Implementation
Look at how the Media Resource Manager frontend handles this in:

- `frontend/src/pages/LoginAntd.tsx` - Shows provider selection and OAuth redirect
- `frontend/src/utils/auth.ts` - Token handling and session management

## Key Cognito Endpoints

| Endpoint | URL |
|----------|-----|
| Authorization | `https://{domain}/oauth2/authorize` |
| Token | `https://{domain}/oauth2/token` |
| User Info | `https://{domain}/oauth2/userInfo` |
| Logout | `https://{domain}/logout` |

## Code Examples

### PKCE Code Generation

```javascript
const crypto = require('crypto');

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}
```

### Building the Authorization URL

```javascript
function buildAuthUrl(config, codeChallenge, identityProvider = null) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: config.redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  
  if (identityProvider) {
    params.append('identity_provider', identityProvider);
  }
  
  return `https://${config.cognitoDomain}/oauth2/authorize?${params.toString()}`;
}
```

### Token Exchange

```javascript
async function exchangeCodeForTokens(config, code, codeVerifier) {
  const response = await fetch(`https://${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code: code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  
  return response.json();
}
```

### Using Tokens with Identity Pool

```javascript
const { fromCognitoIdentityPool } = require('@aws-sdk/credential-providers');
const { S3Client } = require('@aws-sdk/client-s3');

function createS3Client(config, idToken) {
  return new S3Client({
    region: config.region,
    credentials: fromCognitoIdentityPool({
      clientConfig: { region: config.region },
      identityPoolId: config.identityPoolId,
      logins: {
        [`cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`]: idToken,
      },
    }),
  });
}
```
