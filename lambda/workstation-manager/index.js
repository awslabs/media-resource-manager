// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand, DeleteCommand, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { EC2Client, TerminateInstancesCommand, DescribeInstancesCommand, StopInstancesCommand, RebootInstancesCommand, ModifyInstanceAttributeCommand, DescribeVolumesCommand, DescribeImagesCommand, CreateTagsCommand } = require('@aws-sdk/client-ec2');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DirectoryServiceClient, DescribeDirectoriesCommand } = require('@aws-sdk/client-directory-service');
const { DirectoryServiceDataClient, ListGroupMembersCommand } = require('@aws-sdk/client-directory-service-data');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { CognitoIdentityProviderClient, ListUsersCommand } = require('@aws-sdk/client-cognito-identity-provider');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const ec2Client = new EC2Client({ region: process.env.AWS_REGION });
const sfnClient = new SFNClient({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });
const directoryService = new DirectoryServiceClient({ region: process.env.AWS_REGION });
const directoryServiceData = new DirectoryServiceDataClient({ region: process.env.AWS_REGION });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

// Base image SSM parameter mappings - these are AWS public parameters available in all regions
const BASE_IMAGE_SSM_PARAMS = {
  'windows-2025': '/aws/service/ami-windows-latest/Windows_Server-2025-English-Full-Base',
  'windows-2022': '/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base',
  'ubuntu-22.04': '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id'
};

// Cache for base image AMI IDs in primary region (to detect if an AMI is a base image)
let baseImageAmiCache = null;

/**
 * Get the base image AMI IDs for the primary region
 * Returns a map of AMI ID -> SSM parameter name
 */
async function getBaseImageAmiMap() {
  if (baseImageAmiCache) return baseImageAmiCache;
  
  baseImageAmiCache = new Map();
  
  for (const [key, paramName] of Object.entries(BASE_IMAGE_SSM_PARAMS)) {
    try {
      const result = await ssm.send(new GetParameterCommand({ Name: paramName }));
      if (result.Parameter?.Value) {
        baseImageAmiCache.set(result.Parameter.Value, paramName);
      }
    } catch (error) {
      console.warn('Could not fetch base image SSM param', paramName + ':', error.message);
    }
  }
  
  // Also check for Rocky Linux 8 (not SSM-based, but auto-generated)
  try {
    const rocky8Result = await ec2Client.send(new DescribeImagesCommand({
      Owners: ['792107900819'],
      Filters: [
        { Name: 'name', Values: ['Rocky-8-EC2-Base-8*x86_64*'] },
        { Name: 'state', Values: ['available'] },
        { Name: 'architecture', Values: ['x86_64'] }
      ]
    }));
    const rocky8Images = rocky8Result.Images?.sort((a, b) => 
      new Date(b.CreationDate) - new Date(a.CreationDate)
    ) || [];
    if (rocky8Images.length > 0) {
      // Rocky Linux uses EC2 DescribeImages, not SSM - mark it specially
      baseImageAmiCache.set(rocky8Images[0].ImageId, 'rocky-8');
    }
  } catch (error) {
    console.warn('Could not fetch Rocky Linux 8 AMI:', error.message);
  }
  
  console.log('Base image AMI cache populated:', [...baseImageAmiCache.entries()]);
  return baseImageAmiCache;
}

/**
 * Resolve a base image AMI ID for a target region
 * If the AMI is a base image (SSM-based), resolve the SSM parameter in the target region
 * Returns the regional AMI ID, or the original AMI ID if not a base image
 */
