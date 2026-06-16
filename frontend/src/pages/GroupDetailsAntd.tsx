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
} from 'antd';
import {
  HomeOutlined,
  ArrowLeftOutlined,
  ReloadOutlined,
  TeamOutlined,
  UserOutlined,
  DesktopOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';

const { Title, Text, Link } = Typography;

interface GroupDetailsAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

interface Group {
  groupId: string;
  groupName: string;
  description?: string;
  createdAt: string;
}

interface GroupUser {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  groups?: string[];
}

interface Workstation {
  instanceId: string;
  workstationName?: string;
  assignedUserId: string;
  assignedUserDisplay?: string;
  instanceType: string;
  status: string;
  instanceStatus?: string;
  platform?: string;
}

const GroupDetailsAntd: React.FC<GroupDetailsAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const [group, setGroup] = useState<Group | null>(null);
  const [users, setUsers] = useState<GroupUser[]>([]);
  const [workstations, setWorkstations] = useState<Workstation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchGroupDetails = async () => {
    setLoading(true);
    setError('');
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No authentication token');

      const groupResponse = await apiCall(`groups/${groupId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!groupResponse.ok) throw new Error('Failed to fetch group details');
      const groupData = await groupResponse.json();
      setGroup(groupData);

      const usersResponse = await apiCall('users', {
        headers: { Authorization: `Bearer ${token}` },
      });
      let groupUsers: GroupUser[] = [];
      if (usersResponse.ok) {
        const usersData = await usersResponse.json();
        groupUsers = usersData.filter((u: GroupUser) => {
          if (!u.groups || !Array.isArray(u.groups)) return false;
          return (
            u.groups.includes(groupData.groupName) ||
            u.groups.includes(groupData.groupId) ||
            u.groups.some((g: string) => g.toLowerCase() === groupData.groupName?.toLowerCase())
          );
        });
        setUsers(groupUsers);
      }

      const workstationsResponse = await apiCall('workstations', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (workstationsResponse.ok) {
        const workstationsData = await workstationsResponse.json();
        const groupUserIds = groupUsers.map((u) => u.userId);
        const groupWorkstations = workstationsData.filter(
          (ws: Workstation) =>
            ws.assignedUserId === groupData.groupId ||
            ws.assignedUserId === `group:${groupData.groupId}` ||
            groupUserIds.includes(ws.assignedUserId)
        );
        setWorkstations(groupWorkstations);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load group details');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (groupId) fetchGroupDetails();
  }, [groupId]);

  const getWorkstationStateTag = (status: string) => {
    switch (status) {
      case 'running': return <Tag color="green">Running</Tag>;
      case 'stopped': return <Tag color="default">Stopped</Tag>;
      case 'pending': return <Tag color="blue">Starting</Tag>;
      case 'stopping': return <Tag color="orange">Stopping</Tag>;
      case 'terminated': return <Tag color="red">Terminated</Tag>;
      default: return <Tag>{status}</Tag>;
    }
  };

  const userColumns: ColumnsType<GroupUser> = [
    {
      title: 'Name',
      key: 'name',
      sorter: (a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`),
      render: (_, record) => (
        <Link onClick={() => (window.location.href = `/users/${encodeURIComponent(record.userId)}`)}>
          {record.firstName} {record.lastName}
        </Link>
      ),
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      sorter: (a, b) => (a.email || '').localeCompare(b.email || ''),
    },
  ];

  const workstationColumns: ColumnsType<Workstation> = [
    {
      title: 'Name',
      key: 'name',
      render: (_, record) => (
        <Link onClick={() => (window.location.href = `/workstations/${record.instanceId}`)}>
          {record.workstationName || record.instanceId}
        </Link>
      ),
    },
    {
      title: 'Assigned To',
      key: 'assignedTo',
      render: (_, record) => record.assignedUserDisplay || record.assignedUserId || 'Unassigned',
    },
    {
      title: 'Instance Type',
      dataIndex: 'instanceType',
      key: 'instanceType',
    },
    {
      title: 'Platform',
      dataIndex: 'platform',
      key: 'platform',
      render: (platform) => {
        const color = platform === 'Windows' ? 'blue' : platform === 'Linux' ? 'green' : 'default';
        return <Tag color={color}>{platform || 'Unknown'}</Tag>;
      },
    },
    {
      title: 'Status',
      key: 'status',
      render: (_, record) => getWorkstationStateTag(record.instanceStatus || record.status || 'Unknown'),
    },
  ];

  if (loading) {
    return (
      <AppLayoutAntd isAdmin={isAdmin} user={user} config={config} onSignOut={onSignOut} onChangePassword={onChangePassword}>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
          <Spin size="large" />
        </div>
      </AppLayoutAntd>
    );
  }

  if (error || !group) {
    return (
      <AppLayoutAntd isAdmin={isAdmin} user={user} config={config} onSignOut={onSignOut} onChangePassword={onChangePassword}>
        <div style={{ width: '100%' }}>
          <Breadcrumb
            style={{ marginBottom: 16 }}
            items={[
              { href: '/dashboard', title: <><HomeOutlined /> Dashboard</> },
              { href: '/users', title: 'Users / Groups' },
              { title: 'Group Details' },
            ]}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <Title level={3} style={{ margin: 0 }}>Group Details</Title>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/users')}>Back</Button>
          </div>
          <Alert type="error" message={error || 'Group not found'} />
        </div>
      </AppLayoutAntd>
    );
  }

  const tabItems = [
    {
      key: 'overview',
      label: <span><TeamOutlined /> Overview</span>,
      children: (
        <Space direction="vertical" size={24} style={{ width: '100%' }}>
          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Group Information</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="Group Name">{group.groupName}</Descriptions.Item>
              <Descriptions.Item label="Group ID">{group.groupId}</Descriptions.Item>
              <Descriptions.Item label="Created">{new Date(group.createdAt).toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="Description" span={3}>
                {group.description || <Text type="secondary">No description</Text>}
              </Descriptions.Item>
            </Descriptions>
          </div>

          <Divider style={{ margin: 0 }} />

          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Summary</Text>
            <Descriptions column={{ xs: 1, sm: 2 }} size="small">
              <Descriptions.Item label="Members">
                <Tag icon={<UserOutlined />} color="blue">{users.length} users</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Workstations">
                <Tag icon={<DesktopOutlined />} color="green">{workstations.length} assigned</Tag>
              </Descriptions.Item>
            </Descriptions>
          </div>
        </Space>
      ),
    },
    {
      key: 'users',
      label: <span><UserOutlined /> Members ({users.length})</span>,
      children: (
        <div>
          <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Group Members</Text>
          <Table
            rowKey="userId"
            columns={userColumns}
            dataSource={users}
            pagination={false}
            size="small"
            locale={{ emptyText: 'No users in this group' }}
          />
        </div>
      ),
    },
    {
      key: 'workstations',
      label: <span><DesktopOutlined /> Workstations ({workstations.length})</span>,
      children: (
        <div>
          <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Group Workstations</Text>
          <Table
            rowKey="instanceId"
            columns={workstationColumns}
            dataSource={workstations}
            pagination={false}
            size="small"
            locale={{ emptyText: 'No workstations assigned to this group or its members' }}
          />
        </div>
      ),
    },
  ];

  return (
    <AppLayoutAntd isAdmin={isAdmin} user={user} config={config} onSignOut={onSignOut} onChangePassword={onChangePassword}>
      <div style={{ width: '100%' }}>
        <Breadcrumb
          style={{ marginBottom: 16 }}
          items={[
            { href: '/dashboard', title: <><HomeOutlined /> Dashboard</> },
            { href: '/users', title: 'Users / Groups' },
            { title: group.groupName },
          ]}
        />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>{group.groupName}</Title>
            <Space style={{ marginTop: 8 }}>
              <Tag icon={<TeamOutlined />} color="purple">Group</Tag>
              <Text type="secondary">{group.groupId}</Text>
            </Space>
          </div>
          <Space>
            <Tooltip title="Refresh">
              <Button icon={<ReloadOutlined />} onClick={fetchGroupDetails} loading={loading} />
            </Tooltip>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/users')}>Back</Button>
          </Space>
        </div>

        <Card>
          <Tabs items={tabItems} />
        </Card>
      </div>
    </AppLayoutAntd>
  );
};

export default GroupDetailsAntd;
