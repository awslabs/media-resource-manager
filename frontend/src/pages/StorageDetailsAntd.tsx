// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Card,
  Tabs,
  Descriptions,
  Tag,
  Alert,
  Spin,
  Typography,
  Breadcrumb,
  Button,
  Space,
  Tooltip,
  Divider,
} from 'antd';
import {
  HomeOutlined,
  ArrowLeftOutlined,
  ReloadOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { apiCall } from '../utils/api';

const { Title, Text, Paragraph } = Typography;

interface StorageDetailsAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const StorageDetailsAntd: React.FC<StorageDetailsAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
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
      setLoading(true);
      const token = getAuthToken();
      if (!token) {
        throw new Error('No current user');
      }

      const response = await apiCall(`storage/${storageId}`, {
        headers: { Authorization: `Bearer ${token}` },
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

  const getStatusTag = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'available':
        return <Tag color="green">Available</Tag>;
      case 'creating':
        return <Tag color="blue">Creating</Tag>;
      case 'deleting':
        return <Tag color="orange">Deleting</Tag>;
      case 'failed':
        return <Tag color="red">Failed</Tag>;
      case 'updating':
        return <Tag color="blue">Updating</Tag>;
      default:
        return <Tag>{status || 'Unknown'}</Tag>;
    }
  };

  const getStorageTypeLabel = (type: string) => {
    switch (type) {
      case 'fsx-windows':
        return 'FSx for Windows File Server';
      case 'fsx-ontap':
        return 'FSx for NetApp ONTAP';
      case 'mountpoint-s3':
        return 'Mountpoint for S3';
      default:
        return type;
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  // Generate mounting instructions based on storage type
  const getMountingInstructions = () => {
    if (!details) return '';

    if (details.type === 'fsx-ontap') {
      const svmId = details.svmId || '<svm-id>';
      const junctionPath = details.junctionPath || '/vol1';
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
net use Z: \\\\<svm-smb-dns-name>\\c${junctionPath.replace(/\//g, '\\\\')} /persistent:yes

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

  if (loading) {
    return (
      <AppLayoutAntd
        isAdmin={isAdmin}
        user={user}
        config={config}
        onSignOut={onSignOut}
        onChangePassword={onChangePassword}
      >
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
          <Spin size="large" />
        </div>
      </AppLayoutAntd>
    );
  }

  if (error) {
    return (
      <AppLayoutAntd
        isAdmin={isAdmin}
        user={user}
        config={config}
        onSignOut={onSignOut}
        onChangePassword={onChangePassword}
      >
        <div style={{ width: '100%' }}>
          <Breadcrumb
            style={{ marginBottom: 16 }}
            items={[
              { href: '/dashboard', title: <><HomeOutlined /> Dashboard</> },
              { href: '/filesystems', title: 'Filesystems' },
              { title: 'Details' },
            ]}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <Title level={3} style={{ margin: 0 }}>Storage Details</Title>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/filesystems')}>
              Back
            </Button>
          </div>
          <Alert type="error" message={error} />
        </div>
      </AppLayoutAntd>
    );
  }

  const mountingInstructions = getMountingInstructions();

  // Build tab items based on storage type
  const tabItems = [
    {
      key: 'general',
      label: 'General',
      children: (
        <Space direction="vertical" size={24} style={{ width: '100%' }}>
          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Storage Information</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="Storage ID">{details.storageId}</Descriptions.Item>
              <Descriptions.Item label="Name">{details.name}</Descriptions.Item>
              <Descriptions.Item label="Type">{getStorageTypeLabel(details.type)}</Descriptions.Item>
              <Descriptions.Item label="Status">{getStatusTag(details.status)}</Descriptions.Item>
              <Descriptions.Item label="Created">{details.createdAt ? formatDate(details.createdAt) : '-'}</Descriptions.Item>
              <Descriptions.Item label="Updated">{details.updatedAt ? formatDate(details.updatedAt) : '-'}</Descriptions.Item>
            </Descriptions>
            {details.description && (
              <div style={{ marginTop: 12 }}>
                <Text type="secondary">Description: {details.description}</Text>
              </div>
            )}
          </div>

          <Divider style={{ margin: 0 }} />

          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Configuration</Text>
            {details.type === 'fsx-ontap' && (
              <Descriptions column={{ xs: 1, sm: 2, md: 4 }} size="small">
                <Descriptions.Item label="Storage Capacity">{details.storageCapacity ? `${details.storageCapacity} GiB` : '-'}</Descriptions.Item>
                <Descriptions.Item label="Total Throughput">{details.throughput ? `${details.throughput} MB/s` : '-'}</Descriptions.Item>
                <Descriptions.Item label="HA Pairs">{details.haPairs?.toString() || '-'}</Descriptions.Item>
                <Descriptions.Item label="Throughput per HA Pair">{details.throughputPerHaPair ? `${details.throughputPerHaPair} MB/s` : '-'}</Descriptions.Item>
                <Descriptions.Item label="Deployment Type">{details.deploymentType || '-'}</Descriptions.Item>
                <Descriptions.Item label="Volume Size">{details.volumeSize ? `${details.volumeSize} GiB` : '-'}</Descriptions.Item>
                <Descriptions.Item label="Security Style">{details.securityStyle || '-'}</Descriptions.Item>
                <Descriptions.Item label="Backup Retention">{details.backupRetention ? `${details.backupRetention} days` : '-'}</Descriptions.Item>
              </Descriptions>
            )}
            {details.type === 'fsx-windows' && (
              <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
                <Descriptions.Item label="Storage Capacity">{details.storageCapacity || details.configuration?.ssdStorageCapacity ? `${details.storageCapacity || details.configuration?.ssdStorageCapacity} GiB` : '-'}</Descriptions.Item>
                <Descriptions.Item label="Throughput Capacity">{details.throughput || details.configuration?.throughputCapacity ? `${details.throughput || details.configuration?.throughputCapacity} MB/s` : '-'}</Descriptions.Item>
                <Descriptions.Item label="Backup Retention">{details.backupRetention || details.configuration?.automaticBackupRetentionPeriod ? `${details.backupRetention || details.configuration?.automaticBackupRetentionPeriod} days` : '-'}</Descriptions.Item>
              </Descriptions>
            )}
            {details.type === 'mountpoint-s3' && (
              <Descriptions column={{ xs: 1, sm: 2, md: 4 }} size="small">
                <Descriptions.Item label="Bucket Name">{details.bucketName || '-'}</Descriptions.Item>
                <Descriptions.Item label="Prefix">{details.prefix || '/'}</Descriptions.Item>
                <Descriptions.Item label="Mount Path">{details.mountPath || '-'}</Descriptions.Item>
                <Descriptions.Item label="Access Mode">{details.accessMode || '-'}</Descriptions.Item>
              </Descriptions>
            )}
          </div>

          {(details.fsxFileSystemId || details.fsxDnsName || details.fsxResourceArn) && (
            <>
              <Divider style={{ margin: 0 }} />
              <div>
                <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>FSx File System</Text>
                <Descriptions column={{ xs: 1, sm: 2 }} size="small">
                  {details.fsxFileSystemId && <Descriptions.Item label="File System ID">{details.fsxFileSystemId}</Descriptions.Item>}
                  {details.fsxDnsName && details.fsxDnsName !== 'N/A' && <Descriptions.Item label="DNS Name">{details.fsxDnsName}</Descriptions.Item>}
                  {details.fsxResourceArn && <Descriptions.Item label="Resource ARN" span={2}>{details.fsxResourceArn}</Descriptions.Item>}
                </Descriptions>
              </div>
            </>
          )}

          {details.type === 'fsx-ontap' && (details.svmId || details.volumeId) && (
            <>
              <Divider style={{ margin: 0 }} />
              <div>
                <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>ONTAP Details</Text>
                <Descriptions column={{ xs: 1, sm: 2 }} size="small">
                  {details.svmId && <Descriptions.Item label="SVM ID">{details.svmId}</Descriptions.Item>}
                  {details.volumeId && <Descriptions.Item label="Volume ID">{details.volumeId}</Descriptions.Item>}
                  {details.junctionPath && <Descriptions.Item label="Junction Path">{details.junctionPath}</Descriptions.Item>}
                  {details.svmArn && <Descriptions.Item label="SVM ARN" span={2}>{details.svmArn}</Descriptions.Item>}
                </Descriptions>
              </div>
            </>
          )}

          {(details.cloudFormationStackName || details.executionArn) && (
            <>
              <Divider style={{ margin: 0 }} />
              <div>
                <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>CloudFormation</Text>
                <Descriptions column={{ xs: 1, sm: 2 }} size="small">
                  {details.cloudFormationStackName && <Descriptions.Item label="Stack Name">{details.cloudFormationStackName}</Descriptions.Item>}
                  {details.executionArn && <Descriptions.Item label="Step Functions Execution" span={2}>{details.executionArn}</Descriptions.Item>}
                </Descriptions>
              </div>
            </>
          )}
        </Space>
      ),
    },
  ];

  // Add mounting instructions tab if available
  if (mountingInstructions) {
    tabItems.push({
      key: 'mounting',
      label: 'Mounting Instructions',
      children: (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text type="secondary">Use these commands to manually mount the file system to your EC2 instances:</Text>
            <Tooltip title="Copy to clipboard">
              <Button
                icon={<CopyOutlined />}
                size="small"
                onClick={() => copyToClipboard(mountingInstructions)}
              >
                Copy
              </Button>
            </Tooltip>
          </div>
          <Paragraph>
            <pre style={{
              background: '#1e1e1e',
              color: '#d4d4d4',
              padding: 16,
              borderRadius: 6,
              overflow: 'auto',
              fontSize: 13,
              lineHeight: 1.5,
              margin: 0,
            }}>
              {mountingInstructions}
            </pre>
          </Paragraph>
        </Space>
      ),
    });
  }

  return (
    <AppLayoutAntd
      isAdmin={isAdmin}
      user={user}
      config={config}
      onSignOut={onSignOut}
      onChangePassword={onChangePassword}
    >
      <div style={{ width: '100%' }}>
        {/* Breadcrumb */}
        <Breadcrumb
          style={{ marginBottom: 16 }}
          items={[
            { href: '/dashboard', title: <><HomeOutlined /> Dashboard</> },
            { href: '/filesystems', title: 'Filesystems' },
            { title: details?.name || storageId || 'Details' },
          ]}
        />

        {/* Header with actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>{details?.name || 'Storage Details'}</Title>
            <Space style={{ marginTop: 8 }}>
              <Text type="secondary">{getStorageTypeLabel(details?.type)}</Text>
              {getStatusTag(details?.status)}
            </Space>
          </div>
          <Space>
            <Tooltip title="Refresh">
              <Button icon={<ReloadOutlined />} onClick={fetchStorageDetails} loading={loading} />
            </Tooltip>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/filesystems')}>
              Back
            </Button>
          </Space>
        </div>

        {/* Content Card with Tabs */}
        <Card >
          <Tabs items={tabItems} />
        </Card>
      </div>
    </AppLayoutAntd>
  );
};

export default StorageDetailsAntd;
