// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand, DescribeNetworkInterfacesCommand, DeleteNetworkInterfaceCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, GetParametersByPathCommand, DeleteParametersCommand } = require('@aws-sdk/client-ssm');

const ec2 = new EC2Client();
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());
const ssm = new SSMClient();

// EC2 error codes for instance IDs that no longer exist (or never could). A
// workstation record can outlive its instance: it was terminated outside MRM,
// or EC2 stopped listing it about an hour after termination. On stack delete
// such an instance is already gone, so it counts as cleaned up.
const GONE_INSTANCE_ERRORS = new Set(['InvalidInstanceID.NotFound', 'InvalidInstanceID.Malformed']);
const ENDING_STATES = new Set(['shutting-down', 'terminated']);
const BATCH_SIZE = 100;
const TERMINATE_ATTEMPTS = 3;

const isGoneInstanceError = (error) => GONE_INSTANCE_ERRORS.has(error?.name) || GONE_INSTANCE_ERRORS.has(error?.Code);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function chunks(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

// The instances in instanceIds that EC2 still lists. An instance-id filter,
// unlike InstanceIds, returns no error for IDs that don't exist.
async function describeExisting(instanceIds) {
    const found = [];
    for (const batch of chunks(instanceIds, BATCH_SIZE)) {
        let NextToken;
        do {
            const page = await ec2.send(new DescribeInstancesCommand({
                Filters: [{ Name: 'instance-id', Values: batch }],
                NextToken
            }));
            for (const reservation of page.Reservations || []) found.push(...(reservation.Instances || []));
            NextToken = page.NextToken;
        } while (NextToken);
    }
    return found;
}

// Terminate the instances that exist and aren't already shutting down or
// terminated. If one disappears between the describe and the terminate, EC2
// fails that whole TerminateInstances call with InvalidInstanceID.NotFound,
// so describe again and retry the rest. Any other error fails the cleanup.
async function terminateExisting(instanceIds) {
    for (let attempt = 1; ; attempt++) {
        const existing = await describeExisting(instanceIds);
        const live = existing.filter(i => !ENDING_STATES.has(i.State?.Name)).map(i => i.InstanceId);
        const gone = instanceIds.length - existing.length;
        console.log(`Instances: ${live.length} to terminate, ${existing.length - live.length} already shutting down or terminated, ${gone} no longer exist`);
        if (live.length === 0) return;

        try {
            for (const batch of chunks(live, BATCH_SIZE)) {
                await ec2.send(new TerminateInstancesCommand({ InstanceIds: batch }));
                console.log(`Terminating instances: ${batch.join(', ')}`);
            }
            return;
        } catch (error) {
            if (!isGoneInstanceError(error) || attempt >= TERMINATE_ATTEMPTS) throw error;
            console.log(`An instance disappeared before it was terminated (${error.name}), checking again`);
            await sleep(5000);
        }
    }
}

exports.handler = async (event) => {
    console.log('Cleanup event:', JSON.stringify({ ...event, ResponseURL: event.ResponseURL && '[REDACTED]' }, null, 2));

    if (event.RequestType === 'Delete') {
        try {
            const securityGroupId = event.ResourceProperties.SecurityGroupId;
            const tableName = event.ResourceProperties.WorkstationTableName;
            const ssmParameterPrefix = event.ResourceProperties.SsmParameterPrefix;

            // 0. Clean up SSM parameters created by DCV Session Manager
            if (ssmParameterPrefix) {
                console.log(`Cleaning up SSM parameters under prefix: ${ssmParameterPrefix}`);
                try {
                    const params = await ssm.send(new GetParametersByPathCommand({
                        Path: ssmParameterPrefix,
                        Recursive: true
                    }));
                    
                    if (params.Parameters?.length > 0) {
                        const paramNames = params.Parameters.map(p => p.Name);
                        console.log(`Found ${paramNames.length} SSM parameters to delete: ${paramNames.join(', ')}`);
                        
                        // DeleteParameters accepts max 10 at a time
                        for (let i = 0; i < paramNames.length; i += 10) {
                            const batch = paramNames.slice(i, i + 10);
                            await ssm.send(new DeleteParametersCommand({ Names: batch }));
                            console.log(`Deleted SSM parameters: ${batch.join(', ')}`);
                        }
                    } else {
                        console.log('No SSM parameters found to delete');
                    }
                } catch (ssmError) {
                    console.log(`SSM cleanup error (non-fatal): ${ssmError.message}`);
                }
            }

            // 1. Find and terminate ALL workstations in the table (except already terminated)
            const workstations = await dynamodb.send(new ScanCommand({
                TableName: tableName,
                FilterExpression: '#status <> :terminated',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                    ':terminated': 'terminated'
                }
            }));

            const instanceIds = [...new Set((workstations.Items || []).map(item => item.instanceId).filter(Boolean))];
            if (instanceIds.length > 0) {
                console.log(`Found ${workstations.Items.length} workstation records with ${instanceIds.length} instance IDs to clean up`);

                // Terminate the instances that still exist (running, stopped, etc.)
                await terminateExisting(instanceIds);

                // Wait for termination. Instances EC2 no longer lists count as terminated.
                for (let attempts = 0; attempts < 30; attempts++) {
                  const remaining = (await describeExisting(instanceIds)).filter(i => i.State?.Name !== 'terminated');
                  if (remaining.length === 0) break;
                  await sleep(10000);
                }
              }
              
              // 2. Aggressively clean up Lambda ENIs
              console.log(`Cleaning up Lambda ENIs for security group: ${securityGroupId}`);
              
              let waitAttempts = 0;
              const maxWaitAttempts = 90; // 15 minutes max wait (90 * 10 seconds)
              
              while (waitAttempts < maxWaitAttempts) {
                const enis = await ec2.send(new DescribeNetworkInterfacesCommand({
                  Filters: [
                    { Name: 'group-id', Values: [securityGroupId] }
                  ]
                }));
                
                const lambdaEnis = (enis.NetworkInterfaces || []).filter(eni => 
                  eni.Description && eni.Description.includes('Lambda')
                );
                
                console.log(`Found ${lambdaEnis.length} Lambda ENIs still attached to security group`);
                
                if (lambdaEnis.length === 0) {
                  console.log('All Lambda ENIs have been cleaned up');
                  break;
                }
                
                // Try to delete available ENIs
                for (const eni of lambdaEnis) {
                  console.log(`Processing Lambda ENI: ${eni.NetworkInterfaceId}, Status: ${eni.Status}, Description: ${eni.Description}`);
                  
                  if (eni.Status === 'available') {
                    try {
                      console.log(`Attempting to delete available ENI: ${eni.NetworkInterfaceId}`);
                      await ec2.send(new DeleteNetworkInterfaceCommand({
                        NetworkInterfaceId: eni.NetworkInterfaceId
                      }));
                      console.log(`Delete request sent for ENI: ${eni.NetworkInterfaceId}`);
                    } catch (deleteError) {
                      console.log(`Failed to delete ENI ${eni.NetworkInterfaceId}: ${deleteError.message}`);
                      // Continue with other ENIs
                    }
                  } else {
                    console.log(`ENI ${eni.NetworkInterfaceId} is not available (status: ${eni.Status}), waiting...`);
                  }
                }
                
                // Wait a bit for deletions to process
                await new Promise(resolve => setTimeout(resolve, 5000));
                
                await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
                waitAttempts++;
              }
              
              // Final check
              const finalEnis = await ec2.send(new DescribeNetworkInterfacesCommand({
                Filters: [
                  { Name: 'group-id', Values: [securityGroupId] }
                ]
              }));
              
              const remainingLambdaEnis = (finalEnis.NetworkInterfaces || []).filter(eni => 
                eni.Description && eni.Description.includes('Lambda')
              );
              
              if (remainingLambdaEnis.length > 0) {
                const errorMsg = `Failed to delete ${remainingLambdaEnis.length} Lambda ENIs after cleanup timeout`;
                console.error(errorMsg);
                remainingLambdaEnis.forEach(eni => {
                  console.error(`Remaining ENI: ${eni.NetworkInterfaceId}, Status: ${eni.Status}`);
                });
                throw new Error(errorMsg);
              } else {
                console.log('All Lambda ENIs successfully cleaned up');
              }
              
              console.log('Cleanup completed');
              
            } catch (error) {
              console.error('Cleanup error:', error);
              throw error; // Fail the custom resource
            }
          }
          
          // Return success only if cleanup succeeded
          return {
            PhysicalResourceId: 'cleanup-resource',
            Data: { Status: 'Complete' }
          };
        };