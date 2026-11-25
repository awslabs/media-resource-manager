// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const crypto = require('crypto');

const lambdaClient = new LambdaClient();
const dynamoDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Just-in-time provisioning of the `mrm-users` DDB record on successful LDAP
 * authentication. Mirrors the pattern Cognito uses for SAML-federated users
 * (record materialises on first sign-in) so admins never need to pre-sync a
 * potentially-huge AD group into DDB just to make users assignable.
 *
 * Idempotent: `createdAt` and manually-editable admin fields (department,
 * preferences) are preserved via `if_not_exists`. LDAP-owned fields (email,
 * firstName, lastName, isAdmin) are refreshed to LDAP truth on every login.
 * `lastLoginAt` is always updated so admins can see who is active.
 *
 * A DDB failure MUST NOT fail authentication - LDAP truth outranks the DDB
 * cache. Log and continue.
 */
async function upsertUserRecord({ username, email, firstName, lastName, isAdmin }) {
  const tableName = process.env.USER_TABLE_NAME;
  if (!tableName) {
    console.warn('USER_TABLE_NAME not configured; skipping JIT user upsert');
    return;
  }
  const now = new Date().toISOString();
  try {
    await dynamoDoc.send(new UpdateCommand({
      TableName: tableName,
      Key: { userId: username },
      UpdateExpression:
        'SET #email = :email, #firstName = :firstName, #lastName = :lastName, ' +
        '#isAdmin = :isAdmin, #lastLoginAt = :now, ' +
        '#createdAt = if_not_exists(#createdAt, :now), ' +
        '#preferences = if_not_exists(#preferences, :emptyMap)',
      ExpressionAttributeNames: {
        '#email': 'email',
        '#firstName': 'firstName',
        '#lastName': 'lastName',
        '#isAdmin': 'isAdmin',
        '#lastLoginAt': 'lastLoginAt',
        '#createdAt': 'createdAt',
        '#preferences': 'preferences',
      },
      ExpressionAttributeValues: {
        ':email': email || '',
        ':firstName': firstName || '',
        ':lastName': lastName || '',
        ':isAdmin': !!isAdmin,
        ':now': now,
        ':emptyMap': {},
      },
    }));
    // Sign-in names are personal data, so log lines in this Lambda never
    // include them.
    console.log(`JIT user record upserted (isAdmin=${!!isAdmin})`);
  } catch (err) {
    // Never fail auth on cache write. Downstream impact is only that the
    // user does not appear in the admin listing until their next sign-in.
    console.warn(`JIT user upsert failed: ${err.name} ${err.message}`);
  }
}

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

// Simple JWT implementation
async function createJWT(payload) {
    const secret = await getJwtSecret();
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret)
        .update(encodedHeader + '.' + encodedPayload)
        .digest('base64url');
    return encodedHeader + '.' + encodedPayload + '.' + signature;
}

/**
 * Admin status from a user's AD attributes. Checks the group attributes and
 * matches each group's CN (parsed from its DN) against the configured admin
 * group name(s). ADMIN_GROUP_NAME is populated from the /Auth/AdminGroupName
 * SSM parameter, seeded from the adminGroupName CDK context / CFN parameter
 * (default "MRM-Admins"). Comma-separated values allow multiple admin groups.
 * "AWS Delegated Administrators" is always honored so that upgrades from AWS
 * Managed Microsoft AD (where that group grants admin by default) keep working
 * even if the operator has not updated adminGroupName. Used at sign-in and on
 * session refresh, so both read admin status the same way.
 */
function adminFromAttributes(attributes) {
  const adminGroupConfig = process.env.ADMIN_GROUP_NAME || 'AWS Delegated Administrators';
  const configuredAdminGroups = adminGroupConfig
    .split(',')
    .map(g => g.trim().toLowerCase())
    .filter(g => g);
  const validAdminGroups = new Set([
    ...configuredAdminGroups,
    'aws delegated administrators',
  ]);
  // DN example: "CN=MRM-Admins,OU=Groups,DC=customer,DC=internal"
  const extractCn = (dn) => {
    const match = /^CN=([^,]+)/i.exec(String(dn));
    return match ? match[1].trim().toLowerCase() : String(dn).trim().toLowerCase();
  };
  let foundGroups = false;
  for (const groupAttr of ['memberOf', 'member', 'groups', 'group']) {
    if (attributes[groupAttr]) {
      const groups = Array.isArray(attributes[groupAttr]) ? attributes[groupAttr] : [attributes[groupAttr]];
      foundGroups = true;
      for (const group of groups) {
        if (validAdminGroups.has(extractCn(group))) {
          return { isAdmin: true, foundGroups, matchedGroup: group };
        }
      }
    }
  }
  return { isAdmin: false, foundGroups, matchedGroup: null };
}