async function resolveBaseImageForRegion(amiId, targetRegion) {
  const baseImageMap = await getBaseImageAmiMap();
  const ssmParamName = baseImageMap.get(amiId);
  
  if (!ssmParamName) {
    // Not a base image, return original AMI ID
    return { isBaseImage: false, regionalAmiId: amiId };
  }
  
  // It's a base image - resolve in target region
  console.log(`AMI ${amiId} is a base image (${ssmParamName}), resolving for region ${targetRegion}`);
  
  if (ssmParamName === 'rocky-8') {
    // Rocky Linux uses EC2 DescribeImages in the target region
    try {
      const regionalEc2 = new EC2Client({ region: targetRegion });
      const rocky8Result = await regionalEc2.send(new DescribeImagesCommand({
        Owners: ['792107900819'],
        Filters: [
          { Name: 'name', Values: ['Rocky-8-EC2-Base-8*x86_64*'] },
          { Name: 'state', Values: ['available'] },
          { Name: 'architecture', Values: ['x86_64'] }
        ]
      }));
      const rocky8Images = rocky8Result.Images?.sort((a, b) => 
        new Date(b.CreationDate) - new Date(a.CreationDate)
      ) || [];
      if (rocky8Images.length > 0) {
        console.log(`Resolved Rocky Linux 8 AMI for ${targetRegion}: ${rocky8Images[0].ImageId}`);
        return { isBaseImage: true, regionalAmiId: rocky8Images[0].ImageId };
      }
    } catch (error) {
      console.error('Failed to resolve Rocky Linux 8 AMI for', targetRegion + ':', error.message);
    }
    return { isBaseImage: true, regionalAmiId: amiId }; // Fallback to original
  }
  
  // SSM-based base image - resolve in target region
  try {
    const regionalSsm = new SSMClient({ region: targetRegion });
    const result = await regionalSsm.send(new GetParameterCommand({ Name: ssmParamName }));
    if (result.Parameter?.Value) {
      console.log(`Resolved base image ${ssmParamName} for ${targetRegion}: ${result.Parameter.Value}`);
      return { isBaseImage: true, regionalAmiId: result.Parameter.Value };
    }
  } catch (error) {
    console.error('Failed to resolve SSM param', ssmParamName, 'for', targetRegion + ':', error.message);
  }
  
  return { isBaseImage: true, regionalAmiId: amiId }; // Fallback to original
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

// Helper function to get directory ID
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

// Helper function to get Cognito User Pool ID
async function getCognitoUserPoolId() {
  try {
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    // Try the Auth path first (where it's actually stored)
    const parameterName = `/${pascalCaseName}/Auth/UserPoolId`;
    const result = await ssm.send(new GetParameterCommand({
      Name: parameterName
    }));
    return result.Parameter.Value;
  } catch (error) {
    console.log('Could not get Cognito User Pool ID:', error.message);
    return null;
  }
}

// Helper function to get Cognito users for display name resolution
async function getCognitoUsersForDisplay() {
  try {
    const userPoolId = await getCognitoUserPoolId();
    if (!userPoolId) return [];

    const users = [];
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
      
      for (const user of result.Users || []) {
        const attributes = {};
        (user.Attributes || []).forEach(attr => {
          attributes[attr.Name] = attr.Value;
        });

        // Build user object with display info
        const email = attributes.email || '';
        const emailPrefix = email.split('@')[0].toLowerCase();
        const firstName = attributes.given_name || '';
        const lastName = attributes.family_name || '';
        // Build display name from available attributes
        let displayName = null;
        if (firstName && lastName) {
          displayName = `${firstName} ${lastName}`;
        } else if (firstName) {
          displayName = firstName;
        } else if (lastName) {
          displayName = lastName;
        }
        
        users.push({
          userId: user.Username,
          email: email,
          emailPrefix: emailPrefix,
          firstName: firstName,
          lastName: lastName,
          displayName: displayName
        });
      }

      paginationToken = result.PaginationToken;
    } while (paginationToken);

    return users;
  } catch (error) {
    console.log('Could not fetch Cognito users:', error.message);
    return [];
  }
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const { httpMethod: method, path, body } = event;
  
  try {
    switch (method) {
      case 'GET':
        if (path === '/workstations') {
          return await getWorkstations(event);
        } else if (path.startsWith('/workstations/')) {
          return await getWorkstationDetails(path.split('/')[2], event);
        }
        break;
      case 'POST':
        if (path === '/workstations') {
          const parsedBody = JSON.parse(body);
          // Handle both formats: {workstations: [...]} and direct workstation object
          if (parsedBody.workstations && Array.isArray(parsedBody.workstations)) {
            // Process each workstation in the array
            const results = [];
            for (const workstation of parsedBody.workstations) {
              const result = await createWorkstation(workstation);
              results.push(JSON.parse(result.body));
            }
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
              body: JSON.stringify({ results })
            };
          } else {
            // Direct workstation object (backward compatibility)
            return await createWorkstation(parsedBody);
          }
        } else if (path === '/workstations/start') {
          return await startWorkstation(JSON.parse(body));
        } else if (path === '/workstations/stop') {
          return await stopWorkstation(JSON.parse(body));
        } else if (path === '/workstations/reboot') {
          return await rebootWorkstation(JSON.parse(body));
        } else if (path === '/workstations/change-instance-type') {
          return await changeInstanceType(JSON.parse(body));
        } else if (path === '/workstations/volumes/resize' ||
                   path === '/workstations/volumes/add' ||
                   path === '/workstations/volumes/detach') {
          return await invokeVolumeManager(path, JSON.parse(body));
        }
        break;
      case 'PUT':
        if (path.startsWith('/workstations/')) {
          return await updateWorkstation(path.split('/')[2], JSON.parse(body));
        } else if (path === '/workstations') {
          const { instanceId, assignedUserId } = JSON.parse(body);
          return await updateWorkstation(instanceId, { assignedUserId });
        }
        break;
      case 'DELETE':
        if (path.startsWith('/workstations/')) {
          return await deleteWorkstation(path.split('/')[2]);
        }
        break;
    }
    
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Not found' })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: error.message })
    };
  }
};

