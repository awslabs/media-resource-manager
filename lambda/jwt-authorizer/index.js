// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// Cache the secret to avoid repeated API calls
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

// Parse LDAP JWT tokens
async function parseJWT(token) {
    try {
        const secret = await getJwtSecret();
        const [header, payload, signature] = token.split('.');
        const expectedSignature = crypto.createHmac('sha256', secret)
            .update(header + '.' + payload)
            .digest('base64url');

        if (signature !== expectedSignature) {
            throw new Error('Invalid signature');
        }

        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());

        if (decoded.exp < Math.floor(Date.now() / 1000)) {
            throw new Error('Token expired');
        }

        return decoded;
    } catch (error) {
        throw new Error('Invalid token: ' + error.message);
    }
}

// Validate Cognito JWT tokens
function validateCognitoToken(token) {
    try {
        const [header, payload] = token.split('.');
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());

        // Basic validation - check issuer and expiration
        if (!decoded.iss || !decoded.iss.includes('cognito-idp')) {
            throw new Error('Invalid issuer');
        }

        if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
            throw new Error('Token expired');
        }

        return decoded;
    } catch (error) {
        throw new Error('Invalid Cognito token: ' + error.message);
    }
}

// Check if Cognito user is admin
function isAdminUser(cognitoData) {
    // First check for custom:isAdmin attribute (from Okta SAML)
    if (cognitoData['custom:isAdmin']) {
        return cognitoData['custom:isAdmin'] === 'true';
    }

    // Collect groups from all possible sources
    const cognitoGroups = cognitoData['cognito:groups'] || [];
    const customGroups = cognitoData['custom:groups'] || '';
    const directGroups = cognitoData['groups'] || [];

    // Normalize groups to an array (handle string or array formats)
    const normalizeGroups = (groups) => {
        if (Array.isArray(groups)) {
            // Clean any brackets from individual group IDs (edge case from IdP)
            return groups.map(g => g.replace(/^\[|\]$/g, '').trim());
        }
        if (typeof groups === 'string' && groups) {
            // Remove surrounding brackets if present (e.g., "[guid1,guid2]" -> "guid1,guid2")
            const cleaned = groups.replace(/^\[|\]$/g, '').trim();
            return cleaned.split(',').map(g => g.trim());
        }
        return [];
    };

    const allGroups = [
        ...normalizeGroups(cognitoGroups),
        ...normalizeGroups(customGroups),
        ...normalizeGroups(directGroups)
    ];

    // AdminGroupName can be comma-separated (e.g., "MRM-Admins,14b814d8-0051-70ce-abfc-e94bf1852946")
    const adminGroupConfig = process.env.ADMIN_GROUP_NAME || 'MRM-Admins';
    const validAdminGroups = adminGroupConfig.split(',').map(g => g.trim().toLowerCase());

    // Check if user is in any of the valid admin groups (case-insensitive)
    const isAdmin = allGroups.some(userGroup =>
        validAdminGroups.includes(userGroup.toLowerCase())
    );

    if (isAdmin) {
        return true;
    }

    // Final fallback to department check
    const department = cognitoData['custom:department'];
    return department === 'IT' || department === 'Admin';
}

exports.handler = async (event) => {
    console.log('JWT Authorizer called for:', event.methodArn);

    try {
        const token = event.authorizationToken?.replace('Bearer ', '');
        if (!token) {
            throw new Error('No token provided');
        }

        let userData;
        let tokenType = 'ldap';

        // Try to determine token type by checking the payload
        try {
            const [, payloadPart] = token.split('.');
            const decoded = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());

            // Cognito tokens have 'iss' field with cognito-idp
            if (decoded.iss && decoded.iss.includes('cognito-idp')) {
                tokenType = 'cognito';
                userData = validateCognitoToken(token);
                console.log('Cognito token validated for user:', userData.email);
            } else {
                // LDAP token
                userData = await parseJWT(token);
                console.log('LDAP token validated for user:', userData.username);
            }
        } catch (error) {
            // Fallback to LDAP token parsing
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