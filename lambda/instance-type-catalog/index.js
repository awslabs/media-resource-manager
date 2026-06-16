// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Instance Type Catalog Sync Lambda
 * 
 * Fetches EC2 instance types from DescribeInstanceTypes API and stores them in DynamoDB.
 * Supports multi-region by querying each configured regional hub.
 * 
 * Uses TTL-based cleanup: items not seen for 7 days are automatically deleted.
 * This handles deprecated instance types gracefully.
 */

const { EC2Client, DescribeInstanceTypesCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const CATALOG_TABLE = process.env.CATALOG_TABLE_NAME;
const REGIONAL_HUBS_TABLE = process.env.REGIONAL_HUBS_TABLE_NAME;
const PRIMARY_REGION = process.env.AWS_REGION;

// TTL: 7 days from last sync (in seconds)
const TTL_DAYS = 7;

// Instance type families we care about for workstations
// Uses broad prefixes to automatically pick up new generations (e.g., g7, m8, etc.)
const RELEVANT_FAMILIES = [
  't',                   // Burstable (t3, t3a, t4g, future)
  'm',                   // General purpose (m5, m6i, m7i, future)
  'c',                   // Compute optimized (c5, c6i, c7i, future)
  'r',                   // Memory optimized (r5, r6i, r7i, future)
  'g',                   // GPU - NVIDIA workstation (g4dn, g5, g6, future)
  'p',                   // GPU - NVIDIA high performance (p3, p4d, p5, future)
  'mac',                 // Apple Silicon - all generations (mac1, mac2, mac-m4, future)
];

// Map processor architectures to platforms
const ARCH_TO_PLATFORMS = {
  'x86_64': ['windows', 'linux'],
  'arm64': ['linux'],  // ARM Linux only (no Windows ARM support for workstations)
  'x86_64_mac': ['macos'],
  'arm64_mac': ['macos'],
};

exports.handler = async () => {
  console.log('Starting instance type catalog sync');
  
  try {
    // Get all regional hubs
    const regions = await getRegions();
    console.log(`Syncing instance types for regions: ${regions.join(', ')}`);
    
    // Fetch instance types from all regions
    const instanceTypeMap = new Map();
    
    for (const region of regions) {
      console.log(`Fetching instance types for region: ${region}`);
      const regionTypes = await fetchInstanceTypesForRegion(region);
      
      for (const instanceType of regionTypes) {
        const existing = instanceTypeMap.get(instanceType.instanceType);
        if (existing) {
          // Add region to existing entry
          if (!existing.regions.includes(region)) {
            existing.regions.push(region);
          }
        } else {
          instanceTypeMap.set(instanceType.instanceType, {
            ...instanceType,
            regions: [region],
          });
        }
      }
    }
    
    console.log(`Found ${instanceTypeMap.size} unique instance types across all regions`);
    
    // Calculate TTL (7 days from now)
    const ttl = Math.floor(Date.now() / 1000) + (TTL_DAYS * 24 * 60 * 60);
    
    // Write to DynamoDB with TTL
    let written = 0;
    for (const [instanceType, data] of instanceTypeMap) {
      await docClient.send(new PutCommand({
        TableName: CATALOG_TABLE,
        Item: {
          instanceType,
          ...data,
          updatedAt: new Date().toISOString(),
          ttl,  // DynamoDB will auto-delete items after this timestamp
        },
      }));
      written++;
    }
    
    console.log(`Wrote ${written} instance types to catalog with TTL of ${TTL_DAYS} days`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Instance type catalog sync complete',
        instanceTypesCount: written,
        regions: regions,
        ttlDays: TTL_DAYS,
      }),
    };
  } catch (error) {
    console.error('Error syncing instance type catalog:', error);
    throw error;
  }
};


