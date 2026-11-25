// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { requireAdmin } = require('../shared/authz');
const { requestSummary } = require('../shared/log-redact');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sfnClient = new SFNClient({});
const ssmClient = new SSMClient({});

const REGIONAL_HUBS_TABLE = process.env.REGIONAL_HUBS_TABLE_NAME;
const WORKSTATION_TABLE = process.env.WORKSTATION_TABLE_NAME;
const PASCAL_CASE_NAME = process.env.PASCAL_CASE_NAME;

/**
 * API Handler Lambda - Deletes a regional hub
 * Validates no workstations exist, updates status, and starts the deletion state machine
 */
exports.handler = async (event) => {
  console.log('DeleteRegionalHub API event:', JSON.stringify(requestSummary(event)));

  // SECURITY: deleting a regional hub tears down the region's stack and
  // orphans any workstations still running there.
  // Admin only. See H1-3966572 / GHSA-58q4-fcw9-2778 / SIM P498186948.
  const denial = requireAdmin(event);
  if (denial) return denial;

  try {
    // Get region from path parameters
    const region = event.pathParameters?.region;
    
    if (!region) {
      return response(400, { error: 'Region is required' });
    }
    
    // Check if regional hub exists
    const hubResult = await docClient.send(new GetCommand({
      TableName: REGIONAL_HUBS_TABLE,
      Key: { region }
    }));
    
    if (!hubResult.Item) {
      return response(404, { error: `Regional hub not found for region ${region}` });
    }
    
    const hub = hubResult.Item;
    
    // Check if hub is in a deletable state
    const deletableStates = ['available', 'failed', 'delete-failed'];
    if (!deletableStates.includes(hub.status)) {
      return response(409, { 
        error: `Cannot delete regional hub in status: ${hub.status}`,
        status: hub.status
      });
    }
    
    // Check if this is the primary region (cannot delete primary)
    if (hub.isPrimary) {
      return response(400, { error: 'Cannot delete the primary region' });
    }

    // Workstations still in the Region use the hub's VPC, subnets and roles,
    // and its stack can't be deleted around them.
    const workstationCount = await countActiveWorkstations(region);
    if (workstationCount > 0) {
      const noun = workstationCount === 1 ? 'workstation' : 'workstations';
      return response(409, {
        error: `Terminate the ${workstationCount} ${noun} in ${region} before deleting its regional hub.`,
        workstationCount
      });
    }
    
    // Update status to deleting
    await docClient.send(new UpdateCommand({
      TableName: REGIONAL_HUBS_TABLE,
      Key: { region },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':status': 'deleting',
        ':updatedAt': new Date().toISOString()
      }
    }));
    
    // Get state machine ARN from SSM
    const ssmParam = await ssmClient.send(new GetParameterCommand({
      Name: `/${PASCAL_CASE_NAME}/RegionalHub/DeletionStateMachineArn`
    }));
    
    const stateMachineArn = ssmParam.Parameter.Value;
    
    // Start the deletion state machine
    const executionResult = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify({
        region,
        cloudFormationStackName: hub.cloudFormationStackName
      })
    }));
    
    console.log('Deletion state machine execution started:', executionResult.executionArn);
    
    return response(202, {
      message: 'Regional hub deletion initiated',
      region,
      status: 'deleting',
      executionArn: executionResult.executionArn
    });
    
  } catch (error) {
    console.error('Error deleting regional hub:', error);
    return response(500, { error: error.message });
  }
};

// Workstation records whose instance is gone: the EC2 state handler marks a
// terminated instance's record 'Terminated', and a failed create is 'failed'.
const ENDED_STATUSES = ['terminated', 'failed'];

/**
 * Count the workstation records in a Region whose instance may still exist.
 * Same filtered scan as getWorkstationCountForRegion in get-regional-hub (the
 * table has no region index and few items), read to the last page. Records
 * without a region belong to the primary Region, which can't be deleted, so
 * they don't count here.
 */
async function countActiveWorkstations(region) {
  let count = 0;
  let ExclusiveStartKey;
  do {
    const page = await docClient.send(new ScanCommand({
      TableName: WORKSTATION_TABLE,
      FilterExpression: '#r = :region',
      ExpressionAttributeNames: { '#r': 'region', '#s': 'status' },
      ExpressionAttributeValues: { ':region': region },
      ProjectionExpression: 'instanceId, #s, instanceStatus',
      ExclusiveStartKey
    }));
    count += (page.Items || []).filter(item =>
      !ENDED_STATUSES.includes(String(item.status || '').toLowerCase()) &&
      String(item.instanceStatus || '').toLowerCase() !== 'terminated'
    ).length;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return count;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    },
    body: JSON.stringify(body)
  };
}
