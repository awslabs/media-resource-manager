// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { CloudFormationClient, DeleteStackCommand, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');

/**
 * CloudFormation Delete Lambda - Deletes CloudFormation stack in target region
 * Called by the Regional Hub Deletion State Machine
 */
exports.handler = async (event) => {
  console.log('DeleteRegionalHubCfn event:', JSON.stringify(event, null, 2));
  
  const { region, stackName } = event;
  
  if (!region || !stackName) {
    throw new Error('Missing required parameters: region, stackName');
  }
  
  // Create CloudFormation client for the TARGET region
  const cfn = new CloudFormationClient({ region });
  
  try {
    // First check if stack exists
    try {
      await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    } catch (error) {
      if (error.name === 'ValidationError' && error.message.includes('does not exist')) {
        console.log('Stack does not exist, nothing to delete');
        return {
          stackName,
          region,
          status: 'DELETED',
          message: 'Stack does not exist'
        };
      }
      throw error;
    }
    
    // Delete the stack
    await cfn.send(new DeleteStackCommand({
      StackName: stackName
    }));
    
    console.log('Stack deletion initiated:', stackName);
    
    return {
      stackName,
      region,
      status: 'DELETE_IN_PROGRESS'
    };
  } catch (error) {
    console.error('Error deleting stack:', error);
    throw error;
  }
};
