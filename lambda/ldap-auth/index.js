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
    console.log(`JIT user record upserted for ${username} (isAdmin=${!!isAdmin})`);
  } catch (err) {
    // Never fail auth on cache write. Downstream impact is only that the
    // user does not appear in the admin listing until their next sign-in.
    console.warn(`JIT user upsert failed for ${username}: ${err.name} ${err.message}`);
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
            console.log('Starting LDAP authentication for:', username);
            
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
                      console.log('Display name:', displayName);
                    }
                    if (attributes.mail) {
                      email = attributes.mail;
                      console.log('Email:', email);
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
                    
                    // Check multiple possible group attributes and match each
                    // group's CN (parsed from its DN) against the configured
                    // admin group name(s). ADMIN_GROUP_NAME is populated from
                    // the /Auth/AdminGroupName SSM parameter, seeded from the
                    // adminGroupName CDK context / CFN parameter (default
                    // "MRM-Admins"). Comma-separated values allow multiple
                    // admin groups. "AWS Delegated Administrators" is always
                    // honored so that upgrades from AWS Managed Microsoft AD
                    // (where that group grants admin by default) keep working
                    // even if the operator has not updated adminGroupName.
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
                    const groupAttributes = ['memberOf', 'member', 'groups', 'group'];
                    let foundGroups = false;
                    let matchedAdminGroup = null;

                    for (const groupAttr of groupAttributes) {
                      if (attributes[groupAttr]) {
                        const groups = Array.isArray(attributes[groupAttr]) ? attributes[groupAttr] : [attributes[groupAttr]];
                        console.log('Found groups in', '"' + groupAttr + '":', groups);
                        foundGroups = true;

                        for (const group of groups) {
                          const cn = extractCn(group);
                          if (validAdminGroups.has(cn)) {
                            isAdmin = true;
                            matchedAdminGroup = group;
                            break;
                          }
                        }

                        if (isAdmin) {
                          console.log('User is admin based on group:', matchedAdminGroup);
                          break;
                        }
                      }
                    }
                    console.log('Configured admin groups:', Array.from(validAdminGroups));
                    
                    if (!foundGroups) {
                      console.log('No group attributes found. Available attributes:', Object.keys(attributes));
                    }
                    
                    console.log('Final admin status:', isAdmin);
                  } catch (entryError) {
                    console.log('Error processing entry:', entryError.message);
                    console.log('Entry structure:', JSON.stringify(entry, null, 2));
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
        
        exports.handler = async (event) => {
          const rawBody = JSON.parse(event.body || '{}');
          // Normalise UPN ("user@domain.tld") and down-level ("DOMAIN\user")
          // forms into a bare sAMAccountName. The LDAP search filter below
          // binds on sAMAccountName only, so the non-canonical forms would
          // otherwise silently fail to match despite being valid AD
          // identifiers. Frontend also strips defensively; doing it here
          // covers direct API callers (curl, integration tests, other
          // clients) too.
          const rawUsername = rawBody.username;
          const username = typeof rawUsername === 'string'
            ? rawUsername.trim().replace(/^[^\\]+\\/, '').replace(/@.+$/, '')
            : rawUsername;
          const password = rawBody.password;
          console.log('Direct LDAP Auth request for user:', username, rawUsername !== username ? `(normalised from "${rawUsername}")` : '');

          if (!username || !password) {
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
                exp: Math.floor(Date.now() / 1000) + 3600 // 1 hour
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
            console.error('Authentication error:', error);
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