async function getWorkstations(event) {
  // Extract user information from authorizer context
  const authorizerContext = event.requestContext?.authorizer || {};
  const isAdmin = authorizerContext.isAdmin === 'true';
  const currentUserId = authorizerContext.username;
  const tokenType = authorizerContext.tokenType || 'ldap';
  
  console.log('User:', currentUserId);
  console.log('Is admin:', isAdmin);
  console.log('Token type:', tokenType);
  
  if (!currentUserId) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }
  
  console.log('Querying workstations for user:', currentUserId);
  
  let result;
  
  try {
    if (isAdmin) {
      // Admins see all workstations
      console.log('Admin user - scanning all workstations');
      console.log('Table name:', process.env.WORKSTATION_TABLE_NAME);
      
      result = await dynamodb.send(new ScanCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME
      }));
      
      console.log('Scan completed, found items:', result.Items?.length || 0);
    } else if (currentUserId) {
      // Regular users see workstations assigned to them directly OR to their groups
      // For Cognito users (Identity Center/Okta), use the full username
      // For LDAP users, strip the domain part
      const userIdForQuery = tokenType === 'cognito' 
        ? currentUserId 
        : (currentUserId.includes('@') ? currentUserId.split('@')[0] : currentUserId);
      console.log('Querying workstations for user:', userIdForQuery);
      
      // Get user's groups
      let userGroups = [];
      try {
        if (tokenType === 'cognito') {
          // Cognito mode: check group memberships in DynamoDB
          const groupsResult = await dynamodb.send(new ScanCommand({
            TableName: process.env.GROUPS_TABLE_NAME
          }));
          
          console.log(`Checking DynamoDB group memberships for user: ${userIdForQuery}`);
          
          // Build variants for group membership check (with and without IdP prefix)
          const memberVariants = [userIdForQuery];
          if (userIdForQuery.includes('_')) {
            const stripped = userIdForQuery.split('_').slice(1).join('_');
            if (stripped && stripped !== userIdForQuery) memberVariants.push(stripped);
          }
          
          for (const group of groupsResult.Items || []) {
            const members = group.members || [];
            if (memberVariants.some(v => members.includes(v))) {
              console.log(`User ${userIdForQuery} is member of group ${group.groupName}`);
              userGroups.push(group.groupId);
            }
          }
        } else {
          // LDAP mode: check group memberships via Directory Services
          const directoryId = await getDirectoryId();
          
          // Get all groups and check which ones this user belongs to
          const groupsResult = await dynamodb.send(new ScanCommand({
            TableName: process.env.GROUPS_TABLE_NAME
          }));
          
          console.log(`Checking Directory Services group memberships for user: ${userIdForQuery}`);
          
          // For each group, check if user is a member via Directory Services
          for (const group of groupsResult.Items || []) {
            try {
              const sanitizedGroupName = group.groupName.replace(/[^a-zA-Z0-9\-_.]/g, '');
              console.log(`Checking membership in group: ${sanitizedGroupName}`);
              
              const membersResult = await directoryServiceData.send(new ListGroupMembersCommand({
                DirectoryId: directoryId,
                SAMAccountName: sanitizedGroupName
              }));
              
              const members = membersResult.Members?.map(member => member.SAMAccountName) || [];
              console.log('Group', sanitizedGroupName, 'members:', members);
              
              if (members.includes(userIdForQuery)) {
                console.log(`User ${userIdForQuery} is member of group ${sanitizedGroupName}`);
                userGroups.push(group.groupId);
              }
            } catch (error) {
              console.log('Error checking membership for group', group.groupName + ':', error);
            }
          }
        }
        
        console.log('User groups from Directory Services:', userGroups);
      } catch (error) {
        console.log('Could not fetch user groups from Directory Services:', error);
      }
      
      // Query workstations assigned directly to user
      // Also query with stripped userId (without IdP prefix) to handle workstations
      // assigned before the user first logged in via Cognito (Identity Center sync
      // stores userId without the "IdentityCenter_" prefix, but after login the
      // Cognito username includes it)
      const userIdVariants = [userIdForQuery];
      if (userIdForQuery.includes('_')) {
        const strippedId = userIdForQuery.split('_').slice(1).join('_');
        if (strippedId && strippedId !== userIdForQuery) {
          userIdVariants.push(strippedId);
        }
      }
      console.log('Querying GSI with userId variants:', userIdVariants);
      
      const directQueries = userIdVariants.map(uid =>
        dynamodb.send(new QueryCommand({
          TableName: process.env.WORKSTATION_TABLE_NAME,
          IndexName: 'user-assignment-index',
          KeyConditionExpression: 'assignedUserId = :userId',
          ExpressionAttributeValues: {
            ':userId': uid
          }
        }))
      );
      const directResults = await Promise.all(directQueries);
      const directAssignments = { Items: directResults.flatMap(r => r.Items || []) };
      
      let groupAssignments = { Items: [] };
      
      // Query workstations assigned to user's groups
      if (userGroups.length > 0) {
        console.log('Querying workstations for groups:', userGroups);
        const groupQueries = userGroups.map(groupId => 
          dynamodb.send(new QueryCommand({
            TableName: process.env.WORKSTATION_TABLE_NAME,
            IndexName: 'user-assignment-index',
            KeyConditionExpression: 'assignedUserId = :groupId',
            ExpressionAttributeValues: {
              ':groupId': groupId
            }
          }))
        );
        
        const groupResults = await Promise.all(groupQueries);
        const allGroupItems = groupResults.flatMap(result => result.Items || []);
        groupAssignments = { Items: allGroupItems };
        console.log('Found group workstations:', allGroupItems.length);
      }
      
      // Combine direct and group assignments (remove duplicates by instanceId)
      const allItems = [...(directAssignments.Items || []), ...(groupAssignments.Items || [])];
      const uniqueItems = allItems.filter((item, index, self) => 
        index === self.findIndex(i => i.instanceId === item.instanceId)
      );
      
      result = { Items: uniqueItems };
      console.log('Total workstations (direct + group):', result.Items.length);
    } else {
      result = { Items: [] };
    }
    
    const workstations = result.Items || [];
    
    // Enrich with EC2 instance status (handling cross-region workstations)
    if (workstations.length > 0) {
      // Group workstations by region, skipping already-terminated instances
      const workstationsByRegion = {};
      workstations.forEach(w => {
        if (w.instanceId && w.instanceStatus !== 'terminated') {
          const region = w.region || process.env.AWS_REGION;
          if (!workstationsByRegion[region]) {
            workstationsByRegion[region] = [];
          }
          workstationsByRegion[region].push(w.instanceId);
        }
      });
      
      const statusMap = {};
      
      // Query EC2 in each region with retry for InvalidInstanceID.NotFound
      for (const [region, allInstanceIds] of Object.entries(workstationsByRegion)) {
        let remainingIds = [...allInstanceIds];
        const regionalEc2 = region !== process.env.AWS_REGION 
          ? new EC2Client({ region }) 
          : ec2Client;
        
        while (remainingIds.length > 0) {
          try {
            const ec2Result = await regionalEc2.send(new DescribeInstancesCommand({
              InstanceIds: remainingIds
            }));
            
            ec2Result.Reservations?.forEach(reservation => {
              reservation.Instances?.forEach(instance => {
                statusMap[instance.InstanceId] = instance.State?.Name || 'unknown';
              });
            });
            break; // Success — exit retry loop
          } catch (error) {
            if (error.Code === 'InvalidInstanceID.NotFound' || error.name === 'InvalidInstanceID.NotFound') {
              // Parse the bad instance IDs from the error message
              const match = error.message?.match(/instance IDs? '([^']+)'/i);
              if (match) {
                const badIds = match[1].split(',').map(id => id.trim());
                console.log(`Instances not found in EC2 (region ${region}): ${badIds.join(', ')} — marking as terminated`);
                badIds.forEach(id => { statusMap[id] = 'terminated'; });
                remainingIds = remainingIds.filter(id => !badIds.includes(id));
                continue; // Retry with remaining IDs
              }
            }
            // Non-retryable error — keep DynamoDB values, don't overwrite with 'unknown'
            console.log('Error fetching EC2 status for region', region + ':', error.message || error);
            break;
          }
        }
      }
      
      // Apply status to workstations (only overwrite if we have data, never default to 'unknown')
      workstations.forEach(workstation => {
        if (workstation.instanceId && statusMap[workstation.instanceId] !== undefined) {
          workstation.instanceStatus = statusMap[workstation.instanceId];
        }
      });
      
      // Self-heal DynamoDB for instances discovered as terminated
      workstations.forEach(workstation => {
        if (workstation.instanceStatus === 'terminated' && workstation.status !== 'Terminated') {
          workstation.status = 'Terminated';
          workstation.dcvStatus = 'stopped';
          // Fire-and-forget DynamoDB update
          dynamodb.send(new UpdateCommand({
            TableName: process.env.WORKSTATION_TABLE_NAME,
            Key: { instanceId: workstation.instanceId },
            UpdateExpression: 'SET instanceStatus = :ist, #status = :wst, dcvStatus = :dcv, updatedAt = :ts REMOVE dcvSessionId, sessionState',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':ist': 'terminated',
              ':wst': 'Terminated',
              ':dcv': 'stopped',
              ':ts': new Date().toISOString(),
            },
          })).catch(err => console.warn('Failed to self-heal workstation', workstation.instanceId + ':', err.message));
        }
      });
    }
    
    // Fetch groups and users for resolution
    try {
      const groupsResult = await dynamodb.send(new ScanCommand({
        TableName: process.env.GROUPS_TABLE_NAME
      }));
      const groups = groupsResult.Items || [];
      
      const usersResult = await dynamodb.send(new ScanCommand({
        TableName: process.env.USER_TABLE_NAME
      }));
      const users = usersResult.Items || [];
      
      // Get Cognito users for fallback display name resolution
      const cognitoUsers = await getCognitoUsersForDisplay();
      
      // Helper function to format Cognito usernames for display
      // Strips IdP prefix (e.g., "IdentityCenter_") and domain suffix (e.g., "@amazon.com")
      const formatUserIdForDisplay = (userId) => {
        if (!userId) return userId;
        let displayName = userId;
        // Strip IdP prefixes (IdentityCenter_, Okta_, etc.)
        if (displayName.includes('_')) {
          const parts = displayName.split('_');
          // Only strip if it looks like an IdP prefix (first part is a known provider)
          const knownPrefixes = ['IdentityCenter', 'Okta', 'SAML', 'AzureAD', 'AmazonFederate'];
          if (knownPrefixes.includes(parts[0])) {
            displayName = parts.slice(1).join('_');
          }
        }
        // Strip domain suffix for cleaner display
        if (displayName.includes('@')) {
          displayName = displayName.split('@')[0];
        }
        return displayName;
      };
      
      // Helper function to find a user by various ID formats (checks DynamoDB first, then Cognito)
      const findUserByAssignedId = (assignedUserId) => {
        if (!assignedUserId) return null;
        
        // Try exact match in DynamoDB users first
        let user = users.find(u => u.userId === assignedUserId);
        if (user) return user;
        
        // Try matching by email (assignedUserId might be just username, user.userId might be full email)
        const formattedAssignedId = formatUserIdForDisplay(assignedUserId).toLowerCase();
        user = users.find(u => {
          const formattedUserId = formatUserIdForDisplay(u.userId).toLowerCase();
          return formattedUserId === formattedAssignedId;
        });
        if (user) return user;
        
        // Try matching by email prefix in DynamoDB
        user = users.find(u => {
          if (u.email) {
            const emailPrefix = u.email.split('@')[0].toLowerCase();
            return emailPrefix === formattedAssignedId;
          }
          return false;
        });
        if (user) return user;
        
        // Fallback: Check Cognito users
        // Try exact match by username
        let cognitoUser = cognitoUsers.find(u => u.userId === assignedUserId);
        if (cognitoUser) return cognitoUser;
        
        // Try matching by formatted username in Cognito (strip IdP prefix and domain from both sides)
        cognitoUser = cognitoUsers.find(u => {
          const formattedCognitoId = formatUserIdForDisplay(u.userId).toLowerCase();
          return formattedCognitoId === formattedAssignedId;
        });
        if (cognitoUser) return cognitoUser;
        
        // Try matching by email prefix in Cognito
        cognitoUser = cognitoUsers.find(u => u.emailPrefix === formattedAssignedId);
        if (cognitoUser) return cognitoUser;
        
        // Try matching by full email in Cognito
        if (assignedUserId.includes('@')) {
          cognitoUser = cognitoUsers.find(u => u.email.toLowerCase() === assignedUserId.toLowerCase());
          if (cognitoUser) return cognitoUser;
        }
        
        return null;
      };
      
      // Resolve assignedUserId to display names
      workstations.forEach(workstation => {
        if (workstation.assignedUserId) {
          // Check if it's a group ID (may have "group:" prefix from assignment)
          const assignedId = workstation.assignedUserId;
          const groupIdToCheck = assignedId.startsWith('group:') ? assignedId.substring(6) : assignedId;
          const group = groups.find(g => g.groupId === groupIdToCheck || g.groupId === assignedId);
          if (group) {
            workstation.assignedUserDisplay = `${group.groupName} (Group)`;
            workstation.isGroupAssignment = true;
            workstation.resolvedGroupId = group.groupId;
          } else {
            // Check if it's a user ID in our users table or Cognito
            const user = findUserByAssignedId(workstation.assignedUserId);
            if (user) {
              // Always construct as "firstName lastName" for consistent formatting
              // (Identity Center displayName is often "lastName, firstName" which we don't want)
              if (user.firstName && user.lastName) {
                workstation.assignedUserDisplay = `${user.firstName} ${user.lastName}`;
              } else if (user.displayName) {
                workstation.assignedUserDisplay = user.displayName;
              } else {
                workstation.assignedUserDisplay = user.firstName || user.lastName || formatUserIdForDisplay(workstation.assignedUserId);
              }
            } else {
              // User not found anywhere - format the ID for display
              workstation.assignedUserDisplay = formatUserIdForDisplay(workstation.assignedUserId);
            }
          }
        } else {
          workstation.assignedUserDisplay = 'Unassigned';
        }
      });
    } catch (error) {
      console.log('Could not fetch groups/users for resolution:', error);
      // Continue without group resolution
    }
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify(workstations)
    };
  } catch (error) {
    console.error('Error fetching workstations:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to fetch workstations' })
    };
  }
}

