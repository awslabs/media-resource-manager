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

    // Constant-time comparison to close a signature-oracle timing side channel.
    const providedBuf = Buffer.from(signature || '', 'base64url');
    const expectedBuf = Buffer.from(expectedSignature, 'base64url');
    if (providedBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      throw new Error('Invalid signature');
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());

    // Reject tokens missing exp — the previous check treated undefined < now
    // as false and accepted the token. Even though signature verification
    // already blocks unauthenticated forgeries, this defends against a
    // seed-secret-only compromise where an attacker with the HMAC secret
    // could otherwise mint tokens with no expiration.
    if (typeof decoded.exp !== 'number' || decoded.exp < Math.floor(Date.now() / 1000)) {
      throw new Error('Token expired');
    }

    return decoded;
  } catch (error) {
    throw new Error('Invalid token');
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      cookies[name] = value;
    });
  }
  return cookies;
}

exports.handler = async (event) => {
  try {
    const cookies = parseCookies(event.headers.Cookie || event.headers.cookie);
    const token = cookies['auth-token'];
    
    if (!token) {
      return {
        statusCode: 401,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': 'true'
        },
        body: JSON.stringify({ error: 'No auth token' })
      };
    }
    
    const userData = await parseJWT(token);
    
    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true'
      },
      body: JSON.stringify({
        username: userData.username,
        attributes: {
          email: userData.email,
          given_name: userData.given_name,
          family_name: userData.family_name,
          'custom:isAdmin': userData.isAdmin ? 'true' : 'false'
        }
      })
    };
  } catch (error) {
    return {
      statusCode: 401,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true'
      },
      body: JSON.stringify({ error: 'Invalid token' })
    };
  }
};
