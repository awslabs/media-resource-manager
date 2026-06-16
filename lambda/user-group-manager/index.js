// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { DirectoryServiceClient, DescribeDirectoriesCommand, ResetUserPasswordCommand } = require('@aws-sdk/client-directory-service');
const { DirectoryServiceDataClient, CreateUserCommand, UpdateUserCommand, DisableUserCommand, DeleteUserCommand, AddGroupMemberCommand, CreateGroupCommand, ListGroupMembersCommand, RemoveGroupMemberCommand, DescribeUserCommand, DeleteGroupCommand, UpdateGroupCommand } = require('@aws-sdk/client-directory-service-data');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { CognitoIdentityProviderClient, ListUsersCommand, AdminListGroupsForUserCommand } = require('@aws-sdk/client-cognito-identity-provider');
const crypto = require('crypto');

const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const directoryService = new DirectoryServiceClient({});
const directoryServiceData = new DirectoryServiceDataClient({});
const ssm = new SSMClient({});
const cognitoClient = new CognitoIdentityProviderClient({});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

exports.handler = async (event) => {
  const { httpMethod, path, body, queryStringParameters, pathParameters } = event;
  
  console.log(`Event received: {"httpMethod":"${httpMethod}","path":"${path}","pathParameters":${JSON.stringify(pathParameters)},"queryStringParameters":${JSON.stringify(queryStringParameters)},"body":"${body ? 'present' : 'missing'}"}`);

  try {
    if (httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: ''
      };
    }
    
    switch (httpMethod) {
      case 'GET':
        if (path === '/users') {
          return await getUsers(event);
        } else if (path === '/groups') {
          const queryParams = queryStringParameters || {};
          if (queryParams.userId) {
            console.log(`Getting groups for user: ${queryParams.userId}`);
            return await getUserGroups(queryParams.userId);
          }
          return await getGroups(event);
        } else if (path.startsWith('/groups/')) {
          const groupId = pathParameters?.groupId || path.split('/')[2];
          return await getGroupById(groupId);
        } else if (path.match(/^\/users\/[^/]+\/schedule$/)) {
          // GET /users/{userId}/schedule
          const userId = decodeURIComponent(pathParameters?.id || path.split('/')[2]);
          return await getUserSchedule(userId);
        }
        break;
        
      case 'POST':
        if (path === '/users') {
          const queryParams = event.queryStringParameters || {};
          const requestBody = body ? JSON.parse(body) : {};
          
          // Check for removeFromGroups action - support both query string and request body
          if (queryParams.action === 'removeFromGroups' && queryParams.userId) {
            return await removeUserFromGroups(queryParams.userId, requestBody);
          }
          if (requestBody.action === 'removeFromGroups' && requestBody.userId) {
            return await removeUserFromGroups(requestBody.userId, requestBody);
          }
          
          if (requestBody.userIds && requestBody.groupIds) {
            return await assignUsersToGroups(requestBody);
          } else {
            return await createUser(requestBody);
          }
        } else if (path === '/users/disable') {
          return await disableUsers(JSON.parse(body));
        } else if (path === '/users/enable') {
          return await enableUsers(JSON.parse(body));
        } else if (path === '/users/delete') {
          return await deleteUsers(JSON.parse(body));
        } else if (path === '/groups') {
          return await createGroup(JSON.parse(body));
        }
        break;
        
      case 'PUT':
        if (path.startsWith('/groups/')) {
          const groupId = pathParameters?.groupId || path.split('/')[2];
          return await updateGroup(groupId, JSON.parse(body));
        } else if (path.match(/^\/users\/[^/]+\/schedule$/)) {
          // PUT /users/{userId}/schedule
          const userId = decodeURIComponent(pathParameters?.id || path.split('/')[2]);
          return await updateUserSchedule(userId, JSON.parse(body), event);
        }
        break;
        
      case 'DELETE':
        if (path.startsWith('/groups/')) {
          // Try pathParameters first, then fallback to path parsing
          const groupId = pathParameters?.groupId || path.split('/')[2];
          return await deleteGroup(groupId);
        } else if (path.match(/^\/users\/[^/]+\/schedule$/)) {
          // DELETE /users/{userId}/schedule
          const userId = decodeURIComponent(pathParameters?.id || path.split('/')[2]);
          return await deleteUserSchedule(userId, event);
        }
        break;
    }
    
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Not found' })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

async function getDirectoryId() {
  try {
    // Get pascal case name from environment variable
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    const parameterName = `/${pascalCaseName}/Identity/ActiveDirectoryId`;
    const result = await ssm.send(new GetParameterCommand({
      Name: parameterName
    }));
    return result.Parameter.Value;
  } catch (error) {
    console.log('SSM parameter not found, discovering directory from Directory Service');
    const result = await directoryService.send(new DescribeDirectoriesCommand({}));
    if (result.DirectoryDescriptions && result.DirectoryDescriptions.length > 0) {
      return result.DirectoryDescriptions[0].DirectoryId;
    }
    throw new Error('No directory found');
  }
}

// Helper function to check if Cognito auth mode is enabled
async function getUseCognitoAuth() {
  try {
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    const parameterName = `/${pascalCaseName}/Auth/UseCognitoAuth`;
    const result = await ssm.send(new GetParameterCommand({
      Name: parameterName
    }));
    return result.Parameter.Value === 'true';
  } catch (error) {
    console.log('UseCognitoAuth parameter not found, defaulting to false (LDAP mode)');
    return false;
  }
}

// Helper function to get Cognito User Pool ID
async function getCognitoUserPoolId() {
  try {
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    const parameterName = `/${pascalCaseName}/Auth/UserPoolId`;
    const result = await ssm.send(new GetParameterCommand({
      Name: parameterName
    }));
    return result.Parameter.Value;
  } catch (error) {
    console.error('Failed to get Cognito User Pool ID:', error);
    throw new Error('Cognito User Pool ID not configured');
  }
}

async function getUsers(event) {
  try {
    const useCognitoAuth = await getUseCognitoAuth();
    
    if (useCognitoAuth) {
      // Cognito mode: fetch users from Cognito User Pool
      return await getUsersFromCognito();
    } else {
      // LDAP mode: fetch users from DynamoDB + Directory Service
      return await getUsersFromLDAP();
    }
  } catch (error) {
    console.error('Error getting users:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to get users' })
    };
  }
}

