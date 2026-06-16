// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
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
  Collapse,
  InputNumber,
  Radio,
  Divider,
  Checkbox,
  Tabs,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ReloadOutlined,
  HomeOutlined,
  EditOutlined,
  PlayCircleOutlined,
  SwapOutlined,
  EnvironmentOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken } from '../utils/auth';
import {
  DataSyncTask,
  DataSyncLocation,
  S3Bucket,
  listDataSyncTasks,
  listDataSyncLocations,
  listS3Buckets,
  deleteDataSyncTask,
  deleteDataSyncLocation,
  startTaskExecution,
  createDataSyncTask,
  updateDataSyncTask,
  createDataSyncLocation,
  getDataSyncConfig,
  DataSyncConfig,
} from '../utils/datasyncApi';
import { apiCall } from '../utils/api';

const { Title, Text, Link } = Typography;
const { TextArea } = Input;

// Default task options matching backend defaults
const DEFAULT_OPTIONS = {
  transferMode: 'CHANGED',
  verifyMode: 'ONLY_FILES_TRANSFERRED',
  overwriteMode: 'ALWAYS',
  preserveDeletedFiles: 'PRESERVE',
  logLevel: 'BASIC',
};

// Presets for common use cases
const TASK_PRESETS = {
  incremental: {
    label: 'Incremental Sync (Recommended)',
    description: 'Transfer only changed files, verify transferred files, preserve deleted files',
    options: {
      transferMode: 'CHANGED',
      verifyMode: 'ONLY_FILES_TRANSFERRED',
      overwriteMode: 'ALWAYS',
      preserveDeletedFiles: 'PRESERVE',
      logLevel: 'BASIC',
    },
  },
  mirror: {
    label: 'Mirror Sync',
    description: 'Keep destination identical to source, including deletions',
    options: {
      transferMode: 'CHANGED',
      verifyMode: 'ONLY_FILES_TRANSFERRED',
      overwriteMode: 'ALWAYS',
      preserveDeletedFiles: 'REMOVE',
      logLevel: 'BASIC',
    },
  },
  fullCopy: {
    label: 'Full Copy',
    description: 'Transfer all files regardless of changes, full verification',
    options: {
      transferMode: 'ALL',
      verifyMode: 'POINT_IN_TIME_CONSISTENT',
      overwriteMode: 'ALWAYS',
      preserveDeletedFiles: 'PRESERVE',
      logLevel: 'TRANSFER',
    },
  },
  custom: {
    label: 'Custom',
    description: 'Configure all options manually',
    options: null,
  },
};

interface StorageResource {
  storageId: string;
  name: string;
  type: string;
  status: string;
}