async function getWorkstationDetails(instanceId, event) {
  try {
    // Extract user information from authorizer context
    const authorizerContext = event.requestContext?.authorizer || {};
    const userId = authorizerContext.userId;
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    // Get workstation from DynamoDB to check permissions
    const getCommand = new GetCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId }
    });
    
    const workstationResult = await dynamodb.send(getCommand);
    
    if (!workstationResult.Item) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Workstation not found' })
      };
    }
    
    const workstation = workstationResult.Item;
    
    // Check permissions - admin can see all, users can only see their assigned workstations
    if (!isAdmin && workstation.assignedUserId !== userId) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Access denied' })
      };
    }
    
    // Create EC2 client for the appropriate region
    const region = workstation.region;
    const ec2 = region && region !== process.env.AWS_REGION 
      ? new EC2Client({ region }) 
      : ec2Client;
    
    // Get EC2 instance details (may not exist if terminated and purged)
    let instance = null;
    try {
      const describeCommand = new DescribeInstancesCommand({
        InstanceIds: [instanceId]
      });
      
      const ec2Result = await ec2.send(describeCommand);
      
      if (ec2Result.Reservations?.[0]?.Instances?.[0]) {
        instance = ec2Result.Reservations[0].Instances[0];
        
        // Sync any drifted EC2 attributes back to DynamoDB.
        // Catches out-of-band changes made directly in the EC2 console
        // (e.g. instance type change, IP reassignment).
        const updates = {};
        if (instance.InstanceType && instance.InstanceType !== workstation.instanceType) {
          updates.instanceType = instance.InstanceType;
        }
        if (instance.PrivateIpAddress && instance.PrivateIpAddress !== workstation.privateIpAddress) {
          updates.privateIpAddress = instance.PrivateIpAddress;
        }
        if ((instance.PublicIpAddress || null) !== (workstation.publicIpAddress || null)) {
          updates.publicIpAddress = instance.PublicIpAddress || null;
        }

        if (Object.keys(updates).length > 0) {
          console.log(`Syncing drifted EC2 attributes for ${instanceId}:`, updates);
          const updateExprParts = Object.keys(updates).map((k, i) => `#f${i} = :v${i}`);
          const exprNames = Object.fromEntries(Object.keys(updates).map((k, i) => [`#f${i}`, k]));
          const exprValues = Object.fromEntries(Object.keys(updates).map((k, i) => [`:v${i}`, updates[k]]));
          exprValues[':updatedAt'] = new Date().toISOString();

          // Fire-and-forget — don't block the response
          dynamodb.send(new UpdateCommand({
            TableName: process.env.WORKSTATION_TABLE_NAME,
            Key: { instanceId },
            UpdateExpression: `SET ${updateExprParts.join(', ')}, updatedAt = :updatedAt`,
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: exprValues,
            ConditionExpression: 'attribute_exists(instanceId)'
          })).catch(err => console.error(`Failed to sync EC2 attributes for ${instanceId}:`, err));

          // Merge live values into workstation so response is immediately correct
          Object.assign(workstation, updates);
        }

        // Get volume details for size information
        const volumeIds = instance.BlockDeviceMappings?.map(bdm => bdm.Ebs?.VolumeId).filter(Boolean) || [];
        let volumes = [];
        
        if (volumeIds.length > 0) {
          const volumesResult = await ec2.send(new DescribeVolumesCommand({
            VolumeIds: volumeIds
          }));
          volumes = volumesResult.Volumes || [];
        }
        
        // Enhance BlockDeviceMappings with volume size
        if (instance.BlockDeviceMappings && volumes.length > 0) {
          instance.BlockDeviceMappings = instance.BlockDeviceMappings.map(bdm => {
            const volume = volumes.find(v => v.VolumeId === bdm.Ebs?.VolumeId);
            return {
              ...bdm,
              Ebs: {
                ...bdm.Ebs,
                VolumeSize: volume?.Size
              }
            };
          });
        }
      }
    } catch (ec2Error) {
      // Instance terminated and purged from EC2 — return DynamoDB data only
      console.log(`EC2 instance ${instanceId} not found: ${ec2Error.message}`);
    }
    
    // Combine workstation metadata with EC2 details
    const details = {
      workstation: workstation,
      ec2Instance: instance
    };
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify(details)
    };
    
  } catch (error) {
    console.error('Error getting workstation details:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to get workstation details' })
    };
  }
}

