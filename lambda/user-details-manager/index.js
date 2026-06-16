// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, ScanCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { DirectoryServiceClient, DescribeDirectoriesCommand } = require('@aws-sdk/client-directory-service');
const { DirectoryServiceDataClient, ListGroupMembersCommand, DescribeUserCommand, ListGroupsForMemberCommand } = require('@aws-sdk/client-directory-service-data');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { CognitoIdentityProviderClient, AdminGetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const directoryService = new DirectoryServiceClient({ region: process.env.AWS_REGION });
const directoryServiceData = new DirectoryServiceDataClient({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

async function getDirectoryId() {
  try {
    // Get pascal case name from environment variable
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    const parameterName = `/${pascalCaseName}/Identity/ActiveDirectoryId`;
    const response = await ssm.send(new GetParameterCommand({
      Name: parameterName
    }));
    return response.Parameter?.Value;
  } catch (error) {
    console.error('Error getting directory ID from SSM:', error);
    // Fallback to describing directories
    const directories = await directoryService.send(new DescribeDirectoriesCommand({}));
    if (directories.DirectoryDescriptions && directories.DirectoryDescriptions.length > 0) {
      return directories.DirectoryDescriptions[0].DirectoryId;
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

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const { httpMethod: method, path } = event;
  
  try {
    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: ''
      };
    }

    switch (method) {
      case 'GET':
        if (path.startsWith('/users/')) {
          return await getUserDetails(path.split('/')[2], event);
        }
        break;
      default:
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ message: 'Not found' })
        };
    }
  } catch (error) {
    console.error('Lambda error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: error.message })
    };
  }
};

async function getUserDetails(userId, event) {
  try {
    // Extract user information from authorizer context
    const authorizerContext = event.requestContext?.authorizer || {};
    const currentUserId = authorizerContext.userId;
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    // Check permissions - admin can see all users, users can only see themselves
    if (!isAdmin && currentUserId !== userId) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Access denied' })
      };
    }
    
    // Check if Cognito auth mode is enabled
    const useCognitoAuth = await getUseCognitoAuth();
    
    if (useCognitoAuth) {
      return await getUserDetailsCognito(userId);
    } else {
      return await getUserDetailsLDAP(userId);
    }
    
  } catch (error) {
    console.error('Error getting user details:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to get user details' })
    };
  }
}

