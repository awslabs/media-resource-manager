// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { CognitoJwtVerifier } = require('aws-jwt-verify');

// ─── LDAP token: HS256 verified against a Secrets Manager secret ──────────────
// Cache the shared secret so we do not call Secrets Manager on every invocation.

let cachedSecret = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getJwtSecret() {
    const now = Date.now();
    if (cachedSecret && now < cacheExpiry) {
        return cachedSecret;
    }

    const client = new SecretsManagerClient();
    const command = new GetSecretValueCommand({
        SecretId: process.env.JWT_SECRET_ARN
    });
    const response = await client.send(command);
    cachedSecret = response.SecretString;
    cacheExpiry = now + CACHE_TTL;
    return cachedSecret;
}

// Parse and verify an LDAP JWT token. Verifies the HS256 signature against the
// shared secret in Secrets Manager, then checks expiration.
async function parseJWT(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) {
            throw new Error('Malformed token');
        }
        const [header, payload, signature] = parts;

        const secret = await getJwtSecret();
        const expectedSignature = crypto.createHmac('sha256', secret)
            .update(header + '.' + payload)
            .digest('base64url');

        // Constant-time comparison to prevent signature timing side channels.
        const providedBuf = Buffer.from(signature || '', 'base64url');
        const expectedBuf = Buffer.from(expectedSignature, 'base64url');
        if (providedBuf.length !== expectedBuf.length ||
            !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
            throw new Error('Invalid signature');
        }

        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());

        if (typeof decoded.exp !== 'number' || decoded.exp < Math.floor(Date.now() / 1000)) {
            throw new Error('Token expired');
        }

        return decoded;
    } catch (error) {
        throw new Error('Invalid token: ' + error.message);
    }
}

// ─── Cognito token: RS256 verified against the User Pool JWKS ─────────────────
// The verifier enforces: JWKS signature, exact issuer match, aud/client_id,
// token_use === 'id', exp, iat, and nbf. JWKS is cached in-process by the
// library so we only pay the network cost on first use per Lambda instance.

let cognitoVerifier = null;

function getCognitoVerifier() {
    if (cognitoVerifier) {
        return cognitoVerifier;
    }

    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    const clientId = process.env.COGNITO_APP_CLIENT_ID;

    if (!userPoolId || !clientId) {
        throw new Error('COGNITO_USER_POOL_ID and COGNITO_APP_CLIENT_ID environment variables are required for Cognito token verification');
    }

    cognitoVerifier = CognitoJwtVerifier.create({
        userPoolId,
        tokenUse: 'id',
        clientId,
    });

    return cognitoVerifier;
}

async function validateCognitoToken(token) {
    try {
        return await getCognitoVerifier().verify(token);
    } catch (error) {
        // aws-jwt-verify throws descriptive errors (JwtInvalidSignatureError,
        // JwtInvalidIssuerError, JwtInvalidClaimError, etc.). We surface the
        // library's message but do not leak internal details beyond that.
        throw new Error('Invalid Cognito token: ' + error.message);
    }
}

// ─── Admin check ──────────────────────────────────────────────────────────────