async function createWorkstation(data) {
  const { amiId, instanceType, assignedUserId, domainId, rootVolumeSize, pipelineId, acronym, joinDomain, platform, region } = data;
  
  // Default joinDomain to true for backward compatibility (only applies to Windows)
  const shouldJoinDomain = joinDomain !== false;
  
  console.log('Starting workstation creation via Step Functions:', { amiId, instanceType, assignedUserId, domainId, rootVolumeSize, pipelineId, acronym, joinDomain: shouldJoinDomain, platform, region });
  
  try {
    // If a satellite region is specified, look up regional configuration
    let regionalConfig = null;
    const targetRegion = region || process.env.AWS_REGION;
    
    if (region && region !== process.env.AWS_REGION) {
      console.log(`Looking up regional configuration for ${region}`);
      try {
        const regionalHubResult = await dynamodb.send(new GetCommand({
          TableName: process.env.REGIONAL_HUBS_TABLE_NAME,
          Key: { region }
        }));
        
        if (!regionalHubResult.Item) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            body: JSON.stringify({ error: `Regional hub not found for region: ${region}` })
          };
        }
        
        if (regionalHubResult.Item.status !== 'available') {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            body: JSON.stringify({ error: `Regional hub ${region} is not available (status: ${regionalHubResult.Item.status})` })
          };
        }
        
        regionalConfig = regionalHubResult.Item;
        console.log(`Regional config found:`, JSON.stringify(regionalConfig, null, 2));
        
        // Check if the AMI is available in the target region
        if (regionalConfig.amis && regionalConfig.amis[amiId]) {
          const regionalAmi = regionalConfig.amis[amiId];
          if (regionalAmi.status !== 'available') {
            return {
              statusCode: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
              body: JSON.stringify({ error: `AMI ${amiId} is not yet available in ${region} (status: ${regionalAmi.status})` })
            };
          }
        } else {
          console.log(`Warning: AMI ${amiId} not found in regional hub AMI mappings, will attempt to use source AMI ID`);
        }
      } catch (error) {
        console.error('Error looking up regional hub:', error);
        return {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: `Failed to look up regional hub: ${error.message}` })
        };
      }
    }
    // Determine platform from AMI if not provided
    let detectedPlatform = platform;
    
    if (!detectedPlatform) {
      // Check if AMI is in our images table with platform info
      try {
        const amiResult = await dynamodb.send(new GetCommand({
          TableName: process.env.AMI_TABLE_NAME,
          Key: { amiId }
        }));
        
        if (amiResult.Item && amiResult.Item.platform) {
          detectedPlatform = amiResult.Item.platform;
          console.log(`Platform detected from images table: ${detectedPlatform}`);
        }
      } catch (error) {
        console.log('Could not fetch AMI platform from images table:', error.message);
      }
      
      // If still no platform, check EC2 AMI details
      if (!detectedPlatform) {
        try {
          const { DescribeImagesCommand } = require('@aws-sdk/client-ec2');
          const ec2Result = await ec2Client.send(new DescribeImagesCommand({
            ImageIds: [amiId]
          }));
          
          if (ec2Result.Images && ec2Result.Images.length > 0) {
            const image = ec2Result.Images[0];
            
            // Check name first for macOS (macOS AMIs have PlatformDetails: Linux/UNIX)
            if (image.Name) {
              const nameLower = image.Name.toLowerCase();
              if (nameLower.includes('macos') || nameLower.includes('mac-')) {
                detectedPlatform = 'macOS';
              }
            }
            
            // If not macOS, check platform details from EC2
            if (!detectedPlatform && image.PlatformDetails) {
              if (image.PlatformDetails.toLowerCase().includes('linux')) {
                detectedPlatform = 'Linux';
              } else if (image.PlatformDetails.toLowerCase().includes('windows')) {
                detectedPlatform = 'Windows';
              }
            }
            
            // Fallback to name-based detection for Linux/Windows
            if (!detectedPlatform && image.Name) {
              const nameLower = image.Name.toLowerCase();
              if (nameLower.includes('ubuntu') || nameLower.includes('linux') || nameLower.includes('amazon-linux') || nameLower.includes('amzn') || nameLower.includes('rocky') || nameLower.includes('centos') || nameLower.includes('rhel')) {
                detectedPlatform = 'Linux';
              } else if (nameLower.includes('windows')) {
                detectedPlatform = 'Windows';
              }
            }
            console.log(`Platform detected from EC2 AMI: ${detectedPlatform}`);
          }
        } catch (error) {
          console.log('Could not fetch AMI details from EC2:', error.message);
        }
      }
    }
    
    // Fail explicitly if platform cannot be determined
    if (!detectedPlatform) {
      console.error(`Platform could not be determined for AMI: ${amiId}`);
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ 
          error: `Platform could not be determined for AMI ${amiId}. Please ensure the image has a platform defined in the images table or pass the platform explicitly in the request.` 
        })
      };
    }
    
    // Select the appropriate state machine based on platform (case-insensitive check)
    const platformLower = detectedPlatform.toLowerCase();
    console.log(`Platform detection complete - original: "${platform}", detected: "${detectedPlatform}", normalized: "${platformLower}"`);
    
    let stateMachineArn;
    if (platformLower === 'linux') {
      stateMachineArn = process.env.LINUX_STATE_MACHINE_ARN;
      console.log(`Selected LINUX state machine: ${stateMachineArn}`);
    } else if (platformLower === 'macos') {
      stateMachineArn = process.env.MACOS_STATE_MACHINE_ARN;
      console.log(`Selected MACOS state machine: ${stateMachineArn}`);
      if (!stateMachineArn) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'macOS workstation creation is not yet configured' })
        };
      }
    } else {
      stateMachineArn = process.env.STATE_MACHINE_ARN;
      console.log(`Selected WINDOWS (default) state machine: ${stateMachineArn}`);
    }
    
    console.log(`Using ${detectedPlatform} state machine: ${stateMachineArn}`);
    
    // Determine the effective AMI ID for the target region
    let effectiveAmiId = amiId;
    if (region && region !== process.env.AWS_REGION) {
      // Check if this is a base image that needs regional resolution
      const baseImageResult = await resolveBaseImageForRegion(amiId, region);
      if (baseImageResult.isBaseImage) {
        effectiveAmiId = baseImageResult.regionalAmiId;
        console.log(`Base image resolved for ${region}: ${amiId} -> ${effectiveAmiId}`);
      } else if (regionalConfig?.amis?.[amiId]?.targetAmiId) {
        // Use replicated AMI from regional hub mapping
        effectiveAmiId = regionalConfig.amis[amiId].targetAmiId;
        console.log(`Replicated AMI found for ${region}: ${amiId} -> ${effectiveAmiId}`);
      }
    }
    
    const executionInput = {
      amiId,
      instanceType,
      assignedUserId,
      domainId,
      rootVolumeSize,
      pipelineId,
      acronym,
      joinDomain: platformLower === 'windows' ? shouldJoinDomain : false, // Only Windows supports domain join
      platform: detectedPlatform,
      region: targetRegion,
      // Include regional config for satellite regions
      ...(regionalConfig && {
        regionalConfig: {
          vpcId: regionalConfig.vpcId,
          // subnetMappings format: array of "subnet-id:az-id" strings for macOS Lambda
          subnetMappings: Array.isArray(regionalConfig.subnetIds) 
            ? regionalConfig.subnetIds 
            : (regionalConfig.subnetIds ? regionalConfig.subnetIds.split(',') : []),
          securityGroupId: regionalConfig.workstationSecurityGroupId,
          launchTemplateId: regionalConfig.launchTemplateId,
          hostResourceGroupArn: regionalConfig.hostResourceGroupArn,
          instanceProfileName: regionalConfig.instanceProfileName,
          // Use the resolved regional AMI ID
          regionalAmiId: effectiveAmiId
        }
      })
    };
    
    const executionName = `workstation-${assignedUserId}-${Date.now()}`;
    
    const result = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: stateMachineArn,
      name: executionName,
      input: JSON.stringify(executionInput)
    }));
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ 
        message: 'Workstation creation started',
        executionArn: result.executionArn,
        platform: detectedPlatform
      })
    };
  } catch (error) {
    console.error('Error creating workstation:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to create workstation' })
    };
  }
}