// Helper function to get AdminGroupName from SSM
async function getAdminGroupName() {
  try {
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    const parameterName = `/${pascalCaseName}/Auth/AdminGroupName`;
    const result = await ssm.send(new GetParameterCommand({
      Name: parameterName
    }));
    return result.Parameter.Value;
  } catch (error) {
    console.log('AdminGroupName parameter not found, defaulting to MRM-Admins');
    return 'MRM-Admins';
  }
}

// Get users from Cognito User Pool (for Cognito auth mode)
async function getUsersFromCognito() {
  try {
    const userPoolId = await getCognitoUserPoolId();
    
    // Get admin group configuration for role detection
    const adminGroupConfig = await getAdminGroupName();
    const validAdminGroups = adminGroupConfig.split(',').map(g => g.trim().toLowerCase());
    
    // Fetch all users from Cognito (handles pagination)
    let allUsers = [];
    let paginationToken = null;
    
    do {
      const params = {
        UserPoolId: userPoolId,
        Limit: 60
      };
      if (paginationToken) {
        params.PaginationToken = paginationToken;
      }
      
      const result = await cognitoClient.send(new ListUsersCommand(params));
      allUsers = allUsers.concat(result.Users || []);
      paginationToken = result.PaginationToken;
    } while (paginationToken);
    
    // Get groups from DynamoDB for group membership lookup
    const groupsResult = await dynamodb.send(new ScanCommand({
      TableName: process.env.GROUPS_TABLE_NAME
    }));
    const groups = groupsResult.Items || [];
    
    // Build a map of user -> groups from DynamoDB
    const userGroupMap = new Map();
    for (const group of groups) {
      const members = group.members || [];
      for (const memberId of members) {
        if (!userGroupMap.has(memberId)) {
          userGroupMap.set(memberId, []);
        }
        userGroupMap.get(memberId).push(group.groupName);
      }
    }
    
    // Helper to normalize groups
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

    // Map Cognito users to our expected format (async to fetch group memberships)
    const cognitoUserIds = new Set(); // Track Cognito user IDs for deduplication
    const users = await Promise.all(allUsers.map(async (cognitoUser) => {
      const attributes = {};
      (cognitoUser.Attributes || []).forEach(attr => {
        attributes[attr.Name] = attr.Value;
      });
      
      // Determine userId based on user type:
      // - Federated users (Okta, IdentityCenter): use Username (e.g., "IdentityCenter_jdoe@example.com")
      // - Native Cognito users: use email (Username is a UUID for native users)
      const username = cognitoUser.Username;
      const isFederatedUser = username.includes('_') && !/^[0-9a-f-]{36}$/i.test(username);
      const userId = isFederatedUser ? username : (attributes.email || username);
      const displayUsername = isFederatedUser ? username.split('_').slice(1).join('_') : (attributes.email || username);
      
      // Track this user's ID and email for deduplication with DynamoDB users
      cognitoUserIds.add(userId.toLowerCase());
      if (attributes.email) {
        cognitoUserIds.add(attributes.email.toLowerCase());
      }
      // Also track the display username (email without IdP prefix)
      cognitoUserIds.add(displayUsername.toLowerCase());
      
      // Find user's groups from DynamoDB group memberships
      const userGroups = userGroupMap.get(username) || userGroupMap.get(userId) || [];
      
      // Collect groups from all possible sources for admin detection:
      // 1. custom:groups attribute (Identity Center sends group IDs here)
      // 2. cognito:groups (Cognito native groups)
      // 3. groups attribute (some IdPs use this)
      // 4. DynamoDB group memberships
      // 5. Cognito User Pool group memberships (fetched via AdminListGroupsForUser)
      const customGroups = attributes['custom:groups'] || '';
      const cognitoGroups = attributes['cognito:groups'] || '';
      const directGroups = attributes['groups'] || '';
      
      // Fetch Cognito User Pool group memberships for this user
      let cognitoPoolGroups = [];
      try {
        const groupsResult = await cognitoClient.send(new AdminListGroupsForUserCommand({
          UserPoolId: userPoolId,
          Username: username
        }));
        cognitoPoolGroups = (groupsResult.Groups || []).map(g => g.GroupName);
      } catch (error) {
        console.log('Could not fetch Cognito groups for user', username + ':', error.message);
      }
      
      const allUserGroups = [
        ...normalizeGroups(customGroups),
        ...normalizeGroups(cognitoGroups),
        ...normalizeGroups(directGroups),
        ...userGroups,
        ...cognitoPoolGroups
      ];
      
      // Check admin status from multiple sources:
      // 1. custom:isAdmin attribute (native Cognito users)
      // 2. Group membership matching AdminGroupName (federated users or Cognito groups)
      const isAdminFromAttribute = attributes['custom:isAdmin'] === 'true';
      const isAdminFromGroup = allUserGroups.some(userGroup => 
        validAdminGroups.includes(userGroup.toLowerCase())
      );
      const isAdmin = isAdminFromAttribute || isAdminFromGroup;
      
      return {
        userId: userId,
        email: attributes.email || '',
        firstName: attributes.given_name || attributes.name?.split(' ')[0] || displayUsername,
        lastName: attributes.family_name || attributes.name?.split(' ').slice(1).join(' ') || '',
        department: attributes['custom:department'] || '',
        status: cognitoUser.Enabled ? 'ACTIVE' : 'DISABLED',
        enabled: cognitoUser.Enabled || false,
        role: isAdmin ? 'Administrator' : 'User',
        isAdmin: isAdmin,
        groups: [...userGroups, ...cognitoPoolGroups], // Include Cognito pool groups in display
        createdAt: cognitoUser.UserCreateDate?.toISOString() || new Date().toISOString(),
        cognitoUser: true // Flag to indicate this is a Cognito user
      };
    }));
    
    // Merge in DynamoDB synced users (from Identity Center sync) that haven't logged in yet
    try {
      const ddbUsersResult = await dynamodb.send(new ScanCommand({
        TableName: process.env.USER_TABLE_NAME,
        FilterExpression: '#source = :source',
        ExpressionAttributeNames: { '#source': 'source' },
        ExpressionAttributeValues: { ':source': 'identity-center' }
      }));
      
      const ddbUsers = ddbUsersResult.Items || [];
      console.log(`Found ${ddbUsers.length} Identity Center synced users in DynamoDB`);
      
      for (const ddbUser of ddbUsers) {
        // Check if this user already exists in Cognito (by userId or email)
        const userIdLower = (ddbUser.userId || '').toLowerCase();
        const emailLower = (ddbUser.email || '').toLowerCase();
        
        const alreadyInCognito = cognitoUserIds.has(userIdLower) || cognitoUserIds.has(emailLower);
        
        if (!alreadyInCognito) {
          // User hasn't logged in yet - add them to the list
          // Prefix userId with "IdentityCenter_" to match the Cognito username format
          // that will be used when the user eventually logs in via SAML federation.
          // This ensures workstation assignments use the same ID format as the login token.
          const normalizedUserId = ddbUser.userId.includes('_') 
            ? ddbUser.userId  // Already has a provider prefix
            : `IdentityCenter_${ddbUser.userId}`;
          const userGroups = userGroupMap.get(ddbUser.userId) || userGroupMap.get(ddbUser.email) || [];
          
          users.push({
            userId: normalizedUserId,
            email: ddbUser.email || '',
            firstName: ddbUser.firstName || '',
            lastName: ddbUser.lastName || '',
            department: ddbUser.department || '',
            status: 'PENDING', // Not yet logged in
            enabled: true,
            role: ddbUser.isAdmin ? 'Administrator' : 'User',
            isAdmin: ddbUser.isAdmin || false,
            groups: userGroups,
            createdAt: ddbUser.syncedAt || ddbUser.createdAt || new Date().toISOString(),
            cognitoUser: false,
            syncedFromIdentityCenter: true // Flag to indicate this user was synced but hasn't logged in
          });
          console.log(`Added synced user not yet in Cognito: ${ddbUser.userId}`);
        }
      }
    } catch (ddbError) {
      console.warn('Could not fetch DynamoDB synced users:', ddbError.message);
      // Continue without DynamoDB users - Cognito users will still be returned
    }
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(users)
    };
  } catch (error) {
    console.error('Error getting users from Cognito:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to get users from Cognito: ' + error.message })
    };
  }
}

