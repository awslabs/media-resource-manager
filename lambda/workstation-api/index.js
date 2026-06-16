// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { EC2Client, RunInstancesCommand, StartInstancesCommand, StopInstancesCommand, TerminateInstancesCommand, DescribeInstancesCommand, CreateTagsCommand } = require('@aws-sdk/client-ec2');
const { SSMClient, SendCommandCommand, GetCommandInvocationCommand, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { DirectoryServiceClient, DescribeDirectoriesCommand, ResetUserPasswordCommand } = require('@aws-sdk/client-directory-service');
const { DirectoryServiceDataClient, ListGroupMembersCommand } = require('@aws-sdk/client-directory-service-data');
const { CognitoIdentityProviderClient, ListUsersCommand } = require('@aws-sdk/client-cognito-identity-provider');

const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const ec2 = new EC2Client({});
const ssm = new SSMClient({});
const sfn = new SFNClient({});
const directoryService = new DirectoryServiceClient({});
const directoryServiceData = new DirectoryServiceDataClient({});
const cognitoClient = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  const { httpMethod, path, body } = event;
  
  console.log('Event received:', JSON.stringify({ httpMethod, path, body: body ? 'present' : 'missing' }));
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  };

  // Default instance types catalog - used when no allowlist is configured
  // All G-series GPU instances enabled by default for Windows/Linux
  // All DCV-supported Mac instances enabled by default for macOS
  const DEFAULT_INSTANCE_TYPES = {
    windows: {
      enabled: [
        'g4dn.xlarge', 'g4dn.2xlarge', 'g4dn.4xlarge', 'g4dn.8xlarge', 'g4dn.12xlarge', 'g4dn.16xlarge',
        'g5.xlarge', 'g5.2xlarge', 'g5.4xlarge', 'g5.8xlarge', 'g5.12xlarge', 'g5.16xlarge', 'g5.24xlarge', 'g5.48xlarge',
        'g6.xlarge', 'g6.2xlarge', 'g6.4xlarge', 'g6.8xlarge', 'g6.12xlarge', 'g6.16xlarge'
      ],
      default: 'g4dn.xlarge'
    },
    linux: {
      enabled: [
        'g4dn.xlarge', 'g4dn.2xlarge', 'g4dn.4xlarge', 'g4dn.8xlarge', 'g4dn.12xlarge', 'g4dn.16xlarge',
        'g5.xlarge', 'g5.2xlarge', 'g5.4xlarge', 'g5.8xlarge', 'g5.12xlarge', 'g5.16xlarge', 'g5.24xlarge', 'g5.48xlarge',
        'g6.xlarge', 'g6.2xlarge', 'g6.4xlarge', 'g6.8xlarge', 'g6.12xlarge', 'g6.16xlarge'
      ],
      default: 'g4dn.xlarge'
    },
    macos: {
      enabled: [
        'mac2.metal', 'mac2-m1ultra.metal',
        'mac2-m2.metal', 'mac2-m2pro.metal',
        'mac-m4.metal', 'mac-m4pro.metal'
      ],
      default: 'mac2-m2.metal'
    }
  };
  
  try {
    // Handle CORS preflight requests
    if (httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: ''
      };
    }
    
    switch (httpMethod) {
      case 'GET':
        if (path === '/workstations') {
          return await getWorkstations(event);
        } else if (path.startsWith('/workstations/')) {
          return await getWorkstationDetails(path.split('/')[2], event);
        } else if (path === '/settings') {
          return await getSettings(event);
        } else if (path === '/settings/instance-types') {
          return await getAllowedInstanceTypes(event);
        } else if (path === '/instance-types/catalog') {
          return await getInstanceTypeCatalog(event);
        } else if (path === '/domains') {
          return await getDomains();
        }
        break;
      case 'POST':
        if (path === '/workstations') {
          return await createWorkstation(JSON.parse(body));
        } else if (path === '/workstations/start') {
          return await startWorkstation(JSON.parse(body));
        } else if (path === '/workstations/stop') {
          return await stopWorkstation(JSON.parse(body));
        } else if (path === '/workstations/keep-alive') {
          return await setKeepAlive(JSON.parse(body), event);
        } else if (path === '/settings') {
          return await saveSettings(JSON.parse(body), event);
        } else if (path === '/settings/instance-types') {
          return await saveAllowedInstanceTypes(JSON.parse(body), event);
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
        if (path.startsWith('/workstations/') && path.endsWith('/keep-alive')) {
          const instanceId = path.split('/')[2];
          return await cancelKeepAlive(instanceId, event);
        } else if (path.startsWith('/workstations/')) {
          return await deleteWorkstation(path.split('/')[2]);
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
      if (!userPoolId) {
        console.log('No Cognito User Pool ID found, skipping Cognito user lookup');
        return [];
      }
      
      console.log(`Fetching Cognito users from pool: ${userPoolId}`);

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
          // Check multiple possible name attributes for federated users
          let displayName = null;
          if (firstName && lastName) {
            displayName = `${firstName} ${lastName}`;
          } else if (attributes.name) {
            // Some IdPs store full name in 'name' attribute
            displayName = attributes.name;
          } else if (attributes['custom:displayName']) {
            displayName = attributes['custom:displayName'];
          } else if (firstName) {
            displayName = firstName;
          } else if (lastName) {
            displayName = lastName;
          }
          
          console.log(`Cognito user: ${user.Username}, email: ${email}, emailPrefix: ${emailPrefix}, firstName: ${firstName}, lastName: ${lastName}, name: ${attributes.name || ''}, displayName: ${displayName}`);
          
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

      console.log(`Found ${users.length} Cognito users for display name resolution`);
      return users;
    } catch (error) {
      console.log('Could not fetch Cognito users:', error.message);
      return [];
    }
  }

  async function getWorkstations(event) {
    // Extract user information from authorizer context
    const authorizerContext = event.requestContext?.authorizer || {};
    const isAdmin = authorizerContext.isAdmin === 'true';
    const currentUserId = authorizerContext.username;
    
    console.log('User:', currentUserId);
    console.log('Is admin:', isAdmin);
    
    if (!currentUserId) {
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }
    
    console.log('Querying workstations for user:', currentUserId);
    
    let result;
    
    if (isAdmin) {
      // Admins see all workstations
      result = await dynamodb.send(new ScanCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME
      }));
    } else if (currentUserId) {
      // Regular users see workstations assigned to them directly OR to their groups
      const userIdForQuery = currentUserId.includes('@') ? currentUserId.split('@')[0] : currentUserId;
      console.log('Querying workstations for user:', userIdForQuery);
      
      // Get user's groups from Directory Services
      let userGroups = [];
      try {
        const directoryId = await getDirectoryId();
        
        // Get all groups and check which ones this user belongs to
        const groupsResult = await dynamodb.send(new ScanCommand({
          TableName: process.env.GROUPS_TABLE_NAME
        }));
        
        console.log(`Checking group memberships for user: ${userIdForQuery}`);
        
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
        
        console.log('User groups from Directory Services:', userGroups);
      } catch (error) {
        console.log('Could not fetch user groups from Directory Services:', error);
      }
      
      // Query workstations assigned directly to user
      const directAssignments = await dynamodb.send(new QueryCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        IndexName: 'user-assignment-index',
        KeyConditionExpression: 'assignedUserId = :userId',
        ExpressionAttributeValues: {
          ':userId': userIdForQuery
        }
      }));
      
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
      // No user context, return empty result
      result = { Items: [] };
    }

    // Get real-time EC2 instance status for each workstation
    const workstations = result.Items || [];
    if (workstations.length > 0) {
      const instanceIds = workstations.map(w => w.instanceId).filter(Boolean);
      
      if (instanceIds.length > 0) {
        try {
          console.log('Getting real-time EC2 status for instances:', instanceIds);
          const ec2Response = await ec2.send(new DescribeInstancesCommand({
            InstanceIds: instanceIds
          }));
          
          // Create a map of instanceId -> current EC2 status
          const instanceStatusMap = {};
          ec2Response.Reservations?.forEach(reservation => {
            reservation.Instances?.forEach(instance => {
              instanceStatusMap[instance.InstanceId] = {
                status: instance.State?.Name || 'unknown',
                statusCode: instance.State?.Code || 0
              };
            });
          });
          
          // Update workstation objects with real-time EC2 status
          workstations.forEach(workstation => {
            if (workstation.instanceId && instanceStatusMap[workstation.instanceId]) {
              const realTimeStatus = instanceStatusMap[workstation.instanceId];
              workstation.instanceStatus = realTimeStatus.status;  // Only update instanceStatus
              workstation.statusCode = realTimeStatus.statusCode;
              workstation.lastStatusUpdate = new Date().toISOString();
            }
          });
          
          console.log('Updated workstations with real-time EC2 status');
        } catch (error) {
          console.error('Error getting EC2 instance status:', error);
          // Continue with DynamoDB data if EC2 call fails
        }
      }
    }

    // Get groups to resolve group IDs to names (for all users)
    if (workstations.length > 0) {
      try {
        const groupsResult = await dynamodb.send(new ScanCommand({
          TableName: process.env.GROUPS_TABLE_NAME
        }));
        const groups = groupsResult.Items || [];
        
        // Get users to resolve user IDs to names
        const usersResult = await dynamodb.send(new ScanCommand({
          TableName: process.env.USER_TABLE_NAME
        }));
        const users = usersResult.Items || [];
        console.log(`Fetched ${users.length} users from DynamoDB for display name resolution`);
        users.forEach(u => {
          console.log(`DynamoDB user: userId=${u.userId}, email=${u.email}, firstName=${u.firstName}, lastName=${u.lastName}`);
        });
        
        // Get Cognito users for fallback display name resolution
        const cognitoUsers = await getCognitoUsersForDisplay();
        
        // Helper function to format user IDs for display
        const formatUserIdForDisplay = (userId) => {
          if (!userId) return userId;
          let displayName = userId;
          // Strip IdP prefixes (IdentityCenter_, Okta_, etc.)
          if (displayName.includes('_')) {
            const parts = displayName.split('_');
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
          
          console.log(`Looking up user for assignedUserId: "${assignedUserId}"`);
          
          // Try exact match in DynamoDB users first
          let user = users.find(u => u.userId === assignedUserId);
          if (user) {
            console.log(`Found user in DynamoDB by exact match: ${user.userId}`);
            return user;
          }
          
          // Try matching by formatted userId in DynamoDB
          const formattedAssignedId = formatUserIdForDisplay(assignedUserId).toLowerCase();
          console.log(`Formatted assignedUserId for lookup: "${formattedAssignedId}"`);
          
          user = users.find(u => {
            const formattedUserId = formatUserIdForDisplay(u.userId).toLowerCase();
            return formattedUserId === formattedAssignedId;
          });
          if (user) {
            console.log(`Found user in DynamoDB by formatted match: ${user.userId}`);
            return user;
          }
          
          // Try matching by email prefix in DynamoDB
          user = users.find(u => {
            if (u.email) {
              const emailPrefix = u.email.split('@')[0].toLowerCase();
              return emailPrefix === formattedAssignedId;
            }
            return false;
          });
          if (user) {
            console.log(`Found user in DynamoDB by email prefix: ${user.userId}, firstName: ${user.firstName}, lastName: ${user.lastName}`);
            return user;
          }
          
          // Try matching by full email in DynamoDB (if assignedUserId contains @)
          if (assignedUserId.includes('@')) {
            user = users.find(u => u.email && u.email.toLowerCase() === assignedUserId.toLowerCase());
            if (user) {
              console.log(`Found user in DynamoDB by full email: ${user.userId}, firstName: ${user.firstName}, lastName: ${user.lastName}`);
              return user;
            }
          }
          
          // Fallback: Check Cognito users
          console.log(`User not found in DynamoDB (checked ${users.length} users), checking ${cognitoUsers.length} Cognito users`);
          
          // Try exact match by username
          let cognitoUser = cognitoUsers.find(u => u.userId === assignedUserId);
          if (cognitoUser) {
            console.log(`Found Cognito user by exact match: ${cognitoUser.userId}, displayName: ${cognitoUser.displayName}`);
            return cognitoUser;
          }
          
          // Try matching by formatted username in Cognito (strip IdP prefix and domain from both sides)
          cognitoUser = cognitoUsers.find(u => {
            const formattedCognitoId = formatUserIdForDisplay(u.userId).toLowerCase();
            return formattedCognitoId === formattedAssignedId;
          });
          if (cognitoUser) {
            console.log(`Found Cognito user by formatted username "${formattedAssignedId}": ${cognitoUser.userId}, firstName: ${cognitoUser.firstName}, lastName: ${cognitoUser.lastName}, displayName: ${cognitoUser.displayName}`);
            return cognitoUser;
          }
          
          // Try matching by email prefix in Cognito
          cognitoUser = cognitoUsers.find(u => u.emailPrefix === formattedAssignedId);
          if (cognitoUser) {
            console.log(`Found Cognito user by email prefix "${formattedAssignedId}": ${cognitoUser.userId}, displayName: ${cognitoUser.displayName}`);
            return cognitoUser;
          }
          
          // Try matching by full email in Cognito
          if (assignedUserId.includes('@')) {
            cognitoUser = cognitoUsers.find(u => u.email.toLowerCase() === assignedUserId.toLowerCase());
            if (cognitoUser) {
              console.log(`Found Cognito user by full email: ${cognitoUser.userId}, displayName: ${cognitoUser.displayName}`);
              return cognitoUser;
            }
          }
          
          console.log(`No user found for assignedUserId: "${assignedUserId}"`);
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
              // Check if it's a user ID
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
    }
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify(workstations)
    };
  }

  async function getDomains() {
    try {
      const result = await directoryService.send(new DescribeDirectoriesCommand({}));
      
      const domains = result.DirectoryDescriptions?.map(dir => ({
        id: dir.DirectoryId,
        name: dir.Name,
        type: dir.Type,
        size: dir.Size
      })) || [];
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify(domains)
      };
    } catch (error) {
      console.error('Error fetching domains:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to fetch domains' })
      };
    }
  }
  
  async function createWorkstation(data) {
    // Support both single workstation and bulk creation
    const workstations = Array.isArray(data.workstations) ? data.workstations : [data];
    
    console.log(`Starting creation of ${workstations.length} workstation(s) via Step Functions`);
    
    try {
      const results = [];
      
      for (const workstation of workstations) {
        const { amiId, instanceType, assignedUserId, domainId, rootVolumeSize, pipelineId, joinDomain, acronym, region } = workstation;
        
        // Start Step Functions execution
        const executionInput = {
          amiId,
          instanceType,
          assignedUserId: assignedUserId || '', // Allow empty for unassigned workstations
          domainId,
          rootVolumeSize,
          pipelineId,
          joinDomain,
          acronym,
          region
        };
        
        // Generate unique execution name - handle empty assignedUserId
        const userPart = assignedUserId ? assignedUserId.replace(/[^a-zA-Z0-9-_]/g, '-').substring(0, 20) : 'unassigned';
        const executionName = `workstation-${userPart}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        
        const result = await sfn.send(new StartExecutionCommand({
          stateMachineArn: process.env.STATE_MACHINE_ARN,
          name: executionName,
          input: JSON.stringify(executionInput)
        }));
        
        console.log('Step Functions execution started:', result.executionArn);
        
        results.push({
          executionArn: result.executionArn,
          executionName,
          assignedUserId: assignedUserId || 'unassigned'
        });
      }
      
      return {
        statusCode: 202,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ 
          message: `${workstations.length} workstation creation(s) started`,
          executions: results
        })
      };
      
    } catch (error) {
      console.error('Error starting workstation creation:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to start workstation creation' })
      };
    }
  }
  
  async function installDCVOnInstance(instanceId) {
    console.log('Installing DCV on instance:', instanceId);
    
    // Check if instance is running
    const instanceResult = await ec2.send(new DescribeInstancesCommand({
      InstanceIds: [instanceId]
    }));
    
    const instance = instanceResult.Reservations[0]?.Instances[0];
    if (!instance || instance.State.Name !== 'running') {
      console.log('Instance not ready yet, will retry...');
      return;
    }
    
    // Get the Session Manager endpoint from SSM Parameter Store
    // Get pascal case name from environment variable
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    const parameterName = `/${pascalCaseName}/DCV/SessionManager/Endpoint`;
    
    const getParameterResult = await ssm.send(new GetParameterCommand({
      Name: parameterName
    }));
    const sessionManagerEndpoint = getParameterResult.Parameter.Value;
    
    console.log(`Retrieved Session Manager endpoint: ${sessionManagerEndpoint}`);
    
    // Run SSM document to install DCV and SMAgent
    const commandParams = {
      DocumentName: 'InstallDCVandSMAgent',
      InstanceIds: [instanceId],
      Parameters: {
        SessMgrDNS: [sessionManagerEndpoint]
      },
      Comment: `Installing DCV and SMAgent on workstation ${instanceId}`
    };
    
    console.log('Sending SSM command:', JSON.stringify(commandParams, null, 2));
    
    const commandResult = await ssm.send(new SendCommandCommand(commandParams));
    const commandId = commandResult.Command.CommandId;
    
    console.log('SSM command sent:', commandId);
    
    // Update DynamoDB with command ID
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId },
      UpdateExpression: 'SET dcvInstallStatus = :status, dcvInstallCommandId = :commandId',
      ExpressionAttributeValues: { 
        ':status': 'installing',
        ':commandId': commandId
      }
    }));
  }
  
  async function startWorkstation(data) {
    const { instanceId } = data;
    
    try {
      // Start the state machine for robust instance starting with DCV readiness checks
      const result = await sfn.send(new StartExecutionCommand({
        stateMachineArn: process.env.START_STATE_MACHINE_ARN,
        input: JSON.stringify({
          instanceId: instanceId
        })
      }));
      
      console.log(`Started state machine execution: ${result.executionArn}`);
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ 
          message: 'Workstation start initiated - DCV will be ready shortly',
          executionArn: result.executionArn
        })
      };
    } catch (error) {
      console.error('Error starting state machine:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to start workstation' })
      };
    }
  }
  
  async function stopWorkstation(data) {
    const { instanceId } = data;
    
    await ec2.send(new StopInstancesCommand({
      InstanceIds: [instanceId]
    }));
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ message: 'Workstation stopping' })
    };
  }
  
  async function updateWorkstation(instanceId, data) {
    const { assignedUserId, workstationName } = data;
    
    const updateExpressions = [];
    const expressionValues = {};
    
    if (assignedUserId !== undefined) {
      updateExpressions.push('assignedUserId = :userId');
      expressionValues[':userId'] = assignedUserId;
    }
    
    if (workstationName !== undefined) {
      updateExpressions.push('workstationName = :name');
      expressionValues[':name'] = workstationName;
      
      // Update EC2 Name tag
      try {
        await ec2.send(new CreateTagsCommand({
          Resources: [instanceId],
          Tags: [{ Key: 'Name', Value: workstationName }],
        }));
      } catch (tagError) {
        console.warn('Failed to update EC2 Name tag:', tagError.message);
      }
    }
    
    if (updateExpressions.length === 0) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'No fields to update' })
      };
    }
    
    await dynamodb.send(new UpdateCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      Key: { instanceId },
      UpdateExpression: 'SET ' + updateExpressions.join(', '),
      ExpressionAttributeValues: expressionValues
    }));
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ message: 'Workstation updated' })
    };
  }

  async function deleteWorkstation(instanceId) {
    try {
      // First terminate the EC2 instance
      await ec2.send(new TerminateInstancesCommand({
        InstanceIds: [instanceId]
      }));
      
      // Then remove from DynamoDB
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

  async function getBrowserSessionsConfig() {
    try {
      const browserSessionsParam = await ssm.send(new GetParameterCommand({
        Name: '/workstation/dcv/browser-sessions-enabled'
      }));
      const browserSessionsEnabled = browserSessionsParam.Parameter.Value === 'true';
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ browserSessionsEnabled })
      };
    } catch (error) {
      console.error('Error getting browser sessions config:', error);
      // Default to enabled if parameter doesn't exist
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ browserSessionsEnabled: true })
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
      
      const workstationResult = await docClient.send(getCommand);
      
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
      
      // Get EC2 instance details
      const describeCommand = new DescribeInstancesCommand({
        InstanceIds: [instanceId]
      });
      
      const ec2Result = await ec2.send(describeCommand);
      
      if (!ec2Result.Reservations || ec2Result.Reservations.length === 0 || 
          !ec2Result.Reservations[0].Instances || ec2Result.Reservations[0].Instances.length === 0) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'EC2 instance not found' })
        };
      }
      
      const instance = ec2Result.Reservations[0].Instances[0];

      // Sync any drifted EC2 attributes back to DynamoDB.
      // This catches out-of-band changes made directly in the EC2 console
      // (e.g. instance type change, IP reassignment) without requiring a
      // separate API route or polling mechanism.
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
        docClient.send(new UpdateCommand({
          TableName: process.env.WORKSTATION_TABLE_NAME,
          Key: { instanceId },
          UpdateExpression: `SET ${updateExprParts.join(', ')}, updatedAt = :updatedAt`,
          ExpressionAttributeNames: exprNames,
          ExpressionAttributeValues: exprValues,
          ConditionExpression: 'attribute_exists(instanceId)'
        })).catch(err => console.error(`Failed to sync EC2 attributes for ${instanceId}:`, err));

        // Return the merged record with live values so the UI is immediately correct
        Object.assign(workstation, updates);
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

  async function getSettings(event) {
    // Extract user information from authorizer context
    const authorizerContext = event.requestContext?.authorizer || {};
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    try {
      // Get browser sessions setting (available to all users)
      const settings = {};
      const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
      
      try {
        const browserSessionsParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/DCV/BrowserSessionsEnabled`
        }));
        settings.browserSessionsEnabled = browserSessionsParam.Parameter.Value === 'true';
      } catch (error) {
        // Parameter doesn't exist yet, default to true
        if (error.name !== 'ParameterNotFound') {
          console.log('Error getting browser-sessions-enabled parameter:', error);
        }
        settings.browserSessionsEnabled = true; // Default to enabled
      }
      
      // Get Keep Alive settings (available to all users to know if feature is enabled)
      try {
        const keepAliveEnabledParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/KeepAliveEnabled`
        }));
        settings.keepAliveEnabled = keepAliveEnabledParam.Parameter.Value === 'true';
      } catch (error) {
        if (error.name !== 'ParameterNotFound') {
          console.log('Error getting keep-alive-enabled parameter:', error);
        }
        settings.keepAliveEnabled = false; // Default to disabled
      }
      
      try {
        const keepAliveMaxParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/KeepAliveMaxHours`
        }));
        settings.keepAliveMaxHours = parseInt(keepAliveMaxParam.Parameter.Value) || 24;
      } catch (error) {
        if (error.name !== 'ParameterNotFound') {
          console.log('Error getting keep-alive-max-hours parameter:', error);
        }
        settings.keepAliveMaxHours = 24; // Default max
      }
      
      // Get Auto-Start settings (available to all users to know if feature is enabled)
      try {
        const autoStartEnabledParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/AutoStartEnabled`
        }));
        settings.autoStartEnabled = autoStartEnabledParam.Parameter.Value === 'true';
      } catch (error) {
        if (error.name !== 'ParameterNotFound') {
          console.log('Error getting auto-start-enabled parameter:', error);
        }
        settings.autoStartEnabled = false; // Default to disabled
      }
      
      try {
        const autoStartLeadParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/AutoStartLeadTimeMinutes`
        }));
        settings.autoStartLeadTimeMinutes = parseInt(autoStartLeadParam.Parameter.Value) || 15;
      } catch (error) {
        if (error.name !== 'ParameterNotFound') {
          console.log('Error getting auto-start-lead-time parameter:', error);
        }
        settings.autoStartLeadTimeMinutes = 15; // Default lead time
      }
      
      // Only admins can access other settings
      if (isAdmin) {
        try {
          const disconnectedDurationParam = await ssm.send(new GetParameterCommand({
            Name: `/${pascalCaseName}/DCV/DisconnectedDuration`
          }));
          settings.disconnectedDuration = parseInt(disconnectedDurationParam.Parameter.Value);
        } catch (error) {
          // Parameter doesn't exist yet, that's okay
          if (error.name !== 'ParameterNotFound') {
            console.log('Error getting disconnected-duration parameter:', error);
          }
        }
      }
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify(settings)
      };
    } catch (error) {
      console.error('Error getting settings:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to get settings' })
      };
    }
  }

  async function saveSettings(data, event) {
    // Extract user information from authorizer context
    const authorizerContext = event.requestContext?.authorizer || {};
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    if (!isAdmin) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Access denied. Administrator privileges required.' })
      };
    }

    try {
      const { disconnectedDuration, browserSessionsEnabled, keepAliveEnabled, keepAliveMaxHours, autoStartEnabled, autoStartLeadTimeMinutes } = data;
      
      // Get pascal case name from environment variable
      const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
      
      // Save disconnected duration setting
      if (disconnectedDuration !== null && disconnectedDuration !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `/${pascalCaseName}/DCV/DisconnectedDuration`,
          Value: disconnectedDuration.toString(),
          Type: 'String',
          Overwrite: true,
          Description: 'Minutes to wait before shutting down workstation after user disconnection'
        }));
      }
      
      // Save browser sessions enabled setting
      if (browserSessionsEnabled !== null && browserSessionsEnabled !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `/${pascalCaseName}/DCV/BrowserSessionsEnabled`,
          Value: browserSessionsEnabled.toString(),
          Type: 'String',
          Overwrite: true,
          Description: 'Whether browser-based DCV sessions are enabled for users'
        }));
      }
      
      // Save Keep Alive enabled setting
      if (keepAliveEnabled !== null && keepAliveEnabled !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `/${pascalCaseName}/Settings/KeepAliveEnabled`,
          Value: keepAliveEnabled.toString(),
          Type: 'String',
          Overwrite: true,
          Description: 'Whether users can request Keep Alive to temporarily prevent auto-shutdown'
        }));
      }
      
      // Save Keep Alive max hours setting
      if (keepAliveMaxHours !== null && keepAliveMaxHours !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `/${pascalCaseName}/Settings/KeepAliveMaxHours`,
          Value: keepAliveMaxHours.toString(),
          Type: 'String',
          Overwrite: true,
          Description: 'Maximum hours users can request for Keep Alive'
        }));
      }
      
      // Save Auto-Start enabled setting
      if (autoStartEnabled !== null && autoStartEnabled !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `/${pascalCaseName}/Settings/AutoStartEnabled`,
          Value: autoStartEnabled.toString(),
          Type: 'String',
          Overwrite: true,
          Description: 'Whether auto-start scheduling is enabled for users'
        }));
      }
      
      // Save Auto-Start lead time setting
      if (autoStartLeadTimeMinutes !== null && autoStartLeadTimeMinutes !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `/${pascalCaseName}/Settings/AutoStartLeadTimeMinutes`,
          Value: autoStartLeadTimeMinutes.toString(),
          Type: 'String',
          Overwrite: true,
          Description: 'Minutes before scheduled start time to begin starting workstations'
        }));
      }
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ message: 'Settings saved successfully' })
      };
    } catch (error) {
      console.error('Error saving settings:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to save settings' })
      };
    }
  }

  async function getAllowedInstanceTypes(event) {
    // Extract user information from authorizer context
    const authorizerContext = event.requestContext?.authorizer || {};
    
    try {
      const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
      
      try {
        const param = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/AllowedInstanceTypes`
        }));
        
        const allowedTypes = JSON.parse(param.Parameter.Value);
        
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify(allowedTypes)
        };
      } catch (error) {
        // Parameter doesn't exist yet, return defaults
        // Check for ParameterNotFound error (AWS SDK v3 may use different error structures)
        if (error.name === 'ParameterNotFound' || 
            error.code === 'ParameterNotFound' ||
            error.message?.includes('ParameterNotFound') ||
            error.$metadata?.httpStatusCode === 400) {
          console.log('AllowedInstanceTypes parameter not found, returning defaults');
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            body: JSON.stringify(DEFAULT_INSTANCE_TYPES)
          };
        }
        throw error;
      }
    } catch (error) {
      console.error('Error getting allowed instance types:', error);
      // If all else fails, return defaults rather than an error
      // This ensures users can always create workstations
      console.log('Returning default instance types due to error');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify(DEFAULT_INSTANCE_TYPES)
      };
    }
  }

  async function saveAllowedInstanceTypes(data, event) {
    // Extract user information from authorizer context
    const authorizerContext = event.requestContext?.authorizer || {};
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    if (!isAdmin) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Access denied. Administrator privileges required.' })
      };
    }

    try {
      const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
      
      // Validate the data structure
      const { windows, linux, macos } = data;
      
      if (!windows || !linux || !macos) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'Invalid data structure. Must include windows, linux, and macos configurations.' })
        };
      }
      
      // Validate each platform has enabled array and default
      for (const [platform, config] of Object.entries(data)) {
        if (!Array.isArray(config.enabled) || config.enabled.length === 0) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            body: JSON.stringify({ error: `Platform ${platform} must have at least one enabled instance type.` })
          };
        }
        if (!config.default || !config.enabled.includes(config.default)) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            body: JSON.stringify({ error: `Platform ${platform} default must be one of the enabled instance types.` })
          };
        }
      }
      
      await ssm.send(new PutParameterCommand({
        Name: `/${pascalCaseName}/Settings/AllowedInstanceTypes`,
        Value: JSON.stringify(data),
        Type: 'String',
        Overwrite: true,
        Description: 'Allowed instance types per platform for workstation creation'
      }));
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ message: 'Allowed instance types saved successfully' })
      };
    } catch (error) {
      console.error('Error saving allowed instance types:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to save allowed instance types' })
      };
    }
  }

  // Keep Alive feature - allows users to temporarily prevent auto-shutdown
  async function setKeepAlive(data, event) {
    const authorizerContext = event.requestContext?.authorizer || {};
    const currentUserId = authorizerContext.username;
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    const { instanceId, durationHours } = data;
    
    if (!instanceId || !durationHours) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'instanceId and durationHours are required' })
      };
    }
    
    try {
      const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
      
      // Check if Keep Alive feature is enabled
      let keepAliveEnabled = false;
      let maxDurationHours = 24; // Default max
      
      try {
        const enabledParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/KeepAliveEnabled`
        }));
        keepAliveEnabled = enabledParam.Parameter.Value === 'true';
      } catch (error) {
        if (error.name !== 'ParameterNotFound') throw error;
        // Feature not configured, default to disabled
      }
      
      if (!keepAliveEnabled && !isAdmin) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'Keep Alive feature is not enabled. Contact your administrator.' })
        };
      }
      
      // Get max duration setting
      try {
        const maxParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/KeepAliveMaxHours`
        }));
        maxDurationHours = parseInt(maxParam.Parameter.Value) || 24;
      } catch (error) {
        if (error.name !== 'ParameterNotFound') throw error;
      }
      
      // Validate duration (admins can bypass max)
      if (!isAdmin && durationHours > maxDurationHours) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: `Maximum Keep Alive duration is ${maxDurationHours} hours` })
        };
      }
      
      // Get workstation to verify ownership
      const workstation = await dynamodb.send(new GetCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        Key: { instanceId }
      }));
      
      if (!workstation.Item) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'Workstation not found' })
        };
      }
      
      // Check if user has access to this workstation (admin or assigned user)
      const userIdForCheck = currentUserId?.includes('@') ? currentUserId.split('@')[0] : currentUserId;
      const assignedId = workstation.Item.assignedUserId || '';
      // Normalize both IDs: strip IdP prefixes (IdentityCenter_, Okta_, etc.) and compare case-insensitively
      const normalizeUserId = (id) => {
        if (!id) return '';
        let normalized = id;
        // Strip known IdP prefixes
        const knownPrefixes = ['IdentityCenter_', 'Okta_', 'SAML_', 'AzureAD_', 'AmazonFederate_'];
        for (const prefix of knownPrefixes) {
          if (normalized.startsWith(prefix)) {
            normalized = normalized.substring(prefix.length);
            break;
          }
        }
        // Strip @domain for comparison
        if (normalized.includes('@')) {
          normalized = normalized.split('@')[0];
        }
        return normalized.toLowerCase();
      };
      if (!isAdmin && normalizeUserId(assignedId) !== normalizeUserId(currentUserId)) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'You can only set Keep Alive on workstations assigned to you' })
        };
      }
      
      // Calculate expiration time
      const keepAliveUntil = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
      
      // Update workstation with Keep Alive info
      await dynamodb.send(new UpdateCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        Key: { instanceId },
        UpdateExpression: 'SET keepAliveUntil = :until, keepAliveRequestedBy = :user, keepAliveRequestedAt = :at',
        ExpressionAttributeValues: {
          ':until': keepAliveUntil,
          ':user': currentUserId,
          ':at': new Date().toISOString()
        }
      }));
      
      console.log(`Keep Alive set for ${instanceId} until ${keepAliveUntil} by ${currentUserId}`);
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ 
          message: 'Keep Alive activated',
          keepAliveUntil,
          durationHours
        })
      };
    } catch (error) {
      console.error('Error setting Keep Alive:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to set Keep Alive' })
      };
    }
  }

  async function cancelKeepAlive(instanceId, event) {
    const authorizerContext = event.requestContext?.authorizer || {};
    const currentUserId = authorizerContext.username;
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    try {
      // Get workstation to verify ownership
      const workstation = await dynamodb.send(new GetCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        Key: { instanceId }
      }));
      
      if (!workstation.Item) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'Workstation not found' })
        };
      }
      
      // Check if user has access (admin or assigned user)
      const userIdForCheck = currentUserId?.includes('@') ? currentUserId.split('@')[0] : currentUserId;
      const assignedId = workstation.Item.assignedUserId || '';
      // Normalize both IDs: strip IdP prefixes (IdentityCenter_, Okta_, etc.) and compare case-insensitively
      const normalizeUserId = (id) => {
        if (!id) return '';
        let normalized = id;
        const knownPrefixes = ['IdentityCenter_', 'Okta_', 'SAML_', 'AzureAD_', 'AmazonFederate_'];
        for (const prefix of knownPrefixes) {
          if (normalized.startsWith(prefix)) {
            normalized = normalized.substring(prefix.length);
            break;
          }
        }
        if (normalized.includes('@')) {
          normalized = normalized.split('@')[0];
        }
        return normalized.toLowerCase();
      };
      if (!isAdmin && normalizeUserId(assignedId) !== normalizeUserId(currentUserId)) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'You can only cancel Keep Alive on workstations assigned to you' })
        };
      }
      
      // Remove Keep Alive attributes
      await dynamodb.send(new UpdateCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        Key: { instanceId },
        UpdateExpression: 'REMOVE keepAliveUntil, keepAliveRequestedBy, keepAliveRequestedAt'
      }));
      
      console.log(`Keep Alive cancelled for ${instanceId} by ${currentUserId}`);
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ message: 'Keep Alive cancelled' })
      };
    } catch (error) {
      console.error('Error cancelling Keep Alive:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to cancel Keep Alive' })
      };
    }
  }

  /**
   * Get instance type catalog from DynamoDB
   * Returns all instance types with their metadata, optionally filtered by region or platform
   */
  async function getInstanceTypeCatalog(event) {
    const queryParams = event.queryStringParameters || {};
    const regionFilter = queryParams.region;
    const platformFilter = queryParams.platform;
    
    try {
      const catalogTableName = process.env.INSTANCE_TYPE_CATALOG_TABLE_NAME;
      
      if (!catalogTableName) {
        // Return empty catalog if table not configured
        console.log('Instance type catalog table not configured');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ instanceTypes: {}, source: 'none' })
        };
      }
      
      // Scan the catalog table
      const result = await dynamodb.send(new ScanCommand({
        TableName: catalogTableName
      }));
      
      // Transform to the format expected by frontend
      const catalog = {};
      for (const item of result.Items || []) {
        // Apply region filter if specified
        if (regionFilter && item.regions && !item.regions.includes(regionFilter)) {
          continue;
        }
        
        // Apply platform filter if specified
        if (platformFilter && item.platforms && !item.platforms.includes(platformFilter)) {
          continue;
        }
        
        catalog[item.instanceType] = {
          family: item.family,
          label: item.label,
          platforms: item.platforms || [],
          vCpu: item.vCpu,
          memoryGb: item.memoryGb,
          gpuInfo: item.gpuInfo,
          regions: item.regions || [],
          architecture: item.architecture
        };
      }
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ 
          instanceTypes: catalog,
          source: 'dynamodb',
          count: Object.keys(catalog).length
        })
      };
    } catch (error) {
      console.error('Error fetching instance type catalog:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to fetch instance type catalog' })
      };
    }
  }
};
