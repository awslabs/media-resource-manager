// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Invoke Install Script Agent Lambda
 * 
 * Validates request parameters, checks usage limits, and starts the
 * Step Functions state machine to generate installation scripts.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { randomUUID } = require('crypto');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const sfnClient = new SFNClient({ region: process.env.AWS_REGION });

const EXECUTION_STATE_TABLE = process.env.EXECUTION_STATE_TABLE_NAME;
const USAGE_TABLE = process.env.USAGE_TABLE_NAME;
const PASCAL_CASE_NAME = process.env.PASCAL_CASE_NAME;
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Handle OPTIONS preflight
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    const body = JSON.parse(event.body || '{}');
    // Generate a softwareId if not provided - use software name as base for cleaner IDs
    const baseName = (body.softwareName || 'software').toLowerCase().replace(/[^a-z0-9]/g, '-');
    const softwareId = event.pathParameters?.softwareId || `${baseName}-${randomUUID().substring(0, 8)}`;
    // Always save to library (no draft mode) - agent will create the script and save it
    const isDraftMode = false;

    // Validate required parameters
    const validation = validateRequest(body, softwareId);
    if (!validation.valid) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: validation.error })
      };
    }

    // Check if agent is enabled
    const agentEnabled = await checkAgentEnabled();
    if (!agentEnabled) {
      return {
        statusCode: 503,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Install Script Agent is currently disabled' })
      };
    }

    // Check usage limits
    const withinLimits = await checkUsageLimits();
    if (!withinLimits.allowed) {
      return {
        statusCode: 429,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'Usage limit exceeded',
          limitType: withinLimits.limitType,
          currentUsage: withinLimits.currentUsage,
          limit: withinLimits.limit
        })
      };
    }

    // Generate execution ID and session ID
    const executionId = randomUUID();
    const sessionId = body.sessionId || randomUUID();

    // Create initial execution state record
    const request = {
      softwareName: body.softwareName,
      platform: body.platform,
      testAutomatically: body.testAutomatically !== false,
      maxAttempts: body.maxAttempts || 3,
      timeoutMinutes: body.timeoutMinutes || 15,
      isDraftMode
    };
    if (body.version) request.version = body.version;
    if (body.mediaS3Uri) request.mediaS3Uri = body.mediaS3Uri;

    await createExecutionState({
      executionId,
      softwareId,
      sessionId,
      status: 'pending',
      request,
      isDraftMode,
      createdAt: new Date().toISOString()
    });

    // Get the state machine ARN from environment or SSM
    let stateMachineArn = STATE_MACHINE_ARN;
    if (!stateMachineArn) {
      try {
        const response = await ssmClient.send(new GetParameterCommand({
          Name: `/${PASCAL_CASE_NAME}/Agent/ScriptGenerationStateMachineArn`
        }));
        stateMachineArn = response.Parameter?.Value;
      } catch (error) {
        console.error('Could not get state machine ARN from SSM:', error);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Script generation state machine not configured' })
        };
      }
    }

    if (!stateMachineArn) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Script generation state machine ARN not found' })
      };
    }

    // Start the state machine execution
    const stateMachineInput = {
      executionId,
      sessionId,
      softwareId,
      softwareName: body.softwareName,
      platform: body.platform,
      mediaS3Uri: body.mediaS3Uri || '',
      testAutomatically: body.testAutomatically ?? true,
      maxAttempts: body.maxAttempts ?? 3,
      isDraftMode,
      userRequirements: body.userRequirements || ''
    };

    console.log('Starting state machine:', stateMachineArn);
    console.log('Input:', JSON.stringify(stateMachineInput, null, 2));

    await sfnClient.send(new StartExecutionCommand({
      stateMachineArn,
      name: executionId,
      input: JSON.stringify(stateMachineInput)
    }));

    return {
      statusCode: 202,
      headers: corsHeaders,
      body: JSON.stringify({
        executionId,
        sessionId,
        status: 'started',
        progressUrl: isDraftMode 
          ? `/images/software/generation-progress-draft?executionId=${executionId}`
          : `/images/software/${softwareId}/generation-progress?executionId=${executionId}`
      })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message })
    };
  }
};

function validateRequest(body, softwareId) {
  if (!body.softwareName) {
    return { valid: false, error: 'softwareName is required' };
  }
  if (!body.platform || !['Windows', 'Linux'].includes(body.platform)) {
    return { valid: false, error: 'platform must be Windows or Linux' };
  }
  return { valid: true };
}

async function checkAgentEnabled() {
  try {
    const response = await ssmClient.send(new GetParameterCommand({
      Name: `/${PASCAL_CASE_NAME}/Agent/Enabled`
    }));
    return response.Parameter?.Value === 'true';
  } catch (error) {
    if (error.name === 'ParameterNotFound') {
      return true;
    }
    throw error;
  }
}

async function checkUsageLimits() {
  const today = new Date().toISOString().split('T')[0];
  const month = today.substring(0, 7);

  let dailyLimit = 10;
  let monthlyLimit = 100;

  try {
    const [dailyParam, monthlyParam] = await Promise.all([
      ssmClient.send(new GetParameterCommand({ Name: `/${PASCAL_CASE_NAME}/Agent/MaxDailyGenerations` })),
      ssmClient.send(new GetParameterCommand({ Name: `/${PASCAL_CASE_NAME}/Agent/MaxMonthlyGenerations` }))
    ]);
    dailyLimit = parseInt(dailyParam.Parameter?.Value || '10', 10);
    monthlyLimit = parseInt(monthlyParam.Parameter?.Value || '100', 10);
  } catch (error) {
    console.warn('Could not fetch limits from SSM, using defaults:', error.message);
  }

  const [dailyUsage, monthlyUsage] = await Promise.all([
    getUsage(`daily#${today}`),
    getUsage(`monthly#${month}`)
  ]);

  if (dailyUsage >= dailyLimit) {
    return { allowed: false, limitType: 'daily', currentUsage: dailyUsage, limit: dailyLimit };
  }
  if (monthlyUsage >= monthlyLimit) {
    return { allowed: false, limitType: 'monthly', currentUsage: monthlyUsage, limit: monthlyLimit };
  }

  return { allowed: true, dailyUsage, monthlyUsage };
}

async function getUsage(usageKey) {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: USAGE_TABLE,
      Key: { usageKey }
    }));
    return result.Item?.count || 0;
  } catch (error) {
    console.warn('Could not get usage:', error.message);
    return 0;
  }
}

async function createExecutionState(state) {
  await docClient.send(new PutCommand({
    TableName: EXECUTION_STATE_TABLE,
    Item: state
  }));
}