async function updateWorkstation(instanceId, updateData) {
  try {
    const updateExpression = [];
    const removeExpression = [];
    const expressionAttributeValues = {};
    
    if (updateData.assignedUserId !== undefined) {
      // If assignedUserId is empty string or null, remove the attribute entirely
      // This is required because DynamoDB GSI partition keys cannot be empty strings
      if (updateData.assignedUserId === '' || updateData.assignedUserId === null) {
        removeExpression.push('assignedUserId');
      } else {
        updateExpression.push('assignedUserId = :assignedUserId');
        expressionAttributeValues[':assignedUserId'] = updateData.assignedUserId;
      }
    }
    
    if (updateData.storageConfig !== undefined) {
      updateExpression.push('storageConfig = :storageConfig');
      expressionAttributeValues[':storageConfig'] = updateData.storageConfig;
    }
    
    if (updateData.workstationName !== undefined) {
      updateExpression.push('workstationName = :workstationName');
      expressionAttributeValues[':workstationName'] = updateData.workstationName;
      
      // Update EC2 Name tag
      try {
        await ec2Client.send(new CreateTagsCommand({
          Resources: [instanceId],
          Tags: [{ Key: 'Name', Value: updateData.workstationName }],
        }));
      } catch (tagError) {
        console.warn('Failed to update EC2 Name tag:', tagError.message);
      }
    }
    
    if (updateExpression.length === 0 && removeExpression.length === 0) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'No valid update fields provided' })
      };
    }
    
    // Build the update expression
    let fullUpdateExpression = '';
    if (updateExpression.length > 0) {
      fullUpdateExpression = `SET ${updateExpression.join(', ')}`;
    }
    if (removeExpression.length > 0) {
      fullUpdateExpression += (fullUpdateExpression ? ' ' : '') + `REMOVE ${removeExpression.join(', ')}`;
    }
    
    const updateParams = {
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId },
      UpdateExpression: fullUpdateExpression
    };
    
    // Only add ExpressionAttributeValues if there are values to set
    if (Object.keys(expressionAttributeValues).length > 0) {
      updateParams.ExpressionAttributeValues = expressionAttributeValues;
    }
    
    await dynamodb.send(new UpdateCommand(updateParams));
    
    // If storage config was updated, trigger the appropriate mount manager based on platform
    if (updateData.storageConfig !== undefined) {
      // Get workstation to determine platform
      const workstationResult = await dynamodb.send(new GetCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        Key: { instanceId }
      }));
      const workstation = workstationResult.Item;
      const platform = workstation?.platform?.toLowerCase() || 'windows';
      
      // Trigger SMB mount manager for Windows
      if (platform === 'windows' && process.env.FSX_SMB_MOUNT_MANAGER_FUNCTION_ARN) {
        try {
          await lambdaClient.send(new InvokeCommand({
            FunctionName: process.env.FSX_SMB_MOUNT_MANAGER_FUNCTION_ARN,
            InvocationType: 'Event', // Async invocation
            Payload: JSON.stringify({
              action: 'updateInstance',
              instanceId: instanceId
            })
          }));
          console.log(`FSx SMB mount manager triggered for Windows instance ${instanceId}`);
        } catch (error) {
          console.error('Failed to trigger FSx SMB mount manager for instance', instanceId + ':', error);
        }
      }
      
      // Trigger NFS mount manager for Linux/macOS
      if ((platform === 'linux' || platform === 'macos') && process.env.FSX_NFS_MOUNT_MANAGER_FUNCTION_ARN) {
        try {
          await lambdaClient.send(new InvokeCommand({
            FunctionName: process.env.FSX_NFS_MOUNT_MANAGER_FUNCTION_ARN,
            InvocationType: 'Event', // Async invocation
            Payload: JSON.stringify({
              action: 'updateInstance',
              instanceId: instanceId
            })
          }));
          console.log(`FSx NFS mount manager triggered for ${platform} instance ${instanceId}`);
        } catch (error) {
          console.error('Failed to trigger FSx NFS mount manager for instance', instanceId + ':', error);
        }
      }
    }
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ message: 'Workstation updated successfully' })
    };
  } catch (error) {
    console.error('Error updating workstation:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to update workstation' })
    };
  }
}