function isAdminUser(cognitoData) {
    // Trust only cognito:groups for admin determination.
    //
    // cognito:groups reflects either native Cognito group membership (set via
    // AdminAddUserToGroup with IAM) or SAML group claims that the
    // pre-token-generation trigger has merged in from custom:groups. Both
    // paths are administratively controlled:
    //   - Native group membership can only be modified by admin API calls with
    //     IAM credentials, never by end-user access tokens.
    //   - custom:groups is IdP-writable via SAML attribute mapping, and after
    //     the UserPoolClient writeAttributes restriction in auth-construct.ts
    //     it is no longer user-writable via UpdateUserAttributes.
    //
    // Do NOT trust custom:isAdmin, custom:department, or the raw 'groups'
    // claim. Those are user-writable (or user-writable before the CDK
    // restriction lands on an existing deployment) and can be self-elevated
    // via UpdateUserAttributes.
    const cognitoGroups = cognitoData['cognito:groups'] || [];

    const normalizeGroups = (groups) => {
        if (Array.isArray(groups)) {
            return groups.map(g => g.replace(/^\[|\]$/g, '').trim());
        }
        if (typeof groups === 'string' && groups) {
            const cleaned = groups.replace(/^\[|\]$/g, '').trim();
            return cleaned.split(',').map(g => g.trim());
        }
        return [];
    };

    const userGroups = normalizeGroups(cognitoGroups);

    // AdminGroupName can be comma-separated (e.g. "MRM-Admins,14b814d8-...")
    const adminGroupConfig = process.env.ADMIN_GROUP_NAME || 'MRM-Admins';
    const validAdminGroups = adminGroupConfig.split(',').map(g => g.trim().toLowerCase());

    return userGroups.some(userGroup =>
        validAdminGroups.includes(userGroup.toLowerCase())
    );
}

// ─── Handler ──────────────────────────────────────────────────────────────────

// Route the token to the correct verifier by inspecting an unverified claim.
// The routing decision is safe even if an attacker lies in `iss`: both
// verifiers fully verify cryptographic signatures and will reject any token
// that was not signed by the trusted issuer. The routing heuristic only
// selects which verifier runs; identity is proven by the signature check.
function chooseTokenType(token) {
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('Malformed token');
    }
    let preview;
    try {
        preview = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch (e) {
        throw new Error('Malformed token payload');
    }
    if (preview.iss && preview.iss.includes('cognito-idp')) {
        return 'cognito';
    }
    return 'ldap';
}

exports.handler = async (event) => {
    console.log('JWT Authorizer called for:', event.methodArn);

    try {
        const token = event.authorizationToken?.replace('Bearer ', '');
        if (!token) {
            throw new Error('No token provided');
        }

        const tokenType = chooseTokenType(token);

        let userData;
        if (tokenType === 'cognito') {
            userData = await validateCognitoToken(token);
            console.log('Cognito token validated for user:', userData.email);
        } else {
            userData = await parseJWT(token);
            console.log('LDAP token validated for user:', userData.username);
        }

        // Normalize user data format
        // Determine userId based on user type:
        // - Federated users (Okta, IdentityCenter): use cognito:username (e.g., "IdentityCenter_user@example.com")
        // - Native Cognito users: use email (cognito:username is a UUID for native users)
        const cognitoUsername = userData['cognito:username'] || '';
        const isFederatedUser = cognitoUsername.includes('_') && !/^[0-9a-f-]{36}$/i.test(cognitoUsername);
        const userId = tokenType === 'cognito'
            ? (isFederatedUser ? cognitoUsername : userData.email)
            : (userData.sub || userData.username);

        const normalizedUser = {
            userId: userId,
            email: userData.email,
            firstName: userData.given_name || userData.firstName,
            lastName: userData.family_name || userData.lastName,
            isAdmin: tokenType === 'cognito' ? isAdminUser(userData) : (userData.isAdmin || false)
        };

        return {
            principalId: normalizedUser.userId,
            policyDocument: {
                Version: '2012-10-17',
                Statement: [{
                    Action: 'execute-api:Invoke',
                    Effect: 'Allow',
                    Resource: event.methodArn
                }]
            },
            context: {
                username: normalizedUser.userId,  // Keep original field name for compatibility
                userId: normalizedUser.userId,
                email: normalizedUser.email,
                firstName: normalizedUser.firstName,
                lastName: normalizedUser.lastName,
                isAdmin: normalizedUser.isAdmin ? 'true' : 'false',
                tokenType: tokenType
            }
        };
    } catch (error) {
        console.log('Authorization failed:', error.message);
        throw new Error('Unauthorized');
    }
};

// Exported for unit tests. Not part of the runtime authorizer contract.
exports.isAdminUser = isAdminUser;
