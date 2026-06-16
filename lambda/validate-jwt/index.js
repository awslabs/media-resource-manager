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
