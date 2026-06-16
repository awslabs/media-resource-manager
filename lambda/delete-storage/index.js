// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, DeleteCommand, UpdateCommand, QueryCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { CloudFormationClient, DescribeStacksCommand, DeleteStackCommand } = require('@aws-sdk/client-cloudformation');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DataSyncClient, DeleteTaskCommand, DeleteLocationCommand } = require('@aws-sdk/client-datasync');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const sfn = new SFNClient({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });
const dataSyncClient = new DataSyncClient({ region: process.env.AWS_REGION });

// Cache for DataSync table name (fetched from SSM once)
let dataSyncTableNameCache = null;

// Cache CloudFormation clients by region
const cfnClients = {};

function getCfnClient(region) {
  const targetRegion = region || process.env.AWS_REGION;
  if (!cfnClients[targetRegion]) {
    cfnClients[targetRegion] = new CloudFormationClient({ region: targetRegion });
  }
  return cfnClients[targetRegion];
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'DELETE,OPTIONS'
};

/**
 * Get DataSync table name from SSM parameter (cached after first fetch)
 */
async function getDataSyncTableName() {
  if (dataSyncTableNameCache) {
    return dataSyncTableNameCache;
  }

  const ssmPath = process.env.DATASYNC_TABLE_SSM_PATH;
  if (!ssmPath) {
    console.log('DATASYNC_TABLE_SSM_PATH not configured, skipping DataSync integration');
    return null;
  }

  try {
    const result = await ssm.send(new GetParameterCommand({ Name: ssmPath }));
    dataSyncTableNameCache = result.Parameter?.Value;
    console.log(`DataSync table name from SSM: ${dataSyncTableNameCache}`);
    return dataSyncTableNameCache;
  } catch (error) {
    if (error.name === 'ParameterNotFound') {
      console.log(`SSM parameter ${ssmPath} not found - DataSync stack may not be deployed yet`);
      return null;
    }
    console.error('Error fetching DataSync table name from SSM:', error);
    return null;
  }
}

/**
 * Cascade-delete DataSync tasks and locations that reference the storage
 * being deleted.
 *
 * This must run BEFORE kicking off the CloudFormation stack deletion, because
 * DataSync keeps ENIs attached to the FSx security group for as long as a
 * location referencing that FSx exists. Leaving them around causes the CFN
 * stack delete to fail with DependencyViolation on the security group, which
 * leaves the storage record stuck in "deleting" forever.
 *
 * Steps:
 *   1. Find DataSync LOCATION records in mrm-datasync with storageId == this storage
 *   2. Find TASK records whose source/destination is one of those locations
 *   3. For each task: call DataSync DeleteTask, delete TASK + EXECUTION# rows
 *   4. For each location: call DataSync DeleteLocation, delete LOCATION row
 *
 * "Already gone" errors (InvalidRequestException from DataSync) are logged
 * and treated as success so partial-failure retries converge.
 */