async function deleteWorkstation(instanceId) {
  try {
    // Get workstation record to determine region
    const workstationResult = await dynamodb.send(new GetCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId }
    }));
    
    const region = workstationResult.Item?.region;
    
    // Create EC2 client for the appropriate region
    const ec2 = region && region !== process.env.AWS_REGION 
      ? new EC2Client({ region }) 
      : ec2Client;
    
    // Terminate the EC2 instance (ignore errors if already terminated/gone)
    try {
      await ec2.send(new TerminateInstancesCommand({
        InstanceIds: [instanceId]
      }));
    } catch (ec2Error) {
      // Instance already terminated or purged from EC2 — that's fine, just clean up DynamoDB
      console.log(`EC2 terminate skipped for ${instanceId}: ${ec2Error.message}`);
    }
    
    // Remove from DynamoDB
    await dynamodb.send(new DeleteCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId }
    }));
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ message: 'Workstation deleted successfully' })
    };
  } catch (error) {
    console.error('Error deleting workstation:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to delete workstation' })
    };
  }
}

async function startWorkstation(data) {
  const { instanceId } = data;
  
  try {
    // Update workflow status immediately so UI shows transitional state
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId },
      UpdateExpression: 'SET #st = :status, updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#st': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'starting-instance',
        ':updatedAt': new Date().toISOString()
      }
    }));
    
    const executionInput = { instanceId };
    const executionName = `start-workstation-${instanceId}-${Date.now()}`;
    
    const result = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: process.env.START_STATE_MACHINE_ARN,
      name: executionName,
      input: JSON.stringify(executionInput)
    }));
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ 
        message: 'Workstation start initiated',
        executionArn: result.executionArn
      })
    };
  } catch (error) {
    console.error('Error starting workstation:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to start workstation' })
    };
  }
}

