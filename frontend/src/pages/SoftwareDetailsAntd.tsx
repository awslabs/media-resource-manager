// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Card,
  Descriptions,
  Tag,
  Table,
  Alert,
  Spin,
  Typography,
  Breadcrumb,
  Button,
  Space,
} from 'antd';
import {
  HomeOutlined,
  ArrowLeftOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';

const { Title, Text } = Typography;

interface ParameterDefinition {
  name: string;
  description?: string;
  required?: boolean;
}

interface SoftwareItem {
  softwareId: string;
  name: string;
  versionNumber: string;
  componentVersion?: string;
  category: string;
  description: string;
  componentArn: string;
  estimatedInstallTime: string;
  diskSpaceRequired: string;
  gpuRequired: boolean;
  platform?: string;
  parameters?: ParameterDefinition[];
}

interface SoftwareDetailsAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const SoftwareDetailsAntd: React.FC<SoftwareDetailsAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const { softwareId } = useParams<{ softwareId: string }>();
  const navigate = useNavigate();
  const [software, setSoftware] = useState<SoftwareItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (softwareId) {
      fetchSoftwareDetails();
    }
  }, [softwareId]);

  const fetchSoftwareDetails = async () => {
    try {
      const token = getAuthToken();
      if (!token) {
        setError('Not authenticated');
        setLoading(false);
        return;
      }

      const response = await apiCall(`/images/software/${softwareId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        setSoftware(data);
      } else if (response.status === 404) {
        setError('Software not found');
      } else {
        setError('Failed to load software details');
      }
    } catch (err) {
      console.error('Error fetching software details:', err);
      setError('Failed to load software details');
    } finally {
      setLoading(false);
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

  if (error || !software) {
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
              { href: '/software', title: 'Software' },
              { title: 'Details' },
            ]}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <Title level={3} style={{ margin: 0 }}>Software Details</Title>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/software')}>
              Back
            </Button>
          </div>
          <Alert type="error" message={error || 'Software not found'} />
        </div>
      </AppLayoutAntd>
    );
  }

  const platformColor = software.platform === 'Linux' ? 'green' : software.platform === 'macOS' ? 'default' : 'blue';

  const parameterColumns: ColumnsType<ParameterDefinition> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      render: (desc) => desc || '—',
    },
    {
      title: 'Required',
      dataIndex: 'required',
      key: 'required',
      render: (required) =>
        required ? <Tag color="red">Required</Tag> : <Tag>Optional</Tag>,
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
        <Breadcrumb
          style={{ marginBottom: 16 }}
          items={[
            { href: '/dashboard', title: <><HomeOutlined /> Dashboard</> },
            { href: '/software', title: 'Software' },
            { title: software.name || softwareId || 'Details' },
          ]}
        />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>{software.name}</Title>
            <Space style={{ marginTop: 8 }}>
              <Text type="secondary">Version {software.versionNumber || 'Latest'}</Text>
              <Tag color={platformColor}>{software.platform || 'Windows'}</Tag>
            </Space>
          </div>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/software')}>
            Back to Software
          </Button>
        </div>

        <Space direction="vertical" size={24} style={{ width: '100%' }}>
          <Card title="Software Information">
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="Platform">
                <Tag color={platformColor}>{software.platform || 'Windows'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Category">
                <Tag>{software.category ? software.category.charAt(0).toUpperCase() + software.category.slice(1) : 'N/A'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Version">{software.versionNumber || 'Latest'}</Descriptions.Item>
              <Descriptions.Item label="Estimated Install Time">{software.estimatedInstallTime || 'N/A'}</Descriptions.Item>
              <Descriptions.Item label="Disk Space Required">{software.diskSpaceRequired || 'N/A'}</Descriptions.Item>
              <Descriptions.Item label="GPU Required">
                {software.gpuRequired ? <Tag color="red">Yes</Tag> : <Tag>No</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="Component ARN" span={3}>
                <Text copyable style={{ wordBreak: 'break-all' }}>{software.componentArn || 'N/A'}</Text>
              </Descriptions.Item>
            </Descriptions>
          </Card>

          {software.parameters && software.parameters.length > 0 && (
            <Card title={`Parameters (${software.parameters.length})`}>
              <Table
                columns={parameterColumns}
                dataSource={software.parameters}
                rowKey="name"
                pagination={false}
                size="small"
              />
            </Card>
          )}
        </Space>
      </div>
    </AppLayoutAntd>
  );
};

export default SoftwareDetailsAntd;
