// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage CloudFormation Worker Lambda
 * 
 * Handles cross-region CloudFormation operations for storage resources.
 * Called by the storage creation/deletion state machines to deploy
 * CloudFormation stacks in regional hubs.
 * 
 * Actions:
 * - createStack: Create a new CloudFormation stack
 * - describeStacks: Get stack status (for polling)
 * - deleteStack: Delete a CloudFormation stack
 */

const { 
  CloudFormationClient, 
  CreateStackCommand, 
  DescribeStacksCommand,
  DeleteStackCommand 
} = require('@aws-sdk/client-cloudformation');

// Cache CloudFormation clients by region
const cfnClients = {};

function getCfnClient(region) {
  const targetRegion = region || process.env.AWS_REGION;
  if (!cfnClients[targetRegion]) {
    cfnClients[targetRegion] = new CloudFormationClient({ region: targetRegion });
  }
  return cfnClients[targetRegion];
}

exports.handler = async (event) => {
  console.log('StorageCfnWorker event:', JSON.stringify(event, null, 2));
  
  const { action, region, stackName, templateBody, parameters } = event;
  
  if (!action) {
    throw new Error('Missing required parameter: action');
  }
  
  if (!stackName) {
    throw new Error('Missing required parameter: stackName');
  }
  
  // Default to primary region if not specified
  const targetRegion = region || process.env.AWS_REGION;
  const cfn = getCfnClient(targetRegion);
  
  console.log(`Executing ${action} for stack ${stackName} in region ${targetRegion}`);
  
  switch (action) {
    case 'createStack':
      return await createStack(cfn, stackName, templateBody, parameters, targetRegion);
    
    case 'describeStacks':
      return await describeStacks(cfn, stackName, targetRegion);
    
    case 'deleteStack':
      return await deleteStack(cfn, stackName, targetRegion);
    
    default:
      throw new Error(`Unknown action: ${action}`);
  }
};

/**
 * Create a CloudFormation stack
 */
async function createStack(cfn, stackName, templateBody, parameters, region) {
  if (!templateBody) {
    throw new Error('Missing required parameter: templateBody for createStack');
  }
  
  try {
    const result = await cfn.send(new CreateStackCommand({
      StackName: stackName,
      TemplateBody: templateBody,
      Parameters: parameters || [],
      Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
      Tags: [
        { Key: 'ManagedBy', Value: process.env.PRODUCT_NAME || 'MediaResourceManager' },
        { Key: 'CreatedBy', Value: 'StorageStateMachine' },
        { Key: 'Region', Value: region }
      ],
      OnFailure: 'DELETE' // Clean up on failure
    }));
    
    console.log(`Stack creation initiated: ${result.StackId}`);
    
    return {
      stackId: result.StackId,
      stackName,
      region,
      status: 'CREATE_IN_PROGRESS'
    };
  } catch (error) {
    console.error('Error creating stack:', error);
    throw error;
  }
}

/**
 * Describe a CloudFormation stack (for polling status)
 */
async function describeStacks(cfn, stackName, region) {
  try {
    const result = await cfn.send(new DescribeStacksCommand({
      StackName: stackName
    }));
    
    if (!result.Stacks || result.Stacks.length === 0) {
      throw new Error(`Stack not found: ${stackName}`);
    }
    
    const stack = result.Stacks[0];
    
    console.log(`Stack ${stackName} status: ${stack.StackStatus}`);
    
    // Return in format compatible with state machine expectations
    return {
      Stacks: [{
        StackName: stack.StackName,
        StackId: stack.StackId,
        StackStatus: stack.StackStatus,
        StackStatusReason: stack.StackStatusReason,
        Outputs: stack.Outputs || [],
        CreationTime: stack.CreationTime,
        LastUpdatedTime: stack.LastUpdatedTime
      }],
      region
    };
  } catch (error) {
    // Handle stack not found (might be deleted)
    if (error.name === 'ValidationError' && error.message.includes('does not exist')) {
      console.log(`Stack ${stackName} does not exist`);
      return {
        Stacks: [{
          StackName: stackName,
          StackStatus: 'DELETE_COMPLETE',
          StackStatusReason: 'Stack does not exist'
        }],
        region
      };
    }
    console.error('Error describing stack:', error);
    throw error;
  }
}

/**
 * Delete a CloudFormation stack
 */
async function deleteStack(cfn, stackName, region) {
  try {
    await cfn.send(new DeleteStackCommand({
      StackName: stackName
    }));
    
    console.log(`Stack deletion initiated: ${stackName}`);
    
    return {
      stackName,
      region,
      status: 'DELETE_IN_PROGRESS'
    };
  } catch (error) {
    // If stack doesn't exist, consider it already deleted
    if (error.name === 'ValidationError' && error.message.includes('does not exist')) {
      console.log(`Stack ${stackName} already deleted or doesn't exist`);
      return {
        stackName,
        region,
        status: 'DELETE_COMPLETE'
      };
    }
    console.error('Error deleting stack:', error);
    throw error;
  }
}