// Get users from LDAP/Directory Service (original implementation)
async function getUsersFromLDAP() {
  try {
    const result = await dynamodb.send(new ScanCommand({
      TableName: process.env.USER_TABLE_NAME
    }));
    
    // Get directory ID for Directory Service calls
    const directoryId = await getDirectoryId();
    
    // Get all groups once
    const groupsResult = await dynamodb.send(new ScanCommand({
      TableName: process.env.GROUPS_TABLE_NAME
    }));
    
    // Build a map of group memberships by fetching all group members once
    const groupMemberships = new Map();
    
    for (const group of groupsResult.Items) {
      try {
        const sanitizedGroupName = group.groupName.replace(/[^a-zA-Z0-9\-_.]/g, '');
        const membersResult = await directoryServiceData.send(new ListGroupMembersCommand({
          DirectoryId: directoryId,
          SAMAccountName: sanitizedGroupName
        }));
        
        const members = membersResult.Members?.map(member => member.SAMAccountName) || [];
        groupMemberships.set(group.groupName, members);
      } catch (error) {
        console.log('Could not fetch members for group', group.groupName + ':', error.message);
        groupMemberships.set(group.groupName, []);
      }
    }
    
    // Fetch user status and build response
    const users = await Promise.all(result.Items.map(async (user) => {
      try {
        // Get user details from Directory Service Data API
        const userResult = await directoryServiceData.send(new DescribeUserCommand({
          DirectoryId: directoryId,
          SAMAccountName: user.userId
        }));
        
        // Find user's groups from the membership map
        const sanitizedUsername = user.userId.replace(/[^a-zA-Z0-9\-_.]/g, '');
        const userGroups = [];
        
        for (const [groupName, members] of groupMemberships) {
          if (members.includes(sanitizedUsername)) {
            userGroups.push(groupName);
          }
        }
        
        return {
          ...user,
          status: userResult.Enabled ? 'ACTIVE' : 'DISABLED',
          enabled: userResult.Enabled || false,
          role: user.isAdmin ? 'Administrator' : 'User',
          groups: userGroups
        };
      } catch (error) {
        console.error('Error fetching status for user', user.userId + ':', error);
        return {
          ...user,
          status: 'UNKNOWN',
          enabled: false,
          role: user.isAdmin ? 'Administrator' : 'User',
          groups: []
        };
      }
    }));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(users)
    };
  } catch (error) {
    console.error('Error getting users from LDAP:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to get users' })
    };
  }
}

async function getGroups(event) {
  try {
    const result = await dynamodb.send(new ScanCommand({
      TableName: process.env.GROUPS_TABLE_NAME
    }));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(result.Items || [])
    };
  } catch (error) {
    console.error('Error getting groups:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to get groups' })
    };
  }
}

async function getUserGroups(userId) {
  try {
    const useCognitoAuth = await getUseCognitoAuth();
    
    if (useCognitoAuth) {
      // Cognito mode: get groups from DynamoDB only
      return await getUserGroupsFromDynamoDB(userId);
    } else {
      // LDAP mode: get groups from Directory Service
      return await getUserGroupsFromLDAP(userId);
    }
  } catch (error) {
    console.error('Error getting user groups:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to get user groups' })
    };
  }
}

