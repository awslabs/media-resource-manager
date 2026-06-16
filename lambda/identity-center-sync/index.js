// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Identity Center User Sync Lambda
 * 
 * Syncs users from AWS Identity Center to the local DynamoDB users table.
 * Can sync all users or users from configured groups.
 */

const { IdentitystoreClient, ListUsersCommand, ListGroupMembershipsCommand, DescribeUserCommand, ListGroupsCommand } = require('@aws-sdk/client-identitystore');
const { SSOAdminClient, ListInstancesCommand } = require('@aws-sdk/client-sso-admin');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const identitystore = new IdentitystoreClient({});
const ssoAdmin = new SSOAdminClient({});
const ssm = new SSMClient({});
const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

// Helper to get Identity Store ID from SSM
async function getIdentityStoreIdFromSSM() {
  try {
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    const result = await ssm.send(new GetParameterCommand({
      Name: `/${pascalCaseName}/Identity/IdentityStoreId`
    }));
    return result.Parameter?.Value;
  } catch (error) {
    console.log('Identity Store ID not found in SSM:', error.message);
    return null;
  }
}

// Helper to get configured sync groups from SSM
async function getSyncGroupsFromSSM() {
  try {
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    const result = await ssm.send(new GetParameterCommand({
      Name: `/${pascalCaseName}/Identity/SyncGroups`
    }));
    const value = result.Parameter?.Value;
    if (value) {
      // Parse comma-separated group IDs
      return value.split(',').map(g => g.trim()).filter(g => g.length > 0);
    }
    return [];
  } catch (error) {
    console.log('Sync groups not configured in SSM:', error.message);
    return [];
  }
}

exports.handler = async (event) => {
  console.log('Identity Center Sync triggered:', JSON.stringify(event, null, 2));
  
  const { httpMethod, body } = event;
  
  if (httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  
  try {
    const requestBody = body ? JSON.parse(body) : {};
    const { groupIds: providedGroupIds, identityStoreId: providedIdentityStoreId } = requestBody;
    
    // Get Identity Store ID (priority: request > env var > SSM > auto-discover)
    let identityStoreId = providedIdentityStoreId || process.env.IDENTITY_STORE_ID;
    
    if (!identityStoreId) {
      // Try SSM parameter (set by setup script)
      identityStoreId = await getIdentityStoreIdFromSSM();
    }
    
    if (!identityStoreId) {
      // Auto-discover Identity Store ID from SSO instance (same-account only)
      console.log('Auto-discovering Identity Store ID...');
      try {
        const instancesResponse = await ssoAdmin.send(new ListInstancesCommand({}));
        const instance = instancesResponse.Instances?.[0];
        if (instance) {
          identityStoreId = instance.IdentityStoreId;
          console.log(`Found Identity Store ID: ${identityStoreId}`);
        }
      } catch (error) {
        console.log('Could not auto-discover Identity Store ID:', error.message);
      }
    }
    
    if (!identityStoreId) {
      throw new Error('No Identity Center instance found. For cross-account deployments, please configure the Identity Store ID in SSM parameter: /{PascalCaseName}/Identity/IdentityStoreId');
    }
    
    console.log(`Using Identity Store ID: ${identityStoreId}`);
    
    // Determine which groups to sync from (priority: request > SSM config > all users)
    let groupIdentifiers = providedGroupIds || [];
    
    if (groupIdentifiers.length === 0) {
      // Check SSM for configured sync groups
      groupIdentifiers = await getSyncGroupsFromSSM();
    }
    
    let usersToSync = [];
    let resolvedGroupIds = [];
    
    if (groupIdentifiers.length > 0) {
      // Resolve group names to IDs if needed
      resolvedGroupIds = await resolveGroupIdentifiers(identityStoreId, groupIdentifiers);
      
      if (resolvedGroupIds.length === 0) {
        throw new Error(`Could not resolve any of the configured groups: ${groupIdentifiers.join(', ')}`);
      }
      
      console.log(`Syncing users from ${resolvedGroupIds.length} group(s): ${resolvedGroupIds.join(', ')}`);
      
      // Collect users from all groups (deduplicate by userId)
      const userMap = new Map();
      for (const groupId of resolvedGroupIds) {
        try {
          const groupUsers = await getUsersFromGroup(identityStoreId, groupId);
          console.log(`Found ${groupUsers.length} users in group ${groupId}`);
          for (const user of groupUsers) {
            if (!userMap.has(user.userId)) {
              userMap.set(user.userId, user);
            }
          }
        } catch (error) {
          console.error('Error fetching users from group', groupId + ':', error.message);
        }
      }
      usersToSync = Array.from(userMap.values());
    } else {
      // No groups configured - sync all users
      console.log('No sync groups configured - syncing all users from Identity Center');
      usersToSync = await getAllUsers(identityStoreId);
    }
    
    console.log(`Found ${usersToSync.length} unique users to sync`);
    
    // Sync users to DynamoDB
    const results = await syncUsersToDynamoDB(usersToSync);
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        message: `Successfully synced ${results.synced} users`,
        synced: results.synced,
        skipped: results.skipped,
        errors: results.errors,
        groupsSynced: resolvedGroupIds.length > 0 ? resolvedGroupIds : ['all']
      })
    };
    
  } catch (error) {
    console.error('Sync error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: error.message })
    };
  }
};

