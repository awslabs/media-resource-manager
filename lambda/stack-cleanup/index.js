// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand, DescribeNetworkInterfacesCommand, DeleteNetworkInterfaceCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, GetParametersByPathCommand, DeleteParametersCommand } = require('@aws-sdk/client-ssm');

const ec2 = new EC2Client();
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());
const ssm = new SSMClient();

exports.handler = async (event) => {
    console.log('Cleanup event:', JSON.stringify(event, null, 2));

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

            if (workstations.Items?.length > 0) {
                console.log(`Found \${workstations.Items.length} workstations to clean up`);
                
                const instanceIds = workstations.Items.map(item => item.instanceId);
                
                // Terminate all instances (running, stopped, etc.)
                await ec2.send(new TerminateInstancesCommand({
                  InstanceIds: instanceIds
                }));
                
                console.log(`Terminated instances: \${instanceIds.join(', ')}`);
                
                // Wait for termination
                let attempts = 0;
                while (attempts < 30) {
                  const instances = await ec2.send(new DescribeInstancesCommand({
                    InstanceIds: instanceIds
                  }));
                  
                  const allTerminated = instances.Reservations.every(r => 
                    r.Instances.every(i => i.State.Name === 'terminated')
                  );
                  
                  if (allTerminated) break;
                  
                  await new Promise(resolve => setTimeout(resolve, 10000));
                  attempts++;
                }
              }
              
              // 2. Aggressively clean up Lambda ENIs
              console.log(`Cleaning up Lambda ENIs for security group: \${securityGroupId}`);
              
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
                
                console.log(`Found \${lambdaEnis.length} Lambda ENIs still attached to security group`);
                
                if (lambdaEnis.length === 0) {
                  console.log('All Lambda ENIs have been cleaned up');
                  break;
                }
                
                // Try to delete available ENIs
                for (const eni of lambdaEnis) {
                  console.log(`Processing Lambda ENI: \${eni.NetworkInterfaceId}, Status: \${eni.Status}, Description: \${eni.Description}`);
                  
                  if (eni.Status === 'available') {
                    try {
                      console.log(`Attempting to delete available ENI: \${eni.NetworkInterfaceId}`);
                      await ec2.send(new DeleteNetworkInterfaceCommand({
                        NetworkInterfaceId: eni.NetworkInterfaceId
                      }));
                      console.log(`Delete request sent for ENI: \${eni.NetworkInterfaceId}`);
                    } catch (deleteError) {
                      console.log(`Failed to delete ENI \${eni.NetworkInterfaceId}: \${deleteError.message}`);
                      // Continue with other ENIs
                    }
                  } else {
                    console.log(`ENI \${eni.NetworkInterfaceId} is not available (status: \${eni.Status}), waiting...`);
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
                const errorMsg = `Failed to delete \${remainingLambdaEnis.length} Lambda ENIs after cleanup timeout`;
                console.error(errorMsg);
                remainingLambdaEnis.forEach(eni => {
                  console.error(`Remaining ENI: \${eni.NetworkInterfaceId}, Status: \${eni.Status}`);
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