// Get user groups from DynamoDB (for Cognito auth mode)
async function getUserGroupsFromDynamoDB(userId) {
  try {
    // Query group memberships table for this user
    // For now, we'll scan groups and check membership attribute
    const groupsResult = await dynamodb.send(new ScanCommand({
      TableName: process.env.GROUPS_TABLE_NAME
    }));
    
    const userGroups = [];
    
    for (const group of groupsResult.Items || []) {
      // Check if user is in the group's members array
      const members = group.members || [];
      if (members.includes(userId)) {
        userGroups.push({
          groupId: group.groupId,
          groupName: group.groupName,
          description: group.description
        });
      }
    }
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ groups: userGroups })
    };
  } catch (error) {
    console.error('Error getting user groups from DynamoDB:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to get user groups' })
    };
  }
}

// Get user groups from LDAP/Directory Service (original implementation)
async function getUserGroupsFromLDAP(userId) {
  try {
    const directoryId = await getDirectoryId();
    const sanitizedUsername = userId.replace(/[^a-zA-Z0-9\-_.]/g, '');
    
    const groupsResult = await dynamodb.send(new ScanCommand({
      TableName: process.env.GROUPS_TABLE_NAME
    }));
    
    const userGroups = [];
    
    for (const group of groupsResult.Items) {
      try {
        const sanitizedGroupName = group.groupName.replace(/[^a-zA-Z0-9\-_.]/g, '');
        console.log(`Checking membership for group: ${sanitizedGroupName}`);
        
        const membersResult = await directoryServiceData.send(new ListGroupMembersCommand({
          DirectoryId: directoryId,
          SAMAccountName: sanitizedGroupName
        }));
        
        console.log(`Group ${sanitizedGroupName} has ${membersResult.Members?.length || 0} members`);
        console.log(`Looking for user: ${sanitizedUsername}`);
        
        const isMember = membersResult.Members?.some(member => {
          console.log(`Checking member: ${member.SAMAccountName} (type: ${typeof member.SAMAccountName})`);
          return member.SAMAccountName && member.SAMAccountName === sanitizedUsername;
        });
        
        console.log(`User ${sanitizedUsername} is member of ${sanitizedGroupName}: ${isMember}`);
        
        if (isMember) {
          userGroups.push({
            groupId: group.groupId,
            groupName: group.groupName,
            description: group.description
          });
        }
      } catch (error) {
        console.log('Could not check membership for group', group.groupName + ':', error.message);
        // Skip this group and continue with the next one
      }
    }

    console.log('Returning', userGroups.length, 'groups for user', userId + ':', JSON.stringify(userGroups));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ groups: userGroups })
    };
  } catch (error) {
    console.error('Error getting user groups from LDAP:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to get user groups' })
    };
  }
}

async function createUser(userData) {
  // Check if Cognito auth mode - user creation is disabled
  const useCognitoAuth = await getUseCognitoAuth();
  if (useCognitoAuth) {
    return {
      statusCode: 403,
      headers: corsHeaders,
      body: JSON.stringify({ 
        error: 'User creation is disabled in Cognito authentication mode. Users are managed through your Identity Provider (Okta, IAM Identity Center, etc.).' 
      })
    };
  }
  
  const { firstName, lastName, email, department, isAdmin, temporaryPassword } = userData;
  
  try {
    // Extract username from email (part before @)
    const username = email.split('@')[0];
    const sanitizedUsername = username.replace(/[^a-zA-Z0-9\-_.]/g, '');
    
    // Validate username - prevent reserved/problematic usernames
    const reservedUsernames = ['user', 'admin', 'administrator', 'root', 'system', 'service', 'guest', 'public'];
    if (reservedUsernames.includes(sanitizedUsername.toLowerCase())) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ 
          error: `Username "${sanitizedUsername}" is reserved and cannot be used. Please use a different email address.` 
        })
      };
    }
    
    const directoryId = await getDirectoryId();
    
    await directoryServiceData.send(new CreateUserCommand({
      DirectoryId: directoryId,
      SAMAccountName: sanitizedUsername,
      GivenName: firstName,
      Surname: lastName,
      EmailAddress: email,
      OtherAttributes: {
        department: {
          S: department
        }
      }
    }));

    // Enable the user by resetting password (ResetUserPassword automatically enables disabled users)
    await directoryService.send(new ResetUserPasswordCommand({
      DirectoryId: directoryId,
      UserName: sanitizedUsername,
      NewPassword: temporaryPassword
    }));
    
    if (isAdmin) {
      await directoryServiceData.send(new AddGroupMemberCommand({
        DirectoryId: directoryId,
        GroupName: 'AWS Delegated Administrators',
        MemberName: sanitizedUsername
      }));
    }
    
    await dynamodb.send(new PutCommand({
      TableName: process.env.USER_TABLE_NAME,
      Item: {
        userId: sanitizedUsername,  // Store sanitized username to match Directory Service
        email,
        firstName,
        lastName,
        department,
        isAdmin: !!isAdmin,
        preferences: {},
        createdAt: new Date().toISOString()
      }
    }));
    
    return {
      statusCode: 201,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'User created successfully' })
    };
  } catch (error) {
    console.error('Error creating user:', error);
    
    // Handle case where user already exists in AD
    if (error.name === 'ConflictException' && error.message.includes('User already exists')) {
      try {
        // User exists in AD, just add them to our DynamoDB table
        const username = email.split('@')[0];
        const sanitizedUsername = username.replace(/[^a-zA-Z0-9\-_.]/g, '');
        
        await dynamodb.send(new PutCommand({
          TableName: process.env.USER_TABLE_NAME,
          Item: {
            userId: sanitizedUsername,
            email,
            firstName,
            lastName,
            department,
            isAdmin: !!isAdmin,
            preferences: {},
            createdAt: new Date().toISOString(),
            importedFromAD: true
          }
        }));
        
        return {
          statusCode: 201,
          headers: corsHeaders,
          body: JSON.stringify({ 
            message: 'User already exists in Active Directory. Added to Workstation Management console for management.',
            userId: sanitizedUsername
          })
        };
      } catch (dbError) {
        console.error('Error adding existing user to DynamoDB:', dbError);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'User exists in AD but failed to add to management console' })
        };
      }
    }
    
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to create user' })
    };
  }
}

