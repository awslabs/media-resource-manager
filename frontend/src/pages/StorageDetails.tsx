// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ContentLayout,
  Header,
  SpaceBetween,
  Container,
  StatusIndicator,
  KeyValuePairs,
  Button,
  Alert,
  Spinner,
  BreadcrumbGroup,
  Box,
  Grid,
} from '@cloudscape-design/components';
import CodeView from '@cloudscape-design/code-view/code-view';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { apiCall } from '../utils/api';

const StorageDetails: React.FC = () => {
  const { storageId } = useParams<{ storageId: string }>();
  const navigate = useNavigate();
  const [details, setDetails] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (storageId) {
      fetchStorageDetails();
    }
  }, [storageId]);

  const fetchStorageDetails = async () => {
    try {
      const token = getAuthToken();
      if (!token) {
        throw new Error('No current user');
      }

      const response = await apiCall(`storage/${storageId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setDetails(data);
      } else if (response.status === 404) {
        setError('Storage resource not found');
      } else if (response.status === 403) {
        setError('Access denied');
      } else {
        setError('Failed to load storage details');
      }
    } catch (error) {
      console.error('Error fetching storage details:', error);
      if (!handleAuthError(error)) {
        setError('Failed to load storage details');
      }
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getStatusIndicator = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'available':
        return <StatusIndicator type="success">Available</StatusIndicator>;
      case 'creating':
        return <StatusIndicator type="pending">Creating</StatusIndicator>;
      case 'deleting':
        return <StatusIndicator type="pending">Deleting</StatusIndicator>;
      case 'failed':
        return <StatusIndicator type="error">Failed</StatusIndicator>;
      case 'updating':
        return <StatusIndicator type="pending">Updating</StatusIndicator>;
      default:
        return <StatusIndicator type="info">{status || 'Unknown'}</StatusIndicator>;
    }
  };

  if (error) {
    return (
      <ContentLayout 
        header={
          <Header
            actions={
              <Button onClick={() => navigate('/storage')}>
                Back to Storage
              </Button>
            }
          >
            Storage Details
          </Header>
        }
      >
        <Alert type="error">{error}</Alert>
      </ContentLayout>
    );
  }

  const storageInfo = details ? [
    { label: 'Storage ID', value: details.storageId },
    { label: 'Name', value: details.name },
    { label: 'Description', value: details.description || '-' },
    { label: 'Type', value: details.type === 'fsx-windows' ? 'FSx for Windows File Server' : 
                           details.type === 'fsx-ontap' ? 'FSx for NetApp ONTAP' :
                           details.type === 'mountpoint-s3' ? 'Mountpoint for S3' : details.type },
    { label: 'Status', value: getStatusIndicator(details.status) },
    { label: 'Created', value: details.createdAt ? formatDate(details.createdAt) : '-' },
    { label: 'Updated', value: details.updatedAt ? formatDate(details.updatedAt) : '-' }
  ] : [];

  // Build configuration info based on storage type
  const getConfigurationInfo = () => {
    if (!details) return [];
    
    if (details.type === 'fsx-ontap') {
      return [
        { label: 'Storage Capacity', value: details.storageCapacity ? `${details.storageCapacity} GiB` : '-' },
        { label: 'Total Throughput', value: details.throughput ? `${details.throughput} MB/s` : '-' },
        { label: 'HA Pairs', value: details.haPairs?.toString() || '-' },
        { label: 'Throughput per HA Pair', value: details.throughputPerHaPair ? `${details.throughputPerHaPair} MB/s` : '-' },
        { label: 'Deployment Type', value: details.deploymentType || '-' },
        { label: 'Volume Size', value: details.volumeSize ? `${details.volumeSize} GiB` : '-' },
        { label: 'Security Style', value: details.securityStyle || '-' },
        { label: 'Backup Retention', value: details.backupRetention ? `${details.backupRetention} days` : '-' }
      ];
    } else if (details.type === 'fsx-windows') {
      return [
        { label: 'Storage Capacity', value: details.storageCapacity || details.configuration?.ssdStorageCapacity ? `${details.storageCapacity || details.configuration?.ssdStorageCapacity} GiB` : '-' },
        { label: 'Throughput Capacity', value: details.throughput || details.configuration?.throughputCapacity ? `${details.throughput || details.configuration?.throughputCapacity} MB/s` : '-' },
        { label: 'Backup Retention', value: details.backupRetention || details.configuration?.automaticBackupRetentionPeriod ? `${details.backupRetention || details.configuration?.automaticBackupRetentionPeriod} days` : '-' }
      ];
    } else if (details.type === 'mountpoint-s3') {
      return [
        { label: 'Bucket Name', value: details.bucketName || '-' },
        { label: 'Prefix', value: details.prefix || '/' },
        { label: 'Mount Path', value: details.mountPath || '-' },
        { label: 'Access Mode', value: details.accessMode || '-' }
      ];
    }
    return [];
  };

  const configurationInfo = getConfigurationInfo();

  // Build FSx info based on storage type
  const getFsxInfo = () => {
    if (!details) return [];
    
    const info = [];
    if (details.fsxFileSystemId) info.push({ label: 'File System ID', value: details.fsxFileSystemId });
    if (details.fsxDnsName && details.fsxDnsName !== 'N/A') info.push({ label: 'DNS Name', value: details.fsxDnsName });
    if (details.fsxResourceArn) info.push({ label: 'Resource ARN', value: details.fsxResourceArn });
    
    // FSxN-specific fields
    if (details.type === 'fsx-ontap') {
      if (details.svmId) info.push({ label: 'SVM ID', value: details.svmId });
      if (details.svmArn) info.push({ label: 'SVM ARN', value: details.svmArn });
      if (details.volumeId) info.push({ label: 'Volume ID', value: details.volumeId });
      if (details.junctionPath) info.push({ label: 'Junction Path', value: details.junctionPath });
    }
    
    return info;
  };

  const fsxInfo = getFsxInfo();

  const cloudFormationInfo = details ? [
    ...(details.cloudFormationStackName ? [{ label: 'Stack Name', value: details.cloudFormationStackName }] : []),
    ...(details.executionArn ? [{ label: 'Step Functions Execution', value: details.executionArn }] : [])
  ] : [];

  const allItems = [
    {
      type: 'group',
      title: 'Storage Information',
      items: storageInfo
    },
    ...(configurationInfo.length > 0 ? [{
      type: 'group',
      title: 'Configuration',
      items: configurationInfo
    }] : []),
    ...(fsxInfo.length > 0 ? [{
      type: 'group',
      title: 'FSx File System',
      items: fsxInfo
    }] : []),
    ...(cloudFormationInfo.length > 0 ? [{
      type: 'group',
      title: 'CloudFormation',
      items: cloudFormationInfo
    }] : [])
  ];

  // Generate mounting instructions based on storage type
  const getMountingInstructions = () => {
    if (!details) return '';
    
    if (details.type === 'fsx-ontap') {
      const svmId = details.svmId || '<svm-id>';
      const junctionPath = details.junctionPath || '/vol1';
      // Note: SVM DNS endpoints are retrieved at mount time via FSx API
      return `# FSx for NetApp ONTAP Mounting Instructions
# Note: The SVM DNS endpoints are retrieved automatically when mounting via the UI.
# For manual mounting, you'll need to get the SVM endpoints from the AWS Console or CLI.

# Get SVM endpoints (run this first):
aws fsx describe-storage-virtual-machines --storage-virtual-machine-ids ${svmId} \\
  --query 'StorageVirtualMachines[0].Endpoints' --output json

# ============================================
# For Windows (SMB):
# ============================================
# Use the SMB DNS endpoint from the command above
net use Z: \\\\<svm-smb-dns-name>\\c$${junctionPath.replace(/\//g, '\\\\')} /persistent:yes

# ============================================
# For Linux (NFS):
# ============================================
# Use the NFS DNS endpoint from the command above
sudo mkdir -p /mnt/fsxn
sudo mount -t nfs <svm-nfs-dns-name>:${junctionPath} /mnt/fsxn

# For persistent mounting, add to /etc/fstab:
# <svm-nfs-dns-name>:${junctionPath} /mnt/fsxn nfs defaults 0 0

# ============================================
# For macOS (NFS):
# ============================================
sudo mkdir -p /Volumes/fsxn
sudo mount -t nfs -o resvport <svm-nfs-dns-name>:${junctionPath} /Volumes/fsxn`;
    } else if (details.type === 'fsx-windows' && details.fsxDnsName) {
      return `# Mount FSx for Windows File System
# Replace <drive-letter> with your desired drive letter (e.g., Z:)

# For Windows instances:
net use <drive-letter>: \\\\${details.fsxDnsName}\\share /persistent:yes

# Example:
net use Z: \\\\${details.fsxDnsName}\\share /persistent:yes

# To unmount:
net use <drive-letter>: /delete

# For Linux instances (if using SMB/CIFS):
sudo mkdir /mnt/fsx
sudo mount -t cifs //${details.fsxDnsName}/share /mnt/fsx -o username=<domain-user>,domain=<domain-name>

# Add to /etc/fstab for persistent mounting:
//${details.fsxDnsName}/share /mnt/fsx cifs username=<domain-user>,domain=<domain-name>,uid=1000,gid=1000,iocharset=utf8 0 0`;
    } else if (details.type === 'mountpoint-s3') {
      return `# Mountpoint for S3
# This storage is automatically mounted to Linux workstations via the Mount Storage feature.

# Manual mounting (requires Mountpoint for S3 installed):
mount-s3 ${details.bucketName} ${details.mountPath} ${details.prefix ? `--prefix ${details.prefix}` : ''}

# To unmount:
umount ${details.mountPath}`;
    }
    return '';
  };

  const mountingInstructions = getMountingInstructions();

  return (
    <ContentLayout
      defaultPadding
      headerVariant="high-contrast"
      maxContentWidth={1200}
      breadcrumbs={
        <BreadcrumbGroup
          items={[
            { text: 'Dashboard', href: '/dashboard' },
            { text: 'Storage', href: '/storage' },
            { text: details?.name || storageId || 'Details' }
          ]}
          ariaLabel="Breadcrumbs"
        />
      }
      header={
        <Box padding={{ vertical: "l" }}>
          <Grid
            gridDefinition={[
              { colspan: { default: 12, xs: 8, s: 9 } },
              { colspan: { default: 12, xs: 4, s: 3 } }
            ]}
          >
            <div>
              <Box variant="h1" fontSize="display-l">
                Storage Details
              </Box>
              <Box
                variant="p"
                color="text-body-secondary"
                margin={{ top: "xxs", bottom: "s" }}
              >
                Storage Name: {details?.name || storageId}
              </Box>
            </div>
          </Grid>
        </Box>
      }
    >
      {loading ? (
        <Container>
          <Spinner size="large" />
        </Container>
      ) : (
        <SpaceBetween direction="vertical" size="l">
          <Container header={<Header variant="h2">Storage Details</Header>}>
            <KeyValuePairs columns={3} items={allItems} />
          </Container>

          {mountingInstructions && (
            <Container header={<Header variant="h2">Mounting Instructions</Header>}>
              <Box variant="p" margin={{ bottom: "s" }}>
                Use these commands to manually mount the file system to your EC2 instances:
              </Box>
              <CodeView content={mountingInstructions} />
            </Container>
          )}
        </SpaceBetween>
      )}
    </ContentLayout>
  );
};

export default StorageDetails;
