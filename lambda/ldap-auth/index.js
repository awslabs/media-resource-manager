// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const crypto = require('crypto');

const lambdaClient = new LambdaClient();

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
              url: `ldap://\${domainName}:389`,
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
              const searchFilter = `(&(objectClass=user)(sAMAccountName=${username}))`;
              
              client.search(baseDN, {
                filter: searchFilter,
                scope: 'sub',
                attributes: ['*'] // Request all attributes to see what's available
              }, (searchErr, searchRes) => {
                let isAdmin = false;
                let displayName = username;
                let email = `${username}@${domainName}`;
                
                if (searchErr) {
                  console.log('LDAP search failed:', searchErr.message);
                  client.unbind();
                  resolve({ success: true, isAdmin: false, displayName, email });
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
                    
                    // Check multiple possible group attributes
                    const groupAttributes = ['memberOf', 'member', 'groups', 'group'];
                    let foundGroups = false;
                    
                    for (const groupAttr of groupAttributes) {
                      if (attributes[groupAttr]) {
                        const groups = Array.isArray(attributes[groupAttr]) ? attributes[groupAttr] : [attributes[groupAttr]];
                        console.log('Found groups in', '"' + groupAttr + '":', groups);
                        foundGroups = true;
                        
                        isAdmin = groups.some(group => {
                          const groupLower = group.toLowerCase();
                          return groupLower.includes('aws delegated administrators') ||
                                 groupLower.includes('aws-delegated-administrators') ||
                                 groupLower.includes('awsdelegatedadministrators');
                        });
                        
                        if (isAdmin) {
                          console.log('User is admin based on group:', groups.find(g => 
                            g.toLowerCase().includes('aws') && g.toLowerCase().includes('admin')
                          ));
                          break;
                        }
                      }
                    }
                    
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
                  resolve({ success: true, isAdmin, displayName, email });
                });
                
                searchRes.on('error', (searchError) => {
                  console.log('LDAP search error:', searchError.message);
                  client.unbind();
                  resolve({ success: true, isAdmin: false, displayName, email });
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
          console.log('Direct LDAP Auth request for user:', JSON.parse(event.body || '{}').username);
          
          const { username, password } = JSON.parse(event.body || '{}');
          
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
              // Create JWT token with proper admin status from AD groups
              const payload = {
                username: username,
                email: ldapResult.email || username + '@studio.mcs.internal',
                given_name: ldapResult.displayName || username,
                family_name: '',
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