async function deleteDataSyncTasksAndLocations(storageId) {
  const dataSyncTableName = await getDataSyncTableName();
  if (!dataSyncTableName) {
    console.log('DataSync table not available, skipping DataSync cleanup');
    return { deletedTasks: [], deletedLocations: [], errors: [] };
  }

  const deletedTasks = [];
  const deletedLocations = [];
  const errors = [];

  try {
    // 1. Find DataSync locations referencing this storage
    const locationsResult = await dynamodb.send(new QueryCommand({
      TableName: dataSyncTableName,
      IndexName: 'type-index',
      KeyConditionExpression: '#type = :type',
      FilterExpression: 'storageId = :storageId',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: {
        ':type': 'LOCATION',
        ':storageId': storageId
      }
    }));

    const locations = locationsResult.Items || [];
    console.log(`Found ${locations.length} DataSync locations referencing storage ${storageId}`);

    if (locations.length === 0) {
      return { deletedTasks, deletedLocations, errors };
    }

    const locationIds = new Set(locations.map(l => l.locationId));

    // 2. Find tasks whose source or destination is one of those locations
    const tasksResult = await dynamodb.send(new QueryCommand({
      TableName: dataSyncTableName,
      IndexName: 'type-index',
      KeyConditionExpression: '#type = :type',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':type': 'TASK' }
    }));

    const affectedTasks = (tasksResult.Items || []).filter(t =>
      locationIds.has(t.sourceLocationId) || locationIds.has(t.destinationLocationId)
    );

    // 3. Delete each task: DataSync then DynamoDB (task + its executions)
    for (const task of affectedTasks) {
      try {
        if (task.taskArn) {
          try {
            await dataSyncClient.send(new DeleteTaskCommand({ TaskArn: task.taskArn }));
            console.log(`Deleted DataSync task ${task.taskArn}`);
          } catch (e) {
            if (e.name === 'InvalidRequestException') {
              console.log(`DataSync task ${task.taskArn} already gone`);
            } else {
              throw e;
            }
          }
        }

        // Delete any EXECUTION# rows under this task (batches of 25)
        const execs = await dynamodb.send(new QueryCommand({
          TableName: dataSyncTableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': `TASK#${task.taskId}`,
            ':skPrefix': 'EXECUTION#'
          }
        }));
        const execItems = execs.Items || [];
        for (let i = 0; i < execItems.length; i += 25) {
          const batch = execItems.slice(i, i + 25).map(item => ({
            DeleteRequest: { Key: { pk: item.pk, sk: item.sk } }
          }));
          await dynamodb.send(new BatchWriteCommand({
            RequestItems: { [dataSyncTableName]: batch }
          }));
        }

        // Delete the TASK metadata row
        await dynamodb.send(new DeleteCommand({
          TableName: dataSyncTableName,
          Key: { pk: `TASK#${task.taskId}`, sk: 'METADATA' }
        }));

        deletedTasks.push(task.taskId);
        console.log(`Deleted task ${task.taskId} (${task.name || 'unnamed'}) and ${execItems.length} execution records`);
      } catch (err) {
        console.error(`Failed to delete task ${task.taskId}:`, err);
        errors.push({ taskId: task.taskId, error: err.message });
      }
    }

    // 4. Delete each location: DataSync then DynamoDB
    for (const location of locations) {
      try {
        if (location.locationArn) {
          try {
            await dataSyncClient.send(new DeleteLocationCommand({ LocationArn: location.locationArn }));
            console.log(`Deleted DataSync location ${location.locationArn}`);
          } catch (e) {
            if (e.name === 'InvalidRequestException') {
              console.log(`DataSync location ${location.locationArn} already gone`);
            } else {
              throw e;
            }
          }
        }

        await dynamodb.send(new DeleteCommand({
          TableName: dataSyncTableName,
          Key: { pk: `LOCATION#${location.locationId}`, sk: 'METADATA' }
        }));

        deletedLocations.push(location.locationId);
        console.log(`Deleted location ${location.locationId} (${location.name || 'unnamed'})`);
      } catch (err) {
        console.error(`Failed to delete location ${location.locationId}:`, err);
        errors.push({ locationId: location.locationId, error: err.message });
      }
    }

    return { deletedTasks, deletedLocations, errors };
  } catch (error) {
    console.error('Error in deleteDataSyncTasksAndLocations:', error);
    // Surface the error so the caller can decide whether to proceed or bail.
    // If cleanup fails, we'd rather fail the storage delete than leave
    // orphaned ENIs that cause a stuck stack.
    throw new Error(`DataSync cleanup failed for storage ${storageId}: ${error.message}`);
  }
}

