// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});

const REGIONAL_HUBS_TABLE = process.env.REGIONAL_HUBS_TABLE_NAME;
const PASCAL_CASE_NAME = process.env.PASCAL_CASE_NAME;
const ACRONYM = process.env.ACRONYM;

/**
 * API Handler Lambda - Updates an existing regional hub
 * Regenerates the CloudFormation template and updates the stack
 */
exports.handler = async (event) => {
  console.log('UpdateRegionalHub API event:', JSON.stringify(event, null, 2));
  
  try {
    // Parse request body
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    
    const { region } = body;
    
    // Validate required fields
    if (!region) {
      return response(400, { error: 'Region is required' });
    }
    
    // Get existing hub record
    const existingHub = await docClient.send(new GetCommand({
      TableName: REGIONAL_HUBS_TABLE,
      Key: { region }
    }));
    
    if (!existingHub.Item) {
      return response(404, { error: `Regional hub not found for region ${region}` });
    }
    
    const hub = existingHub.Item;
    
    // Check if hub is in a state that allows updates
    const updatableStates = ['available', 'update_failed'];
    if (!updatableStates.includes(hub.status)) {
      return response(409, { 
        error: `Regional hub is in state '${hub.status}' and cannot be updated. Must be in one of: ${updatableStates.join(', ')}` 
      });
    }
    
    // Allow overriding certain settings from the request body
    const enableWindows = body.enableWindows !== undefined ? body.enableWindows : hub.enableWindows;
    const enableLinux = body.enableLinux !== undefined ? body.enableLinux : hub.enableLinux;
    const enableMacOS = body.enableMacOS !== undefined ? body.enableMacOS : hub.enableMacOS;
    const dcvDomainName = body.dcvDomainName !== undefined ? body.dcvDomainName : hub.dcvDomainName;
    const dcvCertificateArn = body.dcvCertificateArn !== undefined ? body.dcvCertificateArn : hub.dcvCertificateArn;
    
    // Update status to 'updating'
    await docClient.send(new UpdateCommand({
      TableName: REGIONAL_HUBS_TABLE,
      Key: { region },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, enableWindows = :enableWindows, enableLinux = :enableLinux, enableMacOS = :enableMacOS',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'updating',
        ':updatedAt': new Date().toISOString(),
        ':enableWindows': enableWindows,
        ':enableLinux': enableLinux,
        ':enableMacOS': enableMacOS
      }
    }));
    
    // Step 1: Generate new CloudFormation template
    console.log('Generating updated CloudFormation template...');
    const generateTemplateResult = await lambdaClient.send(new InvokeCommand({
      FunctionName: `${ACRONYM.toLowerCase()}-generate-regional-hub-template`,
      Payload: JSON.stringify({
        region: hub.region,
        displayName: hub.displayName,
        vpcCidr: hub.vpcCidr,
        availabilityZones: hub.availabilityZones,
        publicSubnetMask: hub.publicSubnetMask,
        privateSubnetMask: hub.privateSubnetMask,
        dcvDomainName,
        dcvCertificateArn,
        enableWindows,
        enableLinux,
        enableMacOS
      })
    }));
    
    const templateResult = JSON.parse(Buffer.from(generateTemplateResult.Payload).toString());
    console.log('Template generation result:', JSON.stringify(templateResult, null, 2));
    
    if (generateTemplateResult.FunctionError) {
      throw new Error(`Template generation failed: ${templateResult.errorMessage || 'Unknown error'}`);
    }
    
    // Step 2: Update the CloudFormation stack
    console.log('Updating CloudFormation stack...');
    const updateStackResult = await lambdaClient.send(new InvokeCommand({
      FunctionName: `${ACRONYM.toLowerCase()}-update-regional-hub-cfn`,
      Payload: JSON.stringify({
        region: templateResult.region,
        stackName: templateResult.stackName,
        templateUrl: templateResult.templateUrl,
        parameters: templateResult.parameters
      })
    }));
    
    const stackResult = JSON.parse(Buffer.from(updateStackResult.Payload).toString());
    console.log('Stack update result:', JSON.stringify(stackResult, null, 2));
    
    if (updateStackResult.FunctionError) {
      // Update status to failed
      await docClient.send(new UpdateCommand({
        TableName: REGIONAL_HUBS_TABLE,
        Key: { region },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, lastError = :error',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'update_failed',
          ':updatedAt': new Date().toISOString(),
          ':error': stackResult.errorMessage || 'Unknown error'
        }
      }));
      
      throw new Error(`Stack update failed: ${stackResult.errorMessage || 'Unknown error'}`);
    }
    
    // Handle "no changes" case
    if (stackResult.status === 'NO_CHANGES') {
      await docClient.send(new UpdateCommand({
        TableName: REGIONAL_HUBS_TABLE,
        Key: { region },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'available',
          ':updatedAt': new Date().toISOString()
        }
      }));
      
      return response(200, {
        message: 'Regional hub is already up to date',
        region,
        status: 'available'
      });
    }
    
    return response(202, {
      message: 'Regional hub update initiated',
      region,
      status: 'updating',
      stackId: stackResult.stackId
    });
    
  } catch (error) {
    console.error('Error updating regional hub:', error);
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