async function getRegions() {
  // Always include primary region
  const regions = [PRIMARY_REGION];
  
  // Get additional regions from regional hubs table
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: REGIONAL_HUBS_TABLE,
      FilterExpression: '#status = :available',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':available': 'available' },
    }));
    
    for (const hub of result.Items || []) {
      if (hub.region && !regions.includes(hub.region)) {
        regions.push(hub.region);
      }
    }
  } catch (error) {
    console.log('Could not fetch regional hubs, using primary region only:', error.message);
  }
  
  return regions;
}

async function fetchInstanceTypesForRegion(region) {
  const ec2Client = new EC2Client({ region });
  const instanceTypes = [];
  let nextToken;
  
  do {
    const command = new DescribeInstanceTypesCommand({
      NextToken: nextToken,
      MaxResults: 100,
    });
    
    const response = await ec2Client.send(command);
    
    for (const type of response.InstanceTypes || []) {
      // Filter to relevant families
      const family = type.InstanceType.split('.')[0];
      if (!RELEVANT_FAMILIES.some(f => family.startsWith(f))) {
        continue;
      }
      
      // Determine platforms based on architecture
      const arch = type.ProcessorInfo?.SupportedArchitectures?.[0] || 'x86_64';
      let platforms = ARCH_TO_PLATFORMS[arch] || ['linux'];
      
      // Mac instances are special
      if (family.startsWith('mac')) {
        platforms = ['macos'];
      }
      
      // Build GPU info string
      let gpuInfo = null;
      if (type.GpuInfo?.Gpus?.length > 0) {
        const gpu = type.GpuInfo.Gpus[0];
        const gpuCount = type.GpuInfo.Gpus.reduce((sum, g) => sum + (g.Count || 1), 0);
        gpuInfo = gpuCount > 1 ? `${gpuCount}x ${gpu.Name}` : gpu.Name;
      }
      
      // Build family label
      const familyLabel = getFamilyLabel(family, gpuInfo);
      
      // Build display label
      const vCpu = type.VCpuInfo?.DefaultVCpus || 0;
      const memoryGb = Math.round((type.MemoryInfo?.SizeInMiB || 0) / 1024);
      let label = `${type.InstanceType} (${vCpu} vCPU, ${memoryGb} GB`;
      if (gpuInfo) {
        label += `, ${gpuInfo}`;
      }
      label += ')';
      
      instanceTypes.push({
        instanceType: type.InstanceType,
        family: familyLabel,
        label,
        vCpu,
        memoryGb,
        gpuInfo,
        platforms,
        architecture: arch,
      });
    }
    
    nextToken = response.NextToken;
  } while (nextToken);
  
  return instanceTypes;
}

