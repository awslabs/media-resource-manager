// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse CloudFormation Stack Outputs Lambda
 * 
 * This Lambda normalizes CloudFormation outputs into a consistent format
 * for storage in DynamoDB, regardless of storage type (fsx-windows, fsx-ontap, etc.)
 * 
 * Input: Step Functions state with stackStatus.Stacks[0].Outputs array and storageType
 * Output: Normalized object with named fields for DynamoDB update
 */

exports.handler = async (event) => {
  console.log('ParseStackOutputs received event:', JSON.stringify(event, null, 2));
  
  const { storageType, stackStatus } = event;
  const outputs = stackStatus?.Stacks?.[0]?.Outputs || [];
  
  // Convert outputs array to a map for easy lookup by OutputKey
  const outputMap = {};
  for (const output of outputs) {
    outputMap[output.OutputKey] = output.OutputValue;
  }
  
  console.log('Output map:', outputMap);
  
  // Build normalized result based on storage type
  let result = {};
  
  switch (storageType) {
    case 'fsx-windows':
      result = parseFsxWindowsOutputs(outputMap);
      break;
      
    case 'fsx-ontap':
      result = parseFsxOntapOutputs(outputMap);
      break;
      
    case 'storage-gateway':
      result = parseStorageGatewayOutputs(outputMap);
      break;
      
    default:
      // Generic fallback - just pass through all outputs
      result = { outputs: outputMap };
      console.warn(`Unknown storage type: ${storageType}, using generic output parsing`);
  }
  
  console.log('Parsed result:', result);
  return result;
};

/**
 * Parse FSx for Windows File Server outputs
 */
function parseFsxWindowsOutputs(outputMap) {
  return {
    fsxFileSystemId: outputMap.FsxFileSystemId || 'N/A',
    fsxDnsName: outputMap.FsxDnsName || 'N/A',
    fsxResourceArn: outputMap.FsxResourceArn || 'N/A'
  };
}

/**
 * Parse FSx for NetApp ONTAP outputs
 * Note: DNS endpoints for SVM are not available as CloudFormation outputs.
 * They must be retrieved via FSx API (DescribeStorageVirtualMachines) after creation.
 */
function parseFsxOntapOutputs(outputMap) {
  return {
    fsxFileSystemId: outputMap.FileSystemId || 'N/A',
    fsxDnsName: 'N/A', // ONTAP doesn't expose DNS via CloudFormation - retrieved via API at mount time
    fsxResourceArn: outputMap.FileSystemArn || 'N/A',
    svmId: outputMap.SvmId || 'N/A',
    svmArn: outputMap.SvmArn || 'N/A',
    volumeId: outputMap.VolumeId || 'N/A',
    junctionPath: outputMap.JunctionPath || '/vol1'
  };
}

/**
 * Parse Storage Gateway outputs (placeholder for future)
 */
function parseStorageGatewayOutputs(outputMap) {
  return {
    gatewayId: outputMap.GatewayId || 'N/A',
    gatewayArn: outputMap.GatewayArn || 'N/A',
    fileShareId: outputMap.FileShareId || 'N/A',
    fileShareArn: outputMap.FileShareArn || 'N/A'
  };
}
