// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Invoke AgentCore with Task Token Lambda
 * 
 * This Lambda is invoked by Step Functions with a TaskToken.
 * It invokes the AgentCore runtime and passes the TaskToken to the agent.
 * The agent will call SendTaskSuccess/SendTaskFailure when done.
 */

const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = require('@aws-sdk/client-bedrock-agentcore');
const { SFNClient, SendTaskFailureCommand } = require('@aws-sdk/client-sfn');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { randomUUID } = require('crypto');

const agentCoreClient = new BedrockAgentCoreClient({ region: process.env.AWS_REGION });
const sfnClient = new SFNClient({ region: process.env.AWS_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const taskToken = event.TaskToken;
  const requestData = event.requestData || {};

  if (!taskToken) {
    throw new Error('TaskToken is required');
  }

  try {
    // Get the AgentCore runtime ARN from SSM
    let runtimeArn;
    try {
      const response = await ssmClient.send(new GetParameterCommand({
        Name: '/agentcore/install_script_agent/runtime-arn'
      }));
      runtimeArn = response.Parameter?.Value;
    } catch (error) {
      console.error('Could not get runtime ARN from SSM:', error);
      await sendTaskFailure(taskToken, 'ConfigurationError', 'AgentCore runtime not configured');
      throw new Error('AgentCore runtime not configured');
    }

    if (!runtimeArn) {
      await sendTaskFailure(taskToken, 'ConfigurationError', 'AgentCore runtime ARN not found');
      throw new Error('AgentCore runtime ARN not found');
    }

    console.log('Invoking AgentCore runtime:', runtimeArn);

    // Generate session ID
    const sessionId = requestData.sessionId || randomUUID();

    // Build the payload for the agent - include TaskToken for callback
    const agentPayload = {
      action: 'generate',
      taskToken: taskToken,
      executionId: requestData.executionId,
      softwareId: requestData.softwareId,
      softwareName: requestData.softwareName,
      platform: requestData.platform,
      mediaS3Uri: requestData.mediaS3Uri || '',
      sessionId: sessionId,
      testAutomatically: requestData.testAutomatically ?? true,
      maxAttempts: requestData.maxAttempts ?? 3,
      isDraftMode: requestData.isDraftMode ?? false,
    };

    console.log('Agent payload:', JSON.stringify(agentPayload, null, 2));

    // Invoke the AgentCore runtime
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: sessionId,
      payload: Buffer.from(JSON.stringify(agentPayload)),
      qualifier: 'DEFAULT'
    });

    // Fire-and-forget pattern with error detection
    // The SDK's InvokeAgentRuntime waits for the full response, but we can't wait
    // because the agent takes minutes to complete. Instead, we start the invocation
    // and use Promise.race to detect immediate failures (auth errors, bad ARN, etc.)
    
    const invokePromise = agentCoreClient.send(command);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('TIMEOUT_OK')), 2000)
    );
    
    try {
      // Race between invocation and timeout
      // If invocation fails quickly (auth error, etc.), we'll catch it
      // If it's still running after 2s, that means it was accepted
      await Promise.race([invokePromise, timeoutPromise]);
      // If we get here, the agent responded very quickly (unlikely for real work)
      console.log('AgentCore responded quickly - agent will callback via TaskToken');
    } catch (error) {
      if (error.message === 'TIMEOUT_OK') {
        // This is expected - invocation is in progress, agent will callback
        console.log('AgentCore invocation accepted - agent will callback via TaskToken');
      } else {
        // Real error - invocation failed
        console.error('AgentCore invocation failed:', error.message);
        await sendTaskFailure(taskToken, 'InvocationError', error.message);
        throw error;
      }
    }

    // Return - Step Functions will wait for the TaskToken callback from the agent
    return {
      statusCode: 200,
      message: 'Agent invocation started',
      sessionId: sessionId
    };

  } catch (error) {
    console.error('Error:', error);
    await sendTaskFailure(taskToken, 'UnknownError', error.message);
    throw error;
  }
};

async function sendTaskFailure(taskToken, error, cause) {
  try {
    await sfnClient.send(new SendTaskFailureCommand({
      taskToken: taskToken,
      error: error,
      cause: cause.substring(0, 256)
    }));
    console.log('Sent task failure:', error);
  } catch (err) {
    console.error('Failed to send task failure:', err);
  }
}

// Helper to convert stream to string
async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
