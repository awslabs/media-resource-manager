// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useCallback } from 'react';
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
  PlayCircleOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import AppLayoutAntd from '../components/AppLayoutAntd';
import {
  DataSyncTask,
  DataSyncLocation,
  TaskExecution,
  listDataSyncLocations,
  listDataSyncTasks,
  getTaskExecutions,
  startTaskExecution,
} from '../utils/datasyncApi';

const { Title, Text } = Typography;

interface TaskDetailsAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const TaskDetailsAntd: React.FC<TaskDetailsAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<DataSyncTask | null>(null);
  const [locations, setLocations] = useState<DataSyncLocation[]>([]);
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [executionsLoading, setExecutionsLoading] = useState(false);
  const [error, setError] = useState('');
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [runningExecution, setRunningExecution] = useState(false);

  const fetchTask = useCallback(async () => {
    if (!taskId) return;
    try {
      const tasks = await listDataSyncTasks();
      const foundTask = tasks.find((t: DataSyncTask) => t.taskId === taskId);
      if (!foundTask) {
        setError('Task not found');
        return;
      }
      setTask(foundTask);
    } catch (err: any) {
      setError(err.message || 'Failed to load task');
    }
  }, [taskId]);

  const fetchLocations = useCallback(async () => {
    try {
      const locationsData = await listDataSyncLocations();
      setLocations(locationsData);
    } catch (err) {
      console.error('Failed to fetch locations:', err);
    }
  }, []);

  const fetchExecutions = useCallback(async () => {
    if (!taskId) return;
    try {
      setExecutionsLoading(true);
      const executionsData = await getTaskExecutions(taskId);
      setExecutions(executionsData);
    } catch (err) {
      console.error('Failed to fetch executions:', err);
    } finally {
      setExecutionsLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await Promise.all([fetchTask(), fetchLocations()]);
      setLoading(false);
      fetchExecutions();
    };
    loadData();
  }, [fetchTask, fetchLocations, fetchExecutions]);

  const handleRunTask = async () => {
    if (!taskId) return;
    try {
      setRunningExecution(true);
      await startTaskExecution(taskId);
      setAlert({ type: 'success', message: 'Task execution started successfully' });
      await fetchTask();
      await fetchExecutions();
    } catch (err: any) {
      setAlert({ type: 'error', message: err.message || 'Failed to start execution' });
    } finally {
      setRunningExecution(false);
    }
  };

  const refreshAll = async () => {
    setLoading(true);
    await Promise.all([fetchTask(), fetchLocations()]);
    setLoading(false);
    fetchExecutions();
  };

  const getLocationName = (locationId: string) => {
    const location = locations.find((l) => l.locationId === locationId);
    return location?.name || locationId;
  };

  const getLocationType = (locationId: string) => {
    const location = locations.find((l) => l.locationId === locationId);
    if (!location) return '-';
    if (location.locationType === 'S3') return 'Amazon S3';
    if (location.locationType === 'FSX_ONTAP') return 'FSx for NetApp ONTAP';
    return 'FSx for Windows';
  };

  const getLocationUri = (locationId: string) => {
    const location = locations.find((l) => l.locationId === locationId);
    if (!location) return '-';
    if (location.locationType === 'S3') {
      return location.bucketArn?.split(':').pop() || '-';
    }
    return location.storageId || '-';
  };

  const getStatusTag = (status: string) => {
    const statusLower = status.toLowerCase();
    switch (statusLower) {
      case 'available':
      case 'success':
        return <Tag color="green">{status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}</Tag>;
      case 'running':
      case 'transferring':
      case 'verifying':
        return <Tag color="blue">{status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}</Tag>;
      case 'creating':
      case 'preparing':
      case 'launching':
      case 'queued':
        return <Tag color="orange">{status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}</Tag>;
      case 'error':
      case 'invalid':
        return <Tag color="red">{status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}</Tag>;
      case 'deleting':
        return <Tag color="orange">{status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}</Tag>;
      default:
        return <Tag>{status}</Tag>;
    }
  };

  const formatBytes = (bytes?: number) => {
    if (!bytes) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let value = bytes;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return value.toFixed(2) + ' ' + units[unitIndex];
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '-';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  };

  // Execution history columns
  const executionColumns: ColumnsType<TaskExecution> = [
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status) => getStatusTag(status),
    },
    {
      title: 'Start Time',
      dataIndex: 'startTime',
      key: 'startTime',
      width: 180,
      render: (time) => new Date(time).toLocaleString(),
    },
    {
      title: 'End Time',
      dataIndex: 'endTime',
      key: 'endTime',
      width: 180,
      render: (time) => (time ? new Date(time).toLocaleString() : '-'),
    },
    {
      title: 'Duration',
      dataIndex: 'duration',
      key: 'duration',
      width: 100,
      render: (duration) => formatDuration(duration),
    },
    {
      title: 'Data Transferred',
      dataIndex: 'bytesTransferred',
      key: 'bytesTransferred',
      width: 140,
      render: (bytes) => formatBytes(bytes),
    },
    {
      title: 'Files',
      dataIndex: 'filesTransferred',
      key: 'filesTransferred',
      width: 100,
      render: (files) => files?.toLocaleString() || '-',
    },
  ];

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
              { href: '/data-transfer', title: 'Data Transfer' },
              { title: 'Task Details' },
            ]}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <Title level={3} style={{ margin: 0 }}>Task Details</Title>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/data-transfer')}>
              Back
            </Button>
          </div>
          <Alert type="error" message="Error loading task" description={error} />
        </div>
      </AppLayoutAntd>
    );
  }

  const tabItems = [
    {
      key: 'general',
      label: 'General',
      children: (
        <Space direction="vertical" size={24} style={{ width: '100%' }}>
          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Task Information</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="Task ID">{task?.taskId || '-'}</Descriptions.Item>
              <Descriptions.Item label="Status">{task ? getStatusTag(task.status) : '-'}</Descriptions.Item>
              <Descriptions.Item label="Created">{task?.createdAt ? new Date(task.createdAt).toLocaleString() : '-'}</Descriptions.Item>
            </Descriptions>
          </div>

          <Divider style={{ margin: 0 }} />

          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Source Location</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="Name">{task ? getLocationName(task.sourceLocationId) : '-'}</Descriptions.Item>
              <Descriptions.Item label="Type">{task ? getLocationType(task.sourceLocationId) : '-'}</Descriptions.Item>
              <Descriptions.Item label="URI">{task ? getLocationUri(task.sourceLocationId) : '-'}</Descriptions.Item>
            </Descriptions>
          </div>

          <Divider style={{ margin: 0 }} />

          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Destination Location</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="Name">{task ? getLocationName(task.destinationLocationId) : '-'}</Descriptions.Item>
              <Descriptions.Item label="Type">{task ? getLocationType(task.destinationLocationId) : '-'}</Descriptions.Item>
              <Descriptions.Item label="URI">{task ? getLocationUri(task.destinationLocationId) : '-'}</Descriptions.Item>
            </Descriptions>
          </div>
        </Space>
      ),
    },
    {
      key: 'options',
      label: 'Options',
      children: (
        <Space direction="vertical" size={24} style={{ width: '100%' }}>
          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Transfer Settings</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="Transfer Mode">{task?.options?.transferMode || '-'}</Descriptions.Item>
              <Descriptions.Item label="Verify Mode">{task?.options?.verifyMode || '-'}</Descriptions.Item>
              <Descriptions.Item label="Overwrite Mode">{task?.options?.overwriteMode || '-'}</Descriptions.Item>
            </Descriptions>
          </div>

          <Divider style={{ margin: 0 }} />

          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Additional Options</Text>
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="Preserve Deleted Files">{task?.options?.preserveDeletedFiles || '-'}</Descriptions.Item>
              <Descriptions.Item label="Log Level">{task?.options?.logLevel || '-'}</Descriptions.Item>
              <Descriptions.Item label="Bandwidth Limit">
                {task?.options?.bytesPerSecond
                  ? `${(task.options.bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
                  : 'Unlimited'}
              </Descriptions.Item>
            </Descriptions>
          </div>
        </Space>
      ),
    },
    {
      key: 'executions',
      label: `Executions (${executions.length})`,
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text strong style={{ fontSize: 14 }}>Execution History</Text>
            <Button
              icon={<ReloadOutlined />}
              size="small"
              onClick={fetchExecutions}
              loading={executionsLoading}
            >
              Refresh
            </Button>
          </div>
          <Table
            rowKey="executionId"
            columns={executionColumns}
            dataSource={executions}
            loading={executionsLoading}
            pagination={false}
            size="small"
            locale={{ emptyText: 'No executions. Run the task to see execution history.' }}
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
            { href: '/data-transfer', title: 'Data Transfer' },
            { title: task?.name || taskId || 'Task Details' },
          ]}
        />

        {/* Header with actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>Data Transfer Task</Title>
            <Space style={{ marginTop: 8 }}>
              <Text type="secondary">{task?.name}</Text>
              {task && getStatusTag(task.status)}
            </Space>
          </div>
          <Space>
            <Tooltip title="Refresh">
              <Button icon={<ReloadOutlined />} onClick={refreshAll} loading={loading} />
            </Tooltip>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/data-transfer')}>
              Back
            </Button>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handleRunTask}
              loading={runningExecution}
              disabled={task?.status !== 'available'}
            >
              Run
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

        {/* Content Card with Tabs */}
        <Card >
          <Tabs items={tabItems} />
        </Card>
      </div>
    </AppLayoutAntd>
  );
};

export default TaskDetailsAntd;