async function assignUsersToGroups(assignmentData) {
  try {
    const { userIds, groupIds } = assignmentData;
    const useCognitoAuth = await getUseCognitoAuth();
    
    if (useCognitoAuth) {
      // Cognito mode: manage group memberships in DynamoDB only
      return await assignUsersToGroupsDynamoDB(userIds, groupIds);
    } else {
      // LDAP mode: manage group memberships in Directory Service
      return await assignUsersToGroupsLDAP(userIds, groupIds);
    }
  } catch (error) {
    console.error('Error assigning users to groups:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to assign users to groups' })
    };
  }
}

// Assign users to groups in DynamoDB only (for Cognito auth mode)
async function assignUsersToGroupsDynamoDB(userIds, groupIds) {
  const results = [];
  
  for (const userId of userIds) {
    for (const groupId of groupIds) {
      try {
        // Get current group
        const groupResult = await dynamodb.send(new GetCommand({
          TableName: process.env.GROUPS_TABLE_NAME,
          Key: { groupId }
        }));
        
        if (!groupResult.Item) {
          results.push({ userId, groupId, status: 'error', message: 'Group not found' });
          continue;
        }
        
        // Add user to group's members array
        const currentMembers = groupResult.Item.members || [];
        if (currentMembers.includes(userId)) {
          results.push({ userId, groupId, status: 'already_member' });
          continue;
        }
        
        await dynamodb.send(new UpdateCommand({
          TableName: process.env.GROUPS_TABLE_NAME,
          Key: { groupId },
          UpdateExpression: 'SET members = list_append(if_not_exists(members, :empty), :userId)',
          ExpressionAttributeValues: {
            ':empty': [],
            ':userId': [userId]
          }
        }));
        
        results.push({ userId, groupId, status: 'success' });
      } catch (error) {
        console.error('Failed to assign user', userId, 'to group', groupId + ':', error);
        results.push({ userId, groupId, status: 'error', message: error.message });
      }
    }
  }
  
  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ results })
  };
}

// Assign users to groups in Directory Service (original LDAP implementation)
async function assignUsersToGroupsLDAP(userIds, groupIds) {
  const directoryId = await getDirectoryId();
  const results = [];

  for (const userId of userIds) {
    for (const groupId of groupIds) {
      try {
        const groupResult = await dynamodb.send(new GetCommand({
          TableName: process.env.GROUPS_TABLE_NAME,
          Key: { groupId }
        }));

        if (!groupResult.Item) {
          results.push({ userId, groupId, status: 'error', message: 'Group not found' });
          continue;
        }

        const sanitizedGroupName = groupResult.Item.groupName.replace(/[^a-zA-Z0-9\-_.]/g, '');
        const sanitizedUsername = userId.replace(/[^a-zA-Z0-9\-_.]/g, '');
        
        await directoryServiceData.send(new AddGroupMemberCommand({
          DirectoryId: directoryId,
          GroupName: sanitizedGroupName,
          MemberName: sanitizedUsername
        }));

        results.push({ userId, groupId, status: 'success' });
      } catch (error) {
        const sanitizedUsername = userId.replace(/[^a-zA-Z0-9\-_.]/g, '');
        console.error('Failed to assign user', userId, '(sanitized:', sanitizedUsername + ') to group', groupId + ':', error);
        if (error.message && error.message.includes('Member already exists')) {
          results.push({ userId, groupId, status: 'already_member' });
        } else {
          results.push({ userId, groupId, status: 'error', message: error.message });
        }
      }
    }
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ results })
  };
}

async function removeUserFromGroups(userId, data) {
  try {
    const { groupIds } = data;
    const useCognitoAuth = await getUseCognitoAuth();
    
    if (useCognitoAuth) {
      // Cognito mode: manage group memberships in DynamoDB only
      return await removeUserFromGroupsDynamoDB(userId, groupIds);
    } else {
      // LDAP mode: manage group memberships in Directory Service
      return await removeUserFromGroupsLDAP(userId, groupIds);
    }
  } catch (error) {
    console.error('Error removing user from groups:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to remove user from groups' })
    };
  }
}

// Remove user from groups in DynamoDB only (for Cognito auth mode)
async function removeUserFromGroupsDynamoDB(userId, groupIds) {
  const results = [];
  
  console.log(`removeUserFromGroupsDynamoDB called with userId: "${userId}", groupIds: ${JSON.stringify(groupIds)}`);
  
  for (const groupId of groupIds) {
    try {
      // Get current group
      const groupResult = await dynamodb.send(new GetCommand({
        TableName: process.env.GROUPS_TABLE_NAME,
        Key: { groupId }
      }));
      
      if (!groupResult.Item) {
        console.log(`Group not found: ${groupId}`);
        results.push({ userId, groupId, status: 'error', message: 'Group not found' });
        continue;
      }
      
      // Remove user from group's members array
      const currentMembers = groupResult.Item.members || [];
      console.log(`Group ${groupId} current members: ${JSON.stringify(currentMembers)}`);
      console.log(`Looking for userId to remove: "${userId}"`);
      
      const updatedMembers = currentMembers.filter(member => member !== userId);
      
      console.log(`Members after filter: ${JSON.stringify(updatedMembers)}`);
      console.log(`Removed ${currentMembers.length - updatedMembers.length} member(s)`);
      
      await dynamodb.send(new UpdateCommand({
        TableName: process.env.GROUPS_TABLE_NAME,
        Key: { groupId },
        UpdateExpression: 'SET members = :members',
        ExpressionAttributeValues: {
          ':members': updatedMembers
        }
      }));
      
      console.log(`Successfully removed user ${userId} from group ${groupId} in DynamoDB`);
      results.push({ userId, groupId, status: 'success' });
    } catch (error) {
      console.error('Failed to remove user', userId, 'from group', groupId + ':', error);
      results.push({ userId, groupId, status: 'error', message: error.message });
    }
  }
  
  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ results })
  };
}

