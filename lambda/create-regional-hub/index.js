// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { EC2Client, DescribeAvailabilityZonesCommand } = require('@aws-sdk/client-ec2');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sfnClient = new SFNClient({});
const ssmClient = new SSMClient({});

const REGIONAL_HUBS_TABLE = process.env.REGIONAL_HUBS_TABLE_NAME;
const PASCAL_CASE_NAME = process.env.PASCAL_CASE_NAME;

/**
 * API Handler Lambda - Creates a new regional hub
 * Validates input, creates DynamoDB record, and starts the state machine
 */
exports.handler = async (event) => {
  console.log('CreateRegionalHub API event:', JSON.stringify(event, null, 2));
  
  try {
    // Parse request body
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    
    const {
      region,
      displayName,
      vpcCidr,
      availabilityZones,
      publicSubnetMask = 28,
      privateSubnetMask = 24,
      dcvDomainName,
      dcvCertificateArn,
      enableWindows = true,
      enableLinux = true,
      enableMacOS = false
    } = body;
    
    // Validate required fields
    if (!region) {
      return response(400, { error: 'Region is required' });
    }
    if (!displayName) {
      return response(400, { error: 'Display name is required' });
    }
    if (!vpcCidr) {
      return response(400, { error: 'VPC CIDR is required' });
    }
    if (!availabilityZones || !Array.isArray(availabilityZones) || availabilityZones.length < 2) {
      return response(400, { error: 'At least 2 availability zones are required' });
    }
    
    // Validate VPC CIDR format
    const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
    if (!cidrRegex.test(vpcCidr)) {
      return response(400, { error: 'Invalid VPC CIDR format' });
    }
    
    // Validate availability zones exist in the target region
    const ec2Client = new EC2Client({ region });
    try {
      const azResult = await ec2Client.send(new DescribeAvailabilityZonesCommand({
        Filters: [
          { Name: 'zone-id', Values: availabilityZones }
        ]
      }));
      
      const foundAzIds = azResult.AvailabilityZones.map(az => az.ZoneId);
      const missingAzs = availabilityZones.filter(az => !foundAzIds.includes(az));
      
      if (missingAzs.length > 0) {
        return response(400, { 
          error: `Invalid availability zone IDs for region ${region}: ${missingAzs.join(', ')}` 
        });
      }
    } catch (error) {
      console.error('Error validating availability zones:', error);
      return response(400, { error: `Failed to validate availability zones: ${error.message}` });
    }
    
    // Check if region already exists
    const existingHub = await docClient.send(new GetCommand({
      TableName: REGIONAL_HUBS_TABLE,
      Key: { region }
    }));
    
    if (existingHub.Item) {
      return response(409, { 
        error: `Regional hub already exists for region ${region}`,
        status: existingHub.Item.status
      });
    }
    
    // Create DynamoDB record with pending status
    const now = new Date().toISOString();
    const hubRecord = {
      region,
      displayName,
      vpcCidr,
      availabilityZones,
      publicSubnetMask,
      privateSubnetMask,
      dcvDomainName: dcvDomainName || null,
      dcvCertificateArn: dcvCertificateArn || null,
      enableWindows,
      enableLinux,
      enableMacOS,
      status: 'pending',
      createdAt: now,
      updatedAt: now
    };
    
    await docClient.send(new PutCommand({
      TableName: REGIONAL_HUBS_TABLE,
      Item: hubRecord
    }));
    
    // Get state machine ARN from SSM
    const ssmParam = await ssmClient.send(new GetParameterCommand({
      Name: `/${PASCAL_CASE_NAME}/RegionalHub/CreationStateMachineArn`
    }));
    
    const stateMachineArn = ssmParam.Parameter.Value;
    
    // Start the state machine
    const executionResult = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify({
        region,
        displayName,
        vpcCidr,
        availabilityZones,
        publicSubnetMask,
        privateSubnetMask,
        dcvDomainName,
        dcvCertificateArn,
        enableWindows,
        enableLinux,
        enableMacOS
      })
    }));
    
    console.log('State machine execution started:', executionResult.executionArn);
    
    return response(202, {
      message: 'Regional hub creation initiated',
      region,
      status: 'pending',
      executionArn: executionResult.executionArn
    });
    
  } catch (error) {
    console.error('Error creating regional hub:', error);
    return response(500, { error: error.message });
  }
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    },
    body: JSON.stringify(body)
  };
}