async function stopWorkstation(data) {
  const { instanceId } = data;
  
  try {
    // Get workstation record to determine region
    const workstationResult = await dynamodb.send(new GetCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId }
    }));
    
    const region = workstationResult.Item?.region;
    
    // Update workflow status immediately so UI shows transitional state
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId },
      UpdateExpression: 'SET #st = :status, updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#st': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'Stopping',
        ':updatedAt': new Date().toISOString()
      }
    }));
    
    // Create EC2 client for the appropriate region
    const ec2 = region && region !== process.env.AWS_REGION 
      ? new EC2Client({ region }) 
      : ec2Client;
    
    await ec2.send(new StopInstancesCommand({
      InstanceIds: [instanceId]
    }));
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ message: 'Workstation stop initiated' })
    };
  } catch (error) {
    console.error('Error stopping workstation:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to stop workstation' })
    };
  }
}

async function rebootWorkstation(data) {
  const { instanceId } = data;
  
  try {
    // Get workstation record to determine region
    const workstationResult = await dynamodb.send(new GetCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId }
    }));
    
    const region = workstationResult.Item?.region;
    
    // Update workflow status immediately so UI shows transitional state
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId },
      UpdateExpression: 'SET #st = :status, updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#st': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'Rebooting',
        ':updatedAt': new Date().toISOString()
      }
    }));
    
    // Create EC2 client for the appropriate region
    const ec2 = region && region !== process.env.AWS_REGION 
      ? new EC2Client({ region }) 
      : ec2Client;
    
    await ec2.send(new RebootInstancesCommand({
      InstanceIds: [instanceId]
    }));
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ message: 'Workstation reboot initiated' })
    };
  } catch (error) {
    console.error('Error rebooting workstation:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to reboot workstation' })
    };
  }
}

async function changeInstanceType(data) {
  const { instanceId, instanceType: newInstanceType } = data;

  if (!instanceId || !newInstanceType) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'instanceId and instanceType are required' })
    };
  }

  try {
    // Get workstation record for region and current state
    const workstationResult = await dynamodb.send(new GetCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId }
    }));

    if (!workstationResult.Item) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Workstation not found' })
      };
    }

    const region = workstationResult.Item?.region;

    // Create regional EC2 client if needed
    const ec2 = region && region !== process.env.AWS_REGION
      ? new EC2Client({ region })
      : ec2Client;

    // Verify instance is stopped — EC2 requires this for instance type changes
    const describeResult = await ec2.send(new DescribeInstancesCommand({
      InstanceIds: [instanceId]
    }));

    const instance = describeResult.Reservations?.[0]?.Instances?.[0];
    if (!instance) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'EC2 instance not found' })
      };
    }

    if (instance.State?.Name !== 'stopped') {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: `Instance must be stopped before changing instance type. Current state: ${instance.State?.Name}` })
      };
    }

    // Modify the instance type
    await ec2.send(new ModifyInstanceAttributeCommand({
      InstanceId: instanceId,
      InstanceType: { Value: newInstanceType }
    }));

    // Update DynamoDB with the new instance type
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId },
      UpdateExpression: 'SET instanceType = :instanceType, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':instanceType': newInstanceType,
        ':updatedAt': new Date().toISOString()
      },
      ConditionExpression: 'attribute_exists(instanceId)'
    }));

    console.log(`Changed instance type for ${instanceId} to ${newInstanceType}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        message: 'Instance type changed successfully',
        instanceId,
        instanceType: newInstanceType
      })
    };
  } catch (error) {
    console.error('Error changing instance type:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to change instance type' })
    };
  }
}


async function invokeVolumeManager(path, data) {
  // Durable functions with >15min execution timeout cannot be invoked synchronously.
  // Invoke the volume-manager Lambda asynchronously and return 202 immediately.
  const functionArn = process.env.VOLUME_MANAGER_FUNCTION_ARN;
  if (!functionArn) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Volume manager function not configured' })
    };
  }

  const action = path.split('/').pop(); // 'resize', 'add', or 'detach'

  await lambdaClient.send(new InvokeCommand({
    FunctionName: functionArn,
    InvocationType: 'Event', // async — returns immediately
    Payload: JSON.stringify({
      httpMethod: 'POST',
      path,
      body: JSON.stringify(data),
    }),
  }));

  const messages = {
    resize: 'Volume resize initiated. The file system will be extended automatically once the instance is running.',
    add: 'Volume creation initiated. The volume will be attached shortly — refresh the page in ~30 seconds.',
    detach: data.deleteVolume ? 'Volume detach and delete initiated.' : 'Volume detach initiated.',
  };

  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
    body: JSON.stringify({ message: messages[action] || 'Volume operation initiated.' })
  };
}