// Remove user from groups in Directory Service (original LDAP implementation)
async function removeUserFromGroupsLDAP(userId, groupIds) {
  const directoryId = await getDirectoryId();
  const sanitizedUsername = userId.replace(/[^a-zA-Z0-9\-_.]/g, '');
  const results = [];

  for (const groupId of groupIds) {
    try {
      const groupResult = await dynamodb.send(new GetCommand({
        TableName: process.env.GROUPS_TABLE_NAME,
        Key: { groupId }
      }));

      if (!groupResult.Item) {
        results.push({ userId, groupId, status: 'error', message: 'Group not found' });
        continue;
      }

      const sanitizedGroupName = groupResult.Item.groupName.replace(/[^a-zA-Z0-9\-_.]/g, '');
      
      await directoryServiceData.send(new RemoveGroupMemberCommand({
        DirectoryId: directoryId,
        GroupName: sanitizedGroupName,
        MemberName: sanitizedUsername
      }));
      
      console.log(`Successfully removed user ${sanitizedUsername} from group ${sanitizedGroupName}`);
      results.push({ userId, groupId, status: 'success' });
    } catch (error) {
      console.error('Failed to remove user', userId, 'from group', groupId + ':', error);
      results.push({ userId, groupId, status: 'error', message: error.message });
    }
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ results })
  };
}

async function createGroup(groupData) {
  const { groupName, description } = groupData;
  
  try {
    // Validate input parameters
    if (!groupName || typeof groupName !== 'string' || !groupName.trim()) {
      throw new Error('Group name is required and must be a non-empty string');
    }
    
    const useCognitoAuth = await getUseCognitoAuth();
    
    if (useCognitoAuth) {
      // Cognito mode: create group in DynamoDB only
      return await createGroupDynamoDB(groupName, description);
    } else {
      // LDAP mode: create group in Directory Service + DynamoDB
      return await createGroupLDAP(groupName, description);
    }
  } catch (error) {
    console.error('Error creating group:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to create group: ' + error.message })
    };
  }
}

// Create group in DynamoDB only (for Cognito auth mode)
async function createGroupDynamoDB(groupName, description) {
  try {
    const groupId = `group-${crypto.randomUUID()}`;
    
    await dynamodb.send(new PutCommand({
      TableName: process.env.GROUPS_TABLE_NAME,
      Item: {
        groupId,
        groupName,
        description: description || '',
        members: [], // Initialize empty members array for Cognito mode
        createdAt: new Date().toISOString(),
        cognitoOnly: true // Flag to indicate this is a Cognito-mode group
      }
    }));
    
    return {
      statusCode: 201,
      headers: corsHeaders,
      body: JSON.stringify({ 
        message: 'Group created successfully', 
        groupId,
        groupName,
        description
      })
    };
  } catch (error) {
    console.error('Error creating group in DynamoDB:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to create group' })
    };
  }
}

// Create group in Directory Service + DynamoDB (original LDAP implementation)
async function createGroupLDAP(groupName, description) {
  try {
    const directoryId = await getDirectoryId();
    const sanitizedGroupName = groupName.trim().replace(/[^a-zA-Z0-9\-_.]/g, '');
    
    if (!sanitizedGroupName) {
      throw new Error('Group name contains no valid characters');
    }
    
    const createGroupParams = {
      DirectoryId: directoryId,
      SAMAccountName: sanitizedGroupName
    };
    
    // Add description via other-attributes if provided
    if (description && typeof description === 'string' && description.trim()) {
      createGroupParams.OtherAttributes = {
        description: {
          S: description.trim()
        }
      };
    }
    
    const result = await directoryServiceData.send(new CreateGroupCommand(createGroupParams));
    
    const groupId = `group-${crypto.randomUUID()}`;
    
    await dynamodb.send(new PutCommand({
      TableName: process.env.GROUPS_TABLE_NAME,
      Item: {
        groupId,
        groupName,
        description,
        createdAt: new Date().toISOString()
      }
    }));
    
    return {
      statusCode: 201,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Group created successfully', groupId })
    };
  } catch (error) {
    console.error('Error creating group in LDAP:', error);
    
    // Handle case where group already exists in AD
    if (error.name === 'ConflictException' && error.message.includes('Group already exists')) {
      try {
        // Group exists in AD, just add it to our DynamoDB table
        const groupId = `group-${crypto.randomUUID()}`;
        
        await dynamodb.send(new PutCommand({
          TableName: process.env.GROUPS_TABLE_NAME,
          Item: {
            groupId,
            groupName,
            description,
            createdAt: new Date().toISOString(),
            importedFromAD: true
          }
        }));
        
        return {
          statusCode: 201,
          headers: corsHeaders,
          body: JSON.stringify({ 
            groupId, 
            groupName, 
            description,
            message: 'Group already exists in Active Directory. Added to Workstation Management console for management.' 
          })
        };
      } catch (dbError) {
        console.error('Error adding existing group to DynamoDB:', dbError);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Group exists in AD but failed to add to management console' })
        };
      }
    }
    
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to create group' })
    };
  }
}

async function disableUsers(data) {
  // Check if Cognito auth mode - user management is disabled
  const useCognitoAuth = await getUseCognitoAuth();
  if (useCognitoAuth) {
    return {
      statusCode: 403,
      headers: corsHeaders,
      body: JSON.stringify({ 
        error: 'User management is disabled in Cognito authentication mode. Users are managed through your Identity Provider (Okta, IAM Identity Center, etc.).' 
      })
    };
  }
  
  const { userIds } = data;
  const results = [];
  
  for (const userId of userIds) {
    try {
      const directoryId = await getDirectoryId();
      await directoryServiceData.send(new DisableUserCommand({
        DirectoryId: directoryId,
        SAMAccountName: userId
      }));
      
      results.push({ userId, success: true });
    } catch (error) {
      console.error('Failed to disable user', userId + ':', error);
      results.push({ userId, success: false, error: error.message });
    }
  }
  
  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      message: 'Disable operation completed',
      results
    })
  };
}