// Get user details from Cognito (for Cognito auth mode)
async function getUserDetailsCognito(userId) {
  try {
    const userPoolId = await getCognitoUserPoolId();
    
    console.log(`Looking up Cognito user: ${userId} in pool: ${userPoolId}`);
    
    // Try to get user from Cognito
    let cognitoUser = null;
    try {
      const result = await cognitoClient.send(new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: userId
      }));
      cognitoUser = result;
    } catch (error) {
      console.error('User not found in Cognito, checking DynamoDB:', error.name);
      // Don't return 404 yet — fall through to DynamoDB lookup below
    }

    // If user was not found in Cognito, fall back to DynamoDB.
    // This handles Identity Center synced users who haven't logged in yet.
    // The userId in the URL has an IdP prefix (e.g., "IdentityCenter_user@example.com")
    // but the DynamoDB key is the plain email (e.g., "user@example.com").
    if (!cognitoUser) {
      const strippedUserId = userId.includes('_')
        ? userId.split('_').slice(1).join('_')
        : userId;

      console.log(`Falling back to DynamoDB lookup with stripped userId: ${strippedUserId}`);

      const getUserCommand = new GetCommand({
        TableName: process.env.USER_TABLE_NAME,
        Key: { userId: strippedUserId }
      });
      const userResult = await dynamodb.send(getUserCommand);

      if (!userResult.Item) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'User not found' })
        };
      }

      const dbUser = userResult.Item;
      const user = {
        userId: userId, // Keep the prefixed ID for consistency with the user list
        email: dbUser.email || '',
        firstName: dbUser.firstName || '',
        lastName: dbUser.lastName || '',
        displayName: dbUser.displayName || '',
        department: dbUser.department || '',
        isAdmin: dbUser.isAdmin || false,
        isEnabled: dbUser.isEnabled || false,
        createdAt: dbUser.syncedAt || dbUser.updatedAt || new Date().toISOString(),
        enabled: dbUser.isEnabled || false,
        source: dbUser.source || 'unknown',
        cognitoUser: false,
        syncedFromIdentityCenter: dbUser.source === 'identity-center'
      };

      const userGroups = await getUserGroupsFromDynamoDB(strippedUserId);
      const workstations = await getUserWorkstations(userId, userGroups);
      // Also check workstations under the stripped userId
      const strippedWorkstations = await getUserWorkstations(strippedUserId, userGroups);
      // Merge and deduplicate workstations
      const allWorkstations = [...workstations];
      for (const ws of strippedWorkstations) {
        if (!allWorkstations.find(w => w.instanceId === ws.instanceId)) {
          allWorkstations.push(ws);
        }
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({
          user,
          directoryUser: null,
          groups: userGroups,
          workstations: allWorkstations
        })
      };
    }

    // Parse Cognito user attributes
    const attributes = {};
    (cognitoUser.UserAttributes || []).forEach(attr => {
      attributes[attr.Name] = attr.Value;
    });
    
    // Determine display username for federated users
    const username = cognitoUser.Username;
    const isFederatedUser = username.includes('_') && !/^[0-9a-f-]{36}$/i.test(username);
    const displayUsername = isFederatedUser ? username.split('_').slice(1).join('_') : (attributes.email || username);
    
    // Build user object from Cognito data
    const user = {
      userId: userId,
      email: attributes.email || '',
      firstName: attributes.given_name || attributes.name?.split(' ')[0] || displayUsername,
      lastName: attributes.family_name || attributes.name?.split(' ').slice(1).join(' ') || '',
      department: attributes['custom:department'] || '',
      isAdmin: attributes['custom:isAdmin'] === 'true',
      createdAt: cognitoUser.UserCreateDate?.toISOString() || new Date().toISOString(),
      enabled: cognitoUser.Enabled || false,
      cognitoUser: true
    };
    
    // Get user's groups from DynamoDB (groups store members array)
    const userGroups = await getUserGroupsFromDynamoDB(userId);
    
    // Get user's workstations
    const workstations = await getUserWorkstations(userId, userGroups);
    
    // Combine all user details
    const details = {
      user: user,
      directoryUser: null, // No directory user in Cognito mode
      groups: userGroups,
      workstations: workstations
    };
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify(details)
    };
    
  } catch (error) {
    console.error('Error getting Cognito user details:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to get user details' })
    };
  }
}

// Get user's groups from DynamoDB (for Cognito auth mode)
async function getUserGroupsFromDynamoDB(userId) {
  try {
    const groupsCommand = new ScanCommand({
      TableName: process.env.GROUPS_TABLE_NAME
    });
    
    const groupsResult = await dynamodb.send(groupsCommand);
    const allGroups = groupsResult.Items || [];
    
    const userGroups = [];
    
    for (const group of allGroups) {
      const members = group.members || [];
      if (members.includes(userId)) {
        userGroups.push({
          GroupName: group.groupName,
          Description: group.description
        });
      }
    }
    
    console.log(`Found ${userGroups.length} groups for user ${userId}`);
    return userGroups;
  } catch (error) {
    console.error('Error getting user groups from DynamoDB:', error);
    return [];
  }
}

