// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());
const lambda = new LambdaClient();

exports.handler = async (event) => {
    console.log('EC2 State Change Event:', JSON.stringify(event, null, 2));

    // Handle EC2 instance type change via CloudTrail ModifyInstanceAttribute
    if (event['detail-type'] === 'AWS API Call via CloudTrail' &&
        event.detail?.eventName === 'ModifyInstanceAttribute') {
        const instanceId = event.detail?.requestParameters?.instanceId;
        const newInstanceType = event.detail?.requestParameters?.instanceType?.value;

        if (!instanceId || !newInstanceType) {
            console.log('ModifyInstanceAttribute event missing instanceId or instanceType — skipping');
            return;
        }

        console.log(`Instance type changed for ${instanceId}: ${newInstanceType} (via CloudTrail)`);

        try {
            await dynamodb.send(new UpdateCommand({
                TableName: process.env.WORKSTATION_TABLE_NAME,
                Key: { instanceId },
                UpdateExpression: 'SET instanceType = :instanceType, updatedAt = :updatedAt',
                ExpressionAttributeValues: {
                    ':instanceType': newInstanceType,
                    ':updatedAt': new Date().toISOString()
                },
                ConditionExpression: 'attribute_exists(instanceId)'
            }));
            console.log(`Updated instanceType to ${newInstanceType} for ${instanceId}`);
        } catch (error) {
            if (error.name === 'ConditionalCheckFailedException') {
                console.log(`Instance ${instanceId} not found in workstation table - ignoring`);
            } else {
                console.error('Error updating instance type:', error);
                throw error;
            }
        }
        return;
    }

    const instanceId = event.detail['instance-id'];
    const state = event.detail.state;

    if (!instanceId || !state) {
        console.log('Missing instanceId or state in event');
        return;
    }

    try {
        // Clean up DCV sessions for terminated/shutting-down instances
        if (state === 'shutting-down' || state === 'terminated') {
            try {
                // Get workstation data to find DCV session info
                const workstation = await dynamodb.send(new GetCommand({
                    TableName: process.env.WORKSTATION_TABLE_NAME,
                    Key: { instanceId }
                }));

                if (workstation.Item && workstation.Item.dcvSessionId) {
                    console.log('Cleaning up DCV session ' + workstation.Item.dcvSessionId + ' for instance ' + instanceId);

                    // Invoke DCV session manager to delete the session
                    await lambda.send(new InvokeCommand({
                        FunctionName: process.env.DCV_SESSION_MANAGER_FUNCTION_ARN,
                        InvocationType: 'Event', // Async invocation
                        Payload: JSON.stringify({
                            action: 'delete-session',
                            instanceId: instanceId,
                            sessionId: workstation.Item.dcvSessionId
                        })
                    }));

                    console.log('DCV session cleanup initiated for ' + instanceId);
                }
            } catch (sessionError) {
                console.error(`Error cleaning up DCV session for \${instanceId}:`, sessionError);
                // Don't fail the whole handler if session cleanup fails
              }
            }
            
            // Update status based on instance state
            if (state === 'running') {
              // Update instanceStatus. If the workflow status is 'Rebooting', clear it back to 'Running'
              // since the instance has come back up after a reboot.
              await dynamodb.send(new UpdateCommand({
                TableName: process.env.WORKSTATION_TABLE_NAME,
                Key: { instanceId },
                UpdateExpression: 'SET instanceStatus = :instanceStatus, #status = if_not_exists(#status, :running), updatedAt = :updatedAt',
                ExpressionAttributeNames: {
                  '#status': 'status'
                },
                ExpressionAttributeValues: {
                  ':instanceStatus': state,
                  ':running': 'Running',
                  ':updatedAt': new Date().toISOString()
                },
                ConditionExpression: 'attribute_exists(instanceId)'
              }));
              // If status was Rebooting, explicitly reset it to Running
              try {
                await dynamodb.send(new UpdateCommand({
                  TableName: process.env.WORKSTATION_TABLE_NAME,
                  Key: { instanceId },
                  UpdateExpression: 'SET #status = :running, updatedAt = :updatedAt',
                  ExpressionAttributeNames: { '#status': 'status' },
                  ExpressionAttributeValues: {
                    ':running': 'Running',
                    ':rebooting': 'Rebooting',
                    ':updatedAt': new Date().toISOString()
                  },
                  ConditionExpression: '#status = :rebooting'
                }));
                console.log(`Cleared Rebooting status for ${instanceId} — instance is back online`);
              } catch (condErr) {
                // Not in Rebooting state — that's fine, ignore
              }
            } else if (state === 'stopped') {
              // Set workflow status to "Stopped" when instance is fully stopped
              // But don't overwrite if the start workflow already completed (race condition)
              try {
                await dynamodb.send(new UpdateCommand({
                  TableName: process.env.WORKSTATION_TABLE_NAME,
                  Key: { instanceId },
                  UpdateExpression: 'SET instanceStatus = :instanceStatus, dcvStatus = :dcvStatus, #status = :workflowStatus, updatedAt = :updatedAt',
                  ExpressionAttributeNames: {
                    '#status': 'status'
                  },
                  ExpressionAttributeValues: {
                    ':instanceStatus': state,
                    ':dcvStatus': 'stopped',
                    ':workflowStatus': 'Stopped',
                    ':updatedAt': new Date().toISOString(),
                    ':complete': 'Complete',
                    ':running': 'Running',
                    ':dcvReady': 'DCV Ready',
                    ':starting': 'Starting',
                    ':startingDcv': 'Starting DCV',
                    ':configuring': 'Configuring'
                  },
                  ConditionExpression: 'attribute_exists(instanceId) AND #status <> :complete AND #status <> :running AND #status <> :dcvReady AND #status <> :starting AND #status <> :startingDcv AND #status <> :configuring'
                }));
              } catch (condErr) {
                if (condErr.name === 'ConditionalCheckFailedException') {
                  console.log('Skipping stopped update for ' + instanceId + ' - workstation is in an active start workflow state');
                  // Still update instanceStatus so we track the EC2 state accurately
                  await dynamodb.send(new UpdateCommand({
                    TableName: process.env.WORKSTATION_TABLE_NAME,
                    Key: { instanceId },
                    UpdateExpression: 'SET instanceStatus = :instanceStatus, updatedAt = :updatedAt',
                    ExpressionAttributeValues: {
                      ':instanceStatus': state,
                      ':updatedAt': new Date().toISOString()
                    },
                    ConditionExpression: 'attribute_exists(instanceId)'
                  }));
                } else {
                  throw condErr;
                }
              }
            } else if (state === 'terminated' || state === 'shutting-down') {
              // Set workflow status for terminal states
              const workflowStatus = state === 'terminated' ? 'Terminated' : 'Stopped';
              const updateExpression = state === 'terminated' 
                ? 'SET instanceStatus = :instanceStatus, dcvStatus = :dcvStatus, #status = :workflowStatus, updatedAt = :updatedAt REMOVE dcvSessionId, sessionState'
                : 'SET instanceStatus = :instanceStatus, dcvStatus = :dcvStatus, #status = :workflowStatus, updatedAt = :updatedAt';
                
              await dynamodb.send(new UpdateCommand({
                TableName: process.env.WORKSTATION_TABLE_NAME,
                Key: { instanceId },
                UpdateExpression: updateExpression,
                ExpressionAttributeNames: {
                  '#status': 'status'
                },
                ExpressionAttributeValues: {
                  ':instanceStatus': state,
                  ':dcvStatus': 'stopped',
                  ':workflowStatus': workflowStatus,
                  ':updatedAt': new Date().toISOString()
                },
                ConditionExpression: 'attribute_exists(instanceId)'
              }));
            } else {
              // For other states (pending, stopping), only update instanceStatus
              await dynamodb.send(new UpdateCommand({
                TableName: process.env.WORKSTATION_TABLE_NAME,
                Key: { instanceId },
                UpdateExpression: 'SET instanceStatus = :instanceStatus, updatedAt = :updatedAt',
                ExpressionAttributeValues: {
                  ':instanceStatus': state,
                  ':updatedAt': new Date().toISOString()
                },
                ConditionExpression: 'attribute_exists(instanceId)'
              }));
            }
            
            console.log('Updated instance ' + instanceId + ': state=' + state);
          } catch (error) {
            if (error.name === 'ConditionalCheckFailedException') {
              console.log('Instance ' + instanceId + ' not found in workstation table - ignoring');
            } else {
              console.error('Error updating workstation status:', error);
              throw error;
            }
          }
        };