async function enableUsers(data) {
  // Check if Cognito auth mode - user management is disabled
  const useCognitoAuth = await getUseCognitoAuth();
  if (useCognitoAuth) {
    return {
      statusCode: 403,
      headers: corsHeaders,
      body: JSON.stringify({ 
        error: 'User management is disabled in Cognito authentication mode. Users are managed through your Identity Provider (Okta, IAM Identity Center, etc.).' 
      })
    };
  }
  
  const { userIds } = data;
  const results = [];
  
  for (const userId of userIds) {
    try {
      const directoryId = await getDirectoryId();
      // Generate a random temporary password for the re-enabled user
      const tempPassword = crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, 'x') + 'A1!';
      await directoryService.send(new ResetUserPasswordCommand({
        DirectoryId: directoryId,
        UserName: userId,
        NewPassword: tempPassword
      }));
      
      results.push({ userId, success: true });
    } catch (error) {
      console.error('Failed to enable user', userId + ':', error);
      results.push({ userId, success: false, error: error.message });
    }
  }
  
  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      message: 'Enable operation completed',
      results
    })
  };
}

async function deleteUsers(data) {
  // Check if Cognito auth mode - user management is disabled
  const useCognitoAuth = await getUseCognitoAuth();
  if (useCognitoAuth) {
    return {
      statusCode: 403,
      headers: corsHeaders,
      body: JSON.stringify({ 
        error: 'User deletion is disabled in Cognito authentication mode. Users are managed through your Identity Provider (Okta, IAM Identity Center, etc.).' 
      })
    };
  }
  
  const { userIds } = data;
  const results = [];
  
  for (const userId of userIds) {
    try {
      const directoryId = await getDirectoryId();
      const sanitizedUsername = userId.replace(/[^a-zA-Z0-9\-_.]/g, '');
      
      await directoryServiceData.send(new DeleteUserCommand({
        DirectoryId: directoryId,
        SAMAccountName: sanitizedUsername
      }));
      
      await dynamodb.send(new DeleteCommand({
        TableName: process.env.USER_TABLE_NAME,
        Key: { userId }
      }));
      
      results.push({ userId, success: true });
    } catch (error) {
      console.error('Failed to delete user', userId + ':', error);
      results.push({ userId, success: false, error: error.message });
    }
  }
  
  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      message: 'Delete operation completed',
      results
    })
  };
}

async function deleteGroup(groupId) {
  try {
    // Get group details first
    const groupResult = await dynamodb.send(new GetCommand({
      TableName: process.env.GROUPS_TABLE_NAME,
      Key: { groupId }
    }));
    
    if (!groupResult.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Group not found' })
      };
    }
    
    const group = groupResult.Item;
    const useCognitoAuth = await getUseCognitoAuth();
    
    if (useCognitoAuth || group.cognitoOnly) {
      // Cognito mode or Cognito-only group: delete from DynamoDB only
      await dynamodb.send(new DeleteCommand({
        TableName: process.env.GROUPS_TABLE_NAME,
        Key: { groupId }
      }));
      
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ 
          message: 'Group deleted successfully',
          groupId,
          groupName: group.groupName
        })
      };
    } else {
      // LDAP mode: delete from Directory Service + DynamoDB
      const directoryId = await getDirectoryId();
      const sanitizedGroupName = group.groupName.replace(/[^a-zA-Z0-9\-_.]/g, '');
      
      // Delete from Directory Services
      await directoryServiceData.send(new DeleteGroupCommand({
        DirectoryId: directoryId,
        SAMAccountName: sanitizedGroupName
      }));
      
      // Delete from DynamoDB
      await dynamodb.send(new DeleteCommand({
        TableName: process.env.GROUPS_TABLE_NAME,
        Key: { groupId }
      }));
      
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ 
          message: 'Group deleted successfully',
          groupId,
          groupName: group.groupName
        })
      };
    }
  } catch (error) {
    console.error('Error deleting group:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to delete group: ' + error.message })
    };
  }
}

async function updateGroup(groupId, data) {
  try {
    const { groupName, description } = data;
    
    // Get current group details
    const groupResult = await dynamodb.send(new GetCommand({
      TableName: process.env.GROUPS_TABLE_NAME,
      Key: { groupId }
    }));
    
    if (!groupResult.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Group not found' })
      };
    }
    
    const currentGroup = groupResult.Item;
    const useCognitoAuth = await getUseCognitoAuth();
    
    if (useCognitoAuth || currentGroup.cognitoOnly) {
      // Cognito mode or Cognito-only group: update DynamoDB only
      await dynamodb.send(new UpdateCommand({
        TableName: process.env.GROUPS_TABLE_NAME,
        Key: { groupId },
        UpdateExpression: 'SET groupName = :name, description = :desc, updatedAt = :updated',
        ExpressionAttributeValues: {
          ':name': groupName,
          ':desc': description || '',
          ':updated': new Date().toISOString()
        }
      }));
      
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ 
          message: 'Group updated successfully',
          groupId,
          groupName,
          description
        })
      };
    } else {
      // LDAP mode: update Directory Service + DynamoDB
      return await updateGroupLDAP(groupId, groupName, description, currentGroup);
    }
  } catch (error) {
    console.error('Error updating group:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to update group: ' + error.message })
    };
  }
}

