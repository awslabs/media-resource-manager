// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { EC2Client, DescribeVpcsCommand } = require('@aws-sdk/client-ec2');

const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const ec2 = new EC2Client({});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

exports.handler = async (event) => {
  console.log('ListRegionalHubs event:', JSON.stringify(event, null, 2));
  
  try {
    // Get all regional hubs from DynamoDB
    const result = await dynamodb.send(new ScanCommand({
      TableName: process.env.REGIONAL_HUBS_TABLE_NAME
    }));
    
    const hubs = result.Items || [];
    
    // Add the primary region as a "hub" if not already in the list
    const primaryRegion = process.env.AWS_REGION;
    const hasPrimaryRegion = hubs.some(hub => hub.region === primaryRegion);
    
    if (!hasPrimaryRegion) {
      // Get VPC CIDR for primary region
      let vpcCidr = '';
      const vpcId = process.env.VPC_ID;
      if (vpcId) {
        try {
          const vpcResponse = await ec2.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
          if (vpcResponse.Vpcs && vpcResponse.Vpcs.length > 0) {
            vpcCidr = vpcResponse.Vpcs[0].CidrBlock;
          }
        } catch (e) {
          console.log('Could not get VPC CIDR:', e.message);
        }
      }
      
      // Add primary region as the first hub (always available)
      hubs.unshift({
        region: primaryRegion,
        displayName: getRegionDisplayName(primaryRegion),
        status: 'available',
        isPrimary: true,
        vpcId: vpcId || 'primary-vpc',
        vpcCidr: vpcCidr,
        dcvConnectionGatewayEndpoint: process.env.DCV_ENDPOINT || '',
        // Primary region supports all platforms by default
        enableWindows: true,
        enableLinux: true,
        enableMacOS: true,
        createdAt: new Date(0).toISOString() // Epoch time for primary
      });
    }
    
    // Get workstation counts per region
    const workstationCounts = await getWorkstationCountsByRegion();
    
    // Enrich hubs with workstation counts
    const enrichedHubs = hubs.map(hub => ({
      ...hub,
      workstationCount: workstationCounts[hub.region] || 0,
      isPrimary: hub.region === primaryRegion
    }));
    
    // Sort: primary first, then by displayName
    enrichedHubs.sort((a, b) => {
      if (a.isPrimary) return -1;
      if (b.isPrimary) return 1;
      return (a.displayName || a.region).localeCompare(b.displayName || b.region);
    });
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: enrichedHubs
      })
    };
  } catch (error) {
    console.error('Error listing regional hubs:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to list regional hubs',
        details: error.message
      })
    };
  }
};

async function getWorkstationCountsByRegion() {
  try {
    const result = await dynamodb.send(new ScanCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      ProjectionExpression: '#r',
      ExpressionAttributeNames: { '#r': 'region' }
    }));
    
    const counts = {};
    const primaryRegion = process.env.AWS_REGION;
    
    for (const item of result.Items || []) {
      // Default to primary region if no region specified
      const region = item.region || primaryRegion;
      counts[region] = (counts[region] || 0) + 1;
    }
    
    return counts;
  } catch (error) {
    console.error('Error getting workstation counts:', error);
    return {};
  }
}

function getRegionDisplayName(region) {
  const regionNames = {
    'us-east-1': 'US East (N. Virginia)',
    'us-east-2': 'US East (Ohio)',
    'us-west-1': 'US West (N. California)',
    'us-west-2': 'US West (Oregon)',
    'eu-west-1': 'Europe (Ireland)',
    'eu-west-2': 'Europe (London)',
    'eu-west-3': 'Europe (Paris)',
    'eu-central-1': 'Europe (Frankfurt)',
    'ap-northeast-1': 'Asia Pacific (Tokyo)',
    'ap-northeast-2': 'Asia Pacific (Seoul)',
    'ap-southeast-1': 'Asia Pacific (Singapore)',
    'ap-southeast-2': 'Asia Pacific (Sydney)',
    'ap-south-1': 'Asia Pacific (Mumbai)',
    'sa-east-1': 'South America (São Paulo)',
    'ca-central-1': 'Canada (Central)'
  };
  return regionNames[region] || region;
}
