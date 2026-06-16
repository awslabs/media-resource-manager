// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useMemo, useRef } from 'react';
import type { InputRef } from 'antd';
import {
  Card,
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Alert,
  Tag,
  Space,
  Typography,
  Breadcrumb,
  Tooltip,
  Dropdown,
  InputNumber,
  Collapse,
  Radio,
  Checkbox,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ReloadOutlined,
  HomeOutlined,
  EditOutlined,
  DatabaseOutlined,
  DownOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { MenuProps } from 'antd';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';
import { listStorageS3Buckets, getStorageConfig, S3Bucket, StorageConfig } from '../utils/storageApi';

const { Title, Text, Link } = Typography;
const { TextArea } = Input;

interface StorageResource {
  storageId: string;
  name: string;
  type: string;
  status: string;
  region?: string;
  description?: string;
  storageCapacity?: number;
  throughput?: number;
  backupRetention?: number;
  configuration?: any;
  createdAt?: string;
  fsxFileSystemId?: string;
  storageGatewayId?: string;
}

interface RegionalHub {
  region: string;
  status: string;
  isPrimary?: boolean;
}

interface FilesystemsAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const FilesystemsAntd: React.FC<FilesystemsAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const [storageResources, setStorageResources] = useState<StorageResource[]>([]);
  const [regionalHubs, setRegionalHubs] = useState<RegionalHub[]>([]);
  const [primaryRegion, setPrimaryRegion] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info' | 'warning'; message: string } | null>(null);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  // Ref for create modal name input autofocus
  const createNameInputRef = useRef<InputRef>(null);

  // Focus name input when create modal opens
  useEffect(() => {
    if (showCreateModal) {
      const timer = setTimeout(() => {
        createNameInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [showCreateModal]);

  // Processing states
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // S3 bucket selection state (for Mountpoint S3)
  const [s3Buckets, setS3Buckets] = useState<S3Bucket[]>([]);
  const [storageConfig, setStorageConfig] = useState<StorageConfig | null>(null);
  const [s3BucketsLoading, setS3BucketsLoading] = useState(false);
  const [s3PolicyConfirmed, setS3PolicyConfirmed] = useState(false);

  // Edit state
  const [editingResource, setEditingResource] = useState<StorageResource | null>(null);

  // Filters
  const [filterText, setFilterText] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [regionFilter, setRegionFilter] = useState<string | null>(null);

  // Table preferences with localStorage persistence
  const [sortedInfo, setSortedInfo] = useState<{ columnKey: string; order: 'ascend' | 'descend' } | null>(() => {
    try {
      const saved = localStorage.getItem('filesystems-table-sort');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { columnKey: 'name', order: 'ascend' };
  });

  const [pageSize, setPageSize] = useState(() => {
    try {
      const saved = localStorage.getItem('filesystems-table-pageSize');
      if (saved) return parseInt(saved, 10);
    } catch (e) {}
    return 10;
  });

  // Forms
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const [storageResponse, hubsResponse] = await Promise.all([
        apiCall('storage', { headers: { Authorization: `Bearer ${token}` } }),
        apiCall('regions', { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
      ]);

      if (storageResponse.ok) {
        const data = await storageResponse.json();
        const safeData = Array.isArray(data) ? data : (data.data || []);
        setStorageResources(safeData);
      }

      if (hubsResponse?.ok) {
        const hubsData = await hubsResponse.json();
        const hubs = Array.isArray(hubsData) ? hubsData : (hubsData.data || []);
        const availableHubs = hubs.filter((hub: RegionalHub) => hub.status === 'available' && !hub.isPrimary);
        setRegionalHubs(availableHubs);
        const primaryHub = hubs.find((hub: any) => hub.isPrimary);
        if (primaryHub) setPrimaryRegion(primaryHub.region);
        else if (config?.region) setPrimaryRegion(config.region);
      }
    } catch (error) {
      console.error('Error fetching data:', error);
      setAlert({ type: 'error', message: 'Failed to fetch storage resources' });
    } finally {
      setLoading(false);
    }
  };

  // Filter resources
  const filteredResources = useMemo(() => {
    let filtered = storageResources;
    if (filterText) {
      const searchText = filterText.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.name?.toLowerCase().includes(searchText) ||
          r.storageId?.toLowerCase().includes(searchText) ||
          r.fsxFileSystemId?.toLowerCase().includes(searchText)
      );
    }
    if (typeFilter) {
      filtered = filtered.filter((r) => r.type === typeFilter);
    }
    if (regionFilter) {
      filtered = filtered.filter((r) => r.region === regionFilter);
    }
    return filtered;
  }, [storageResources, filterText, typeFilter, regionFilter]);

  const selectedResources = useMemo(() => {
    return storageResources.filter((r) => selectedRowKeys.includes(r.storageId));
  }, [storageResources, selectedRowKeys]);

  // Get unique regions for filter
  const regionOptions = useMemo(() => {
    const regions = new Set<string>();
    storageResources.forEach((r) => r.region && regions.add(r.region));
    regionalHubs.forEach((h) => regions.add(h.region));
    return Array.from(regions).sort();
  }, [storageResources, regionalHubs]);

  // Handlers
  const handleTableChange = (pagination: any, filters: any, sorter: any) => {
    const newSort = sorter.order
      ? { columnKey: sorter.columnKey || sorter.field, order: sorter.order }
      : null;
    setSortedInfo(newSort);
    try {
      if (newSort) {
        localStorage.setItem('filesystems-table-sort', JSON.stringify(newSort));
      } else {
        localStorage.removeItem('filesystems-table-sort');
      }
    } catch (e) {}
  };

  const handlePageSizeChange = (current: number, size: number) => {
    setPageSize(size);
    try {
      localStorage.setItem('filesystems-table-pageSize', String(size));
    } catch (e) {}
  };

  const handleCreate = async () => {
    try {
      const values = await createForm.validateFields();
      setCreating(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const requestBody: any = { ...values };
      if (!requestBody.region) delete requestBody.region;

      const response = await apiCall('storage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        let successMessage = 'Storage resource created successfully.';
        if (values.type === 'mountpoint-s3') {
          successMessage = 'Mountpoint S3 storage configuration created.';
        } else {
          const timeEstimate = values.type === 'fsx-windows' ? '30-45 minutes' : '30-45 minutes';
          successMessage = `Storage creation started. This typically takes ${timeEstimate}.`;
        }
        setAlert({ type: values.type === 'mountpoint-s3' ? 'success' : 'info', message: successMessage });
        setShowCreateModal(false);
        createForm.resetFields();
        setS3PolicyConfirmed(false);
        fetchData();
      } else {
        const errorData = await response.json();
        setAlert({ type: 'error', message: errorData.error || 'Failed to create storage' });
      }
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to create storage' });
    } finally {
      setCreating(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingResource) return;
    try {
      const values = await editForm.validateFields();
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall(`storage/${editingResource.storageId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: values.name, description: values.description }),
      });

      if (response.ok) {
        setAlert({ type: 'success', message: 'Storage resource updated' });
        setShowEditModal(false);
        setEditingResource(null);
        setSelectedRowKeys([]);
        fetchData();
      } else {
        const errorData = await response.json();
        setAlert({ type: 'error', message: errorData.error || 'Failed to update storage' });
      }
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to update storage' });
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      await Promise.all(
        selectedResources.map((r) =>
          apiCall(`storage/${r.storageId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          })
        )
      );

      setAlert({ type: 'info', message: `Deletion started for ${selectedResources.length} resource(s). This may take 5-10 minutes.` });
      setShowDeleteModal(false);
      setSelectedRowKeys([]);
      fetchData();
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to delete storage' });
    } finally {
      setDeleting(false);
    }
  };

  const openEditModal = () => {
    const resource = selectedResources[0];
    if (resource.status === 'creating' || resource.status === 'deleting') {
      setAlert({ type: 'error', message: 'Cannot edit while resource is being created or deleted.' });
      return;
    }
    setEditingResource(resource);
    editForm.setFieldsValue({ name: resource.name, description: resource.description || '' });
    setShowEditModal(true);
  };

  // Action menu items
  const getActionMenuItems = (): MenuProps['items'] => [
    {
      key: 'edit',
      label: 'Edit',
      icon: <EditOutlined />,
      disabled: selectedRowKeys.length !== 1,
      onClick: openEditModal,
    },
    { type: 'divider' },
    {
      key: 'delete',
      label: 'Delete',
      icon: <DeleteOutlined />,
      danger: true,
      disabled: selectedRowKeys.length === 0,
      onClick: () => setShowDeleteModal(true),
    },
  ];

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'fsx-windows': return 'FSx for Windows';
      case 'fsx-ontap': return 'FSx for ONTAP';
      case 'mountpoint-s3': return 'Mountpoint for S3';
      default: return type;
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'fsx-windows': return 'blue';
      case 'fsx-ontap': return 'purple';
      case 'mountpoint-s3': return 'green';
      default: return 'default';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'available': return 'green';
      case 'creating': return 'blue';
      case 'deleting': return 'default';
      default: return 'red';
    }
  };

  // Columns
  const columns: ColumnsType<StorageResource> = [
    {
      title: 'Resource ID',
      key: 'resourceId',
      width: 180,
      sorter: (a, b) => (a.fsxFileSystemId || '').localeCompare(b.fsxFileSystemId || ''),
      sortOrder: sortedInfo?.columnKey === 'resourceId' ? sortedInfo.order : null,
      render: (_, record) => (
        <Link onClick={() => (window.location.href = `/storage/${record.storageId}`)}>
          {record.fsxFileSystemId || record.storageGatewayId || record.storageId}
        </Link>
      ),
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      sorter: (a, b) => (a.name || '').localeCompare(b.name || ''),
      sortOrder: sortedInfo?.columnKey === 'name' ? sortedInfo.order : null,
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 140,
      sorter: (a, b) => (a.type || '').localeCompare(b.type || ''),
      sortOrder: sortedInfo?.columnKey === 'type' ? sortedInfo.order : null,
      render: (type) => <Tag color={getTypeColor(type)}>{getTypeLabel(type)}</Tag>,
    },
    {
      title: 'Region',
      dataIndex: 'region',
      key: 'region',
      width: 130,
      sorter: (a, b) => (a.region || '').localeCompare(b.region || ''),
      sortOrder: sortedInfo?.columnKey === 'region' ? sortedInfo.order : null,
      render: (region) => region || primaryRegion || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      sorter: (a, b) => (a.status || '').localeCompare(b.status || ''),
      sortOrder: sortedInfo?.columnKey === 'status' ? sortedInfo.order : null,
      render: (status) => (
        <Tag color={getStatusColor(status)}>
          {status?.charAt(0).toUpperCase() + status?.slice(1)}
        </Tag>
      ),
    },
    {
      title: 'Storage (GiB)',
      dataIndex: 'storageCapacity',
      key: 'storageCapacity',
      width: 120,
      align: 'right' as const,
      sorter: (a, b) => (a.storageCapacity || 0) - (b.storageCapacity || 0),
      sortOrder: sortedInfo?.columnKey === 'storageCapacity' ? sortedInfo.order : null,
      render: (val) => val?.toLocaleString() || '-',
    },
    {
      title: 'Throughput (MB/s)',
      dataIndex: 'throughput',
      key: 'throughput',
      width: 140,
      align: 'right' as const,
      sorter: (a, b) => (a.throughput || 0) - (b.throughput || 0),
      sortOrder: sortedInfo?.columnKey === 'throughput' ? sortedInfo.order : null,
      render: (val) => val?.toLocaleString() || '-',
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 120,
      sorter: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
      sortOrder: sortedInfo?.columnKey === 'createdAt' ? sortedInfo.order : null,
      render: (date) => (date ? new Date(date).toLocaleDateString() : '-'),
    },
  ];

  const storageType = Form.useWatch('type', createForm);
  const teamSize = Form.useWatch(['configuration', 'teamSize'], createForm);
  const haPairs = Form.useWatch(['configuration', 'haPairs'], createForm) || 2;
  const isCrossAccountS3 = Form.useWatch(['configuration', 'isCrossAccount'], createForm);

  // Fetch S3 buckets and config when Mountpoint S3 is selected
  useEffect(() => {
    if (storageType === 'mountpoint-s3' && showCreateModal) {
      const fetchS3Data = async () => {
        setS3BucketsLoading(true);
        try {
          const [buckets, config] = await Promise.all([
            listStorageS3Buckets(),
            getStorageConfig(),
          ]);
          setS3Buckets(buckets);
          setStorageConfig(config);
        } catch (error) {
          console.error('Error fetching S3 data:', error);
        } finally {
          setS3BucketsLoading(false);
        }
      };
      fetchS3Data();
    }
  }, [storageType, showCreateModal]);

  // Calculate minimum volume size based on HA pairs (100 GiB * 8 constituents * haPairs)
  const getMinVolumeSize = (pairs: number) => 100 * 8 * pairs;
  const getHaPairsForTeamSize = (size: string) => {
    const map: Record<string, number> = { small: 1, medium: 2, large: 6, enterprise: 6 };
    return map[size] || 1;
  };

  // Update volumeSize and haPairs when teamSize changes
  React.useEffect(() => {
    if (teamSize && teamSize !== 'custom') {
      const newHaPairs = getHaPairsForTeamSize(teamSize);
      const minVolumeSize = getMinVolumeSize(newHaPairs);
      const minStorageCapacity = 1024 * newHaPairs;
      createForm.setFieldsValue({
        configuration: {
          ...createForm.getFieldValue('configuration'),
          haPairs: newHaPairs,
          volumeSize: minVolumeSize,
          storageCapacity: minStorageCapacity,
        },
      });
    }
  }, [teamSize, createForm]);

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
            { title: 'Storage' },
            { title: 'Filesystems' },
          ]}
        />

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <Title level={3} style={{ margin: 0 }}>Filesystems</Title>
          <Space>
            <Tooltip title="Refresh">
              <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading} />
            </Tooltip>
            <Dropdown
              menu={{ items: getActionMenuItems() }}
              disabled={selectedRowKeys.length === 0}
            >
              <Button>
                Actions <DownOutlined />
              </Button>
            </Dropdown>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowCreateModal(true)}>
              Create Storage
            </Button>
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

        {/* Filters */}
        <Space style={{ marginBottom: 16 }}>
          <Input.Search
            placeholder="Search by name or ID"
            allowClear
            style={{ width: 250 }}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
          <Select
            placeholder="Any Type"
            allowClear
            style={{ width: 160 }}
            value={typeFilter}
            onChange={setTypeFilter}
            options={[
              { label: 'FSx for Windows', value: 'fsx-windows' },
              { label: 'FSx for ONTAP', value: 'fsx-ontap' },
              { label: 'Mountpoint for S3', value: 'mountpoint-s3' },
            ]}
          />
          <Select
            placeholder="Any Region"
            allowClear
            style={{ width: 140 }}
            value={regionFilter}
            onChange={setRegionFilter}
            options={regionOptions.map((r) => ({ label: r, value: r }))}
          />
          {(filterText || typeFilter || regionFilter) && (
            <Text type="secondary">{filteredResources.length} matches</Text>
          )}
        </Space>

        {/* Table */}
        <Card >
          <Table
            rowKey="storageId"
            columns={columns}
            dataSource={filteredResources}
            loading={loading}
            rowSelection={{
              selectedRowKeys,
              onChange: setSelectedRowKeys,
            }}
            onChange={handleTableChange}
            pagination={{
              pageSize,
              showSizeChanger: true,
              pageSizeOptions: ['10', '20', '50'],
              onShowSizeChange: handlePageSizeChange,
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
            }}
            locale={{
              emptyText: loading ? null : (
                <div style={{ padding: 40 }}>
                  <DatabaseOutlined style={{ fontSize: 48, color: '#ccc', marginBottom: 16 }} />
                  <div>No storage resources</div>
                  <Button type="primary" style={{ marginTop: 16 }} onClick={() => setShowCreateModal(true)}>
                    Create Storage
                  </Button>
                </div>
              ),
            }}
          />
        </Card>

        {/* Create Modal */}
        <Modal
          title="Create Storage Resource"
          open={showCreateModal}
          onCancel={() => {
            setShowCreateModal(false);
            setS3PolicyConfirmed(false);
          }}
          onOk={handleCreate}
          confirmLoading={creating}
          okText="Create"
          okButtonProps={{
            disabled: storageType === 'mountpoint-s3' && isCrossAccountS3 && !s3PolicyConfirmed,
          }}
          width={600}
        >
          <Form form={createForm} layout="vertical" initialValues={{ type: 'fsx-ontap', configuration: { teamSize: 'medium', storageCapacity: 2048, volumeSize: 1600, backupRetention: 30, haPairs: 2, ssdStorageCapacity: 256, throughputCapacity: 64, automaticBackupRetentionPeriod: 7 } }}>
            <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
              <Input ref={createNameInputRef} placeholder="Enter storage name" />
            </Form.Item>
            <Form.Item name="type" label="Type" rules={[{ required: true }]}>
              <Select
                options={[
                  { label: 'FSx for NetApp ONTAP', value: 'fsx-ontap' },
                  { label: 'FSx for Windows File System', value: 'fsx-windows' },
                  { label: 'Mountpoint for Amazon S3', value: 'mountpoint-s3' },
                ]}
              />
            </Form.Item>

            {regionalHubs.length > 0 && (
              <Form.Item name="region" label="Region">
                <Select
                  placeholder={`${primaryRegion || 'Primary Region'} (Primary)`}
                  allowClear
                  options={[
                    { label: `${primaryRegion || 'Primary Region'} (Primary)`, value: '' },
                    ...regionalHubs.map((h) => ({ label: h.region, value: h.region })),
                  ]}
                />
              </Form.Item>
            )}

            {/* FSx ONTAP fields */}
            {storageType === 'fsx-ontap' && (
              <>
                <Alert
                  type="info"
                  message="FSx for NetApp ONTAP provides multi-protocol storage (NFS + SMB) for mixed Windows, Mac, and Linux environments."
                  style={{ marginBottom: 16 }}
                />
                <Form.Item name={['configuration', 'teamSize']} label="Team Size">
                  <Select
                    options={[
                      { label: 'Small (1-5 users) - 3 GB/s', value: 'small' },
                      { label: 'Medium (5-15 users) - 6 GB/s', value: 'medium' },
                      { label: 'Large (15-30 users) - 18 GB/s', value: 'large' },
                      { label: 'Enterprise (30+ users) - 36 GB/s', value: 'enterprise' },
                      { label: 'Custom Configuration', value: 'custom' },
                    ]}
                  />
                </Form.Item>
                <Form.Item name={['configuration', 'storageCapacity']} label="SSD Storage Capacity (GiB)">
                  <InputNumber min={1024 * (haPairs || 1)} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item 
                  name={['configuration', 'volumeSize']} 
                  label="Initial Volume Size (GiB)"
                  tooltip={`Minimum ${getMinVolumeSize(haPairs || 1)} GiB for ${haPairs || 1} HA pair(s). FlexGroup volumes require 100 GiB per constituent × 8 constituents × HA pairs.`}
                >
                  <InputNumber min={getMinVolumeSize(haPairs || 1)} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item name={['configuration', 'backupRetention']} label="Backup Retention (days)">
                  <InputNumber min={0} max={90} style={{ width: '100%' }} />
                </Form.Item>
                {teamSize === 'custom' && (
                  <Collapse ghost items={[{
                    key: 'advanced',
                    label: 'Advanced Options',
                    children: (
                      <>
                        <Form.Item name={['configuration', 'haPairs']} label="HA Pairs">
                          <InputNumber min={1} max={12} style={{ width: '100%' }} />
                        </Form.Item>
                        <Form.Item name={['configuration', 'throughputCapacityPerHaPair']} label="Throughput per HA Pair (MBps)">
                          <Select options={[
                            { label: '1536 MBps', value: 1536 },
                            { label: '3072 MBps', value: 3072 },
                            { label: '6144 MBps', value: 6144 },
                          ]} />
                        </Form.Item>
                      </>
                    ),
                  }]} />
                )}
              </>
            )}

            {/* FSx Windows fields */}
            {storageType === 'fsx-windows' && (
              <>
                <Form.Item name={['configuration', 'ssdStorageCapacity']} label="SSD Storage Capacity (GiB)">
                  <InputNumber min={32} max={65536} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item name={['configuration', 'throughputCapacity']} label="Throughput Capacity (MB/s)">
                  <Select options={[
                    { label: '32 MB/s', value: 32 },
                    { label: '64 MB/s', value: 64 },
                    { label: '128 MB/s', value: 128 },
                    { label: '256 MB/s', value: 256 },
                    { label: '512 MB/s', value: 512 },
                    { label: '1024 MB/s', value: 1024 },
                    { label: '2048 MB/s', value: 2048 },
                  ]} />
                </Form.Item>
                <Form.Item name={['configuration', 'automaticBackupRetentionPeriod']} label="Backup Retention (days)">
                  <InputNumber min={0} max={90} style={{ width: '100%' }} />
                </Form.Item>
              </>
            )}

            {/* Mountpoint S3 fields */}
            {storageType === 'mountpoint-s3' && (
              <>
                <Alert
                  type="info"
                  message="Mountpoint for Amazon S3 allows you to mount an S3 bucket as a local file system on Linux workstations."
                  style={{ marginBottom: 16 }}
                />
                <Form.Item name={['configuration', 'isCrossAccount']} label="Bucket Location" initialValue={false}>
                  <Radio.Group>
                    <Radio.Button value={false}>Same Account</Radio.Button>
                    <Radio.Button value={true}>External Account</Radio.Button>
                  </Radio.Group>
                </Form.Item>

                {!isCrossAccountS3 ? (
                  <Form.Item name={['configuration', 'bucketName']} label="S3 Bucket" rules={[{ required: true }]}>
                    <Select
                      placeholder={s3BucketsLoading ? "Loading buckets..." : "Select S3 bucket"}
                      showSearch
                      loading={s3BucketsLoading}
                      notFoundContent={s3BucketsLoading ? "Loading..." : "No buckets found"}
                      filterOption={(input, option) =>
                        (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                      }
                      options={s3Buckets.map((b) => ({
                        label: b.name,
                        value: b.name,
                      }))}
                    />
                  </Form.Item>
                ) : (
                  <>
                    <Form.Item
                      name={['configuration', 'bucketName']}
                      label="Bucket Name"
                      rules={[
                        { required: true, message: 'Bucket name is required' },
                        { pattern: /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, message: 'Invalid bucket name format' },
                      ]}
                      tooltip="Enter the name of the S3 bucket in the external account"
                    >
                      <Input placeholder="my-external-bucket" />
                    </Form.Item>
                    <Alert
                      type="warning"
                      showIcon
                      message="Bucket Policy Required"
                      description="The external bucket owner must add a bucket policy to allow workstation access. Copy the policy below and add it to the bucket."
                      style={{ marginBottom: 16 }}
                    />
                    <Form.Item noStyle shouldUpdate={(prev, curr) => 
                      prev?.configuration?.bucketName !== curr?.configuration?.bucketName
                    }>
                      {({ getFieldValue }) => {
                        const bucketName = getFieldValue(['configuration', 'bucketName']) || 'YOUR-BUCKET-NAME';
                        const roleArn = storageConfig?.workstationRoleArn || 'arn:aws:iam::ACCOUNT_ID:role/MRM-Workstation-Role';
                        const policy = {
                          Version: '2012-10-17',
                          Statement: [
                            {
                              Sid: 'WorkstationBucketAccess',
                              Effect: 'Allow',
                              Principal: { AWS: roleArn },
                              Action: ['s3:GetBucketLocation', 's3:ListBucket'],
                              Resource: `arn:aws:s3:::${bucketName}`,
                            },
                            {
                              Sid: 'WorkstationObjectAccess',
                              Effect: 'Allow',
                              Principal: { AWS: roleArn },
                              Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
                              Resource: `arn:aws:s3:::${bucketName}/*`,
                            },
                          ],
                        };
                        return (
                          <div style={{ marginBottom: 16 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                              <Text strong>Required Bucket Policy</Text>
                              <Button
                                size="small"
                                onClick={() => {
                                  navigator.clipboard.writeText(JSON.stringify(policy, null, 2));
                                  setAlert({ type: 'success', message: 'Policy copied to clipboard' });
                                }}
                              >
                                Copy
                              </Button>
                            </div>
                            <TextArea
                              value={JSON.stringify(policy, null, 2)}
                              readOnly
                              autoSize={{ minRows: 8, maxRows: 12 }}
                              style={{ fontFamily: 'monospace', fontSize: 12 }}
                            />
                            <Checkbox
                              checked={s3PolicyConfirmed}
                              onChange={(e) => setS3PolicyConfirmed(e.target.checked)}
                              style={{ marginTop: 16 }}
                            >
                              I have added this policy to the external bucket
                            </Checkbox>
                          </div>
                        );
                      }}
                    </Form.Item>
                  </>
                )}

                <Form.Item name={['configuration', 'prefix']} label="Prefix (Optional)">
                  <Input placeholder="project-xyz/camera-originals/" />
                </Form.Item>
                <Form.Item name={['configuration', 'mountPath']} label="Mount Path">
                  <Input placeholder="/mnt/s3" />
                </Form.Item>
                <Form.Item name={['configuration', 'accessMode']} label="Access Mode">
                  <Select options={[
                    { label: 'Read-Only', value: 'read-only' },
                    { label: 'Read-Write', value: 'read-write' },
                  ]} />
                </Form.Item>
              </>
            )}

            <Form.Item name="description" label="Description">
              <TextArea rows={2} placeholder="Optional description" />
            </Form.Item>
          </Form>
        </Modal>

        {/* Edit Modal */}
        <Modal
          title="Edit Storage Resource"
          open={showEditModal}
          onCancel={() => { setShowEditModal(false); setEditingResource(null); }}
          onOk={handleUpdate}
          okText="Update"
        >
          <Form form={editForm} layout="vertical">
            <Form.Item label="Storage ID">
              <Input value={editingResource?.storageId} disabled />
            </Form.Item>
            <Form.Item name="name" label="Name" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="description" label="Description">
              <TextArea rows={2} />
            </Form.Item>
          </Form>
        </Modal>

        {/* Delete Modal */}
        <Modal
          title="Delete Storage Resources"
          open={showDeleteModal}
          onCancel={() => setShowDeleteModal(false)}
          onOk={handleDelete}
          confirmLoading={deleting}
          okText="Delete"
          okButtonProps={{ danger: true }}
        >
          <Alert
            type="warning"
            message="This will delete the storage resources and their associated AWS resources. This action cannot be undone."
            style={{ marginBottom: 16 }}
          />
          <p>Are you sure you want to delete {selectedResources.length} storage resource(s)?</p>
          <ul>
            {selectedResources.map((r) => (
              <li key={r.storageId}>{r.name} ({r.storageId})</li>
            ))}
          </ul>
        </Modal>
      </div>
    </AppLayoutAntd>
  );
};

export default FilesystemsAntd;
