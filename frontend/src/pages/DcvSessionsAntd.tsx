// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useMemo } from 'react';
import {
  Card,
  Table,
  Button,
  Alert,
  Tag,
  Space,
  Typography,
  Breadcrumb,
  Tooltip,
  Input,
  Select,
  Switch,
  Popover,
} from 'antd';
import {
  ReloadOutlined,
  HomeOutlined,
  DeleteOutlined,
  VideoCameraOutlined,
  DesktopOutlined,
  CloudServerOutlined,
  ClusterOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { apiCall } from '../utils/api';
import { getAuthToken } from '../utils/auth';

const { Title, Text, Link } = Typography;

interface DcvSessionsAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const DcvSessionsAntd: React.FC<DcvSessionsAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const [sessions, setSessions] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [loadBalancers, setLoadBalancers] = useState<any[]>([]);
  const [autoScalingGroups, setAutoScalingGroups] = useState<any[]>([]);
  const [workstationAssignments, setWorkstationAssignments] = useState<Record<string, string>>({});
  const [workstationAssignmentDisplays, setWorkstationAssignmentDisplays] = useState<Record<string, string>>({});
  const [instanceStates, setInstanceStates] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [selectedSessionKeys, setSelectedSessionKeys] = useState<React.Key[]>([]);
  const [deletingSessions, setDeletingSessions] = useState(false);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info' | 'warning'; message: string } | null>(null);

  // Filters
  const [filterText, setFilterText] = useState('');
  const [stateFilter, setStateFilter] = useState<string | null>(null);
  const [platformFilter, setPlatformFilter] = useState<string | null>(null);
  const [noConnectionsFilter, setNoConnectionsFilter] = useState(false);

  // Table preferences with localStorage persistence
  const [sessionSortedInfo, setSessionSortedInfo] = useState<{ columnKey: string; order: 'ascend' | 'descend' } | null>(() => {
    try {
      const saved = localStorage.getItem('dcv-sessions-sort');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { columnKey: 'CreationTime', order: 'descend' };
  });

  const [sessionPageSize, setSessionPageSize] = useState(() => {
    try {
      const saved = localStorage.getItem('dcv-sessions-pageSize');
      if (saved) return parseInt(saved, 10);
    } catch (e) {}
    return 10;
  });

  const [serverPageSize, setServerPageSize] = useState(() => {
    try {
      const saved = localStorage.getItem('dcv-servers-pageSize');
      if (saved) return parseInt(saved, 10);
    } catch (e) {}
    return 10;
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const [
        sessionsResponse,
        serversResponse,
        loadBalancersResponse,
        autoScalingGroupsResponse,
        workstationAssignmentsResponse,
        instanceStatesResponse,
      ] = await Promise.all([
        apiCall('/dcv', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'describe-sessions' }),
        }),
        apiCall('/dcv', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'describe-servers' }),
        }),
        apiCall('/dcv', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get-load-balancers' }),
        }),
        apiCall('/dcv', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get-autoscaling-groups' }),
        }),
        apiCall('/dcv', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get-workstation-assignments' }),
        }),
        apiCall('/dcv', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get-instance-states' }),
        }),
      ]);

      const [sessionsData, serversData, loadBalancersData, autoScalingGroupsData, workstationAssignmentsData, instanceStatesData] =
        await Promise.all([
          sessionsResponse.json(),
          serversResponse.json(),
          loadBalancersResponse.json(),
          autoScalingGroupsResponse.json(),
          workstationAssignmentsResponse.json(),
          instanceStatesResponse.json(),
        ]);

      setSessions(sessionsData.Sessions || []);
      setServers(serversData.Servers || []);
      setLoadBalancers(loadBalancersData.LoadBalancers || []);
      setAutoScalingGroups(autoScalingGroupsData.AutoScalingGroups || []);
      setWorkstationAssignments(workstationAssignmentsData.Assignments || {});
      setWorkstationAssignmentDisplays(workstationAssignmentsData.AssignmentDisplays || {});
      setInstanceStates(instanceStatesData.InstanceStates || {});
    } catch (error) {
      console.error('Failed to load DCV data:', error);
      setAlert({ type: 'error', message: 'Failed to load DCV data' });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteSessions = async () => {
    if (selectedSessionKeys.length === 0) return;
    setDeletingSessions(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      for (const sessionId of selectedSessionKeys) {
        await apiCall('/dcv', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete-session', sessionId }),
        });
      }

      setAlert({ type: 'success', message: `Deleted ${selectedSessionKeys.length} session(s)` });
      setSelectedSessionKeys([]);
      await loadData();
    } catch (error) {
      console.error('Failed to delete sessions:', error);
      setAlert({ type: 'error', message: 'Failed to delete sessions' });
    } finally {
      setDeletingSessions(false);
    }
  };

  // Helper functions
  const getServerFromSession = (session: any) => {
    const sessionServer = session.Server;
    if (!sessionServer) return null;
    if (sessionServer.Id) {
      const server = servers.find((s) => s.Id === sessionServer.Id);
      if (server) return server;
    }
    if (sessionServer.Hostname) {
      const server = servers.find((s) => s.Hostname === sessionServer.Hostname);
      if (server) return server;
    }
    if (sessionServer.Ip) {
      const server = servers.find((s) => s.Ip === sessionServer.Ip);
      if (server) return server;
    }
    return null;
  };

  const getStateColor = (state: string) => {
    switch (state) {
      case 'READY': return 'green';
      case 'CREATING': return 'blue';
      case 'DELETING': return 'default';
      case 'DELETED': return 'default';
      case 'UNKNOWN': return 'orange';
      default: return 'red';
    }
  };

  const getInstanceStateColor = (state: string) => {
    switch (state) {
      case 'running': return 'green';
      case 'stopped': return 'red';
      case 'stopping':
      case 'pending': return 'orange';
      default: return 'default';
    }
  };

  // Filter sessions
  const filteredSessions = useMemo(() => {
    let filtered = [...sessions];

    if (filterText) {
      const searchText = filterText.toLowerCase();
      filtered = filtered.filter((session) => {
        const server = getServerFromSession(session);
        const instanceId = server?.Host?.Aws?.EC2InstanceId || '';
        const assignedUser = instanceId ? workstationAssignmentDisplays[instanceId] || workstationAssignments[instanceId] || '' : '';
        return (
          session.Id?.toLowerCase().includes(searchText) ||
          session.Name?.toLowerCase().includes(searchText) ||
          session.Owner?.toLowerCase().includes(searchText) ||
          instanceId.toLowerCase().includes(searchText) ||
          assignedUser.toLowerCase().includes(searchText)
        );
      });
    }

    if (stateFilter) {
      filtered = filtered.filter((session) => session.State === stateFilter);
    }

    if (platformFilter) {
      filtered = filtered.filter((session) => {
        const server = getServerFromSession(session);
        const osFamily = server?.Host?.Os?.Family?.toLowerCase();
        if (platformFilter === 'macos') {
          return osFamily === 'macos' || osFamily === 'darwin';
        }
        return osFamily === platformFilter;
      });
    }

    if (noConnectionsFilter) {
      filtered = filtered.filter((session) => (session.NumOfConnections || 0) === 0);
    }

    return filtered;
  }, [sessions, filterText, stateFilter, platformFilter, noConnectionsFilter, servers, workstationAssignments, workstationAssignmentDisplays]);

  // Handlers
  const handleSessionTableChange = (pagination: any, filters: any, sorter: any) => {
    const newSort = sorter.order ? { columnKey: sorter.columnKey || sorter.field, order: sorter.order } : null;
    setSessionSortedInfo(newSort);
    try {
      if (newSort) {
        localStorage.setItem('dcv-sessions-sort', JSON.stringify(newSort));
      } else {
        localStorage.removeItem('dcv-sessions-sort');
      }
    } catch (e) {}
  };

  const handleSessionPageSizeChange = (current: number, size: number) => {
    setSessionPageSize(size);
    try {
      localStorage.setItem('dcv-sessions-pageSize', String(size));
    } catch (e) {}
  };

  const handleServerPageSizeChange = (current: number, size: number) => {
    setServerPageSize(size);
    try {
      localStorage.setItem('dcv-servers-pageSize', String(size));
    } catch (e) {}
  };

  // Session columns
  const sessionColumns: ColumnsType<any> = [
    {
      title: 'Session ID',
      dataIndex: 'Id',
      key: 'Id',
      width: 180,
      sorter: (a, b) => (a.Id || '').localeCompare(b.Id || ''),
      sortOrder: sessionSortedInfo?.columnKey === 'Id' ? sessionSortedInfo.order : null,
      render: (id) => (
        <Popover content={id} title="Full Session ID">
          <Text style={{ cursor: 'pointer' }}>{id?.substring(0, 20)}...</Text>
        </Popover>
      ),
    },
    {
      title: 'Name',
      dataIndex: 'Name',
      key: 'Name',
      width: 140,
      sorter: (a, b) => (a.Name || '').localeCompare(b.Name || ''),
      sortOrder: sessionSortedInfo?.columnKey === 'Name' ? sessionSortedInfo.order : null,
      render: (name) => name || '-',
    },
    {
      title: 'Owner',
      dataIndex: 'Owner',
      key: 'Owner',
      width: 140,
      sorter: (a, b) => (a.Owner || '').localeCompare(b.Owner || ''),
      sortOrder: sessionSortedInfo?.columnKey === 'Owner' ? sessionSortedInfo.order : null,
    },
    {
      title: 'Platform',
      key: 'platform',
      width: 100,
      render: (_, record) => {
        const server = getServerFromSession(record);
        const osFamily = server?.Host?.Os?.Family;
        if (!osFamily) return 'Unknown';
        if (osFamily === 'macos' || osFamily === 'darwin') return 'macOS';
        return osFamily.charAt(0).toUpperCase() + osFamily.slice(1);
      },
    },
    {
      title: 'Instance ID',
      key: 'instanceId',
      width: 140,
      render: (_, record) => {
        const server = getServerFromSession(record);
        const instanceId = server?.Host?.Aws?.EC2InstanceId;
        if (!instanceId) return 'Unknown';
        return (
          <Link onClick={() => (window.location.href = `/workstations/${instanceId}`)}>
            {instanceId}
          </Link>
        );
      },
    },
    {
      title: 'Assigned User',
      key: 'assignedUser',
      width: 140,
      render: (_, record) => {
        const server = getServerFromSession(record);
        const instanceId = server?.Host?.Aws?.EC2InstanceId;
        const assignedUser = instanceId ? workstationAssignmentDisplays[instanceId] || workstationAssignments[instanceId] : null;
        return assignedUser || 'Unassigned';
      },
    },
    {
      title: 'Instance State',
      key: 'instanceState',
      width: 120,
      render: (_, record) => {
        const server = getServerFromSession(record);
        const instanceId = server?.Host?.Aws?.EC2InstanceId;
        const state = instanceId ? instanceStates[instanceId] : null;
        if (!state) return 'Unknown';
        return (
          <Tag color={getInstanceStateColor(state)}>
            {state.charAt(0).toUpperCase() + state.slice(1)}
          </Tag>
        );
      },
    },
    {
      title: 'State',
      dataIndex: 'State',
      key: 'State',
      width: 100,
      sorter: (a, b) => (a.State || '').localeCompare(b.State || ''),
      sortOrder: sessionSortedInfo?.columnKey === 'State' ? sessionSortedInfo.order : null,
      render: (state, record) => {
        const tag = <Tag color={getStateColor(state)}>{state}</Tag>;
        if (record.Substate) {
          return (
            <Popover content={record.Substate} title="Substate">
              {tag}
            </Popover>
          );
        }
        return tag;
      },
    },
    {
      title: 'Connections',
      dataIndex: 'NumOfConnections',
      key: 'NumOfConnections',
      width: 110,
      align: 'center' as const,
      sorter: (a, b) => (a.NumOfConnections || 0) - (b.NumOfConnections || 0),
      sortOrder: sessionSortedInfo?.columnKey === 'NumOfConnections' ? sessionSortedInfo.order : null,
      render: (num) => num || 0,
    },
    {
      title: 'Created',
      dataIndex: 'CreationTime',
      key: 'CreationTime',
      width: 160,
      sorter: (a, b) => new Date(a.CreationTime || 0).getTime() - new Date(b.CreationTime || 0).getTime(),
      sortOrder: sessionSortedInfo?.columnKey === 'CreationTime' ? sessionSortedInfo.order : null,
      render: (time) => (time ? new Date(time).toLocaleString() : 'Unknown'),
    },
  ];

  // Server columns
  const serverColumns: ColumnsType<any> = [
    {
      title: 'Server ID',
      dataIndex: 'Id',
      key: 'Id',
      width: 180,
      render: (id) => (
        <Popover content={id} title="Full Server ID">
          <Text style={{ cursor: 'pointer' }}>{id?.substring(0, 20)}...</Text>
        </Popover>
      ),
    },
    {
      title: 'Instance ID',
      key: 'instanceId',
      width: 140,
      render: (_, record) => {
        const instanceId = record.Host?.Aws?.EC2InstanceId;
        if (!instanceId) return 'Unknown';
        return (
          <Link onClick={() => (window.location.href = `/workstations/${instanceId}`)}>
            {instanceId}
          </Link>
        );
      },
    },
    {
      title: 'Assigned User',
      key: 'assignedUser',
      width: 140,
      render: (_, record) => {
        const instanceId = record.Host?.Aws?.EC2InstanceId;
        const assignedUser = instanceId ? workstationAssignmentDisplays[instanceId] || workstationAssignments[instanceId] : null;
        return assignedUser || 'Unassigned';
      },
    },
    {
      title: 'Instance State',
      key: 'instanceState',
      width: 120,
      render: (_, record) => {
        const instanceId = record.Host?.Aws?.EC2InstanceId;
        const state = instanceId ? instanceStates[instanceId] : null;
        if (!state) return 'Unknown';
        return (
          <Tag color={getInstanceStateColor(state)}>
            {state.charAt(0).toUpperCase() + state.slice(1)}
          </Tag>
        );
      },
    },
    {
      title: 'Session Availability',
      key: 'availability',
      width: 180,
      render: (_, record) => {
        if (record.Availability === 'AVAILABLE') {
          return <Tag color="green">Available</Tag>;
        }
        return (
          <Popover content={record.UnavailabilityReason || 'Unknown reason'} title="Unavailable">
            <Tag color="red">No new sessions</Tag>
          </Popover>
        );
      },
    },
    {
      title: 'DCV Version',
      dataIndex: 'Version',
      key: 'Version',
      width: 120,
      render: (version) => version || 'Unknown',
    },
    {
      title: 'Agent Version',
      dataIndex: 'SessionManagerAgentVersion',
      key: 'SessionManagerAgentVersion',
      width: 120,
      render: (version) => version || 'Unknown',
    },
  ];

  // Load Balancer columns
  const loadBalancerColumns: ColumnsType<any> = [
    { title: 'Name', dataIndex: 'Name', key: 'Name', width: 200 },
    { title: 'Region', dataIndex: 'Region', key: 'Region', width: 120, render: (r) => r || 'Unknown' },
    { title: 'Type', dataIndex: 'Type', key: 'Type', width: 100 },
    { title: 'Endpoint', dataIndex: 'Endpoint', key: 'Endpoint', ellipsis: true },
    {
      title: 'Target Health',
      key: 'health',
      width: 140,
      render: (_, record) => {
        const healthy = record.HealthyTargets || 0;
        const total = record.TotalTargets || 0;
        const status = record.HealthStatus || 'Unknown';
        let color = 'default';
        if (status === 'Healthy') color = 'green';
        else if (status === 'Degraded') color = 'orange';
        else if (status === 'Unhealthy') color = 'red';
        return <Tag color={color}>{healthy}/{total} healthy</Tag>;
      },
    },
    { title: 'Port', dataIndex: 'Port', key: 'Port', width: 80, align: 'center' as const },
    { title: 'Protocol', dataIndex: 'Protocol', key: 'Protocol', width: 100 },
  ];

  // Auto Scaling Group columns
  const asgColumns: ColumnsType<any> = [
    { title: 'Auto Scaling Group', dataIndex: 'AutoScalingGroupName', key: 'AutoScalingGroupName', ellipsis: true },
    {
      title: 'Instances',
      key: 'instances',
      width: 140,
      render: (_, record) => {
        const healthy = record.HealthyInstances || 0;
        const total = record.TotalInstances || 0;
        let color = 'default';
        if (record.HealthStatus === 'Healthy') color = 'green';
        else if (record.HealthStatus === 'Partially healthy') color = 'orange';
        else if (record.HealthStatus === 'Unhealthy') color = 'red';
        return <Tag color={color}>{healthy}/{total} healthy</Tag>;
      },
    },
    { title: 'Desired', dataIndex: 'DesiredCapacity', key: 'DesiredCapacity', width: 80, align: 'center' as const },
    { title: 'Min', dataIndex: 'MinSize', key: 'MinSize', width: 60, align: 'center' as const },
    { title: 'Max', dataIndex: 'MaxSize', key: 'MaxSize', width: 60, align: 'center' as const },
    {
      title: 'Availability Zones',
      dataIndex: 'AvailabilityZones',
      key: 'AvailabilityZones',
      render: (zones) => zones?.join(', ') || 'N/A',
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
            { title: 'DCV Sessions' },
          ]}
        />

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <Title level={3} style={{ margin: 0 }}>DCV Session Management</Title>
          <Tooltip title="Refresh">
            <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading} />
          </Tooltip>
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

        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {/* Sessions Card */}
          <Card
            title={
              <Space>
                <VideoCameraOutlined />
                <span>Sessions ({filteredSessions.length})</span>
              </Space>
            }
            extra={
              isAdmin && (
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  onClick={handleDeleteSessions}
                  disabled={selectedSessionKeys.length === 0}
                  loading={deletingSessions}
                >
                  Delete ({selectedSessionKeys.length})
                </Button>
              )
            }
            
          >
            <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
              Active DCV sessions across all servers
            </Text>

            {/* Filters */}
            <Space style={{ marginBottom: 16 }} wrap>
              <Input.Search
                placeholder="Search by name, ID, owner, or user"
                allowClear
                style={{ width: 280 }}
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
              <Select
                placeholder="State"
                allowClear
                style={{ width: 120 }}
                value={stateFilter}
                onChange={setStateFilter}
                options={[
                  { label: 'Ready', value: 'READY' },
                  { label: 'Creating', value: 'CREATING' },
                  { label: 'Deleting', value: 'DELETING' },
                  { label: 'Unknown', value: 'UNKNOWN' },
                ]}
              />
              <Select
                placeholder="Platform"
                allowClear
                style={{ width: 120 }}
                value={platformFilter}
                onChange={setPlatformFilter}
                options={[
                  { label: 'Windows', value: 'windows' },
                  { label: 'Linux', value: 'linux' },
                  { label: 'macOS', value: 'macos' },
                ]}
              />
              <Space>
                <Switch checked={noConnectionsFilter} onChange={setNoConnectionsFilter} size="small" />
                <Text type="secondary">No connections</Text>
              </Space>
            </Space>

            <Table
              rowKey="Id"
              columns={sessionColumns}
              dataSource={filteredSessions}
              loading={loading}
              rowSelection={{
                selectedRowKeys: selectedSessionKeys,
                onChange: setSelectedSessionKeys,
              }}
              onChange={handleSessionTableChange}
              pagination={{
                pageSize: sessionPageSize,
                showSizeChanger: true,
                pageSizeOptions: ['10', '20', '50'],
                onShowSizeChange: handleSessionPageSizeChange,
                showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
              }}
              scroll={{ x: 1400 }}
              locale={{
                emptyText: loading ? null : (
                  <div style={{ padding: 40 }}>
                    <VideoCameraOutlined style={{ fontSize: 48, color: '#ccc', marginBottom: 16 }} />
                    <div>No DCV sessions found</div>
                  </div>
                ),
              }}
            />
          </Card>

          {/* Workstations Card */}
          <Card
            title={
              <Space>
                <DesktopOutlined />
                <span>Workstations ({servers.length})</span>
              </Space>
            }
            
          >
            <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
              DCV workstations registered with Session Manager
            </Text>
            <Table
              rowKey="Id"
              columns={serverColumns}
              dataSource={servers}
              loading={loading}
              pagination={{
                pageSize: serverPageSize,
                showSizeChanger: true,
                pageSizeOptions: ['10', '20', '50'],
                onShowSizeChange: handleServerPageSizeChange,
                showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
              }}
              scroll={{ x: 1000 }}
              locale={{
                emptyText: loading ? null : (
                  <div style={{ padding: 40 }}>
                    <DesktopOutlined style={{ fontSize: 48, color: '#ccc', marginBottom: 16 }} />
                    <div>No DCV servers found</div>
                  </div>
                ),
              }}
            />
          </Card>

          {/* Load Balancers Card */}
          <Card
            title={
              <Space>
                <CloudServerOutlined />
                <span>Load Balancers ({loadBalancers.length})</span>
              </Space>
            }
            
          >
            <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
              Network load balancers used by DCV infrastructure
            </Text>
            <Table
              rowKey="Name"
              columns={loadBalancerColumns}
              dataSource={loadBalancers}
              loading={loading}
              pagination={false}
              scroll={{ x: 900 }}
              locale={{
                emptyText: loading ? null : (
                  <div style={{ padding: 40 }}>
                    <CloudServerOutlined style={{ fontSize: 48, color: '#ccc', marginBottom: 16 }} />
                    <div>No load balancers found</div>
                  </div>
                ),
              }}
            />
          </Card>

          {/* Auto Scaling Groups Card */}
          <Card
            title={
              <Space>
                <ClusterOutlined />
                <span>Auto Scaling Groups ({autoScalingGroups.length})</span>
              </Space>
            }
            
          >
            <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
              Auto scaling groups managing DCV infrastructure instances
            </Text>
            <Table
              rowKey="AutoScalingGroupName"
              columns={asgColumns}
              dataSource={autoScalingGroups}
              loading={loading}
              pagination={false}
              scroll={{ x: 800 }}
              locale={{
                emptyText: loading ? null : (
                  <div style={{ padding: 40 }}>
                    <ClusterOutlined style={{ fontSize: 48, color: '#ccc', marginBottom: 16 }} />
                    <div>No auto scaling groups found</div>
                  </div>
                ),
              }}
            />
          </Card>
        </Space>
      </div>
    </AppLayoutAntd>
  );
};

export default DcvSessionsAntd;