// Update group in Directory Service + DynamoDB (original LDAP implementation)
async function updateGroupLDAP(groupId, groupName, description, currentGroup) {
  try {
    const directoryId = await getDirectoryId();
    const oldSanitizedName = currentGroup.groupName.replace(/[^a-zA-Z0-9\-_.]/g, '');
    const newSanitizedName = groupName.replace(/[^a-zA-Z0-9\-_.]/g, '');
    
    // If group name is changing, we need to recreate the AD group
    if (groupName !== currentGroup.groupName) {
      try {
        // Step 1: Get current group members
        let currentMembers = [];
        try {
          const membersResult = await directoryServiceData.send(new ListGroupMembersCommand({
            DirectoryId: directoryId,
            SAMAccountName: oldSanitizedName
          }));
          currentMembers = membersResult.Members?.map(member => member.SAMAccountName) || [];
          console.log(`Found ${currentMembers.length} members in group ${oldSanitizedName}`);
        } catch (error) {
          console.log('Could not get group members:', error.message);
        }
        
        // Step 2: Delete old AD group
        try {
          await directoryServiceData.send(new DeleteGroupCommand({
            DirectoryId: directoryId,
            SAMAccountName: oldSanitizedName
          }));
          console.log(`Deleted old AD group: ${oldSanitizedName}`);
        } catch (error) {
          console.log('Could not delete old group:', error.message);
        }
        
        // Step 3: Create new AD group
        await directoryServiceData.send(new CreateGroupCommand({
          DirectoryId: directoryId,
          SAMAccountName: newSanitizedName,
          GroupType: 'Security',
          GroupScope: 'DomainLocal',
          OtherAttributes: {
            'Description': {
              'S': description || ''
            }
          }
        }));
        console.log(`Created new AD group: ${newSanitizedName}`);
        
        // Step 4: Re-add all members to new group
        for (const memberName of currentMembers) {
          try {
            await directoryServiceData.send(new AddGroupMemberCommand({
              DirectoryId: directoryId,
              GroupName: newSanitizedName,
              MemberName: memberName
            }));
            console.log(`Added member ${memberName} to new group`);
          } catch (error) {
            console.log('Could not add member', memberName + ':', error.message);
          }
        }
        
      } catch (error) {
        console.log('AD group recreation failed:', error.message);
        // Continue with DynamoDB update even if AD operations fail
      }
    } else {
      // Just update description if name hasn't changed
      if (description !== undefined && description !== currentGroup.description) {
        try {
          await directoryServiceData.send(new UpdateGroupCommand({
            DirectoryId: directoryId,
            SAMAccountName: oldSanitizedName,
            UpdateType: 'Replace',
            OtherAttributes: {
              'Description': {
                'S': description || ''
              }
            }
          }));
        } catch (error) {
          console.log('Directory Services description update failed:', error.message);
        }
      }
    }
    
    // Update in DynamoDB (both name and description)
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.GROUPS_TABLE_NAME,
      Key: { groupId },
      UpdateExpression: 'SET groupName = :name, description = :desc, updatedAt = :updated',
      ExpressionAttributeValues: {
        ':name': groupName,
        ':desc': description || '',
        ':updated': new Date().toISOString()
      }
    }));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ 
        message: 'Group updated successfully',
        groupId,
        groupName,
        description
      })
    };
  } catch (error) {
    console.error('Error updating group in LDAP:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to update group: ' + error.message })
    };
  }
}

async function getGroupById(groupId) {
  try {
    console.log(`Getting group details for groupId: ${groupId}`);
    
    const result = await dynamodb.send(new GetCommand({
      TableName: process.env.GROUPS_TABLE_NAME,
      Key: { groupId }
    }));
    
    if (!result.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Group not found' })
      };
    }
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(result.Item)
    };
  } catch (error) {
    console.error('Error getting group by ID:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to get group details: ' + error.message })
    };
  }
}

// Get user's auto-start schedule
async function getUserSchedule(userId) {
  try {
    console.log(`Getting schedule for user: ${userId}`);
    
    const result = await dynamodb.send(new GetCommand({
      TableName: process.env.USER_TABLE_NAME,
      Key: { userId }
    }));
    
    // Return default schedule whether the user row doesn't exist yet
    // (e.g. federated user who hasn't logged in or been synced yet) or
    // exists but has no autoStartSchedule attribute configured.
    // The PUT handler creates the row on first write, so this doesn't
    // mask any data integrity issue.
    const schedule = result.Item?.autoStartSchedule || {
      enabled: false,
      timezone: 'America/New_York',
      schedule: {}
    };
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(schedule)
    };
  } catch (error) {
    console.error('Error getting user schedule:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to get user schedule: ' + error.message })
    };
  }
}

// Update user's auto-start schedule
async function updateUserSchedule(userId, scheduleData, event) {
  try {
    // Check admin authorization
    const authorizerContext = event.requestContext?.authorizer || {};
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    if (!isAdmin) {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Access denied. Administrator privileges required.' })
      };
    }
    
    console.log('Updating schedule for user:', userId, scheduleData);
    
    // Validate schedule data
    const { enabled, timezone, schedule } = scheduleData;
    
    if (typeof enabled !== 'boolean') {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'enabled must be a boolean' })
      };
    }
    
    if (!timezone || typeof timezone !== 'string') {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'timezone is required and must be a string' })
      };
    }
    
    // Validate schedule object - should have day keys with time values
    const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const cleanSchedule = {};
    
    if (schedule && typeof schedule === 'object') {
      for (const [day, time] of Object.entries(schedule)) {
        if (!validDays.includes(day.toLowerCase())) {
          return {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({ error: `Invalid day: ${day}` })
          };
        }
        // Time should be in HH:MM format or null/empty
        if (time && typeof time === 'string') {
          if (!/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
            return {
              statusCode: 400,
              headers: corsHeaders,
              body: JSON.stringify({ error: `Invalid time format for ${day}: ${time}. Use HH:MM format.` })
            };
          }
          cleanSchedule[day.toLowerCase()] = time;
        }
      }
    }
    
    const autoStartSchedule = {
      enabled,
      timezone,
      schedule: cleanSchedule,
      updatedAt: new Date().toISOString()
    };
    
    // Update user record
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.USER_TABLE_NAME,
      Key: { userId },
      UpdateExpression: 'SET autoStartSchedule = :schedule',
      ExpressionAttributeValues: {
        ':schedule': autoStartSchedule
      }
    }));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ 
        message: 'Schedule updated successfully',
        schedule: autoStartSchedule
      })
    };
  } catch (error) {
    console.error('Error updating user schedule:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to update user schedule: ' + error.message })
    };
  }
}

// Delete user's auto-start schedule
async function deleteUserSchedule(userId, event) {
  try {
    // Check admin authorization
    const authorizerContext = event.requestContext?.authorizer || {};
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    if (!isAdmin) {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Access denied. Administrator privileges required.' })
      };
    }
    
    console.log(`Deleting schedule for user: ${userId}`);
    
    // Remove schedule from user record
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.USER_TABLE_NAME,
      Key: { userId },
      UpdateExpression: 'REMOVE autoStartSchedule'
    }));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Schedule deleted successfully' })
    };
  } catch (error) {
    console.error('Error deleting user schedule:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to delete user schedule: ' + error.message })
    };
  }
}
