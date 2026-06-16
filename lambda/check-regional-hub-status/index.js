// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');

exports.handler = async (event) => {
  console.log('CheckRegionalHubStatus event:', JSON.stringify(event, null, 2));
  
  const { region, stackName } = event;
  
  if (!region || !stackName) {
    throw new Error('Missing required parameters: region, stackName');
  }
  
  // Create CloudFormation client for the TARGET region
  const cfn = new CloudFormationClient({ region });
  
  try {
    const result = await cfn.send(new DescribeStacksCommand({
      StackName: stackName
    }));
    
    if (!result.Stacks || result.Stacks.length === 0) {
      throw new Error(`Stack not found: ${stackName}`);
    }
    
    const stack = result.Stacks[0];
    
    console.log('Stack status:', stack.StackStatus);
    
    // Extract outputs if stack is complete
    let outputs = {};
    if (stack.StackStatus === 'CREATE_COMPLETE' && stack.Outputs) {
      for (const output of stack.Outputs) {
        outputs[output.OutputKey] = output.OutputValue;
      }
    }
    
    return {
      stackName,
      region,
      status: stack.StackStatus,
      statusReason: stack.StackStatusReason || null,
      outputs
    };
  } catch (error) {
    // Check if stack doesn't exist (might have been deleted)
    if (error.name === 'ValidationError' && error.message.includes('does not exist')) {
      return {
        stackName,
        region,
        status: 'DELETED',
        statusReason: 'Stack does not exist',
        outputs: {}
      };
    }
    console.error('Error checking stack status:', error);
    throw error;
  }
};
