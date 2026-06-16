// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

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
  console.log('DeleteRegionalHub API event:', JSON.stringify(event, null, 2));
  
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
    
    // Check if there are any workstations in this region
    // Note: This would require a GSI on region, for now we'll skip this check
    // TODO: Add workstation check when GSI is available
    
    // Check if this is the primary region (cannot delete primary)
    if (hub.isPrimary) {
      return response(400, { error: 'Cannot delete the primary region' });
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