// Get user details from LDAP/Directory Service (original implementation)
async function getUserDetailsLDAP(userId) {
  try {
    // Get user from DynamoDB
    const getUserCommand = new GetCommand({
      TableName: process.env.USER_TABLE_NAME,
      Key: { userId }
    });
    
    const userResult = await dynamodb.send(getUserCommand);
    
    if (!userResult.Item) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'User not found' })
      };
    }
    
    const user = userResult.Item;
    
    // Get directory information
    const directoryId = await getDirectoryId();
    let directoryUser = null;
    let userGroups = [];
    
    try {
      // Try different identifiers for directory lookup
      let samAccountName = user.username || user.email?.split('@')[0] || user.userId;
      
      console.log('Attempting directory lookup for:', samAccountName);
      
      // Get user details from directory service
      const describeUserResponse = await directoryServiceData.send(new DescribeUserCommand({
        DirectoryId: directoryId,
        SAMAccountName: samAccountName
      }));
      directoryUser = describeUserResponse.User;
      
      console.log('Directory user found:', directoryUser?.SAMAccountName);
      
      // For groups, we'll need to scan all groups and check membership
      // This is a workaround since ListGroupsForMemberCommand seems to have realm issues
      try {
        // Get all groups from DynamoDB
        const groupsCommand = new ScanCommand({
          TableName: process.env.GROUPS_TABLE_NAME
        });
        
        const groupsResult = await dynamodb.send(groupsCommand);
        const allGroups = groupsResult.Items || [];
        
        console.log(`Checking membership in ${allGroups.length} groups`);
        
        // Check membership in each group
        for (const group of allGroups) {
          try {
            const sanitizedGroupName = group.groupName.replace(/[^a-zA-Z0-9\-_.]/g, '');
            const membersResult = await directoryServiceData.send(new ListGroupMembersCommand({
              DirectoryId: directoryId,
              SAMAccountName: sanitizedGroupName
            }));
            
            const members = membersResult.Members?.map(member => member.SAMAccountName) || [];
            if (members.includes(samAccountName)) {
              userGroups.push({
                GroupName: group.groupName,
                Description: group.description
              });
            }
          } catch (groupError) {
            console.log('Could not check group', group.groupName + ':', groupError.message);
          }
        }
        
        console.log('User groups found:', userGroups.length);
      } catch (groupsError) {
        console.error('Error checking group memberships:', groupsError);
      }
      
    } catch (error) {
      console.error('Error getting directory information:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      // Continue without directory info
    }
    
    // Get user's workstations (directly assigned and via groups)
    const workstations = await getUserWorkstations(userId, userGroups);
    
    // Combine all user details
    const details = {
      user: user,
      directoryUser: directoryUser,
      groups: userGroups,
      workstations: workstations
    };
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify(details)
    };
    
  } catch (error) {
    console.error('Error getting LDAP user details:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to get user details' })
    };
  }
}

async function getUserWorkstations(userId, userGroups) {
  try {
    // Get all workstations assigned directly to the user
    const directCommand = new QueryCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      IndexName: 'user-assignment-index',
      KeyConditionExpression: 'assignedUserId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    });
    
    const directResult = await dynamodb.send(directCommand);
    let allWorkstations = [...(directResult.Items || [])];
    
    console.log('Direct workstations found:', directResult.Items?.length || 0);
    
    // Get workstations assigned to user's groups
    if (userGroups && userGroups.length > 0) {
      // First, get all groups to find group IDs for the user's group names
      const groupsCommand = new ScanCommand({
        TableName: process.env.GROUPS_TABLE_NAME
      });
      
      const groupsResult = await dynamodb.send(groupsCommand);
      const allGroups = groupsResult.Items || [];
      
      // Find group IDs for the user's group names
      const userGroupIds = [];
      for (const userGroup of userGroups) {
        const groupName = typeof userGroup === 'object' ? userGroup.GroupName : userGroup;
        const matchingGroup = allGroups.find(g => g.groupName === groupName);
        if (matchingGroup) {
          userGroupIds.push(matchingGroup.groupId);
          console.log(`Found group ID ${matchingGroup.groupId} for group name ${groupName}`);
        }
      }
      
      console.log('User group IDs for workstation access:', userGroupIds);
      
      // Query workstations for each group ID
      for (const groupId of userGroupIds) {
        const groupCommand = new QueryCommand({
          TableName: process.env.WORKSTATION_TABLE_NAME,
          IndexName: 'user-assignment-index',
          KeyConditionExpression: 'assignedUserId = :groupId',
          ExpressionAttributeValues: {
            ':groupId': groupId
          }
        });
        
        const groupResult = await dynamodb.send(groupCommand);
        if (groupResult.Items && groupResult.Items.length > 0) {
          console.log(`Group access: Found ${groupResult.Items.length} workstations for group ${groupId}`);
          allWorkstations.push(...groupResult.Items);
        }
      }
    }
    
    // Remove duplicates by instanceId
    const uniqueWorkstations = allWorkstations.filter((item, index, self) => 
      index === self.findIndex(w => w.instanceId === item.instanceId)
    );
    
    console.log('Total accessible workstations found:', uniqueWorkstations.length);
    return uniqueWorkstations;
  } catch (error) {
    console.error('Error getting user workstations:', error);
    return [];
  }
}
