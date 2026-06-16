// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Install Script Progress Lambda (SSE)
 * 
 * Implements Server-Sent Events streaming for real-time progress updates
 * during script generation.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const EXECUTION_STATE_TABLE = process.env.EXECUTION_STATE_TABLE_NAME;
const PROGRESS_TABLE = process.env.PROGRESS_TABLE_NAME;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Handle OPTIONS preflight
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    // softwareId can come from path (existing flow) or be omitted (draft mode)
    const softwareId = event.pathParameters?.softwareId;
    const executionId = event.queryStringParameters?.executionId;
    const lastEventId = event.queryStringParameters?.lastEventId;

    if (!executionId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'executionId is required' })
      };
    }

    // Get execution state
    const executionState = await getExecutionState(executionId);
    if (!executionState) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Execution not found' })
      };
    }

    // Verify softwareId matches (only if softwareId is provided in path)
    if (softwareId && executionState.softwareId !== softwareId) {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Execution does not belong to this software' })
      };
    }

    // Get progress events
    const progressEvents = await getProgressEvents(executionId, lastEventId);

    // Build SSE response
    const sseData = buildSSEResponse(executionState, progressEvents);

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      },
      body: sseData
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

async function getExecutionState(executionId) {
  const result = await docClient.send(new GetCommand({
    TableName: EXECUTION_STATE_TABLE,
    Key: { executionId }
  }));
  return result.Item;
}

async function getProgressEvents(executionId, lastEventId) {
  const params = {
    TableName: PROGRESS_TABLE,
    KeyConditionExpression: 'executionId = :executionId',
    ExpressionAttributeValues: {
      ':executionId': executionId
    },
    ScanIndexForward: true // Chronological order
  };

  // If lastEventId provided, only get events after it
  if (lastEventId) {
    params.KeyConditionExpression += ' AND eventId > :lastEventId';
    params.ExpressionAttributeValues[':lastEventId'] = lastEventId;
  }

  const result = await docClient.send(new QueryCommand(params));
  return result.Items || [];
}

function buildSSEResponse(executionState, progressEvents) {
  const lines = [];

  // Send current state as first event (includes progress from execution state table)
  lines.push(formatSSEEvent('state', {
    executionId: executionState.executionId,
    status: executionState.status,
    currentPhase: executionState.currentPhase,
    progressPercent: executionState.progressPercent || 0,
    progressMessage: executionState.progressMessage || '',
    currentAttempt: executionState.currentAttempt,
    maxAttempts: executionState.maxAttempts
  }));

  // Send progress events from progress table (if any)
  for (const event of progressEvents) {
    lines.push(formatSSEEvent('progress', {
      eventId: event.eventId,
      phase: event.phase,
      message: event.message,
      percent: event.percent,
      timestamp: event.timestamp
    }));
  }

  // Send completion event if finished
  if (executionState.status === 'completed' || executionState.status === 'failed') {
    lines.push(formatSSEEvent('complete', {
      status: executionState.status,
      script: executionState.script,
      verified: executionState.verified,
      suggestedCategory: executionState.suggestedCategory,
      suggestedDescription: executionState.suggestedDescription,
      componentArn: executionState.componentArn,
      error: executionState.error,
      attempts: executionState.currentAttempt,
      logs: executionState.logs
    }));
  }

  return lines.join('\n');
}

function formatSSEEvent(eventType, data) {
  const lines = [];
  lines.push(`event: ${eventType}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  lines.push(''); // Empty line to end event
  return lines.join('\n');
}
