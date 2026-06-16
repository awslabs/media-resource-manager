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
  UserOutlined,
  TeamOutlined,
  DesktopOutlined,
  VideoCameraOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { apiCall } from '../utils/api';
import { DcvApiService } from '../utils/dcvApi';

const { Title, Text, Link } = Typography;

interface UserDetailsAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const UserDetailsAntd: React.FC<UserDetailsAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const [details, setDetails] = useState<any>(null);
  const [dcvSessions, setDcvSessions] = useState<any[]>([]);
  const [allGroups, setAllGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dcvLoading, setDcvLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('user-info');
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [userSchedule, setUserSchedule] = useState<any>(null);

  useEffect(() => {
    if (userId) {
      fetchUserDetails();
      fetchAllGroups();
      fetchAutoStartSetting();
      fetchUserSchedule();
    }
  }, [userId]);

  const fetchAutoStartSetting = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall('settings', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const settings = await response.json();
        setAutoStartEnabled(settings.autoStartEnabled === true);
      }
    } catch (error) {
      console.error('Error fetching auto-start setting:', error);
    }
  };

  const fetchUserSchedule = async () => {
    if (!userId) return;
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall(`users/${encodeURIComponent(userId)}/schedule`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const schedule = await response.json();
        setUserSchedule(schedule);
      }
    } catch (error) {
      console.error('Error fetching user schedule:', error);
    }
  };

  const fetchAllGroups = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall('groups', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const groupsData = await response.json();
        setAllGroups(groupsData);
      }
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  };

  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId);
    if (tabId === 'dcv-sessions' && dcvSessions.length === 0) {
      fetchDcvSessions();
    }
  };

  const fetchDcvSessions = async () => {
    if (!userId || !details?.user) return;

    setDcvLoading(true);
    try {
      const userSessions = await DcvApiService.getSessionsForUser(userId);
      setDcvSessions(userSessions);
    } catch (error) {
      console.error('Error fetching DCV sessions:', error);
      setDcvSessions([]);
    } finally {
      setDcvLoading(false);
    }
  };

  const fetchUserDetails = async () => {
    try {
      setLoading(true);
      const token = getAuthToken();
      if (!token) {
        throw new Error('No current user');
      }

      const response = await apiCall(`users/${userId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const data = await response.json();
        setDetails(data);
        setTimeout(() => fetchDcvSessions(), 100);
      } else if (response.status === 404) {
        setError('User not found');
      } else if (response.status === 403) {
        setError('Access denied');
      } else {
        setError('Failed to load user details');
      }
    } catch (error) {
      console.error('Error fetching user details:', error);
      if (!handleAuthError(error)) {
        setError('Failed to load user details');
      }
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  // Format schedule for display
  const formatScheduleDisplay = () => {
    if (!userSchedule?.schedule) return null;
    
    const schedule = userSchedule.schedule;
    const daysWithTimes = Object.entries(schedule)
      .filter(([_, time]) => time)
      .map(([day, time]) => ({ day, time: time as string }));
    
    if (daysWithTimes.length === 0) return null;

    // Check if all times are the same
    const allSameTime = daysWithTimes.every(d => d.time === daysWithTimes[0].time);
    
    // Day abbreviations
    const dayAbbrev: Record<string, string> = {
      sunday: 'Sun', monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed',
      thursday: 'Thu', friday: 'Fri', saturday: 'Sat'
    };
    
    // Check for weekdays pattern (Mon-Fri)
    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
    const weekend = ['saturday', 'sunday'];
    const isWeekdaysOnly = weekdays.every(d => schedule[d]) && weekend.every(d => !schedule[d]);
    const isAllDays = [...weekdays, ...weekend].every(d => schedule[d]);
    
    if (allSameTime) {
      const time = daysWithTimes[0].time;
      if (isAllDays) {
        return `Every day at ${time}`;
      } else if (isWeekdaysOnly) {
        return `Mon-Fri at ${time}`;
      }
    }
    
    // Otherwise list individual days
    return daysWithTimes
      .sort((a, b) => {
        const order = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        return order.indexOf(a.day) - order.indexOf(b.day);
      })
      .map(d => `${dayAbbrev[d.day]} ${d.time}`)
      .join(', ');
  };

  const getWorkstationStateTag = (status: string) => {
    switch (status) {
      case 'running':
        return <Tag color="green">Running</Tag>;
      case 'stopped':
        return <Tag color="default">Stopped</Tag>;
      case 'pending':
        return <Tag color="blue">Starting</Tag>;
      case 'stopping':
        return <Tag color="orange">Stopping</Tag>;
      case 'terminated':
        return <Tag color="red">Terminated</Tag>;
      default:
        return <Tag>{status}</Tag>;
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
              { href: '/users', title: 'Users / Groups' },
              { title: 'User Details' },
            ]}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <Title level={3} style={{ margin: 0 }}>User Details</Title>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/users')}>
              Back
            </Button>
          </div>
          <Alert type="error" message={error} />
        </div>
      </AppLayoutAntd>
    );
  }

  const { user: userData, directoryUser, groups, workstations } = details;

  // Group columns
  const groupColumns: ColumnsType<any> = [
    {
      title: 'Group Name',
      dataIndex: 'GroupName',
      key: 'GroupName',
      render: (groupName) => {
        const matchingGroup = allGroups.find(
          (g) => g.groupName === groupName || g.groupName?.toLowerCase() === groupName?.toLowerCase()
        );
        if (matchingGroup) {
          return (
            <Link onClick={() => (window.location.href = `/groups/${matchingGroup.groupId}`)}>
              {groupName}
            </Link>
          );
        }
        return groupName;
      },
    },
    {
      title: 'Description',
      dataIndex: 'Description',
      key: 'Description',
      render: (desc) => desc || 'No description',
    },
  ];

  // Workstation columns
  const workstationColumns: ColumnsType<any> = [
    {
      title: 'Instance ID',
      dataIndex: 'instanceId',
      key: 'instanceId',
      render: (instanceId) => (
        <Link onClick={() => (window.location.href = `/workstations/${instanceId}`)}>
          {instanceId}
        </Link>
      ),
    },
    {
      title: 'Instance Type',
      dataIndex: 'instanceType',
      key: 'instanceType',
    },
    {
      title: 'Status',
      dataIndex: 'instanceStatus',
      key: 'instanceStatus',
      render: (status) => getWorkstationStateTag(status),
    },
    {
      title: 'Access Type',
      key: 'accessType',
      render: (_, record) => {
        if (record.assignedUserId === userId) {
          return <Tag color="blue">Direct Assignment</Tag>;
        }
        return <Tag color="green">Group Access</Tag>;
      },
    },
  ];

  // DCV Session columns
  const dcvSessionColumns: ColumnsType<any> = [
    {
      title: 'Session ID',
      dataIndex: 'Id',
      key: 'Id',
      ellipsis: true,
    },
    {
      title: 'Session Name',
      dataIndex: 'Name',
      key: 'Name',
      render: (name) => name || 'N/A',
    },
    {
      title: 'Owner',
      dataIndex: 'Owner',
      key: 'Owner',
    },
    {
      title: 'Type',
      dataIndex: 'Type',
      key: 'Type',
      render: (type) => type || 'N/A',
    },
    {
      title: 'Created',
      dataIndex: 'CreationTime',
      key: 'CreationTime',
      render: (time) => (time ? new Date(time).toLocaleString() : 'N/A'),
    },
  ];

  const tabItems = [
    {
      key: 'user-info',
      label: (
        <span>
          <UserOutlined /> User Information
        </span>
      ),
      children: (
        <Space direction="vertical" size={24} style={{ width: '100%' }}>
          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Account Information</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 4 }} size="small">
              <Descriptions.Item label="User ID">{userData.userId}</Descriptions.Item>
              <Descriptions.Item label="Email">{userData.email}</Descriptions.Item>
              <Descriptions.Item label="Created">{userData.createdAt ? formatDate(userData.createdAt) : 'Unknown'}</Descriptions.Item>
              <Descriptions.Item label="Admin">{userData.isAdmin ? <Tag color="red">Yes</Tag> : 'No'}</Descriptions.Item>
            </Descriptions>
          </div>

          <Divider style={{ margin: 0 }} />

          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Personal Information</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="First Name">{userData.firstName}</Descriptions.Item>
              <Descriptions.Item label="Last Name">{userData.lastName}</Descriptions.Item>
              <Descriptions.Item label="Department">{userData.department || 'Not specified'}</Descriptions.Item>
            </Descriptions>
          </div>

          {directoryUser && (
            <>
              <Divider style={{ margin: 0 }} />

              <div>
                <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Directory Information</Text>
                <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
                  <Descriptions.Item label="Username">{directoryUser.SAMAccountName}</Descriptions.Item>
                  <Descriptions.Item label="Display Name">{directoryUser.GivenName} {directoryUser.Surname}</Descriptions.Item>
                  <Descriptions.Item label="Enabled">{directoryUser.Enabled ? <Tag color="green">Yes</Tag> : <Tag color="red">No</Tag>}</Descriptions.Item>
                  <Descriptions.Item label="Email Address">{directoryUser.EmailAddress}</Descriptions.Item>
                </Descriptions>
              </div>

              <Divider style={{ margin: 0 }} />

              <div>
                <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Directory Details</Text>
                <Descriptions column={1} size="small">
                  <Descriptions.Item label="Distinguished Name">{directoryUser.DistinguishedName}</Descriptions.Item>
                </Descriptions>
              </div>
            </>
          )}

          {autoStartEnabled && (
            <>
              <Divider style={{ margin: 0 }} />

              <div>
                <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
                  <ClockCircleOutlined style={{ marginRight: 8 }} />
                  Auto-Start Schedule
                </Text>
                {userSchedule?.enabled && formatScheduleDisplay() ? (
                  <div style={{ 
                    background: 'var(--ant-color-fill-quaternary, #fafafa)', 
                    borderRadius: 8, 
                    padding: 16,
                    border: '1px solid var(--ant-color-border-secondary, #f0f0f0)'
                  }}>
                    <Space direction="vertical" size={8}>
                      <div>
                        <Text type="secondary" style={{ fontSize: 12 }}>Schedule</Text>
                        <div><Text>{formatScheduleDisplay()}</Text></div>
                      </div>
                      <div>
                        <Text type="secondary" style={{ fontSize: 12 }}>Timezone</Text>
                        <div><Text>{userSchedule.timezone}</Text></div>
                      </div>
                    </Space>
                  </div>
                ) : (
                  <Text type="secondary">No schedule configured</Text>
                )}
              </div>
            </>
          )}
        </Space>
      ),
    },
    {
      key: 'groups',
      label: (
        <span>
          <TeamOutlined /> Groups ({groups?.length || 0})
        </span>
      ),
      children: (
        <div>
          <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Group Memberships</Text>
          <Table
            rowKey="GroupName"
            columns={groupColumns}
            dataSource={groups || []}
            pagination={false}
            size="small"
            locale={{ emptyText: 'No groups found' }}
          />
        </div>
      ),
    },
    {
      key: 'workstations',
      label: (
        <span>
          <DesktopOutlined /> Workstations ({workstations?.length || 0})
        </span>
      ),
      children: (
        <div>
          <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Accessible Workstations</Text>
          <Table
            rowKey="instanceId"
            columns={workstationColumns}
            dataSource={workstations || []}
            pagination={false}
            size="small"
            locale={{ emptyText: 'No workstations accessible to this user' }}
          />
        </div>
      ),
    },
    {
      key: 'dcv-sessions',
      label: (
        <span>
          <VideoCameraOutlined /> DCV Sessions ({dcvSessions.length})
        </span>
      ),
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text strong style={{ fontSize: 14 }}>Active Sessions</Text>
            <Button
              icon={<ReloadOutlined />}
              size="small"
              onClick={fetchDcvSessions}
              loading={dcvLoading}
            >
              Refresh
            </Button>
          </div>
          <Table
            rowKey="Id"
            columns={dcvSessionColumns}
            dataSource={dcvSessions}
            loading={dcvLoading}
            pagination={false}
            size="small"
            locale={{ emptyText: 'No DCV sessions found' }}
          />
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
            { href: '/users', title: 'Users / Groups' },
            { title: userData?.email || userId },
          ]}
        />

        {/* Header with actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>
              {userData?.firstName} {userData?.lastName}
            </Title>
            <Space style={{ marginTop: 8 }}>
              <Text type="secondary">{userData?.email}</Text>
              {userData?.isAdmin && <Tag color="red">Administrator</Tag>}
              {userData?.enabled === false && <Tag color="default">Disabled</Tag>}
            </Space>
          </div>
          <Space>
            <Tooltip title="Refresh">
              <Button icon={<ReloadOutlined />} onClick={fetchUserDetails} loading={loading} />
            </Tooltip>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/users')}>
              Back
            </Button>
          </Space>
        </div>

        {/* Content Card with Tabs */}
        <Card >
          <Tabs items={tabItems} activeKey={activeTab} onChange={handleTabChange} />
        </Card>
      </div>
    </AppLayoutAntd>
  );
};

export default UserDetailsAntd;