function getFamilyLabel(family, gpuInfo) {
  // Handle Mac variants
  if (family.startsWith('mac-m4')) {
    // mac-m4 -> M4, mac-m4pro -> M4 Pro, mac-m4max -> M4 Max
    const chipPart = family.replace('mac-', '');
    const chipName = chipPart
      .replace('m4max', 'M4 Max')
      .replace('m4pro', 'M4 Pro')
      .replace('m4', 'M4');
    return `Apple Silicon - ${chipName}`;
  }
  if (family.startsWith('mac2')) {
    if (family === 'mac2') {
      return 'Apple Silicon - M1';
    }
    // Extract chip name: mac2-m1ultra -> M1 Ultra, mac2-m2 -> M2, mac2-m2pro -> M2 Pro
    const chipPart = family.replace('mac2-', '');
    const chipName = chipPart
      .replace('m1ultra', 'M1 Ultra')
      .replace('m2pro', 'M2 Pro')
      .replace('m2', 'M2');
    return `Apple Silicon - ${chipName}`;
  }
  if (family.startsWith('mac1')) {
    return 'Apple Silicon - Intel';
  }

  const familyLabels = {
    // Burstable
    't3': 'Burstable - T3',
    't3a': 'Burstable - T3a (AMD)',
    // General Purpose - M5
    'm5': 'General Purpose - M5',
    'm5a': 'General Purpose - M5a (AMD)',
    'm5ad': 'General Purpose - M5ad (AMD, NVMe)',
    'm5d': 'General Purpose - M5d (NVMe)',
    'm5dn': 'General Purpose - M5dn (NVMe, Network)',
    'm5n': 'General Purpose - M5n (Network)',
    'm5zn': 'General Purpose - M5zn (High Freq)',
    // General Purpose - M6
    'm6i': 'General Purpose - M6i',
    'm6id': 'General Purpose - M6id (NVMe)',
    'm6idn': 'General Purpose - M6idn (NVMe, Network)',
    'm6in': 'General Purpose - M6in (Network)',
    'm6a': 'General Purpose - M6a (AMD)',
    // General Purpose - M7
    'm7i': 'General Purpose - M7i',
    'm7i-flex': 'General Purpose - M7i-flex',
    'm7a': 'General Purpose - M7a (AMD)',
    // Compute Optimized - C5
    'c5': 'Compute Optimized - C5',
    'c5a': 'Compute Optimized - C5a (AMD)',
    'c5ad': 'Compute Optimized - C5ad (AMD, NVMe)',
    'c5d': 'Compute Optimized - C5d (NVMe)',
    'c5n': 'Compute Optimized - C5n (Network)',
    // Compute Optimized - C6
    'c6i': 'Compute Optimized - C6i',
    'c6id': 'Compute Optimized - C6id (NVMe)',
    'c6in': 'Compute Optimized - C6in (Network)',
    'c6a': 'Compute Optimized - C6a (AMD)',
    // Compute Optimized - C7
    'c7i': 'Compute Optimized - C7i',
    'c7i-flex': 'Compute Optimized - C7i-flex',
    'c7a': 'Compute Optimized - C7a (AMD)',
    // Memory Optimized - R5
    'r5': 'Memory Optimized - R5',
    'r5a': 'Memory Optimized - R5a (AMD)',
    'r5ad': 'Memory Optimized - R5ad (AMD, NVMe)',
    'r5b': 'Memory Optimized - R5b (EBS Optimized)',
    'r5d': 'Memory Optimized - R5d (NVMe)',
    'r5dn': 'Memory Optimized - R5dn (NVMe, Network)',
    'r5n': 'Memory Optimized - R5n (Network)',
    // Memory Optimized - R6
    'r6i': 'Memory Optimized - R6i',
    'r6id': 'Memory Optimized - R6id (NVMe)',
    'r6idn': 'Memory Optimized - R6idn (NVMe, Network)',
    'r6in': 'Memory Optimized - R6in (Network)',
    'r6a': 'Memory Optimized - R6a (AMD)',
    // Memory Optimized - R7
    'r7i': 'Memory Optimized - R7i',
    'r7iz': 'Memory Optimized - R7iz (High Freq)',
    'r7a': 'Memory Optimized - R7a (AMD)',
    // GPU - NVIDIA Consumer/Workstation
    'g4dn': 'GPU - NVIDIA T4',
    'g5': 'GPU - NVIDIA A10G',
    'g5g': 'GPU - NVIDIA T4G (Graviton)',
    'g6': 'GPU - NVIDIA L4',
    'g6e': 'GPU - NVIDIA L4 (Enhanced)',
    'g6f': 'GPU - NVIDIA L4 (Fractional)',
    // GPU - NVIDIA High Performance
    'p3': 'GPU - NVIDIA V100',
    'p3dn': 'GPU - NVIDIA V100 (NVMe, Network)',
    'p4d': 'GPU - NVIDIA A100',
    'p4de': 'GPU - NVIDIA A100 (Enhanced)',
    'p5': 'GPU - NVIDIA H100',
    'p5e': 'GPU - NVIDIA H100 (Enhanced)',
    'p5en': 'GPU - NVIDIA H100 (Enhanced, Network)',
  };
  
  return familyLabels[family] || `Other - ${family.toUpperCase()}`;
}
