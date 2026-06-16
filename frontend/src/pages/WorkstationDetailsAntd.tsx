// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Card,
  Tabs,
  Descriptions,
  Tag,
  Table,
  Alert,
  Spin,
  Typography,
  Breadcrumb,
  Button,
  Space,
  Tooltip,
  Divider,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
} from 'antd';
import {
  HomeOutlined,
  ArrowLeftOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  DesktopOutlined,
  ReloadOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { apiCall } from '../utils/api';

const { Title, Text, Link } = Typography;

interface WorkstationDetailsAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const WorkstationDetailsAntd: React.FC<WorkstationDetailsAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const { instanceId } = useParams<{ instanceId: string }>();
  const navigate = useNavigate();
  const [details, setDetails] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [storageResources, setStorageResources] = useState<any[]>([]);
  const [loadingStorage, setLoadingStorage] = useState(false);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info' | 'warning'; message: string } | null>(null);

  // Action states
  const [connecting, setConnecting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  // Volume management state
  const [showResizeModal, setShowResizeModal] = useState(false);
  const [showAddVolumeModal, setShowAddVolumeModal] = useState(false);
  const [showDetachModal, setShowDetachModal] = useState(false);
  const [selectedVolume, setSelectedVolume] = useState<any>(null);
  const [newVolumeSize, setNewVolumeSize] = useState<number>(0);
  const [addVolumeSize, setAddVolumeSize] = useState<number>(100);
  const [addVolumeType, setAddVolumeType] = useState<string>('gp3');
  const [addVolumeDevice, setAddVolumeDevice] = useState<string>('');
  const [deleteOnDetach, setDeleteOnDetach] = useState(false);
  const [volumeActionLoading, setVolumeActionLoading] = useState(false);

  useEffect(() => {
    if (instanceId) {
      fetchWorkstationDetails();
    }
  }, [instanceId]);

  useEffect(() => {
    if (details?.workstation?.storageConfig) {
      fetchStorageDetails();
    }
  }, [details]);

  const fetchStorageDetails = async () => {
    if (!details?.workstation?.storageConfig) return;

    setLoadingStorage(true);
    try {
      const token = getAuthToken();
      if (!token) return;

      const storageIds = Object.keys(details.workstation.storageConfig);
      const storagePromises = storageIds.map(async (storageId) => {
        const response = await apiCall(`storage/${storageId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          const storageData = await response.json();
          return {
            ...storageData,
            config: details.workstation.storageConfig[storageId],
          };
        }
        return null;
      });

      const results = await Promise.all(storagePromises);
      setStorageResources(results.filter(Boolean));
    } catch (error) {
      console.error('Error fetching storage details:', error);
    } finally {
      setLoadingStorage(false);
    }
  };

  const handleResizeVolume = async () => {
    if (!selectedVolume || !newVolumeSize) return;
    setVolumeActionLoading(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');
      const response = await apiCall('workstations/volumes/resize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instanceId, volumeId: selectedVolume.Ebs?.VolumeId, newSize: newVolumeSize }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to resize volume');
      setShowResizeModal(false);
      setSelectedVolume(null);
      setAlert({ type: 'success', message: result.message });
      setTimeout(() => fetchWorkstationDetails(), 3000);
    } catch (err: any) {
      setAlert({ type: 'error', message: err.message || 'Failed to resize volume' });
    } finally {
      setVolumeActionLoading(false);
    }
  };

  const handleAddVolume = async () => {
    if (!addVolumeSize || !addVolumeDevice) return;
    setVolumeActionLoading(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');
      const response = await apiCall('workstations/volumes/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instanceId, size: addVolumeSize, volumeType: addVolumeType, deviceName: addVolumeDevice }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to add volume');
      setShowAddVolumeModal(false);
      setAddVolumeSize(100);
      setAddVolumeType('gp3');
      setAddVolumeDevice('');
      setAlert({ type: 'success', message: result.message });
      setTimeout(() => fetchWorkstationDetails(), 5000);
    } catch (err: any) {
      setAlert({ type: 'error', message: err.message || 'Failed to add volume' });
    } finally {
      setVolumeActionLoading(false);
    }
  };

  const handleDetachVolume = async () => {
    if (!selectedVolume) return;
    setVolumeActionLoading(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');
      const response = await apiCall('workstations/volumes/detach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instanceId, volumeId: selectedVolume.Ebs?.VolumeId, deleteVolume: deleteOnDetach }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to detach volume');
      setShowDetachModal(false);
      setSelectedVolume(null);
      setDeleteOnDetach(false);
      setAlert({ type: 'success', message: result.message });
      setTimeout(() => fetchWorkstationDetails(), 3000);
    } catch (err: any) {
      setAlert({ type: 'error', message: err.message || 'Failed to detach volume' });
    } finally {
      setVolumeActionLoading(false);
    }
  };

  const fetchWorkstationDetails = async () => {
    try {
      setLoading(true);
      const token = getAuthToken();
      if (!token) {
        throw new Error('No current user');
      }

      const response = await apiCall(`workstations/${instanceId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const data = await response.json();
        setDetails(data);
      } else if (response.status === 404) {
        setError('Workstation not found');
      } else if (response.status === 403) {
        setError('Access denied');
      } else {
        setError('Failed to load workstation details');
      }
    } catch (error) {
      console.error('Error fetching workstation details:', error);
      if (!handleAuthError(error)) {
        setError('Failed to load workstation details');
      }
    } finally {
      setLoading(false);
    }
  };

  // Action handlers
  const handleConnect = async () => {
    if (!instanceId) return;
    setConnecting(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('/dcv', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'create-session',
          serverId: instanceId,
          sessionName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email?.split('@')[0] || 'User',
          sessionType: 'console',
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const sessionData = await response.json();
      if (sessionData.error) throw new Error(sessionData.error);

      if (sessionData.connectionUrl) {
        const baseUrl = sessionData.quicConnectionUrl || sessionData.connectionUrl;
        const dcvUrl = baseUrl.replace('https://', 'dcv://');
        window.location.href = dcvUrl;
      }
    } catch (error) {
      console.error('Error connecting to workstation:', error);
      setAlert({ type: 'error', message: `Failed to connect: ${(error as Error).message}` });
    } finally {
      setConnecting(false);
    }
  };

  const handleStart = async () => {
    if (!instanceId) return;
    setStarting(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      await apiCall('workstations/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instanceId }),
      });

      setAlert({ type: 'info', message: 'Starting workstation...' });
      setTimeout(() => fetchWorkstationDetails(), 3000);
    } catch (error) {
      console.error('Error starting workstation:', error);
      setAlert({ type: 'error', message: 'Failed to start workstation' });
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    if (!instanceId) return;
    setStopping(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      await apiCall('workstations/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instanceId }),
      });

      setAlert({ type: 'info', message: 'Stopping workstation...' });
      setTimeout(() => fetchWorkstationDetails(), 3000);
    } catch (error) {
      console.error('Error stopping workstation:', error);
      setAlert({ type: 'error', message: 'Failed to stop workstation' });
    } finally {
      setStopping(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getStateTag = (state: string) => {
    switch (state) {
      case 'running':
        return <Tag color="success">Running</Tag>;
      case 'stopped':
        return <Tag color="default">Stopped</Tag>;
      case 'pending':
        return <Tag color="processing">Starting</Tag>;
      case 'stopping':
        return <Tag color="warning">Stopping</Tag>;
      case 'terminated':
        return <Tag color="error">Terminated</Tag>;
      default:
        return <Tag>{state}</Tag>;
    }
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
              { href: '/workstations', title: 'Workstations' },
              { title: 'Details' },
            ]}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <Title level={3} style={{ margin: 0 }}>Workstation Details</Title>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/workstations')}>
              Back
            </Button>
          </div>
          <Alert type="error" message={error} />
        </div>
      </AppLayoutAntd>
    );
  }

  const { workstation, ec2Instance } = details;
  const instanceState = ec2Instance?.State?.Name;
  const isRunning = instanceState === 'running';
  const isStopped = instanceState === 'stopped';

  // Storage columns
  const storageColumns: ColumnsType<any> = [
    {
      title: 'Storage Name',
      dataIndex: 'name',
      key: 'name',
      render: (name, record) => (
        <Link onClick={() => (window.location.href = `/storage/${record.storageId}`)}>
          {name}
        </Link>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      render: (type) => (type === 'fsx-windows' ? 'FSx for Windows' : type === 'fsx-ontap' ? 'FSx for ONTAP' : type),
    },
    {
      title: 'Drive Letter',
      key: 'driveLetter',
      render: (_, record) => (record.config?.driveLetter ? `${record.config.driveLetter}:` : '-'),
    },
    {
      title: 'Auto Mount',
      key: 'autoMount',
      render: (_, record) => (record.config?.autoMount ? 'Yes' : 'No'),
    },
  ];

  // Block device columns
  const isRootVolume = (record: any) => record.DeviceName === ec2Instance?.RootDeviceName;
  const blockDeviceColumns: ColumnsType<any> = [
    { title: 'Device Name', dataIndex: 'DeviceName', key: 'DeviceName',
      render: (name: string, record: any) => (
        <Space>
          {name}
          {isRootVolume(record) && <Tag color="blue">Root</Tag>}
        </Space>
      )
    },
    { title: 'Volume ID', key: 'VolumeId', render: (_: any, record: any) => record.Ebs?.VolumeId || '-' },
    { title: 'Size (GB)', key: 'VolumeSize', render: (_: any, record: any) => record.Ebs?.VolumeSize ? `${record.Ebs.VolumeSize} GB` : '-' },
    { title: 'Status', key: 'Status', render: (_: any, record: any) => record.Ebs?.Status || '-' },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          <Button
            size="small"
            onClick={() => {
              setSelectedVolume(record);
              setNewVolumeSize(0);
              setShowResizeModal(true);
            }}
          >
            Resize
          </Button>
          <Button
            size="small"
            danger
            disabled={isRootVolume(record)}
            title={isRootVolume(record) ? 'Cannot detach root volume' : undefined}
            onClick={() => {
              setSelectedVolume(record);
              setDeleteOnDetach(false);
              setShowDetachModal(true);
            }}
          >
            Detach
          </Button>
        </Space>
      )
    },
  ];

  // Security group columns
  const securityGroupColumns: ColumnsType<any> = [
    { title: 'Group Name', dataIndex: 'GroupName', key: 'GroupName' },
    { title: 'Group ID', dataIndex: 'GroupId', key: 'GroupId' },
  ];

  // Tags columns
  const tagColumns: ColumnsType<any> = [
    { title: 'Key', dataIndex: 'Key', key: 'Key' },
    { title: 'Value', dataIndex: 'Value', key: 'Value' },
  ];

  const tabItems = [
    {
      key: 'general',
      label: 'General',
      children: (
        <Space direction="vertical" size={24} style={{ width: '100%' }}>
          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Instance Details</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 4 }} size="small">
              <Descriptions.Item label="Instance ID">{ec2Instance.InstanceId}</Descriptions.Item>
              <Descriptions.Item label="State">{getStateTag(ec2Instance.State.Name)}</Descriptions.Item>
              <Descriptions.Item label="Launch Time">{formatDate(ec2Instance.LaunchTime)}</Descriptions.Item>
              <Descriptions.Item label="Assigned User">{workstation.assignedUserId || 'Unassigned'}</Descriptions.Item>
            </Descriptions>
          </div>

          <Divider style={{ margin: 0 }} />

          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Compute Configuration</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="Instance Type">{ec2Instance.InstanceType}</Descriptions.Item>
              <Descriptions.Item label="Architecture">{ec2Instance.Architecture}</Descriptions.Item>
              <Descriptions.Item label="Platform">{ec2Instance.Platform || 'Linux'}</Descriptions.Item>
            </Descriptions>
          </div>

          <Divider style={{ margin: 0 }} />

          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Image Information</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="AMI ID">{ec2Instance.ImageId}</Descriptions.Item>
            </Descriptions>
          </div>
        </Space>
      ),
    },
    {
      key: 'network',
      label: 'Network',
      children: (
        <Space direction="vertical" size={24} style={{ width: '100%' }}>
          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>VPC Configuration</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="VPC ID">{ec2Instance.VpcId}</Descriptions.Item>
              <Descriptions.Item label="Subnet ID">{ec2Instance.SubnetId}</Descriptions.Item>
            </Descriptions>
          </div>

          <Divider style={{ margin: 0 }} />

          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>IP Addresses</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="Private IP">{ec2Instance.PrivateIpAddress}</Descriptions.Item>
              <Descriptions.Item label="Public IP">{ec2Instance.PublicIpAddress || 'None'}</Descriptions.Item>
            </Descriptions>
          </div>

          <Divider style={{ margin: 0 }} />

          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>DNS Names</Text>
            <Descriptions column={{ xs: 1, sm: 2 }} size="small">
              <Descriptions.Item label="Private DNS">{ec2Instance.PrivateDnsName}</Descriptions.Item>
              <Descriptions.Item label="Public DNS">{ec2Instance.PublicDnsName || 'None'}</Descriptions.Item>
            </Descriptions>
          </div>

          {ec2Instance.SecurityGroups?.length > 0 && (
            <>
              <Divider style={{ margin: 0 }} />
              <div>
                <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Security Groups</Text>
                <Table
                  rowKey="GroupId"
                  columns={securityGroupColumns}
                  dataSource={ec2Instance.SecurityGroups}
                  pagination={false}
                  size="small"
                />
              </div>
            </>
          )}
        </Space>
      ),
    },
    {
      key: 'storage',
      label: 'Storage',
      children: (
        <Space direction="vertical" size={24} style={{ width: '100%' }}>
          {storageResources.length > 0 && (
            <>
              <div>
                <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>FSx File Systems (Auto-Mount)</Text>
                <Table
                  rowKey="storageId"
                  columns={storageColumns}
                  dataSource={storageResources}
                  loading={loadingStorage}
                  pagination={false}
                  size="small"
                />
              </div>
              <Divider style={{ margin: 0 }} />
            </>
          )}

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text strong style={{ fontSize: 14 }}>Block Device Mappings (EBS)</Text>
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() => {
                  // Suggest next available device name based on platform
                  const platform = workstation.platform?.toLowerCase();
                  const existing = ec2Instance.BlockDeviceMappings?.map((b: any) => b.DeviceName) || [];
                  const windowsDevices = ['/dev/sdb', '/dev/sdc', '/dev/sdd', '/dev/sde', '/dev/sdf'];
                  const linuxDevices = ['/dev/xvdb', '/dev/xvdc', '/dev/xvdd', '/dev/xvde', '/dev/xvdf'];
                  const candidates = platform === 'windows' ? windowsDevices : linuxDevices;
                  const next = candidates.find(d => !existing.includes(d)) || '';
                  setAddVolumeDevice(next);
                  setAddVolumeSize(100);
                  setAddVolumeType('gp3');
                  setShowAddVolumeModal(true);
                }}
              >
                Add Volume
              </Button>
            </div>
            {ec2Instance.BlockDeviceMappings?.length > 0 ? (
              <Table
                rowKey="DeviceName"
                columns={blockDeviceColumns}
                dataSource={ec2Instance.BlockDeviceMappings}
                pagination={false}
                size="small"
              />
            ) : (
              <Text type="secondary">No block device information available</Text>
            )}
          </div>
        </Space>
      ),
    },
    {
      key: 'tags',
      label: 'Tags',
      children: (
        <div>
          <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Instance Tags</Text>
          {ec2Instance.Tags?.length > 0 ? (
            <Table
              rowKey="Key"
              columns={tagColumns}
              dataSource={ec2Instance.Tags}
              pagination={false}
              size="small"
            />
          ) : (
            <Text type="secondary">No tags found</Text>
          )}
        </div>
      ),
    },
  ];

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
            { href: '/workstations', title: 'Workstations' },
            { title: workstation?.workstationName || instanceId || 'Details' },
          ]}
        />

        {/* Header with actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>{workstation?.workstationName || 'Workstation Details'}</Title>
            <Space style={{ marginTop: 8 }}>
              <Text type="secondary">{instanceId}</Text>
              {getStateTag(instanceState)}
            </Space>
          </div>
          <Space>
            <Tooltip title="Refresh">
              <Button icon={<ReloadOutlined />} onClick={fetchWorkstationDetails} loading={loading} />
            </Tooltip>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/workstations')}>
              Back
            </Button>
            {isRunning && (
              <Button
                type="primary"
                icon={<DesktopOutlined />}
                onClick={handleConnect}
                loading={connecting}
              >
                Connect
              </Button>
            )}
            {isStopped && (
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={handleStart}
                loading={starting}
              >
                Start
              </Button>
            )}
            {isRunning && (
              <Tooltip title="Stop workstation">
                <Button
                  icon={<PauseCircleOutlined />}
                  onClick={handleStop}
                  loading={stopping}
                >
                  Stop
                </Button>
              </Tooltip>
            )}
          </Space>
        </div>

        {alert && (
          <Alert
            type={alert.type}
            message={alert.message}
            closable
            onClose={() => setAlert(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        {/* Content Card with Tabs */}
        <Card >
          <Tabs items={tabItems} />
        </Card>

        {/* Resize Volume Modal */}
        <Modal
          title={`Resize Volume — ${selectedVolume?.DeviceName}`}
          open={showResizeModal}
          onCancel={() => { setShowResizeModal(false); setSelectedVolume(null); }}
          onOk={handleResizeVolume}
          confirmLoading={volumeActionLoading}
          okText="Resize Volume"
          okButtonProps={{ disabled: !newVolumeSize || newVolumeSize <= (selectedVolume?.Ebs?.VolumeSize || 0) }}
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <Text type="secondary">Volume ID: </Text>
              <Text strong>{selectedVolume?.Ebs?.VolumeId}</Text>
            </div>
            <Form layout="vertical">
              <Form.Item
                label="New Size (GB)"
                required
                help={`Must be larger than current size (${selectedVolume?.Ebs?.VolumeSize} GB). EBS volumes cannot be decreased.`}
              >
                <InputNumber
                  min={(selectedVolume?.Ebs?.VolumeSize || 0) + 1}
                  max={16384}
                  value={newVolumeSize || undefined}
                  onChange={(val) => setNewVolumeSize(val || 0)}
                  style={{ width: '100%' }}
                  addonAfter="GB"
                  placeholder={`Current: ${selectedVolume?.Ebs?.VolumeSize} GB`}
                />
              </Form.Item>
            </Form>
            <Alert
              type="info"
              showIcon
              message="Volume resize is non-destructive and works while the instance is running. The file system will be extended automatically via SSM once the instance is running."
            />
          </Space>
        </Modal>

        {/* Add Volume Modal */}
        <Modal
          title="Add Data Volume"
          open={showAddVolumeModal}
          onCancel={() => setShowAddVolumeModal(false)}
          onOk={handleAddVolume}
          confirmLoading={volumeActionLoading}
          okText="Add Volume"
          okButtonProps={{ disabled: !addVolumeDevice || !addVolumeSize }}
        >
          <Form layout="vertical">
            <Form.Item label="Size (GB)" required>
              <InputNumber
                min={1}
                max={16384}
                value={addVolumeSize}
                onChange={(val) => setAddVolumeSize(val || 100)}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item label="Volume Type" required>
              <Select
                value={addVolumeType}
                onChange={setAddVolumeType}
                options={[
                  { value: 'gp3', label: 'gp3 — General Purpose SSD (recommended)' },
                  { value: 'gp2', label: 'gp2 — General Purpose SSD' },
                  { value: 'io2', label: 'io2 — Provisioned IOPS SSD' },
                  { value: 'st1', label: 'st1 — Throughput Optimized HDD' },
                  { value: 'sc1', label: 'sc1 — Cold HDD' },
                ]}
              />
            </Form.Item>
            <Form.Item label="Device Name" required>
              <Input
                value={addVolumeDevice}
                onChange={(e) => setAddVolumeDevice(e.target.value)}
                placeholder={workstation?.platform?.toLowerCase() === 'windows' ? '/dev/sdb' : '/dev/xvdb'}
              />
            </Form.Item>
          </Form>
          <Alert
            type="info"
            showIcon
            message="The volume will be created and attached. On Windows, you will need to initialize and format the disk in Disk Management. On Linux, you will need to format and mount it."
          />
        </Modal>

        {/* Detach Volume Modal */}
        <Modal
          title={`Detach Volume — ${selectedVolume?.DeviceName}`}
          open={showDetachModal}
          onCancel={() => { setShowDetachModal(false); setSelectedVolume(null); setDeleteOnDetach(false); }}
          onOk={handleDetachVolume}
          confirmLoading={volumeActionLoading}
          okText={deleteOnDetach ? 'Detach & Delete' : 'Detach'}
          okButtonProps={{ danger: deleteOnDetach }}
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <Text type="secondary">Volume ID: </Text>
              <Text strong>{selectedVolume?.Ebs?.VolumeId}</Text>
            </div>
            <div>
              <Text type="secondary">Size: </Text>
              <Text strong>{selectedVolume?.Ebs?.VolumeSize} GB</Text>
            </div>
            <Form layout="vertical">
              <Form.Item>
                <Switch
                  checked={deleteOnDetach}
                  onChange={setDeleteOnDetach}
                  checkedChildren="Delete after detach"
                  unCheckedChildren="Keep volume after detach"
                />
              </Form.Item>
            </Form>
            {deleteOnDetach && (
              <Alert
                type="warning"
                showIcon
                message="The volume will be permanently deleted after detaching. This cannot be undone."
              />
            )}
            {!deleteOnDetach && (
              <Alert
                type="info"
                showIcon
                message="The volume will be detached but not deleted. You can re-attach it later."
              />
            )}
          </Space>
        </Modal>
      </div>
    </AppLayoutAntd>
  );
};

export default WorkstationDetailsAntd;