exports.handler = async (event) => {
  console.log('DeleteStorage event:', JSON.stringify(event, null, 2));
  
  try {
    const storageId = event.pathParameters?.storageId;
    if (!storageId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Storage ID is required'
        })
      };
    }
    
    // Get storage record to validate and get CloudFormation stack name
    const getResult = await dynamodb.send(new GetCommand({
      TableName: process.env.STORAGE_TABLE_NAME,
      Key: { storageId }
    }));
    
    if (!getResult.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Storage resource not found'
        })
      };
    }
    
    const storage = getResult.Item;
    
    // Cascade-delete any DataSync tasks and locations that reference this
    // storage. This must run before CloudFormation stack delete so DataSync
    // releases its ENIs from the FSx security group — otherwise stack delete
    // fails with DependencyViolation.
    let dataSyncCleanup;
    try {
      dataSyncCleanup = await deleteDataSyncTasksAndLocations(storageId);
      if (dataSyncCleanup.deletedTasks.length || dataSyncCleanup.deletedLocations.length) {
        console.log(`DataSync cleanup: removed ${dataSyncCleanup.deletedTasks.length} task(s), ${dataSyncCleanup.deletedLocations.length} location(s)`);
      }
      if (dataSyncCleanup.errors.length) {
        // Non-fatal: we logged per-item errors, but if any failed to delete
        // the stack delete will likely also fail. Surface to caller so the
        // user sees a clear error instead of a stuck "deleting" record.
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'Failed to clean up associated DataSync resources',
            details: dataSyncCleanup.errors
          })
        };
      }
    } catch (cleanupError) {
      console.error('DataSync cleanup threw:', cleanupError);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Failed to clean up associated DataSync resources',
          details: cleanupError.message
        })
      };
    }
    
    // Check if storage is already being deleted
    if (storage.status === 'deleting') {
      return {
        statusCode: 409,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Storage is already being deleted'
        })
      };
    }
    
    // For Mountpoint S3 storage (no CloudFormation stack), just delete the DynamoDB record
    if (storage.type === 'mountpoint-s3') {
      await dynamodb.send(new DeleteCommand({
        TableName: process.env.STORAGE_TABLE_NAME,
        Key: { storageId }
      }));
      
      console.log(`Deleted Mountpoint S3 storage record: ${storageId}`);
      
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          message: 'Storage deleted successfully',
          storageId
        })
      };
    }
    
    // For FSx storage, check if we need to handle failed/stuck states
    const stackName = storage.cloudFormationStackName;
    
    // Get region from storage record (defaults to primary region if not set)
    const storageRegion = storage.region || process.env.AWS_REGION;
    console.log(`Storage ${storageId} is in region: ${storageRegion}`);
    
    // Get CloudFormation client for the storage's region
    const cfn = getCfnClient(storageRegion);
    
    // Check if the CloudFormation stack exists and its status
    let stackExists = false;
    let stackStatus = null;
    
    if (stackName) {
      try {
        const stackResponse = await cfn.send(new DescribeStacksCommand({
          StackName: stackName
        }));
        if (stackResponse.Stacks && stackResponse.Stacks.length > 0) {
          stackExists = true;
          stackStatus = stackResponse.Stacks[0].StackStatus;
          console.log(`Stack ${stackName} exists with status: ${stackStatus}`);
        }
      } catch (error) {
        if (error.message && error.message.includes('does not exist')) {
          console.log(`Stack ${stackName} does not exist`);
          stackExists = false;
        } else {
          throw error;
        }
      }
    }
    
    // Handle cases where we can delete directly without Step Functions
    // 1. No stack name (creation never got that far)
    // 2. Stack doesn't exist (already deleted or never created)
    // 3. Stack is in ROLLBACK_COMPLETE (failed and rolled back)
    // 4. Stack is in DELETE_COMPLETE
    const directDeleteStatuses = ['ROLLBACK_COMPLETE', 'DELETE_COMPLETE', 'CREATE_FAILED', 'DELETE_FAILED'];
    
    if (!stackName || !stackExists || (stackStatus && directDeleteStatuses.includes(stackStatus))) {
      console.log(`Direct delete: stackName=${stackName}, stackExists=${stackExists}, stackStatus=${stackStatus}`);
      
      // If stack exists in ROLLBACK_COMPLETE or DELETE_FAILED, try to delete it
      if (stackExists && (stackStatus === 'ROLLBACK_COMPLETE' || stackStatus === 'DELETE_FAILED')) {
        try {
          console.log(`Deleting rolled back/failed stack: ${stackName}`);
          await cfn.send(new DeleteStackCommand({ StackName: stackName }));
          console.log(`Stack deletion initiated for: ${stackName}`);
        } catch (error) {
          console.warn(`Could not delete stack ${stackName}: ${error.message}`);
          // Continue with DynamoDB deletion even if stack deletion fails
        }
      }
      
      // Delete the DynamoDB record directly
      await dynamodb.send(new DeleteCommand({
        TableName: process.env.STORAGE_TABLE_NAME,
        Key: { storageId }
      }));
      
      console.log(`Deleted storage record: ${storageId}`);
      
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          message: 'Storage deleted successfully',
          storageId
        })
      };
    }
    
    // For active stacks, use Step Functions for proper deletion workflow
    // But first check if the storage is stuck in 'creating' status
    if (storage.status === 'creating' || storage.status === 'validating') {
      // Check if the stack is actually still being created
      if (stackStatus && !stackStatus.includes('IN_PROGRESS')) {
        console.log(`Storage stuck in ${storage.status} but stack is ${stackStatus}, proceeding with deletion`);
        // Update status to allow deletion
        await dynamodb.send(new UpdateCommand({
          TableName: process.env.STORAGE_TABLE_NAME,
          Key: { storageId },
          UpdateExpression: 'SET #status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': 'failed' }
        }));
      } else {
        return {
          statusCode: 409,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: 'Cannot delete storage while it is being created. Please wait for creation to complete or fail.'
          })
        };
      }
    }
    
    // Start Step Functions execution for deletion
    const executionName = `storage-deletion-${storageId}-${Date.now()}`;
    
    // storageRegion already defined above
    
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: process.env.STORAGE_DELETION_STATE_MACHINE_ARN,
      name: executionName,
      input: JSON.stringify({
        storageId,
        cloudFormationStackName: stackName,
        region: storageRegion
      })
    }));
    
    console.log(`Started deletion execution: ${executionName} for region: ${storageRegion}`);
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        message: 'Storage deletion started',
        storageId,
        status: 'deleting'
      })
    };
    
  } catch (error) {
    console.error('Error starting storage deletion:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to start storage deletion',
        details: error.message
      })
    };
  }
};
