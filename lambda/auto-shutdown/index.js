// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { EC2Client, StopInstancesCommand } = require('@aws-sdk/client-ec2');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());
const ssm = new SSMClient();

// Cache EC2 clients by region
const ec2Clients = {};
function getEC2Client(region) {
  if (!region) {
    region = process.env.AWS_REGION;
  }
  if (!ec2Clients[region]) {
    ec2Clients[region] = new EC2Client({ region });
  }
  return ec2Clients[region];
}

exports.handler = async (event) => {
    console.log('Starting auto-shutdown check...');

    try {
        // Get timeout duration from Parameter Store
        let timeoutMinutes = null;
        try {
            const param = await ssm.send(new GetParameterCommand({
                Name: `/${process.env.PASCAL_CASE_NAME}/DCV/DisconnectedDuration`
              }));
              timeoutMinutes = parseInt(param.Parameter.Value);
              console.log(`Timeout duration: ${timeoutMinutes} minutes`);
            } catch (error) {
              if (error.name === 'ParameterNotFound') {
                console.log('No timeout duration configured - skipping auto-shutdown');
                return { statusCode: 200, body: 'No timeout configured' };
              }
              throw error;
            }
            
            if (!timeoutMinutes || timeoutMinutes <= 0) {
              console.log('Invalid timeout duration - skipping auto-shutdown');
              return { statusCode: 200, body: 'Invalid timeout duration' };
            }
            
            // Scan workstation table for running instances
            const result = await dynamodb.send(new ScanCommand({
              TableName: process.env.WORKSTATION_TABLE_NAME,
              FilterExpression: 'instanceStatus = :running AND connectionCount = :zero',
              ExpressionAttributeValues: {
                ':running': 'running',
                ':zero': 0
              }
            }));
            
            console.log(`Found ${result.Items.length} running instances with 0 connections`);
            
            const now = new Date();
            const timeoutMs = timeoutMinutes * 60 * 1000;
            let shutdownCount = 0;
            let keepAliveSkipCount = 0;
            
            for (const item of result.Items) {
              const { instanceId, lastDisconnectionTime, instanceStartTime, region, keepAliveUntil } = item;
              
              const now = new Date();
              let shouldShutdown = false;
              let reason = '';
              
              // Check if Keep Alive is active
              if (keepAliveUntil) {
                const keepAliveExpires = new Date(keepAliveUntil);
                if (keepAliveExpires > now) {
                  const remainingMinutes = Math.round((keepAliveExpires - now) / 60000);
                  console.log(`Instance ${instanceId}: Keep Alive active - ${remainingMinutes} minutes remaining, skipping shutdown`);
                  keepAliveSkipCount++;
                  continue; // Skip this instance
                } else {
                  console.log(`Instance ${instanceId}: Keep Alive expired at ${keepAliveUntil}`);
                }
              }
              
              // Check time since instance start
              const startTime = instanceStartTime ? new Date(instanceStartTime) : null;
              const timeSinceStart = startTime ? now - startTime : Infinity;
              
              // Check time since last disconnection
              const disconnectTime = lastDisconnectionTime ? new Date(lastDisconnectionTime) : null;
              const timeSinceDisconnect = disconnectTime ? now - disconnectTime : Infinity;
              
              // Log current state
              console.log(`Instance ${instanceId} (${region || 'primary'}): Started ${startTime ? Math.round(timeSinceStart / 60000) + ' minutes ago' : 'unknown'}, Last disconnect ${disconnectTime ? Math.round(timeSinceDisconnect / 60000) + ' minutes ago' : 'never'}`);
              
              // Only shutdown if ALL conditions are met:
              // 1. Instance has been running longer than timeout
              // 2. Last disconnection was longer than timeout ago (or never connected)
              if (timeSinceStart > timeoutMs) {
                if (!lastDisconnectionTime) {
                  // Never connected and running longer than timeout
                  shouldShutdown = true;
                  reason = `never connected and running ${Math.round(timeSinceStart / 60000)} minutes`;
                } else if (timeSinceDisconnect > timeoutMs) {
                  // Disconnected longer than timeout and running longer than timeout
                  shouldShutdown = true;
                  reason = `disconnected ${Math.round(timeSinceDisconnect / 60000)} minutes ago and running ${Math.round(timeSinceStart / 60000)} minutes`;
                } else {
                  reason = `recently disconnected (${Math.round(timeSinceDisconnect / 60000)} minutes ago)`;
                }
              } else {
                reason = `recently started (${Math.round(timeSinceStart / 60000)} minutes ago)`;
              }
              
              console.log(`Instance ${instanceId}: ${reason}`);
              
              if (shouldShutdown) {
                console.log(`Instance ${instanceId}: Shutting down (timeout exceeded)`);
                
                try {
                  // Use region-specific EC2 client for cross-region support
                  const ec2 = getEC2Client(region);
                  await ec2.send(new StopInstancesCommand({
                    InstanceIds: [instanceId]
                  }));
                  shutdownCount++;
                  console.log(`Instance ${instanceId}: Shutdown initiated in region ${region || 'primary'}`);
                } catch (error) {
                  console.error(`Instance ${instanceId}: Shutdown failed - ${error.message}`);
                }
              }
            }
            
            console.log(`Auto-shutdown completed: ${shutdownCount} instances shut down, ${keepAliveSkipCount} skipped due to Keep Alive`);
            return {
              statusCode: 200,
              body: JSON.stringify({
                message: 'Auto-shutdown completed',
                instancesChecked: result.Items.length,
                instancesShutdown: shutdownCount,
                instancesSkippedKeepAlive: keepAliveSkipCount
              })
            };
            
          } catch (error) {
            console.error('Auto-shutdown error:', error);
            return {
              statusCode: 500,
              body: JSON.stringify({ error: error.message })
            };
          }
        };