interface DataTransferAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const DataTransferAntd: React.FC<DataTransferAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const [tasks, setTasks] = useState<DataSyncTask[]>([]);
  const [locations, setLocations] = useState<DataSyncLocation[]>([]);
  const [s3Buckets, setS3Buckets] = useState<S3Bucket[]>([]);
  const [storageResources, setStorageResources] = useState<StorageResource[]>([]);
  const [dataSyncConfig, setDataSyncConfig] = useState<DataSyncConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTaskKeys, setSelectedTaskKeys] = useState<React.Key[]>([]);
  const [selectedLocationKeys, setSelectedLocationKeys] = useState<React.Key[]>([]);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info' | 'warning'; message: string } | null>(null);

  // Modal states
  const [showCreateTaskModal, setShowCreateTaskModal] = useState(false);
  const [showCreateLocationModal, setShowCreateLocationModal] = useState(false);
  const [editingTask, setEditingTask] = useState<DataSyncTask | null>(null);

  // Refs for modal name input autofocus
  const createTaskNameRef = useRef<InputRef>(null);
  const createLocationNameRef = useRef<InputRef>(null);

  // Focus name input when Create Task modal opens
  useEffect(() => {
    if (showCreateTaskModal) {
      const timer = setTimeout(() => {
        createTaskNameRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [showCreateTaskModal]);

  // Focus name input when Create Location modal opens
  useEffect(() => {
    if (showCreateLocationModal) {
      const timer = setTimeout(() => {
        createLocationNameRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [showCreateLocationModal]);

  // Processing states
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [creatingLocation, setCreatingLocation] = useState(false);
  const [deletingTasks, setDeletingTasks] = useState(false);
  const [deletingLocations, setDeletingLocations] = useState(false);
  const [policyConfirmed, setPolicyConfirmed] = useState(false);

  // Table preferences with localStorage persistence
  const [taskSortedInfo, setTaskSortedInfo] = useState<{ columnKey: string; order: 'ascend' | 'descend' } | null>(() => {
    try {
      const saved = localStorage.getItem('datatransfer-tasks-sort');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { columnKey: 'name', order: 'ascend' };
  });

  const [taskPageSize, setTaskPageSize] = useState(() => {
    try {
      const saved = localStorage.getItem('datatransfer-tasks-pageSize');
      if (saved) return parseInt(saved, 10);
    } catch (e) {}
    return 10;
  });

  const [locationSortedInfo, setLocationSortedInfo] = useState<{ columnKey: string; order: 'ascend' | 'descend' } | null>(() => {
    try {
      const saved = localStorage.getItem('datatransfer-locations-sort');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { columnKey: 'name', order: 'ascend' };
  });

  const [locationPageSize, setLocationPageSize] = useState(() => {
    try {
      const saved = localStorage.getItem('datatransfer-locations-pageSize');
      if (saved) return parseInt(saved, 10);
    } catch (e) {}
    return 10;
  });

  // Forms
  const [taskForm] = Form.useForm();
  const [locationForm] = Form.useForm();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [tasksData, locationsData, bucketsData, configData] = await Promise.all([
        listDataSyncTasks(),
        listDataSyncLocations(),
        listS3Buckets().catch(() => []),
        getDataSyncConfig().catch(() => null),
      ]);
      setTasks(tasksData);
      setLocations(locationsData);
      setS3Buckets(bucketsData);
      if (configData) setDataSyncConfig(configData);

      // Also fetch storage resources for location creation
      const token = getAuthToken();
      if (token) {
        const storageResponse = await apiCall('storage', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (storageResponse.ok) {
          const data = await storageResponse.json();
          setStorageResources(Array.isArray(data) ? data : (data.data || []));
        }
      }
    } catch (error: any) {
      setAlert({ type: 'error', message: `Failed to load data: ${error.message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const selectedTasks = useMemo(() => {
    return tasks.filter((t) => selectedTaskKeys.includes(t.taskId));
  }, [tasks, selectedTaskKeys]);

  const selectedLocations = useMemo(() => {
    return locations.filter((l) => selectedLocationKeys.includes(l.locationId));
  }, [locations, selectedLocationKeys]);

  const getLocationName = (locationId: string) => {
    const location = locations.find((l) => l.locationId === locationId);
    return location?.name || locationId;
  };

  // Handlers
  const handleTaskTableChange = (pagination: any, filters: any, sorter: any) => {
    const newSort = sorter.order
      ? { columnKey: sorter.columnKey || sorter.field, order: sorter.order }
      : null;
    setTaskSortedInfo(newSort);
    try {
      if (newSort) {
        localStorage.setItem('datatransfer-tasks-sort', JSON.stringify(newSort));
      } else {
        localStorage.removeItem('datatransfer-tasks-sort');
      }
    } catch (e) {}
  };

  const handleTaskPageSizeChange = (current: number, size: number) => {
    setTaskPageSize(size);
    try {
      localStorage.setItem('datatransfer-tasks-pageSize', String(size));
    } catch (e) {}
  };

  const handleLocationTableChange = (pagination: any, filters: any, sorter: any) => {
    const newSort = sorter.order
      ? { columnKey: sorter.columnKey || sorter.field, order: sorter.order }
      : null;
    setLocationSortedInfo(newSort);
    try {
      if (newSort) {
        localStorage.setItem('datatransfer-locations-sort', JSON.stringify(newSort));
      } else {
        localStorage.removeItem('datatransfer-locations-sort');
      }
    } catch (e) {}
  };

  const handleLocationPageSizeChange = (current: number, size: number) => {
    setLocationPageSize(size);
    try {
      localStorage.setItem('datatransfer-locations-pageSize', String(size));
    } catch (e) {}
  };

  const handleRunTask = async (task: DataSyncTask) => {
    try {
      setRunningTaskId(task.taskId);
      await startTaskExecution(task.taskId);
      setAlert({ type: 'success', message: `Task "${task.name}" execution started` });
      fetchData();
    } catch (error: any) {
      setAlert({ type: 'error', message: `Failed to start task: ${error.message}` });
    } finally {
      setRunningTaskId(null);
    }
  };

  const handleDeleteTasks = async () => {
    setDeletingTasks(true);
    try {
      await Promise.all(selectedTasks.map((task) => deleteDataSyncTask(task.taskId)));
      setAlert({ type: 'success', message: `Deleted ${selectedTasks.length} task(s)` });
      setSelectedTaskKeys([]);
      fetchData();
    } catch (error: any) {
      setAlert({ type: 'error', message: `Failed to delete tasks: ${error.message}` });
    } finally {
      setDeletingTasks(false);
    }
  };

  const handleDeleteLocations = async () => {
    setDeletingLocations(true);
    try {
      await Promise.all(selectedLocations.map((loc) => deleteDataSyncLocation(loc.locationId)));
      setAlert({ type: 'success', message: `Deleted ${selectedLocations.length} location(s)` });
      setSelectedLocationKeys([]);
      fetchData();
    } catch (error: any) {
      setAlert({ type: 'error', message: `Failed to delete locations: ${error.message}` });
    } finally {
      setDeletingLocations(false);
    }
  };

  const handleCreateTask = async () => {
    try {
      const values = await taskForm.validateFields();
      setCreatingTask(true);
      
      // Build options object
      const options: any = {
        transferMode: values.transferMode || DEFAULT_OPTIONS.transferMode,
        verifyMode: values.verifyMode || DEFAULT_OPTIONS.verifyMode,
        overwriteMode: values.overwriteMode || DEFAULT_OPTIONS.overwriteMode,
        preserveDeletedFiles: values.preserveDeletedFiles || DEFAULT_OPTIONS.preserveDeletedFiles,
        logLevel: values.logLevel || DEFAULT_OPTIONS.logLevel,
      };
      
      // Add bandwidth limit if specified (convert MB/s to bytes/sec)
      if (values.bandwidthLimit) {
        options.bytesPerSecond = Math.round(values.bandwidthLimit * 1024 * 1024);
      }
      
      const taskData = {
        name: values.name,
        sourceLocationId: values.sourceLocationId,
        destinationLocationId: values.destinationLocationId,
        options,
      };
      
      if (editingTask) {
        await updateDataSyncTask(editingTask.taskId, { name: values.name, options });
        setAlert({ type: 'success', message: 'Task updated successfully' });
      } else {
        await createDataSyncTask(taskData);
        setAlert({ type: 'success', message: 'Task created successfully' });
      }
      setShowCreateTaskModal(false);
      setEditingTask(null);
      taskForm.resetFields();
      fetchData();
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to save task' });
    } finally {
      setCreatingTask(false);
    }
  };

  const handleCreateLocation = async () => {
    try {
      const values = await locationForm.validateFields();
      setCreatingLocation(true);
      
      // Build the request in the format expected by the API
      const request: any = {
        name: values.name,
        type: values.locationType,
      };
      
      if (values.locationType === 'S3') {
        const isCrossAccount = values.isCrossAccount || false;
        if (isCrossAccount) {
          // External account bucket - construct ARN from bucket name
          request.s3Config = {
            bucketArn: `arn:aws:s3:::${values.externalBucketName}`,
            subdirectory: values.subdirectory || '/',
            isCrossAccount: true,
          };
        } else {
          // Same account bucket - use selected ARN
          request.s3Config = {
            bucketArn: values.bucketArn,
            isCrossAccount: false,
          };
        }
      } else {
        request.fsxConfig = {
          storageId: values.storageId,
        };
      }
      
      await createDataSyncLocation(request);
      setAlert({ type: 'success', message: 'Location created successfully' });
      setShowCreateLocationModal(false);
      locationForm.resetFields();
      fetchData();
    } catch (error: any) {
      // Check if it's a bucket access denied error for cross-account
      if (error.message?.includes('BUCKET_ACCESS_DENIED') || error.message?.includes('Access denied')) {
        setAlert({ 
          type: 'error', 
          message: 'Access denied to S3 bucket. Please ensure the bucket policy has been applied to grant DataSync access.' 
        });
      } else {
        setAlert({ type: 'error', message: error.message || 'Failed to create location' });
      }
    } finally {
      setCreatingLocation(false);
    }
  };

  const openEditTaskModal = (task: DataSyncTask) => {
    setEditingTask(task);
    const taskOptions = task.options || DEFAULT_OPTIONS;
    // Convert bytes/sec to MB/s for display
    const bandwidthLimit = taskOptions.bytesPerSecond 
      ? taskOptions.bytesPerSecond / (1024 * 1024) 
      : undefined;
    
    taskForm.setFieldsValue({
      name: task.name,
      sourceLocationId: task.sourceLocationId,
      destinationLocationId: task.destinationLocationId,
      preset: 'custom', // When editing, always show custom
      transferMode: taskOptions.transferMode,
      verifyMode: taskOptions.verifyMode,
      overwriteMode: taskOptions.overwriteMode,
      preserveDeletedFiles: taskOptions.preserveDeletedFiles,
      logLevel: taskOptions.logLevel,
      bandwidthLimit,
    });
    setShowCreateTaskModal(true);
  };

  const getStatusColor = (status: string) => {
    const colorMap: Record<string, string> = {
      available: 'green',
      creating: 'blue',
      running: 'blue',
      deleting: 'default',
      error: 'red',
      invalid: 'red',
      SUCCESS: 'green',
      ERROR: 'red',
      TRANSFERRING: 'blue',
      VERIFYING: 'blue',
      PREPARING: 'blue',
      LAUNCHING: 'blue',
      QUEUED: 'default',
    };
    return colorMap[status] || 'default';
  };

  const getLocationTypeColor = (type: string) => {
    const colorMap: Record<string, string> = {
      S3: 'green',
      FSX_ONTAP: 'purple',
      FSX_WINDOWS: 'blue',
    };
    return colorMap[type] || 'default';
  };

  const getLocationTypeLabel = (type: string) => {
    const labelMap: Record<string, string> = {
      S3: 'S3',
      FSX_ONTAP: 'FSx ONTAP',
      FSX_WINDOWS: 'FSx Windows',
    };
    return labelMap[type] || type;
  };

  // Task columns
  const taskColumns: ColumnsType<DataSyncTask> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      sorter: (a, b) => (a.name || '').localeCompare(b.name || ''),
      sortOrder: taskSortedInfo?.columnKey === 'name' ? taskSortedInfo.order : null,
      render: (text, record) => (
        <Link onClick={() => (window.location.href = `/datasync/tasks/${record.taskId}`)}>
          {text}
        </Link>
      ),
    },
    {
      title: 'Source',
      key: 'source',
      width: 160,
      render: (_, record) => getLocationName(record.sourceLocationId),
    },
    {
      title: 'Destination',
      key: 'destination',
      width: 160,
      render: (_, record) => getLocationName(record.destinationLocationId),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      sorter: (a, b) => (a.status || '').localeCompare(b.status || ''),
      sortOrder: taskSortedInfo?.columnKey === 'status' ? taskSortedInfo.order : null,
      render: (status) => (
        <Tag color={getStatusColor(status)}>
          {status?.charAt(0).toUpperCase() + status?.slice(1).toLowerCase()}
        </Tag>
      ),
    },
    {
      title: 'Last Run',
      key: 'lastRun',
      width: 200,
      render: (_, record) => {
        if (!record.lastExecutionTime) return '-';
        return (
          <Space>
            {record.lastExecutionStatus && (
              <Tag color={getStatusColor(record.lastExecutionStatus)}>
                {record.lastExecutionStatus}
              </Tag>
            )}
            <Text type="secondary">{new Date(record.lastExecutionTime).toLocaleString()}</Text>
          </Space>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Space>
          <Tooltip title="Run task">
            <Button
              type="text"
              icon={<PlayCircleOutlined />}
              onClick={() => handleRunTask(record)}
              disabled={record.status !== 'available' || runningTaskId === record.taskId}
              loading={runningTaskId === record.taskId}
            />
          </Tooltip>
          <Tooltip title="Edit">
            <Button
              type="text"
              icon={<EditOutlined />}
              onClick={() => openEditTaskModal(record)}
              disabled={!isAdmin}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  // Location columns
  const locationColumns: ColumnsType<DataSyncLocation> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      sorter: (a, b) => (a.name || '').localeCompare(b.name || ''),
      sortOrder: locationSortedInfo?.columnKey === 'name' ? locationSortedInfo.order : null,
    },
    {
      title: 'Type',
      dataIndex: 'locationType',
      key: 'locationType',
      width: 120,
      sorter: (a, b) => (a.locationType || '').localeCompare(b.locationType || ''),
      sortOrder: locationSortedInfo?.columnKey === 'locationType' ? locationSortedInfo.order : null,
      render: (type) => <Tag color={getLocationTypeColor(type)}>{getLocationTypeLabel(type)}</Tag>,
    },
    {
      title: 'Details',
      key: 'details',
      width: 250,
      render: (_, record) => {
        if (record.locationType === 'S3') {
          const bucketName = record.bucketArn?.split(':').pop() || '-';
          const subdirectory = record.subdirectory && record.subdirectory !== '/' ? record.subdirectory : null;
          return (
            <Space direction="vertical" size={0}>
              <span>{bucketName}</span>
              {subdirectory && <Text type="secondary" style={{ fontSize: 12 }}>Path: {subdirectory}</Text>}
              {record.isCrossAccount && <Tag color="orange" style={{ fontSize: 10 }}>Cross-account</Tag>}
            </Space>
          );
        }
        return record.storageId || '-';
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      sorter: (a, b) => (a.status || '').localeCompare(b.status || ''),
      sortOrder: locationSortedInfo?.columnKey === 'status' ? locationSortedInfo.order : null,
      render: (status) => (
        <Tag color={getStatusColor(status)}>
          {status?.charAt(0).toUpperCase() + status?.slice(1).toLowerCase()}
        </Tag>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 120,
      sorter: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
      sortOrder: locationSortedInfo?.columnKey === 'createdAt' ? locationSortedInfo.order : null,
      render: (date) => (date ? new Date(date).toLocaleDateString() : '-'),
    },
  ];

  const locationType = Form.useWatch('locationType', locationForm);
  const isCrossAccount = Form.useWatch('isCrossAccount', locationForm);

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
            { title: 'Data Transfer' },
          ]}
        />

        {/* Header */}
        <Title level={3} style={{ marginBottom: 24 }}>Data Transfer</Title>

        {alert && (
          <Alert
            type={alert.type}
            message={alert.message}
            closable
            onClose={() => setAlert(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        <Tabs
          defaultActiveKey="tasks"
          items={[
            {
              key: 'tasks',
              label: (
                <Space>
                  <SwapOutlined />
                  <span>Tasks ({tasks.length})</span>
                </Space>
              ),
              children: (
                <Card>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <Text type="secondary">
                      Configure and run DataSync tasks to transfer data between S3 and FSx storage
                    </Text>
                    <Space>
                      <Tooltip title="Refresh">
                        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading} />
                      </Tooltip>
                      <Button
                        onClick={() => {
                          if (selectedTasks.length === 1) {
                            handleRunTask(selectedTasks[0]);
                          }
                        }}
                        disabled={selectedTaskKeys.length !== 1 || selectedTasks[0]?.status !== 'available' || runningTaskId !== null}
                        loading={runningTaskId === selectedTasks[0]?.taskId}
                      >
                        Run
                      </Button>
                      <Button
                        onClick={handleDeleteTasks}
                        disabled={selectedTaskKeys.length === 0 || !isAdmin}
                        loading={deletingTasks}
                      >
                        Delete
                      </Button>
                      <Button
                        type="primary"
                        icon={<PlusOutlined />}
                        onClick={() => {
                          setEditingTask(null);
                          taskForm.resetFields();
                          setShowCreateTaskModal(true);
                        }}
                        disabled={!isAdmin || locations.length < 2}
                      >
                        Create Task
                      </Button>
                    </Space>
                  </div>
                  <Table
                    rowKey="taskId"
                    columns={taskColumns}
                    dataSource={tasks}
                    loading={loading}
                    rowSelection={{
                      selectedRowKeys: selectedTaskKeys,
                      onChange: setSelectedTaskKeys,
                    }}
                    onChange={handleTaskTableChange}
                    pagination={{
                      pageSize: taskPageSize,
                      showSizeChanger: true,
                      pageSizeOptions: ['10', '20', '50'],
                      onShowSizeChange: handleTaskPageSizeChange,
                      showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
                    }}
                    locale={{
                      emptyText: loading ? null : (
                        <div style={{ padding: 40 }}>
                          <SwapOutlined style={{ fontSize: 48, color: '#ccc', marginBottom: 16 }} />
                          <div>No tasks</div>
                          <div style={{ color: '#999', marginTop: 8 }}>Create a task to transfer data between locations.</div>
                        </div>
                      ),
                    }}
                  />
                </Card>
              ),
            },
            {
              key: 'locations',
              label: (
                <Space>
                  <EnvironmentOutlined />
                  <span>Locations ({locations.length})</span>
                </Space>
              ),
              children: (
                <Card>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <Text type="secondary">
                      S3 buckets and FSx storage locations used as sources or destinations for data transfer
                    </Text>
                    <Space>
                      <Tooltip title="Refresh">
                        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading} />
                      </Tooltip>
                      <Button
                        onClick={handleDeleteLocations}
                        disabled={selectedLocationKeys.length === 0 || !isAdmin}
                        loading={deletingLocations}
                      >
                        Delete
                      </Button>
                      <Button
                        type="primary"
                        icon={<PlusOutlined />}
                        onClick={() => {
                          locationForm.resetFields();
                          setPolicyConfirmed(false);
                          setShowCreateLocationModal(true);
                        }}
                        disabled={!isAdmin}
                      >
                        Create Location
                      </Button>
                    </Space>
                  </div>
                  <Table
                    rowKey="locationId"
                    columns={locationColumns}
                    dataSource={locations}
                    loading={loading}
                    rowSelection={{
                      selectedRowKeys: selectedLocationKeys,
                      onChange: setSelectedLocationKeys,
                    }}
                    onChange={handleLocationTableChange}
                    pagination={{
                      pageSize: locationPageSize,
                      showSizeChanger: true,
                      pageSizeOptions: ['10', '20', '50'],
                      onShowSizeChange: handleLocationPageSizeChange,
                      showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
                    }}
                    locale={{
                      emptyText: loading ? null : (
                        <div style={{ padding: 40 }}>
                          <EnvironmentOutlined style={{ fontSize: 48, color: '#ccc', marginBottom: 16 }} />
                          <div>No locations</div>
                          <div style={{ color: '#999', marginTop: 8 }}>Create S3 or FSx locations to use in data transfer tasks.</div>
                        </div>
                      ),
                    }}
                  />
                </Card>
              ),
            },
          ]}
        />

        {/* Create/Edit Task Modal */}
        <Modal
          title={editingTask ? 'Edit Task' : 'Create Task'}
          open={showCreateTaskModal}
          onCancel={() => {
            setShowCreateTaskModal(false);
            setEditingTask(null);
          }}
          onOk={handleCreateTask}
          confirmLoading={creatingTask}
          okText={editingTask ? 'Update' : 'Create'}
          width={640}
        >
          <Form 
            form={taskForm} 
            layout="vertical"
            initialValues={{
              preset: 'incremental',
              ...DEFAULT_OPTIONS,
            }}
          >
            <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
              <Input ref={createTaskNameRef} placeholder="Enter task name" />
            </Form.Item>
            <Form.Item 
              name="sourceLocationId" 
              label="Source Location" 
              rules={[{ required: !editingTask, message: 'Source location is required' }]}
              tooltip={editingTask ? 'Source cannot be changed after task creation' : undefined}
            >
              <Select
                placeholder="Select source location"
                disabled={!!editingTask}
                options={locations
                  .filter(l => l.status === 'available')
                  .map((l) => ({
                    label: `${l.name} (${getLocationTypeLabel(l.locationType)})`,
                    value: l.locationId,
                  }))}
              />
            </Form.Item>
            <Form.Item 
              name="destinationLocationId" 
              label="Destination Location" 
              rules={[{ required: !editingTask, message: 'Destination location is required' }]}
              tooltip={editingTask ? 'Destination cannot be changed after task creation' : undefined}
            >
              <Select
                placeholder="Select destination location"
                disabled={!!editingTask}
                options={locations
                  .filter(l => l.status === 'available')
                  .map((l) => ({
                    label: `${l.name} (${getLocationTypeLabel(l.locationType)})`,
                    value: l.locationId,
                  }))}
              />
            </Form.Item>

            <Divider plain>
              <Space>
                <SettingOutlined />
                Transfer Options
              </Space>
            </Divider>

            <Form.Item name="preset" label="Configuration Preset">
              <Select
                options={Object.entries(TASK_PRESETS).map(([key, preset]) => ({
                  value: key,
                  label: preset.label,
                }))}
                onChange={(value) => {
                  const preset = TASK_PRESETS[value as keyof typeof TASK_PRESETS];
                  if (preset.options) {
                    taskForm.setFieldsValue(preset.options);
                  }
                }}
              />
            </Form.Item>

            <Form.Item noStyle shouldUpdate={(prev, curr) => prev.preset !== curr.preset}>
              {({ getFieldValue }) => {
                const preset = getFieldValue('preset');
                const presetInfo = TASK_PRESETS[preset as keyof typeof TASK_PRESETS];
                return presetInfo && preset !== 'custom' ? (
                  <Alert
                    type="info"
                    message={presetInfo.description}
                    style={{ marginBottom: 16 }}
                  />
                ) : null;
              }}
            </Form.Item>

            <Collapse 
              ghost 
              defaultActiveKey={editingTask ? ['advanced'] : []}
              items={[{
                key: 'advanced',
                label: 'Advanced Options',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Form.Item 
                      name="transferMode" 
                      label="Transfer Mode"
                      tooltip="Which files to transfer"
                    >
                      <Radio.Group>
                        <Radio.Button value="CHANGED">Changed files only</Radio.Button>
                        <Radio.Button value="ALL">All files</Radio.Button>
                      </Radio.Group>
                    </Form.Item>

                    <Form.Item 
                      name="verifyMode" 
                      label="Verification Mode"
                      tooltip="How to verify transferred data"
                    >
                      <Radio.Group>
                        <Radio.Button value="ONLY_FILES_TRANSFERRED">Transferred files</Radio.Button>
                        <Radio.Button value="POINT_IN_TIME_CONSISTENT">Full verification</Radio.Button>
                        <Radio.Button value="NONE">None</Radio.Button>
                      </Radio.Group>
                    </Form.Item>

                    <Form.Item 
                      name="overwriteMode" 
                      label="Overwrite Mode"
                      tooltip="How to handle existing files at destination"
                    >
                      <Radio.Group>
                        <Radio.Button value="ALWAYS">Always overwrite</Radio.Button>
                        <Radio.Button value="NEVER">Never overwrite</Radio.Button>
                      </Radio.Group>
                    </Form.Item>

                    <Form.Item 
                      name="preserveDeletedFiles" 
                      label="Deleted Files"
                      tooltip="How to handle files deleted from source"
                    >
                      <Radio.Group>
                        <Radio.Button value="PRESERVE">Preserve at destination</Radio.Button>
                        <Radio.Button value="REMOVE">Remove from destination</Radio.Button>
                      </Radio.Group>
                    </Form.Item>

                    <Form.Item 
                      name="logLevel" 
                      label="Log Level"
                      tooltip="Amount of detail in CloudWatch logs"
                    >
                      <Radio.Group>
                        <Radio.Button value="OFF">Off</Radio.Button>
                        <Radio.Button value="BASIC">Basic</Radio.Button>
                        <Radio.Button value="TRANSFER">Detailed</Radio.Button>
                      </Radio.Group>
                    </Form.Item>

                    <Form.Item 
                      name="bandwidthLimit" 
                      label="Bandwidth Limit (MB/s)"
                      tooltip="Maximum transfer speed (leave empty for unlimited)"
                    >
                      <InputNumber 
                        min={1} 
                        placeholder="Unlimited" 
                        style={{ width: 200 }}
                        addonAfter="MB/s"
                      />
                    </Form.Item>
                  </Space>
                ),
              }]}
            />
          </Form>
        </Modal>

        {/* Create Location Modal */}
        <Modal
          title="Create Location"
          open={showCreateLocationModal}
          onCancel={() => {
            setShowCreateLocationModal(false);
            setPolicyConfirmed(false);
          }}
          onOk={handleCreateLocation}
          confirmLoading={creatingLocation}
          okText="Create"
          okButtonProps={{
            disabled: locationType === 'S3' && isCrossAccount && !policyConfirmed,
          }}
          width={640}
        >
          <Form form={locationForm} layout="vertical">
            <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
              <Input ref={createLocationNameRef} placeholder="Enter location name" />
            </Form.Item>
            <Form.Item name="locationType" label="Type" rules={[{ required: true }]}>
              <Select
                placeholder="Select location type"
                options={[
                  { label: 'Amazon S3', value: 'S3' },
                  { label: 'FSx for ONTAP', value: 'FSX_ONTAP' },
                  { label: 'FSx for Windows', value: 'FSX_WINDOWS' },
                ]}
              />
            </Form.Item>

            {locationType === 'S3' && (
              <>
                <Form.Item name="isCrossAccount" label="Bucket Location" initialValue={false}>
                  <Radio.Group>
                    <Radio.Button value={false}>Same Account</Radio.Button>
                    <Radio.Button value={true}>External Account</Radio.Button>
                  </Radio.Group>
                </Form.Item>

                <Form.Item noStyle shouldUpdate={(prev, curr) => prev.isCrossAccount !== curr.isCrossAccount}>
                  {({ getFieldValue }) => {
                    const isCrossAccount = getFieldValue('isCrossAccount');
                    if (!isCrossAccount) {
                      return (
                        <Form.Item name="bucketArn" label="S3 Bucket" rules={[{ required: true }]}>
                          <Select
                            placeholder="Select S3 bucket"
                            showSearch
                            filterOption={(input, option) =>
                              (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                            }
                            options={s3Buckets.map((b) => ({
                              label: b.name,
                              value: `arn:aws:s3:::${b.name}`,
                            }))}
                          />
                        </Form.Item>
                      );
                    }
                    return (
                      <>
                        <Form.Item
                          name="externalBucketName"
                          label="Bucket Name"
                          rules={[
                            { required: true, message: 'Bucket name is required' },
                            { pattern: /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, message: 'Invalid bucket name format' },
                          ]}
                          tooltip="Enter the name of the S3 bucket in the external account"
                        >
                          <Input placeholder="my-external-bucket" />
                        </Form.Item>
                        <Form.Item
                          name="subdirectory"
                          label="Subdirectory (Optional)"
                          tooltip="Path prefix within the bucket (e.g., /data/uploads)"
                        >
                          <Input placeholder="/" />
                        </Form.Item>
                        <Alert
                          type="warning"
                          showIcon
                          message="Bucket Policy Required"
                          description="The external bucket owner must add a bucket policy to allow DataSync access. Copy the policy below and add it to the bucket."
                          style={{ marginBottom: 16 }}
                        />
                        <Form.Item noStyle shouldUpdate={(prev, curr) => prev.externalBucketName !== curr.externalBucketName}>
                          {({ getFieldValue: getVal }) => {
                            const bucketName = getVal('externalBucketName') || 'YOUR-BUCKET-NAME';
                            const roleArn = dataSyncConfig?.dataSyncRoleArn || 'arn:aws:iam::ACCOUNT_ID:role/MRM-DataSync-S3-Access';
                            const policy = {
                              Version: '2012-10-17',
                              Statement: [
                                {
                                  Sid: 'DataSyncBucketAccess',
                                  Effect: 'Allow',
                                  Principal: { AWS: roleArn },
                                  Action: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'],
                                  Resource: `arn:aws:s3:::${bucketName}`,
                                },
                                {
                                  Sid: 'DataSyncObjectAccess',
                                  Effect: 'Allow',
                                  Principal: { AWS: roleArn },
                                  Action: ['s3:GetObject', 's3:GetObjectTagging', 's3:GetObjectVersion', 's3:GetObjectVersionTagging', 's3:ListMultipartUploadParts'],
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
                                  checked={policyConfirmed}
                                  onChange={(e) => setPolicyConfirmed(e.target.checked)}
                                  style={{ marginTop: 16 }}
                                >
                                  I have added this policy to the external bucket
                                </Checkbox>
                              </div>
                            );
                          }}
                        </Form.Item>
                      </>
                    );
                  }}
                </Form.Item>
              </>
            )}

            {(locationType === 'FSX_ONTAP' || locationType === 'FSX_WINDOWS') && (
              <Form.Item name="storageId" label="Storage Resource" rules={[{ required: true }]}>
                <Select
                  placeholder="Select storage resource"
                  options={storageResources
                    .filter((s) => {
                      if (locationType === 'FSX_ONTAP') return s.type === 'fsx-ontap';
                      if (locationType === 'FSX_WINDOWS') return s.type === 'fsx-windows';
                      return false;
                    })
                    .map((s) => ({
                      label: s.name,
                      value: s.storageId,
                    }))}
                />
              </Form.Item>
            )}
          </Form>
        </Modal>
      </div>
    </AppLayoutAntd>
  );
};

export default DataTransferAntd;
