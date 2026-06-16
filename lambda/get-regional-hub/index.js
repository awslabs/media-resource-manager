// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { EC2Client, DescribeVpcsCommand, DescribeSubnetsCommand, DescribeSecurityGroupsCommand } = require('@aws-sdk/client-ec2');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const ec2 = new EC2Client({});
const ssm = new SSMClient({});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

exports.handler = async (event) => {
  console.log('GetRegionalHub event:', JSON.stringify(event, null, 2));
  
  try {
    const region = event.pathParameters?.region;
    
    if (!region) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Region parameter is required'
        })
      };
    }
    
    const primaryRegion = process.env.AWS_REGION;
    
    // Handle primary region specially
    if (region === primaryRegion) {
      const workstationCount = await getWorkstationCountForRegion(region);
      const infraDetails = await getPrimaryRegionInfrastructure();
      
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          data: {
            region: primaryRegion,
            displayName: getRegionDisplayName(primaryRegion),
            status: 'available',
            isPrimary: true,
            workstationCount,
            // Primary region supports all platforms
            enableWindows: true,
            enableLinux: true,
            enableMacOS: true,
            createdAt: new Date(0).toISOString(),
            ...infraDetails
          }
        })
      };
    }
    
    // Get regional hub from DynamoDB
    const result = await dynamodb.send(new GetCommand({
      TableName: process.env.REGIONAL_HUBS_TABLE_NAME,
      Key: { region }
    }));
    
    if (!result.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: `Regional hub not found: ${region}`
        })
      };
    }
    
    // Get workstation count for this region
    const workstationCount = await getWorkstationCountForRegion(region);
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: {
          ...result.Item,
          workstationCount,
          isPrimary: false
        }
      })
    };
  } catch (error) {
    console.error('Error getting regional hub:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Failed to get regional hub',
        details: error.message
      })
    };
  }
};

async function getPrimaryRegionInfrastructure() {
  const vpcId = process.env.VPC_ID;
  const dcvEndpoint = process.env.DCV_ENDPOINT;
  const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
  
  const infra = {
    vpcId: vpcId || '',
    vpcCidr: '',
    dcvSessionManagerEndpoint: dcvEndpoint || '',
    dcvConnectionGatewayEndpoint: '',
    dcvDomainName: '',
    workstationSecurityGroupId: '',
    launchTemplateId: '',
    availabilityZones: []
  };
  
  try {
    // Get VPC CIDR
    if (vpcId) {
      const vpcResponse = await ec2.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
      if (vpcResponse.Vpcs && vpcResponse.Vpcs.length > 0) {
        infra.vpcCidr = vpcResponse.Vpcs[0].CidrBlock;
      }
      
      // Get availability zones from subnets
      const subnetResponse = await ec2.send(new DescribeSubnetsCommand({
        Filters: [{ Name: 'vpc-id', Values: [vpcId] }]
      }));
      if (subnetResponse.Subnets) {
        const azSet = new Set(subnetResponse.Subnets.map(s => s.AvailabilityZone));
        infra.availabilityZones = Array.from(azSet).sort();
      }
    }
    
    // Try to get Connection Gateway endpoint from SSM
    try {
      const cgEndpoint = await ssm.send(new GetParameterCommand({
        Name: `/${pascalCaseName}/DCV/ConnectionGateway/Endpoint`
      }));
      infra.dcvConnectionGatewayEndpoint = cgEndpoint.Parameter?.Value || '';
    } catch (e) {
      // Parameter may not exist
    }
    
    // Try to get workstation security group from SSM
    try {
      const sgParam = await ssm.send(new GetParameterCommand({
        Name: `/${pascalCaseName}/Workstation/SecurityGroupId`
      }));
      infra.workstationSecurityGroupId = sgParam.Parameter?.Value || '';
    } catch (e) {
      // Try to find it by tag
      if (vpcId) {
        const sgResponse = await ec2.send(new DescribeSecurityGroupsCommand({
          Filters: [
            { Name: 'vpc-id', Values: [vpcId] },
            { Name: 'tag:Name', Values: [`*Workstation*`] }
          ]
        }));
        if (sgResponse.SecurityGroups && sgResponse.SecurityGroups.length > 0) {
          infra.workstationSecurityGroupId = sgResponse.SecurityGroups[0].GroupId;
        }
      }
    }
    
    // Try to get launch template ID from SSM
    try {
      const ltParam = await ssm.send(new GetParameterCommand({
        Name: `/${pascalCaseName}/Workstation/LaunchTemplateId`
      }));
      infra.launchTemplateId = ltParam.Parameter?.Value || '';
    } catch (e) {
      // Parameter may not exist
    }
    
  } catch (error) {
    console.error('Error getting primary region infrastructure:', error);
  }
  
  return infra;
}

async function getWorkstationCountForRegion(targetRegion) {
  try {
    const primaryRegion = process.env.AWS_REGION;
    
    const result = await dynamodb.send(new ScanCommand({
      TableName: process.env.WORKSTATION_TABLE_NAME,
      FilterExpression: '#r = :region OR (attribute_not_exists(#r) AND :region = :primary)',
      ExpressionAttributeNames: { '#r': 'region' },
      ExpressionAttributeValues: { 
        ':region': targetRegion,
        ':primary': primaryRegion
      },
      Select: 'COUNT'
    }));
    
    return result.Count || 0;
  } catch (error) {
    console.error('Error getting workstation count:', error);
    return 0;
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
