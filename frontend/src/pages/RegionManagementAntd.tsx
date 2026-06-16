// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
  Checkbox,
  Tabs,
  Descriptions,
  Tooltip,
  Breadcrumb,
  Spin,
} from 'antd';
import { PlusOutlined, DeleteOutlined, ReloadOutlined, HomeOutlined, AppleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';

const { Title, Text, Link } = Typography;

interface AvailabilityZone {
  zoneId: string;
  zoneName: string;
  state: string;
  zoneType: string;
  supportsMac: boolean;
}

interface RegionalHub {
  region: string;
  displayName: string;
  status: string;
  vpcCidr?: string;
  availabilityZones?: string[];
  vpcId?: string;
  nlbDnsName?: string;
  workstationSecurityGroupId?: string;
  launchTemplateId?: string;
  dcvSessionManagerEndpoint?: string;
  dcvDomainName?: string;
  enableWindows?: boolean;
  enableLinux?: boolean;
  enableMacOS?: boolean;
  workstationCount?: number;
  amis?: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
  errorMessage?: string;
  isPrimary?: boolean;
}

interface RegionManagementAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const AWS_REGIONS = [
  { value: 'us-east-1', label: 'us-east-1 - US East (N. Virginia)' },
  { value: 'us-east-2', label: 'us-east-2 - US East (Ohio)' },
  { value: 'us-west-1', label: 'us-west-1 - US West (N. California)' },
  { value: 'us-west-2', label: 'us-west-2 - US West (Oregon)' },
  { value: 'eu-west-1', label: 'eu-west-1 - Europe (Ireland)' },
  { value: 'eu-west-2', label: 'eu-west-2 - Europe (London)' },
  { value: 'eu-west-3', label: 'eu-west-3 - Europe (Paris)' },
  { value: 'eu-central-1', label: 'eu-central-1 - Europe (Frankfurt)' },
  { value: 'eu-north-1', label: 'eu-north-1 - Europe (Stockholm)' },
  { value: 'ap-northeast-1', label: 'ap-northeast-1 - Asia Pacific (Tokyo)' },
  { value: 'ap-northeast-2', label: 'ap-northeast-2 - Asia Pacific (Seoul)' },
  { value: 'ap-southeast-1', label: 'ap-southeast-1 - Asia Pacific (Singapore)' },
  { value: 'ap-southeast-2', label: 'ap-southeast-2 - Asia Pacific (Sydney)' },
  { value: 'ap-south-1', label: 'ap-south-1 - Asia Pacific (Mumbai)' },
  { value: 'sa-east-1', label: 'sa-east-1 - South America (São Paulo)' },
  { value: 'ca-central-1', label: 'ca-central-1 - Canada (Central)' },
];

const getRegionDisplayName = (regionCode: string): string => {
  const region = AWS_REGIONS.find(r => r.value === regionCode);
  if (region) {
    const parts = region.label.split(' - ');
    return parts.length > 1 ? parts[1] : region.label;
  }
  return regionCode;
};

// Subnet IP calculation utilities
interface SubnetCalculation {
  vpcTotalIps: number;
  vpcUsableIps: number;
  publicSubnetIps: number;
  privateSubnetIps: number;
  publicUsableIpsPerAz: number;
  privateUsableIpsPerAz: number;
  totalPublicUsableIps: number;
  totalPrivateUsableIps: number;
  isValid: boolean;
  error?: string;
  warning?: string;
}

const calculateSubnetIps = (
  vpcCidr: string,
  publicSubnetMask: number,
  privateSubnetMask: number,
  numAzs: number
): SubnetCalculation => {
  const result: SubnetCalculation = {
    vpcTotalIps: 0,
    vpcUsableIps: 0,
    publicSubnetIps: 0,
    privateSubnetIps: 0,
    publicUsableIpsPerAz: 0,
    privateUsableIpsPerAz: 0,
    totalPublicUsableIps: 0,
    totalPrivateUsableIps: 0,
    isValid: false,
  };

  // Parse VPC CIDR
  const cidrMatch = vpcCidr?.match(/^(\d{1,3}\.){3}\d{1,3}\/(\d{1,2})$/);
  if (!cidrMatch) {
    result.error = 'Invalid CIDR format';
    return result;
  }

  const vpcMask = parseInt(vpcCidr.split('/')[1], 10);
  
  if (vpcMask < 16 || vpcMask > 28) {
    result.error = 'VPC CIDR must be between /16 and /28';
    return result;
  }

  if (publicSubnetMask < vpcMask || publicSubnetMask > 28) {
    result.error = `Public subnet mask must be between /${vpcMask} and /28`;
    return result;
  }

  if (privateSubnetMask < vpcMask || privateSubnetMask > 28) {
    result.error = `Private subnet mask must be between /${vpcMask} and /28`;
    return result;
  }

  if (numAzs < 2) {
    result.error = 'At least 2 availability zones are required';
    return result;
  }

  // Calculate IPs
  result.vpcTotalIps = Math.pow(2, 32 - vpcMask);
  result.vpcUsableIps = result.vpcTotalIps - 5; // AWS reserves 5 IPs per VPC

  result.publicSubnetIps = Math.pow(2, 32 - publicSubnetMask);
  result.privateSubnetIps = Math.pow(2, 32 - privateSubnetMask);

  // AWS reserves 5 IPs per subnet (network, router, DNS, future, broadcast)
  result.publicUsableIpsPerAz = Math.max(0, result.publicSubnetIps - 5);
  result.privateUsableIpsPerAz = Math.max(0, result.privateSubnetIps - 5);

  result.totalPublicUsableIps = result.publicUsableIpsPerAz * numAzs;
  result.totalPrivateUsableIps = result.privateUsableIpsPerAz * numAzs;

  // Check if subnets fit in VPC
  const totalSubnetIps = (result.publicSubnetIps + result.privateSubnetIps) * numAzs;
  if (totalSubnetIps > result.vpcTotalIps) {
    result.error = `Subnets (${totalSubnetIps} IPs) exceed VPC capacity (${result.vpcTotalIps} IPs)`;
    return result;
  }

  // Warnings for small subnets
  if (result.privateUsableIpsPerAz < 50) {
    result.warning = `Private subnets have only ${result.privateUsableIpsPerAz} usable IPs per AZ. Consider using a smaller subnet mask for more workstation capacity.`;
  }

  result.isValid = true;
  return result;
};

// Get recommended subnet masks based on VPC CIDR and number of AZs
const getRecommendedSubnetMasks = (vpcCidr: string, numAzs: number): { public: number; private: number } | null => {
  const cidrMatch = vpcCidr?.match(/^(\d{1,3}\.){3}\d{1,3}\/(\d{1,2})$/);
  if (!cidrMatch) return null;

  const vpcMask = parseInt(vpcCidr.split('/')[1], 10);
  
  // Recommendations based on common VPC sizes
  // Goal: Public subnets small (for NAT/bastion), Private subnets large (for workstations)
  const recommendations: Record<number, Record<number, { public: number; private: number }>> = {
    // /22 VPC (1024 IPs)
    22: {
      2: { public: 28, private: 24 }, // 2 AZs: 16 public + 256 private per AZ
      3: { public: 28, private: 24 }, // 3 AZs: 16 public + 256 private per AZ (768 total)
      4: { public: 28, private: 25 }, // 4 AZs: 16 public + 128 private per AZ
    },
    // /21 VPC (2048 IPs)
    21: {
      2: { public: 27, private: 23 }, // 2 AZs: 32 public + 512 private per AZ
      3: { public: 28, private: 24 }, // 3 AZs: 16 public + 256 private per AZ
      4: { public: 28, private: 24 }, // 4 AZs: 16 public + 256 private per AZ
    },
    // /20 VPC (4096 IPs)
    20: {
      2: { public: 27, private: 22 }, // 2 AZs: 32 public + 1024 private per AZ
      3: { public: 27, private: 23 }, // 3 AZs: 32 public + 512 private per AZ
      4: { public: 28, private: 23 }, // 4 AZs: 16 public + 512 private per AZ
    },
    // /19 VPC (8192 IPs)
    19: {
      2: { public: 26, private: 21 }, // 2 AZs: 64 public + 2048 private per AZ
      3: { public: 27, private: 22 }, // 3 AZs: 32 public + 1024 private per AZ
      4: { public: 27, private: 22 }, // 4 AZs: 32 public + 1024 private per AZ
    },
  };

  const vpcRecs = recommendations[vpcMask];
  if (vpcRecs && vpcRecs[numAzs]) {
    return vpcRecs[numAzs];
  }

  // Default fallback: calculate reasonable defaults
  // Public: small (/28 = 16 IPs)
  // Private: as large as possible while fitting all subnets
  const publicMask = Math.max(vpcMask + 2, 28);
  const privateMask = Math.max(vpcMask + 1, Math.min(vpcMask + 3, 24));
  
  return { public: publicMask, private: privateMask };
};

const RegionManagementAntd: React.FC<RegionManagementAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const [regions, setRegions] = useState<RegionalHub[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<RegionalHub | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Availability zones state
  const [availabilityZones, setAvailabilityZones] = useState<AvailabilityZone[]>([]);
  const [loadingAzs, setLoadingAzs] = useState(false);
  const [selectedAzs, setSelectedAzs] = useState<string[]>([]);
  const [enableMacOS, setEnableMacOS] = useState(false);
  const [azPickerTouched, setAzPickerTouched] = useState(false);

  // Table preferences with localStorage persistence
  const [sortedInfo, setSortedInfo] = useState<{ columnKey: string; order: 'ascend' | 'descend' } | null>(() => {
    try {
      const saved = localStorage.getItem('regions-table-sort');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { columnKey: 'region', order: 'ascend' };
  });

  const [pageSize, setPageSize] = useState(() => {
    try {
      const saved = localStorage.getItem('regions-table-pageSize');
      if (saved) return parseInt(saved, 10);
    } catch (e) {}
    return 10;
  });

  const [form] = Form.useForm();
  
  // Watch form values for subnet calculation
  const vpcCidr = Form.useWatch('vpcCidr', form);
  const publicSubnetMask = Form.useWatch('publicSubnetMask', form);
  const privateSubnetMask = Form.useWatch('privateSubnetMask', form);

  // Calculate subnet IPs based on current form values
  const subnetCalculation = useMemo(() => {
    return calculateSubnetIps(
      vpcCidr || '10.100.0.0/22',
      parseInt(publicSubnetMask, 10) || 28,
      parseInt(privateSubnetMask, 10) || 24,
      selectedAzs.length || 2
    );
  }, [vpcCidr, publicSubnetMask, privateSubnetMask, selectedAzs.length]);

  // Get recommended masks when VPC CIDR or AZ count changes
  const recommendedMasks = useMemo(() => {
    return getRecommendedSubnetMasks(vpcCidr || '10.100.0.0/22', selectedAzs.length || 3);
  }, [vpcCidr, selectedAzs.length]);

  useEffect(() => {
    fetchRegions();
  }, []);

  const fetchRegions = async () => {
    try {
      setLoading(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('regions', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const regionsData = data.success ? data.data : (Array.isArray(data) ? data : []);
      setRegions(regionsData);
    } catch (error) {
      console.error('Error fetching regions:', error);
      setAlert({ type: 'error', message: `Failed to fetch regions: ${(error as Error).message}` });
      setRegions([]);
    } finally {
      setLoading(false);
    }
  };

  // Fetch availability zones for a selected region
  const fetchAvailabilityZones = useCallback(async (region: string, checkMacSupport: boolean = false) => {
    if (!region) {
      setAvailabilityZones([]);
      return;
    }

    try {
      setLoadingAzs(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      // If macOS is enabled, include the filter to check Mac instance support
      const queryParams = checkMacSupport ? '?instanceTypeFilter=mac2' : '';
      const response = await apiCall(`regions/${region}/availability-zones${queryParams}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setAvailabilityZones(data.availabilityZones || []);
    } catch (error) {
      console.error('Error fetching availability zones:', error);
      setAvailabilityZones([]);
    } finally {
      setLoadingAzs(false);
    }
  }, []);

  const handleCreateRegion = async () => {
    try {
      const values = await form.validateFields();
      
      // Validate that at least 2 AZs are selected
      if (!selectedAzs || selectedAzs.length < 2) {
        setAlert({ type: 'error', message: 'Please select at least 2 availability zones' });
        return;
      }

      setCreating(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const payload = {
        region: values.region,
        displayName: values.displayName || getRegionDisplayName(values.region),
        vpcCidr: values.vpcCidr,
        availabilityZones: selectedAzs,
        publicSubnetMask: values.publicSubnetMask || 28,
        privateSubnetMask: values.privateSubnetMask || 24,
        dcvDomainName: values.dcvDomainName,
        enableWindows: values.enableWindows ?? true,
        enableLinux: values.enableLinux ?? true,
        enableMacOS: values.enableMacOS ?? false
      };

      const response = await apiCall('regions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      setAlert({
        type: 'info',
        message: `Regional hub creation started for ${payload.displayName}. This process typically takes 15-30 minutes.`
      });
      setShowCreateModal(false);
      form.resetFields();
      setSelectedAzs([]);
      setAvailabilityZones([]);
      setEnableMacOS(false);
      setAzPickerTouched(false);
      fetchRegions();
    } catch (error) {
      console.error('Error creating regional hub:', error);
      setAlert({ type: 'error', message: `Failed to create regional hub: ${(error as Error).message}` });
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteRegion = async () => {
    if (selectedRowKeys.length === 0) return;

    setDeleting(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const selectedRegions = regions.filter(r => selectedRowKeys.includes(r.region));
      
      for (const region of selectedRegions) {
        if (region.isPrimary) continue;

        const response = await apiCall(`regions/${region.region}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Failed to delete ${region.region}`);
        }
      }

      const deletedCount = selectedRegions.filter(r => !r.isPrimary).length;
      setAlert({
        type: 'info',
        message: `Deletion started for ${deletedCount} regional hub(s). This process may take several minutes.`
      });
      setSelectedRowKeys([]);
      setShowDeleteModal(false);
      fetchRegions();
    } catch (error) {
      console.error('Error deleting regional hub:', error);
      setAlert({ type: 'error', message: `Failed to delete regional hub: ${(error as Error).message}` });
    } finally {
      setDeleting(false);
    }
  };

  const getStatusTag = (status: string, isPrimary?: boolean) => {
    if (isPrimary) return <Tag color="blue">Primary</Tag>;
    switch (status) {
      case 'available': return <Tag color="green">Available</Tag>;
      case 'creating':
      case 'validating': return <Tag color="processing">Creating</Tag>;
      case 'deleting': return <Tag color="default">Deleting</Tag>;
      case 'failed':
      case 'delete-failed': return <Tag color="red">Failed</Tag>;
      case 'initializing': return <Tag color="processing">Initializing</Tag>;
      default: return <Tag>{status}</Tag>;
    }
  };

  const getAvailableRegions = () => {
    const existingRegions = regions.map(r => r.region);
    return AWS_REGIONS.filter(r => !existingRegions.includes(r.value));
  };

  const selectedRegions = useMemo(() => {
    return regions.filter(r => selectedRowKeys.includes(r.region));
  }, [regions, selectedRowKeys]);

  const canDelete = selectedRowKeys.length > 0 && !selectedRegions.every(r => r.isPrimary);

  const handleTableChange = (pagination: any, filters: any, sorter: any) => {
    const newSort = sorter.order 
      ? { columnKey: sorter.columnKey || sorter.field, order: sorter.order }
      : null;
    setSortedInfo(newSort);
    try {
      if (newSort) {
        localStorage.setItem('regions-table-sort', JSON.stringify(newSort));
      } else {
        localStorage.removeItem('regions-table-sort');
      }
    } catch (e) {}
  };

  const handlePageSizeChange = (current: number, size: number) => {
    setPageSize(size);
    try {
      localStorage.setItem('regions-table-pageSize', String(size));
    } catch (e) {}
  };

  const columns: ColumnsType<RegionalHub> = [
    {
      title: 'Region',
      dataIndex: 'region',
      key: 'region',
      sorter: (a, b) => a.region.localeCompare(b.region),
      sortOrder: sortedInfo?.columnKey === 'region' ? sortedInfo.order : null,
      render: (text, record) => (
        <Link onClick={() => { setSelectedRegion(record); setShowDetailsModal(true); }}>
          {text}
        </Link>
      ),
    },
    {
      title: 'Display Name',
      dataIndex: 'displayName',
      key: 'displayName',
      sorter: (a, b) => (a.displayName || '').localeCompare(b.displayName || ''),
      sortOrder: sortedInfo?.columnKey === 'displayName' ? sortedInfo.order : null,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      sorter: (a, b) => a.status.localeCompare(b.status),
      sortOrder: sortedInfo?.columnKey === 'status' ? sortedInfo.order : null,
      render: (status, record) => getStatusTag(status, record.isPrimary),
    },
    {
      title: 'Workstations',
      dataIndex: 'workstationCount',
      key: 'workstationCount',
      sorter: (a, b) => (a.workstationCount || 0) - (b.workstationCount || 0),
      sortOrder: sortedInfo?.columnKey === 'workstationCount' ? sortedInfo.order : null,
      render: (count) => count ?? 0,
    },
    {
      title: 'VPC CIDR',
      dataIndex: 'vpcCidr',
      key: 'vpcCidr',
      render: (cidr) => cidr || '-',
    },
    {
      title: 'Platforms',
      key: 'platforms',
      render: (_, record) => (
        <Space size={4}>
          {record.enableWindows && <Tag color="blue">Windows</Tag>}
          {record.enableLinux && <Tag color="green">Linux</Tag>}
          {record.enableMacOS && <Tag>macOS</Tag>}
        </Space>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      sorter: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
      sortOrder: sortedInfo?.columnKey === 'createdAt' ? sortedInfo.order : null,
      render: (date) => {
        if (!date || date === '0' || date === 0) return '-';
        const parsed = new Date(date);
        // Check for invalid date or epoch (1970)
        if (isNaN(parsed.getTime()) || parsed.getFullYear() < 2000) return '-';
        return parsed.toLocaleDateString();
      },
    },
  ];

  const detailsTabItems = selectedRegion ? [
    {
      key: 'overview',
      label: 'Overview',
      children: (
        <Descriptions column={2} bordered size="small">
          <Descriptions.Item label="Region">{selectedRegion.region}</Descriptions.Item>
          <Descriptions.Item label="Display Name">{selectedRegion.displayName}</Descriptions.Item>
          <Descriptions.Item label="Status">{getStatusTag(selectedRegion.status, selectedRegion.isPrimary)}</Descriptions.Item>
          <Descriptions.Item label="Workstations">{selectedRegion.workstationCount ?? 0}</Descriptions.Item>
          <Descriptions.Item label="VPC CIDR">{selectedRegion.vpcCidr || '-'}</Descriptions.Item>
          <Descriptions.Item label="VPC ID">{selectedRegion.vpcId || '-'}</Descriptions.Item>
          <Descriptions.Item label="Created">{selectedRegion.createdAt ? new Date(selectedRegion.createdAt).toLocaleString() : '-'}</Descriptions.Item>
          <Descriptions.Item label="Last Updated">{selectedRegion.updatedAt ? new Date(selectedRegion.updatedAt).toLocaleString() : '-'}</Descriptions.Item>
        </Descriptions>
      ),
    },
    {
      key: 'infrastructure',
      label: 'Infrastructure',
      children: (
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="NLB DNS Name">{selectedRegion.nlbDnsName || '-'}</Descriptions.Item>
          <Descriptions.Item label="Security Group ID">{selectedRegion.workstationSecurityGroupId || '-'}</Descriptions.Item>
          <Descriptions.Item label="Launch Template ID">{selectedRegion.launchTemplateId || '-'}</Descriptions.Item>
          <Descriptions.Item label="DCV Session Manager Endpoint">{selectedRegion.dcvSessionManagerEndpoint || '-'}</Descriptions.Item>
          <Descriptions.Item label="DCV Domain Name">{selectedRegion.dcvDomainName || '-'}</Descriptions.Item>
          <Descriptions.Item label="Availability Zones">{selectedRegion.availabilityZones?.join(', ') || '-'}</Descriptions.Item>
        </Descriptions>
      ),
    },
    {
      key: 'amis',
      label: 'AMIs',
      children: selectedRegion.amis && Object.keys(selectedRegion.amis).length > 0 ? (
        <Table
          size="small"
          pagination={false}
          columns={[
            { title: 'Source AMI', dataIndex: 'sourceAmi', key: 'sourceAmi' },
            { title: 'Regional AMI', dataIndex: 'targetAmiId', key: 'targetAmiId' },
            { title: 'Type', dataIndex: 'amiType', key: 'amiType' },
            {
              title: 'Status',
              dataIndex: 'status',
              key: 'status',
              render: (status: string) => (
                <Tag color={status === 'available' ? 'green' : status === 'pending' ? 'processing' : 'red'}>
                  {status}
                </Tag>
              ),
            },
          ]}
          dataSource={Object.entries(selectedRegion.amis).map(([sourceAmi, data]: [string, any]) => ({
            key: sourceAmi,
            sourceAmi,
            ...data
          }))}
        />
      ) : (
        <Text type="secondary">No AMIs replicated to this region yet.</Text>
      ),
    },
  ] : [];

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
            { title: 'Regions' },
          ]}
        />

        {/* Header with title and actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <Title level={3} style={{ margin: 0 }}>Regional Hubs</Title>
          <Space>
            <Tooltip title="Refresh">
              <Button icon={<ReloadOutlined />} onClick={fetchRegions} loading={loading} />
            </Tooltip>
            <Button
              icon={<DeleteOutlined />}
              onClick={() => setShowDeleteModal(true)}
              disabled={!canDelete}
            >
              Delete
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setShowCreateModal(true)}
              disabled={getAvailableRegions().length === 0}
            >
              Add Region
            </Button>
          </Space>
        </div>

        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {alert && (
            <Alert
              type={alert.type}
              message={alert.message}
              closable
              onClose={() => setAlert(null)}
            />
          )}

          <Card >
            <Table
              rowSelection={{
                selectedRowKeys,
                onChange: setSelectedRowKeys,
                getCheckboxProps: (record) => ({
                  disabled: record.isPrimary,
                }),
              }}
              columns={columns}
              dataSource={regions}
              rowKey="region"
              loading={loading}
              onChange={handleTableChange}
              pagination={{
                pageSize,
                showSizeChanger: true,
                pageSizeOptions: ['10', '20', '50'],
                onShowSizeChange: handlePageSizeChange,
                showTotal: (total) => `${total} regions`,
              }}
              locale={{
                emptyText: loading ? null : (
                  <Space direction="vertical" align="center" style={{ padding: 24 }}>
                    <Text strong>No satellite regions</Text>
                    <Text type="secondary">Only the primary region is configured. Add satellite regions to expand capacity.</Text>
                    <Button type="primary" onClick={() => setShowCreateModal(true)}>Add Region</Button>
                  </Space>
                ),
              }}
            />
          </Card>
        </Space>
      </div>

      {/* Create Region Modal */}
      <Modal
        title="Add Regional Hub"
        open={showCreateModal}
        onCancel={() => { 
          setShowCreateModal(false); 
          form.resetFields(); 
          setSelectedAzs([]);
          setAvailabilityZones([]);
          setEnableMacOS(false);
          setAzPickerTouched(false);
        }}
        onOk={handleCreateRegion}
        confirmLoading={creating}
        width={700}
        okText="Create Regional Hub"
      >
        <Alert
          type="info"
          message="Creating a regional hub will deploy VPC infrastructure, DCV gateway, and networking components in the selected region. This process typically takes 15-30 minutes."
          style={{ marginBottom: 24 }}
        />

        <Form form={form} layout="vertical" initialValues={{ vpcCidr: '10.100.0.0/22', publicSubnetMask: 28, privateSubnetMask: 24, enableWindows: true, enableLinux: true, enableMacOS: false }}>
          <Space style={{ width: '100%' }} size="large">
            <Form.Item name="region" label="Region" rules={[{ required: true, message: 'Please select a region' }]} style={{ minWidth: 320 }}>
              <Select
                placeholder="Select a region"
                options={getAvailableRegions()}
                onChange={(value) => {
                  form.setFieldValue('displayName', getRegionDisplayName(value));
                  setSelectedAzs([]);
                  setAzPickerTouched(false);
                  fetchAvailabilityZones(value, enableMacOS);
                }}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item name="displayName" label="Display Name" style={{ minWidth: 220 }}>
              <Input placeholder="e.g., US West (Oregon)" />
            </Form.Item>
          </Space>

          <Card size="small" title="Enabled Platforms" style={{ marginBottom: 16 }}>
            <Space size="large">
              <Form.Item name="enableWindows" valuePropName="checked" noStyle>
                <Checkbox>Windows</Checkbox>
              </Form.Item>
              <Form.Item name="enableLinux" valuePropName="checked" noStyle>
                <Checkbox>Linux</Checkbox>
              </Form.Item>
              <Form.Item name="enableMacOS" valuePropName="checked" noStyle>
                <Checkbox 
                  onChange={(e) => {
                    setEnableMacOS(e.target.checked);
                    const region = form.getFieldValue('region');
                    if (region) {
                      fetchAvailabilityZones(region, e.target.checked);
                    }
                  }}
                >
                  macOS (Dedicated Hosts)
                </Checkbox>
              </Form.Item>
            </Space>
            {enableMacOS && (
              <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                macOS requires dedicated hosts and is only available in specific availability zones.
              </Text>
            )}
          </Card>

          <Form.Item name="vpcCidr" label="VPC CIDR" rules={[{ required: true }]} help="CIDR block for the regional VPC (must not overlap with other regions)">
            <Input placeholder="10.100.0.0/22" />
          </Form.Item>

          <Form.Item 
            label="Availability Zones" 
            required
            validateStatus={azPickerTouched && selectedAzs.length > 0 && selectedAzs.length < 2 ? 'error' : undefined}
            help={
              azPickerTouched && selectedAzs.length > 0 && selectedAzs.length < 2
                ? "At least 2 availability zones are required"
                : enableMacOS && availabilityZones.some(az => az.supportsMac) 
                  ? <span><AppleOutlined /> indicates AZs that support Mac instances</span>
                  : "Select at least 2 availability zones for the VPC"
            }
          >
            <Select
              mode="multiple"
              placeholder={loadingAzs ? "Loading availability zones..." : "Select availability zones"}
              value={selectedAzs}
              onChange={(values) => {
                setSelectedAzs(values);
                // Update recommended subnet masks when AZ count changes significantly
                const newRecommended = getRecommendedSubnetMasks(
                  form.getFieldValue('vpcCidr') || '10.100.0.0/22',
                  values.length || 3
                );
                if (newRecommended && values.length >= 2) {
                  // Only auto-update if user hasn't customized the values
                  const currentPublic = form.getFieldValue('publicSubnetMask');
                  const currentPrivate = form.getFieldValue('privateSubnetMask');
                  if (currentPublic === 28 && currentPrivate === 24) {
                    form.setFieldsValue({
                      publicSubnetMask: newRecommended.public,
                      privateSubnetMask: newRecommended.private,
                    });
                  }
                }
              }}
              onBlur={() => setAzPickerTouched(true)}
              loading={loadingAzs}
              disabled={!form.getFieldValue('region') || loadingAzs}
              style={{ width: '100%' }}
              notFoundContent={loadingAzs ? <Spin size="small" /> : "Select a region first"}
              optionLabelProp="label"
            >
              {availabilityZones.map(az => (
                <Select.Option 
                  key={az.zoneId} 
                  value={az.zoneId}
                  label={az.zoneId}
                >
                  <Space>
                    <span>{az.zoneId}</span>
                    <Text type="secondary">({az.zoneName})</Text>
                    {enableMacOS && az.supportsMac && (
                      <Tag color="default" style={{ marginLeft: 4 }}>
                        <AppleOutlined /> Mac
                      </Tag>
                    )}
                  </Space>
                </Select.Option>
              ))}
            </Select>
            {enableMacOS && selectedAzs.length > 0 && !selectedAzs.some(azId => 
              availabilityZones.find(az => az.zoneId === azId)?.supportsMac
            ) && (
              <Alert
                type="warning"
                message="None of the selected AZs support Mac instances. macOS workstations may fail to launch."
                style={{ marginTop: 8 }}
                showIcon
              />
            )}
          </Form.Item>

          <Space style={{ width: '100%' }} size="large">
            <Form.Item name="publicSubnetMask" label="Public Subnet Mask" style={{ flex: 1 }}>
              <Input type="number" min={16} max={28} />
            </Form.Item>
            <Form.Item name="privateSubnetMask" label="Private Subnet Mask" style={{ flex: 1 }}>
              <Input type="number" min={16} max={28} />
            </Form.Item>
          </Space>

          {/* Subnet IP Calculation Display - only show when at least 2 AZs selected */}
          {selectedAzs.length >= 2 && (
            <Card 
              size="small" 
              title={
                <Space>
                  <span>Subnet Capacity</span>
                  {recommendedMasks && (
                    <Button 
                      size="small" 
                      type="link"
                      onClick={() => {
                        form.setFieldsValue({
                          publicSubnetMask: recommendedMasks.public,
                          privateSubnetMask: recommendedMasks.private,
                        });
                      }}
                    >
                      Apply recommended (/{recommendedMasks.public}, /{recommendedMasks.private})
                    </Button>
                  )}
                </Space>
              }
              style={{ marginBottom: 16 }}
            >
              {subnetCalculation.error ? (
                <Alert type="error" message={subnetCalculation.error} showIcon />
              ) : (
                <>
                  <Descriptions size="small" column={2}>
                    <Descriptions.Item label="VPC Total IPs">
                      {subnetCalculation.vpcTotalIps.toLocaleString()}
                    </Descriptions.Item>
                    <Descriptions.Item label="Availability Zones">
                      {selectedAzs.length || 'Select AZs'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Public IPs per AZ">
                      <Tooltip title={`/${publicSubnetMask || 28} subnet = ${subnetCalculation.publicSubnetIps} total, minus 5 AWS reserved`}>
                        <span>{subnetCalculation.publicUsableIpsPerAz.toLocaleString()} usable</span>
                      </Tooltip>
                    </Descriptions.Item>
                    <Descriptions.Item label="Private IPs per AZ">
                      <Tooltip title={`/${privateSubnetMask || 24} subnet = ${subnetCalculation.privateSubnetIps} total, minus 5 AWS reserved`}>
                        <span style={{ fontWeight: 600 }}>{subnetCalculation.privateUsableIpsPerAz.toLocaleString()} usable</span>
                      </Tooltip>
                    </Descriptions.Item>
                    <Descriptions.Item label="Total Public IPs">
                      {subnetCalculation.totalPublicUsableIps.toLocaleString()}
                    </Descriptions.Item>
                    <Descriptions.Item label="Total Private IPs (Workstations)">
                      <Text strong type={subnetCalculation.totalPrivateUsableIps < 100 ? 'warning' : 'success'}>
                        {subnetCalculation.totalPrivateUsableIps.toLocaleString()}
                      </Text>
                    </Descriptions.Item>
                  </Descriptions>
                  {subnetCalculation.warning && (
                    <Alert 
                      type="warning" 
                      message={subnetCalculation.warning} 
                      showIcon 
                      style={{ marginTop: 8 }}
                    />
                  )}
                  <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                    Private subnet capacity determines maximum workstations per AZ. AWS reserves 5 IPs per subnet.
                  </Text>
                </>
              )}
            </Card>
          )}

          <Card size="small" title="DCV Configuration (Optional)" style={{ marginBottom: 16 }}>
            <Form.Item name="dcvDomainName" label="DCV Domain Name" help="Custom domain for DCV gateway. TLS certificate is automatically replicated from primary region.">
              <Input placeholder="dcv-usw2.example.com" />
            </Form.Item>
          </Card>
        </Form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        title="Delete Regional Hub"
        open={showDeleteModal}
        onCancel={() => setShowDeleteModal(false)}
        onOk={handleDeleteRegion}
        confirmLoading={deleting}
        okText="Delete"
        okButtonProps={{ danger: true }}
      >
        <Alert
          type="warning"
          message="This will delete all infrastructure in the selected region(s), including VPC, subnets, and DCV gateway. This action cannot be undone."
          style={{ marginBottom: 16 }}
        />
        <div>
          <Text strong>Selected regions to delete:</Text>
          <ul>
            {selectedRegions.filter(r => !r.isPrimary).map(r => (
              <li key={r.region}>{r.displayName} ({r.region})</li>
            ))}
          </ul>
          {selectedRegions.some(r => r.isPrimary) && (
            <Alert type="info" message="The primary region cannot be deleted and will be skipped." />
          )}
        </div>
      </Modal>

      {/* Region Details Modal */}
      <Modal
        title={selectedRegion ? `${selectedRegion.displayName} Details` : 'Region Details'}
        open={showDetailsModal}
        onCancel={() => { setShowDetailsModal(false); setSelectedRegion(null); }}
        footer={null}
        width={800}
      >
        {selectedRegion && <Tabs items={detailsTabItems} />}
      </Modal>
    </AppLayoutAntd>
  );
};

export default RegionManagementAntd;