// Direct LDAP authentication with group checking
async function authenticateWithLDAP(username, password) {
    const ldap = require('ldapjs');
    const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

    // Get domain name from SSM Parameter Store
    const ssmClient = new SSMClient();
    let domainName = 'studio.mrm.internal'; // fallback

    try {
        const command = new GetParameterCommand({
            Name: `/${process.env.PASCAL_CASE_NAME}/Identity/ActiveDirectoryDomainName`
            });
            const response = await ssmClient.send(command);
            domainName = response.Parameter.Value;
            console.log('Retrieved domain from SSM:', domainName);
          } catch (error) {
            console.error('Failed to get domain name from SSM, using fallback:', error.message);
          }
          
          return new Promise((resolve) => {
            console.log('Starting LDAP authentication');
            
            const client = ldap.createClient({
              url: `ldap://${domainName}:389`,
              timeout: 10000,
              connectTimeout: 10000,
            });
            
            const userDN = `${username}@${domainName}`;
            
            client.bind(userDN, password, (err) => {
              if (err) {
                console.log('LDAP bind failed:', err.message);
                client.unbind();
                resolve({ success: false });
                return;
              }
              
              console.log('LDAP bind successful, checking groups...');
              
              // Check group membership - construct baseDN from domain name
              const domainParts = domainName.split('.');
              const baseDN = domainParts.map(part => `DC=${part}`).join(',');
              console.log('Using baseDN:', baseDN);
              // Escape RFC 4515 LDAP filter special characters in user-supplied
              // input before interpolating it into the search filter. Without
              // this, a username like "*" or "admin)(cn=*" would change the
              // filter's semantics (CWE-90 LDAP injection). Bind already
              // succeeded above, so this only guards the follow-up attribute
              // lookup, but a malformed or filter-manipulating username could
              // still return unexpected attributes or leak enumeration signal.
              const escapeLdapFilter = (value) => String(value).replace(/[\\*\(\)\0]/g, (c) => {
                switch (c) {
                  case '\\': return '\\5c';
                  case '*':  return '\\2a';
                  case '(':  return '\\28';
                  case ')':  return '\\29';
                  case '\0': return '\\00';
                  default:   return c;
                }
              });
              const searchFilter = `(&(objectClass=user)(sAMAccountName=${escapeLdapFilter(username)}))`;
              
              client.search(baseDN, {
                filter: searchFilter,
                scope: 'sub',
                attributes: ['*'] // Request all attributes to see what's available
              }, (searchErr, searchRes) => {
                let isAdmin = false;
                let displayName = username;
                let email = `${username}@${domainName}`;
                // First/last name are captured from LDAP givenName/sn so the
                // JIT `mrm-users` record has real name fields, not just a
                // display string. Fallback: split `displayName` on the first
                // space if the discrete attributes are not published.
                let firstName = '';
                let lastName = '';
                
                if (searchErr) {
                  console.log('LDAP search failed:', searchErr.message);
                  client.unbind();
                  resolve({ success: true, isAdmin: false, displayName, email, firstName, lastName });
                  return;
                }
                
                searchRes.on('searchEntry', (entry) => {
                  try {
                    console.log('Found user entry, checking attributes...');
                    console.log('Entry type:', typeof entry);
                    console.log('Entry object type:', typeof entry.object);
                    
                    // Try different ways to get attributes
                    let attributes = null;
                    if (entry.object) {
                      attributes = entry.object;
                    } else if (entry.attributes) {
                      // Convert attributes array to object
                      attributes = {};
                      entry.attributes.forEach(attr => {
                        attributes[attr.type] = attr.vals.length === 1 ? attr.vals[0] : attr.vals;
                      });
                    }
                    
                    if (!attributes) {
                      console.log('No attributes found in entry');
                      return;
                    }
                    
                    console.log('All attributes:', Object.keys(attributes));
                    
                    if (attributes.displayName) {
                      displayName = attributes.displayName;
                    }
                    if (attributes.mail) {
                      email = attributes.mail;
                    }
                    if (attributes.cn) {
                      displayName = displayName || attributes.cn;
                    }
                    // Discrete name fields for the JIT user record. Prefer
                    // AD's structured givenName/sn attributes; fall back to
                    // splitting the first non-userId human-looking name we
                    // can find (displayName -> cn -> name). Some accounts
                    // (typically service accounts) have none of these set,
                    // in which case we honestly write empty strings and let
                    // the frontend fall back to userId in the Name column.
                    if (attributes.givenName) firstName = String(attributes.givenName);
                    if (attributes.sn) lastName = String(attributes.sn);
                    if (!firstName && !lastName) {
                      const humanName = [attributes.displayName, attributes.cn, attributes.name]
                        .map((v) => v && String(v).trim())
                        .find((v) => v && v !== username);
                      if (humanName) {
                        const parts = humanName.split(/\s+/);
                        firstName = parts[0] || '';
                        lastName = parts.slice(1).join(' ') || '';
                      }
                    }
                    
                    // Admin status from the user's AD groups (see adminFromAttributes)
                    const adminCheck = adminFromAttributes(attributes);
                    isAdmin = adminCheck.isAdmin;
                    if (adminCheck.matchedGroup) {
                      console.log('User is admin based on group:', adminCheck.matchedGroup);
                    }
                    if (!adminCheck.foundGroups) {
                      console.log('No group attributes found. Available attributes:', Object.keys(attributes));
                    }
                    
                    console.log('Final admin status:', isAdmin);
                  } catch (entryError) {
                    console.log('Error processing entry:', entryError.message);
                  }
                });
                
                searchRes.on('end', () => {
                  console.log('LDAP search completed');
                  client.unbind();
                  resolve({ success: true, isAdmin, displayName, email, firstName, lastName });
                });
                
                searchRes.on('error', (searchError) => {
                  console.log('LDAP search error:', searchError.message);
                  client.unbind();
                  resolve({ success: true, isAdmin: false, displayName, email, firstName, lastName });
                });
              });
            });
            
            client.on('error', (clientError) => {
              console.log('LDAP client error:', clientError.message);
              resolve({ success: false });
            });
            
            // Timeout fallback
            setTimeout(() => {
              console.log('LDAP timeout');
              try { client.unbind(); } catch (e) {}
              resolve({ success: false });
            }, 15000);
          });
        }
        
        // Upper bounds for sign-in input. AD itself limits sAMAccountName to
        // 20 characters and passwords to 256; these caps only bound the request.
        const MAX_RAW_USERNAME_LENGTH = 512;
        const MAX_USERNAME_LENGTH = 64;
        const MAX_PASSWORD_LENGTH = 1024;
        // Characters AD does not allow in a sAMAccountName, plus '@' (one left
        // after normalisation means a malformed name) and control characters.
        const INVALID_USERNAME_CHARS = /["/\\[\]:;|=,+*?<>@\x00-\x1f\x7f]/;

        /**
         * Parse and validate a sign-in request body. Returns
         * { username, password } or null when the request is not a JSON object
         * with a usable string username and password. Callers answer null with
         * the same generic 400, so the response gives no hint which check failed.
         *
         * Normalises UPN ("user@domain.tld") and down-level ("DOMAIN\user")
         * forms into a bare sAMAccountName. The LDAP search filter binds on
         * sAMAccountName only, so the non-canonical forms would otherwise
         * silently fail to match despite being valid AD identifiers. The
         * frontend also strips defensively; doing it here covers direct API
         * callers and the change-password Lambda's direct invoke too.
         */
        function parseSignInRequest(event) {
          let body;
          try {
            body = JSON.parse(event.body || '{}');
          } catch (e) {
            return null;
          }
          if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
          const { username: rawUsername, password } = body;
          const isString = (value) => typeof value === 'string';
          if (!isString(rawUsername) || !isString(password)) return null;
          if (rawUsername.length > MAX_RAW_USERNAME_LENGTH) return null;
          const username = rawUsername.trim().replace(/^[^\\]+\\/, '').replace(/@.+$/, '');
          if (!username || username.length > MAX_USERNAME_LENGTH || INVALID_USERNAME_CHARS.test(username)) return null;
          if (!password || password.length > MAX_PASSWORD_LENGTH) return null;
          return { username, password };
        }


        // ─── Session refresh (POST /auth/ldap/refresh) ────────────────────────
        // A signed-in AD session renews its 1-hour token without the password:
        // the current token must verify (HS256 with the MRM secret, unexpired),
        // the user must still exist and be enabled in AD (read with the AD
        // service account), and admin status is re-read from the user's groups.

        /** Lifetime of every token this Lambda issues. */
        const TOKEN_LIFETIME_SECONDS = 3600;
        /**
         * Absolute session cap: a session can be refreshed for at most 12 hours
         * after sign-in (the token's auth_time). Then the user signs in again.
         */
        const SESSION_MAX_SECONDS = 12 * 3600;
        /** Clock skew allowed on iat and auth_time. */
        const CLOCK_SKEW_SECONDS = 60;

        const REFRESH_HEADERS = {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization'
        };

        function refreshResponse(statusCode, body) {
          return { statusCode, headers: REFRESH_HEADERS, body: JSON.stringify(body) };
        }

        /** Reasons a refresh is refused. Logged and returned as codes only. */
        class RefreshRefused extends Error {
          constructor(code, statusCode = 401) {
            super(code);
            this.code = code;
            this.statusCode = statusCode;
          }
        }

        const decodeSegment = (segment) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
        const isWholeNumber = (v) => typeof v === 'number' && Number.isInteger(v);

        /**
         * Verify an MRM AD session token. Only the exact header this Lambda
         * writes is accepted ({"alg":"HS256","typ":"JWT"}), so alg:none,
         * RS256/HS256 confusion and other algorithms are refused before the
         * signature check. The HMAC is compared in constant time, then the
         * claims are checked. Returns the claims or throws RefreshRefused.
         */
        async function verifySessionToken(token, nowSeconds) {
          if (typeof token !== 'string' || token.length > 4096) throw new RefreshRefused('malformed');
          const parts = token.split('.');
          if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new RefreshRefused('malformed');
          const [encodedHeader, encodedPayload, signature] = parts;

          let header;
          let claims;
          try {
            header = decodeSegment(encodedHeader);
            claims = decodeSegment(encodedPayload);
          } catch (e) {
            throw new RefreshRefused('malformed');
          }
          if (!header || typeof header !== 'object' || Object.keys(header).length !== 2 ||
              header.alg !== 'HS256' || header.typ !== 'JWT') {
            throw new RefreshRefused('bad_header');
          }

          const secret = await getJwtSecret();
          const expected = crypto.createHmac('sha256', secret)
            .update(encodedHeader + '.' + encodedPayload)
            .digest();
          const provided = Buffer.from(signature, 'base64url');
          if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
            throw new RefreshRefused('bad_signature');
          }

          if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new RefreshRefused('bad_claims');
          if (!isWholeNumber(claims.exp) || claims.exp <= nowSeconds) throw new RefreshRefused('expired');
          if (!isWholeNumber(claims.iat) || claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new RefreshRefused('bad_claims');
          const username = typeof claims.username === 'string' ? claims.username : '';
          if (!username || username.length > MAX_USERNAME_LENGTH || INVALID_USERNAME_CHARS.test(username)) {
            throw new RefreshRefused('bad_claims');
          }
          // Tokens issued before session refresh existed carry no auth_time:
          // they can't be refreshed, so those users sign in again once.
          if (!isWholeNumber(claims.auth_time)) throw new RefreshRefused('no_auth_time');
          if (claims.auth_time > nowSeconds + CLOCK_SKEW_SECONDS || claims.auth_time > claims.iat + CLOCK_SKEW_SECONDS) {
            throw new RefreshRefused('bad_claims');
          }
          // Past the cap, or the token already lasts until it: nothing to extend.
          if (nowSeconds - claims.auth_time >= SESSION_MAX_SECONDS ||
              claims.exp >= claims.auth_time + SESSION_MAX_SECONDS) {
            throw new RefreshRefused('session_cap');
          }
          return claims;
        }

        // userAccountControl ACCOUNTDISABLE bit
        const UAC_ACCOUNTDISABLE = 0x2;
        // accountExpires: 100-ns intervals since 1601-01-01; 0 and 2^63-1 mean never
        const ACCOUNT_NEVER_EXPIRES = [0n, 9223372036854775807n];
        const FILETIME_EPOCH_OFFSET_SECONDS = 11644473600n;

        function accountExpired(value, nowSeconds) {
          if (value === undefined || value === null || value === '') return false;
          let ticks;
          try { ticks = BigInt(String(value)); } catch (e) { return true; }
          if (ACCOUNT_NEVER_EXPIRES.includes(ticks)) return false;
          return ticks / 10000000n - FILETIME_EPOCH_OFFSET_SECONDS <= BigInt(nowSeconds);
        }

        /** The AD service account's {username, password} from Secrets Manager. */
        async function getServiceAccount() {
          const client = new SecretsManagerClient();
          const response = await client.send(new GetSecretValueCommand({
            SecretId: process.env.AD_SERVICE_ACCOUNT_SECRET_ARN
          }));
          const parsed = JSON.parse(response.SecretString || '{}');
          if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
            throw new Error('AD service-account secret has no username and password');
          }
          return parsed;
        }

        /**
         * Read the user's current AD record with the service account.
         * Resolves to { found, disabled, expired, isAdmin, email, firstName,
         * lastName }. Rejects when AD can't be reached or queried.
         */
        async function lookupUserInAD(username, nowSeconds) {
          const ldap = require('ldapjs');
          const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
          const domain = (await new SSMClient().send(new GetParameterCommand({
            Name: `/${process.env.PASCAL_CASE_NAME}/Identity/ActiveDirectoryDomainName`
          }))).Parameter.Value;
          const serviceAccount = await getServiceAccount();
          const bindName = /[@\\]/.test(serviceAccount.username) ? serviceAccount.username : `${serviceAccount.username}@${domain}`;
          const baseDN = domain.split('.').map((part) => `DC=${part}`).join(',');
          const escapeLdapFilter = (value) => String(value).replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));

          return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              try { client.unbind(); } catch (e) { /* already closed */ }
              fn(value);
            };
            const client = ldap.createClient({ url: `ldap://${domain}:389`, timeout: 10000, connectTimeout: 10000 });
            const timer = setTimeout(() => finish(reject, new Error('LDAP timeout')), 15000);
            client.on('error', (err) => finish(reject, err));
            client.bind(bindName, serviceAccount.password, (bindErr) => {
              if (bindErr) return finish(reject, new Error('Service-account bind failed'));
              client.search(baseDN, {
                filter: `(&(objectClass=user)(sAMAccountName=${escapeLdapFilter(username)}))`,
                scope: 'sub',
                attributes: ['userAccountControl', 'accountExpires', 'memberOf', 'mail', 'givenName', 'sn', 'displayName', 'cn', 'name']
              }, (searchErr, res) => {
                if (searchErr) return finish(reject, searchErr);
                const entries = [];
                res.on('searchEntry', (entry) => {
                  let attributes = entry.object || null;
                  if (!attributes && entry.attributes) {
                    attributes = {};
                    entry.attributes.forEach((attr) => {
                      attributes[attr.type] = attr.vals.length === 1 ? attr.vals[0] : attr.vals;
                    });
                  }
                  if (attributes) entries.push(attributes);
                });
                res.on('error', (err) => finish(reject, err));
                res.on('end', () => {
                  if (entries.length !== 1) return finish(resolve, { found: false });
                  const a = entries[0];
                  const uac = Number.parseInt(String(a.userAccountControl ?? ''), 10);
                  finish(resolve, {
                    found: true,
                    // An unreadable userAccountControl counts as disabled.
                    disabled: !Number.isFinite(uac) || (uac & UAC_ACCOUNTDISABLE) !== 0,
                    expired: accountExpired(a.accountExpires, nowSeconds),
                    isAdmin: adminFromAttributes(a).isAdmin,
                    email: a.mail ? String(a.mail) : '',
                    firstName: a.givenName ? String(a.givenName) : '',
                    lastName: a.sn ? String(a.sn) : '',
                  });
                });
              });
            });
          });
        }

        async function handleRefresh(event) {
          const nowSeconds = Math.floor(Date.now() / 1000);
          const headers = (event && event.headers) || {};
          const authorization = headers.Authorization || headers.authorization || '';
          const match = /^Bearer ([^\s]+)$/.exec(String(authorization));
          try {
            if (!match) throw new RefreshRefused('no_token');
            const claims = await verifySessionToken(match[1], nowSeconds);

            let account;
            try {
              account = await lookupUserInAD(claims.username, nowSeconds);
            } catch (lookupError) {
              console.error('LDAP session refresh: directory lookup failed:', lookupError && lookupError.name, lookupError && lookupError.message);
              return refreshResponse(503, { error: 'Directory unavailable, try again' });
            }
            if (!account.found) throw new RefreshRefused('user_not_found');
            if (account.disabled) throw new RefreshRefused('user_disabled');
            if (account.expired) throw new RefreshRefused('user_expired');

            const payload = {
              username: claims.username,
              email: account.email || claims.email,
              given_name: account.firstName || claims.given_name,
              family_name: account.lastName || claims.family_name || '',
              isAdmin: account.isAdmin,
              iat: nowSeconds,
              auth_time: claims.auth_time,
              // The session ends at the cap, even if the last token would outlive it.
              exp: Math.min(nowSeconds + TOKEN_LIFETIME_SECONDS, claims.auth_time + SESSION_MAX_SECONDS),
            };
            const token = await createJWT(payload);
            console.log(`LDAP session refreshed (isAdmin=${payload.isAdmin})`);
            return refreshResponse(200, { success: true, token });
          } catch (error) {
            if (error instanceof RefreshRefused) {
              console.log('LDAP session refresh refused:', error.code);
              return refreshResponse(error.statusCode, { error: 'Session can not be refreshed. Sign in again.' });
            }
            console.error('LDAP session refresh error:', error && error.name, error && error.message);
            return refreshResponse(500, { error: 'Internal server error' });
          }
        }

        const isRefreshRequest = (event) => !!event &&
          (event.resource === '/auth/ldap/refresh' || /\/auth\/ldap\/refresh$/.test(String(event.path || '')));

        exports.handler = async (event) => {
          if (isRefreshRequest(event)) return handleRefresh(event);
          const request = parseSignInRequest(event || {});
          if (request) {
            console.log('Direct LDAP Auth request received');
          } else {
            console.log('Direct LDAP Auth request rejected: invalid request body');
          }

          if (!request) {
            return {
              statusCode: 400,
              headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Allow-Headers': 'Content-Type'
              },
              body: JSON.stringify({ error: 'Username and password required' })
            };
          }
          const { username, password } = request;
          
          try {
            // Use direct LDAP authentication with group checking
            const ldapResult = await authenticateWithLDAP(username, password);
            
            if (ldapResult.success) {
              // JIT-provision the mrm-users DDB record so this user appears
              // in the admin listing and can be assigned to workstations. Runs
              // before the JWT is minted but never fails auth - see
              // upsertUserRecord() for the "log and continue" contract.
              await upsertUserRecord({
                username,
                email: ldapResult.email,
                firstName: ldapResult.firstName,
                lastName: ldapResult.lastName,
                isAdmin: ldapResult.isAdmin,
              });

              // Create JWT token with proper admin status from AD groups
              const payload = {
                username: username,
                email: ldapResult.email || username + '@studio.mcs.internal',
                given_name: ldapResult.firstName || ldapResult.displayName || username,
                family_name: ldapResult.lastName || '',
                isAdmin: ldapResult.isAdmin || false,
                iat: Math.floor(Date.now() / 1000),
                // Sign-in time, carried by every refreshed token for the 12-hour cap
                auth_time: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS // 1 hour
              };
              
              const token = await createJWT(payload);
              
              return {
                statusCode: 200,
                headers: { 
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*',
                  'Access-Control-Allow-Headers': 'Content-Type'
                },
                body: JSON.stringify({ 
                  success: true, 
                  message: 'LDAP authentication successful',
                  username: username,
                  token: token
                })
              };
            } else {
              return {
                statusCode: 401,
                headers: { 
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*',
                  'Access-Control-Allow-Credentials': 'true',
                  'Access-Control-Allow-Headers': 'Content-Type'
                },
                body: JSON.stringify({ error: 'Invalid credentials' })
              };
            }
          } catch (error) {
            console.error('Authentication error:', error && error.name, error && error.message);
            return {
              statusCode: 500,
              headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Allow-Headers': 'Content-Type'
              },
              body: JSON.stringify({ error: 'Internal server error' })
            };
          }
        };
// Exported for unit tests. Not part of the runtime contract.
exports.SESSION_MAX_SECONDS = SESSION_MAX_SECONDS;
