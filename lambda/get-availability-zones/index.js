// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Get Availability Zones Lambda
 * 
 * Returns availability zones for a given AWS region.
 * Optionally filters to show only AZs that support specific instance types (e.g., Mac instances).
 */

const { EC2Client, DescribeAvailabilityZonesCommand, DescribeInstanceTypeOfferingsCommand } = require('@aws-sdk/client-ec2');

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

exports.handler = async (event) => {
  console.log('GetAvailabilityZones event:', JSON.stringify(event, null, 2));
  
  try {
    // Get region from path parameters
    const region = event.pathParameters?.region;
    if (!region) {
      return response(400, { error: 'Region is required' });
    }
    
    // Optional: filter by instance type family (e.g., 'mac' for Mac instances)
    const queryParams = event.queryStringParameters || {};
    const instanceTypeFilter = queryParams.instanceTypeFilter; // e.g., 'mac2' or 'mac'
    
    const ec2Client = new EC2Client({ region });
    
    // Get all availability zones for the region
    const azResult = await ec2Client.send(new DescribeAvailabilityZonesCommand({
      Filters: [
        { Name: 'state', Values: ['available'] }
      ]
    }));
    
    const availabilityZones = azResult.AvailabilityZones.map(az => ({
      zoneId: az.ZoneId,
      zoneName: az.ZoneName,
      state: az.State,
      zoneType: az.ZoneType,
      supportsMac: false // Will be updated if instanceTypeFilter is provided
    }));
    
    // If instance type filter is provided, check which AZs support those instance types
    if (instanceTypeFilter) {
      const macSupportedAzs = await getMacSupportedAzs(ec2Client, instanceTypeFilter);
      
      for (const az of availabilityZones) {
        az.supportsMac = macSupportedAzs.has(az.zoneName);
      }
    }
    
    // Sort by zone ID for consistent ordering
    availabilityZones.sort((a, b) => a.zoneId.localeCompare(b.zoneId));
    
    return response(200, {
      region,
      availabilityZones
    });
    
  } catch (error) {
    console.error('Error getting availability zones:', error);
    return response(500, { error: error.message });
  }
};

/**
 * Get AZs that support Mac instance types
 */
async function getMacSupportedAzs(ec2Client, instanceTypePrefix) {
  const supportedAzs = new Set();
  
  try {
    // Query instance type offerings filtered by location type (availability-zone)
    let nextToken;
    do {
      const result = await ec2Client.send(new DescribeInstanceTypeOfferingsCommand({
        LocationType: 'availability-zone',
        Filters: [
          { Name: 'instance-type', Values: [`${instanceTypePrefix}*`] }
        ],
        NextToken: nextToken,
        MaxResults: 100
      }));
      
      for (const offering of result.InstanceTypeOfferings || []) {
        supportedAzs.add(offering.Location);
      }
      
      nextToken = result.NextToken;
    } while (nextToken);
    
  } catch (error) {
    console.error('Error checking Mac instance type offerings:', error);
    // Return empty set on error - frontend will show all AZs without Mac support info
  }
  
  return supportedAzs;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body)
  };
}