// Resolve group identifiers (names or IDs) to group IDs
async function resolveGroupIdentifiers(identityStoreId, identifiers) {
  const resolvedIds = [];
  
  // First, get all groups to build a name->ID map
  const allGroups = await listAllGroups(identityStoreId);
  const groupNameToId = new Map();
  const validGroupIds = new Set();
  
  for (const group of allGroups) {
    groupNameToId.set(group.displayName.toLowerCase(), group.groupId);
    validGroupIds.add(group.groupId);
  }
  
  console.log(`Found ${allGroups.length} groups in Identity Center`);
  
  for (const identifier of identifiers) {
    // Check if it's already a valid group ID
    if (validGroupIds.has(identifier)) {
      resolvedIds.push(identifier);
      console.log(`Resolved group ID: ${identifier}`);
    } else {
      // Try to resolve as a group name (case-insensitive)
      const groupId = groupNameToId.get(identifier.toLowerCase());
      if (groupId) {
        resolvedIds.push(groupId);
        console.log(`Resolved group name "${identifier}" to ID: ${groupId}`);
      } else {
        console.warn(`Could not resolve group: ${identifier}`);
      }
    }
  }
  
  return resolvedIds;
}

// List all groups in Identity Center
async function listAllGroups(identityStoreId) {
  const groups = [];
  let nextToken;
  
  do {
    const response = await identitystore.send(new ListGroupsCommand({
      IdentityStoreId: identityStoreId,
      MaxResults: 100,
      NextToken: nextToken
    }));
    
    for (const group of response.Groups || []) {
      groups.push({
        groupId: group.GroupId,
        displayName: group.DisplayName,
        description: group.Description
      });
    }
    
    nextToken = response.NextToken;
  } while (nextToken);
  
  return groups;
}

async function getAllUsers(identityStoreId) {
  const users = [];
  let nextToken;
  
  do {
    const response = await identitystore.send(new ListUsersCommand({
      IdentityStoreId: identityStoreId,
      MaxResults: 100,
      NextToken: nextToken
    }));
    
    for (const user of response.Users || []) {
      users.push(formatUser(user));
    }
    
    nextToken = response.NextToken;
  } while (nextToken);
  
  return users;
}

async function getUsersFromGroup(identityStoreId, groupId) {
  const users = [];
  let nextToken;
  
  do {
    const response = await identitystore.send(new ListGroupMembershipsCommand({
      IdentityStoreId: identityStoreId,
      GroupId: groupId,
      MaxResults: 100,
      NextToken: nextToken
    }));
    
    // Get full user details for each membership
    for (const membership of response.GroupMemberships || []) {
      if (membership.MemberId?.UserId) {
        try {
          const userResponse = await identitystore.send(new DescribeUserCommand({
            IdentityStoreId: identityStoreId,
            UserId: membership.MemberId.UserId
          }));
          users.push(formatUser(userResponse));
        } catch (error) {
          console.warn('Could not get user', membership.MemberId.UserId + ':', error.message);
        }
      }
    }
    
    nextToken = response.NextToken;
  } while (nextToken);
  
  return users;
}

function formatUser(user) {
  // Extract email from Emails array
  const primaryEmail = user.Emails?.find(e => e.Primary)?.Value || user.Emails?.[0]?.Value || '';
  
  // Get name parts
  const firstName = user.Name?.GivenName || '';
  const lastName = user.Name?.FamilyName || '';
  
  // Use email as userId (this matches how Cognito federated users are identified)
  const userId = primaryEmail || user.UserName || user.UserId;
  
  return {
    userId,
    email: primaryEmail,
    firstName,
    lastName,
    displayName: user.DisplayName || `${firstName} ${lastName}`.trim(),
    userName: user.UserName,
    identityCenterUserId: user.UserId,
    source: 'identity-center'
  };
}

async function syncUsersToDynamoDB(users) {
  const tableName = process.env.USER_TABLE_NAME;
  let synced = 0;
  let skipped = 0;
  const errors = [];
  
  for (const user of users) {
    if (!user.userId) {
      console.warn('Skipping user without userId:', user);
      skipped++;
      continue;
    }
    
    try {
      await dynamodb.send(new PutCommand({
        TableName: tableName,
        Item: {
          userId: user.userId,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          displayName: user.displayName,
          userName: user.userName,
          identityCenterUserId: user.identityCenterUserId,
          source: user.source,
          isAdmin: false,
          isEnabled: true,
          syncedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        // Only update if the record doesn't exist or is from identity-center sync
        ConditionExpression: 'attribute_not_exists(userId) OR #source = :source',
        ExpressionAttributeNames: { '#source': 'source' },
        ExpressionAttributeValues: { ':source': 'identity-center' }
      }));
      synced++;
      console.log(`Synced user: ${user.userId}`);
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') {
        // User exists and was manually created - don't overwrite
        console.log(`Skipping existing manual user: ${user.userId}`);
        skipped++;
      } else {
        console.error('Error syncing user', user.userId + ':', error.message);
        errors.push({ userId: user.userId, error: error.message });
      }
    }
  }
  
  return { synced, skipped, errors };
}
