// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { CloudFormationClient, UpdateStackCommand, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const REGIONAL_HUBS_TABLE = process.env.REGIONAL_HUBS_TABLE_NAME;
const ACRONYM = process.env.ACRONYM;

/**
 * Update Regional Hub CloudFormation Stack
 * Regenerates the template and updates the existing stack
 */
exports.handler = async (event) => {
  console.log('UpdateRegionalHubCfn event:', JSON.stringify(event, null, 2));
  
  const { region, stackName, templateUrl, parameters } = event;
  
  if (!region || !stackName || !templateUrl) {
    throw new Error('Missing required parameters: region, stackName, templateUrl');
  }
  
  // Get the CloudFormation service role ARN from environment
  const cfnServiceRoleArn = process.env.CFN_SERVICE_ROLE_ARN;
  if (!cfnServiceRoleArn) {
    throw new Error('CFN_SERVICE_ROLE_ARN environment variable not set');
  }
  
  // Create CloudFormation client for the TARGET region
  const cfn = new CloudFormationClient({ region });
  
  try {
    // First, verify the stack exists
    const describeResult = await cfn.send(new DescribeStacksCommand({
      StackName: stackName
    }));
    
    if (!describeResult.Stacks || describeResult.Stacks.length === 0) {
      throw new Error(`Stack ${stackName} not found in region ${region}`);
    }
    
    const currentStack = describeResult.Stacks[0];
    const currentStatus = currentStack.StackStatus;
    
    // Check if stack is in a state that allows updates
    const updatableStates = [
      'CREATE_COMPLETE',
      'UPDATE_COMPLETE',
      'UPDATE_ROLLBACK_COMPLETE',
      'IMPORT_COMPLETE',
      'IMPORT_ROLLBACK_COMPLETE'
    ];
    
    if (!updatableStates.includes(currentStatus)) {
      throw new Error(`Stack ${stackName} is in state ${currentStatus} and cannot be updated. Must be in one of: ${updatableStates.join(', ')}`);
    }
    
    console.log(`Stack ${stackName} is in state ${currentStatus}, proceeding with update...`);
    
    // Update the stack
    const updateResult = await cfn.send(new UpdateStackCommand({
      StackName: stackName,
      TemplateURL: templateUrl,
      Parameters: parameters || [],
      Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
      RoleARN: cfnServiceRoleArn,
      Tags: [
        { Key: 'ManagedBy', Value: process.env.PRODUCT_NAME || 'MediaResourceManager' },
        { Key: 'UpdatedBy', Value: 'RegionalHubUpdate' },
        { Key: 'LastUpdated', Value: new Date().toISOString() }
      ]
    }));
    
    console.log('Stack update initiated:', updateResult.StackId);
    
    // Update DynamoDB record status
    if (REGIONAL_HUBS_TABLE) {
      await docClient.send(new UpdateCommand({
        TableName: REGIONAL_HUBS_TABLE,
        Key: { region },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'updating',
          ':updatedAt': new Date().toISOString()
        }
      }));
    }
    
    return {
      stackId: updateResult.StackId,
      stackName,
      region,
      status: 'UPDATE_IN_PROGRESS',
      previousStatus: currentStatus
    };
  } catch (error) {
    // Handle "No updates are to be performed" as success
    if (error.message && error.message.includes('No updates are to be performed')) {
      console.log('No changes detected, stack is already up to date');
      return {
        stackName,
        region,
        status: 'NO_CHANGES',
        message: 'Stack is already up to date, no changes required'
      };
    }
    
    console.error('Error updating stack:', error);
    throw error;
  }
};
