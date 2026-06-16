// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ContentLayout,
  Header,
  SpaceBetween,
  Container,
  StatusIndicator,
  KeyValuePairs,
  Button,
  Alert,
  Box,
  Table,
  BreadcrumbGroup,
  Grid,
  Tabs,
  Spinner
} from '@cloudscape-design/components';
import {
  DataSyncTask,
  DataSyncLocation,
  TaskExecution,
  listDataSyncLocations,
  listDataSyncTasks,
  getTaskExecutions,
  startTaskExecution
} from '../utils/datasyncApi';

interface TaskDetailsProps {
  user: any;
  isAdmin: boolean;
}

const TaskDetails: React.FC<TaskDetailsProps> = () => {
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

  const getLocationName = (locationId: string) => {
    const location = locations.find(l => l.locationId === locationId);
    return location?.name || locationId;
  };

  const getLocationType = (locationId: string) => {
    const location = locations.find(l => l.locationId === locationId);
    if (!location) return '-';
    if (location.locationType === 'S3') return 'Amazon S3';
    if (location.locationType === 'FSX_ONTAP') return 'FSx for NetApp ONTAP';
    return 'FSx for Windows';
  };

  const getLocationUri = (locationId: string) => {
    const location = locations.find(l => l.locationId === locationId);
    if (!location) return '-';
    if (location.locationType === 'S3') {
      return location.bucketArn?.split(':').pop() || '-';
    }
    return location.storageId || '-';
  };

  const getStatusIndicator = (status: string) => {
    const statusMap: Record<string, 'success' | 'pending' | 'error' | 'info' | 'in-progress'> = {
      available: 'success',
      creating: 'pending',
      running: 'in-progress',
      deleting: 'pending',
      error: 'error',
      invalid: 'error',
      SUCCESS: 'success',
      ERROR: 'error',
      TRANSFERRING: 'in-progress',
      VERIFYING: 'in-progress',
      PREPARING: 'pending',
      LAUNCHING: 'pending',
      QUEUED: 'pending'
    };
    const displayStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
    return <StatusIndicator type={statusMap[status] || 'info'}>{displayStatus}</StatusIndicator>;
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
    if (hours > 0) return hours + 'h ' + minutes + 'm ' + secs + 's';
    if (minutes > 0) return minutes + 'm ' + secs + 's';
    return secs + 's';
  };

  const executionColumns = [
    { id: 'status', header: 'Status', cell: (item: TaskExecution) => getStatusIndicator(item.status) },
    { id: 'startTime', header: 'Start Time', cell: (item: TaskExecution) => new Date(item.startTime).toLocaleString() },
    { id: 'endTime', header: 'End Time', cell: (item: TaskExecution) => item.endTime ? new Date(item.endTime).toLocaleString() : '-' },
    { id: 'duration', header: 'Duration', cell: (item: TaskExecution) => formatDuration(item.duration) },
    { id: 'bytesTransferred', header: 'Data Transferred', cell: (item: TaskExecution) => formatBytes(item.bytesTransferred) },
    { id: 'filesTransferred', header: 'Files', cell: (item: TaskExecution) => item.filesTransferred?.toLocaleString() || '-' }
  ];

  if (loading) {
    return (
      <ContentLayout
        defaultPadding
        headerVariant="high-contrast"
        maxContentWidth={1200}
        header={
          <Box padding={{ vertical: 'l' }}>
            <Box variant="h1" fontSize="display-l">Loading...</Box>
          </Box>
        }
      >
        <Container>
          <Box textAlign="center" padding="xxl">
            <Spinner size="large" />
          </Box>
        </Container>
      </ContentLayout>
    );
  }

  if (error) {
    return (
      <ContentLayout
        defaultPadding
        headerVariant="high-contrast"
        maxContentWidth={1200}
        breadcrumbs={
          <BreadcrumbGroup
            items={[
              { text: 'Dashboard', href: '/dashboard' },
              { text: 'Storage', href: '/storage' },
              { text: 'Task Details', href: '#' }
            ]}
            ariaLabel="Breadcrumbs"
          />
        }
        header={
          <Box padding={{ vertical: 'l' }}>
            <Box variant="h1" fontSize="display-l">Task Details</Box>
          </Box>
        }
      >
        <Alert type="error" header="Error loading task">{error}</Alert>
      </ContentLayout>
    );
  }

  const generalItems = [
    {
      type: 'group' as const,
      title: 'Task Information',
      items: [
        { label: 'Task ID', value: task?.taskId || '-' },
        { label: 'Status', value: task ? getStatusIndicator(task.status) : '-' },
        { label: 'Created', value: task?.createdAt ? new Date(task.createdAt).toLocaleString() : '-' }
      ]
    },
    {
      type: 'group' as const,
      title: 'Source Location',
      items: [
        { label: 'Name', value: task ? getLocationName(task.sourceLocationId) : '-' },
        { label: 'Type', value: task ? getLocationType(task.sourceLocationId) : '-' },
        { label: 'URI', value: task ? getLocationUri(task.sourceLocationId) : '-' }
      ]
    },
    {
      type: 'group' as const,
      title: 'Destination Location',
      items: [
        { label: 'Name', value: task ? getLocationName(task.destinationLocationId) : '-' },
        { label: 'Type', value: task ? getLocationType(task.destinationLocationId) : '-' },
        { label: 'URI', value: task ? getLocationUri(task.destinationLocationId) : '-' }
      ]
    }
  ];

  const optionsItems = [
    {
      type: 'group' as const,
      title: 'Transfer Settings',
      items: [
        { label: 'Transfer Mode', value: task?.options?.transferMode || '-' },
        { label: 'Verify Mode', value: task?.options?.verifyMode || '-' },
        { label: 'Overwrite Mode', value: task?.options?.overwriteMode || '-' }
      ]
    },
    {
      type: 'group' as const,
      title: 'Additional Options',
      items: [
        { label: 'Preserve Deleted Files', value: task?.options?.preserveDeletedFiles || '-' },
        { label: 'Log Level', value: task?.options?.logLevel || '-' },
        { label: 'Bandwidth Limit', value: task?.options?.bytesPerSecond ? `${(task.options.bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s` : 'Unlimited' }
      ]
    }
  ];

  return (
    <ContentLayout
      defaultPadding
      headerVariant="high-contrast"
      maxContentWidth={1200}
      breadcrumbs={
        <BreadcrumbGroup
          items={[
            { text: 'Dashboard', href: '/dashboard' },
            { text: 'Storage', href: '/storage' },
            { text: task?.name || 'Task Details', href: '#' }
          ]}
          ariaLabel="Breadcrumbs"
        />
      }
      header={
        <Box padding={{ vertical: 'l' }}>
          <Grid
            gridDefinition={[
              { colspan: { default: 12, xs: 8, s: 9 } },
              { colspan: { default: 12, xs: 4, s: 3 } }
            ]}
          >
            <div>
              <Box variant="h1" fontSize="display-l">Data Transfer Task</Box>
              <Box variant="h3" color="text-body-secondary" margin={{ top: 'xxs', bottom: 's' }}>
                {task?.name}
              </Box>
            </div>
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={() => navigate('/storage')}>Back</Button>
                <Button
                  variant="primary"
                  onClick={handleRunTask}
                  loading={runningExecution}
                  disabled={task?.status !== 'available'}
                >
                  Run task
                </Button>
              </SpaceBetween>
            </Box>
          </Grid>
        </Box>
      }
    >
      <SpaceBetween size="l">
        {alert && (
          <Alert type={alert.type} dismissible onDismiss={() => setAlert(null)}>
            {alert.message}
          </Alert>
        )}
        <Container>
          <Tabs
            tabs={[
              {
                label: 'General',
                id: 'general',
                content: (
                  <Container header={<Header variant="h2">Task Configuration</Header>}>
                    <KeyValuePairs columns={3} items={generalItems} />
                  </Container>
                )
              },
              {
                label: 'Options',
                id: 'options',
                content: (
                  <Container header={<Header variant="h2">Transfer Options</Header>}>
                    <KeyValuePairs columns={3} items={optionsItems} />
                  </Container>
                )
              },
              {
                label: 'Executions',
                id: 'executions',
                content: (
                  <Container
                    header={
                      <Header
                        variant="h2"
                        counter={'(' + executions.length + ')'}
                        actions={
                          <Button iconName="refresh" onClick={fetchExecutions} loading={executionsLoading}>
                            Refresh
                          </Button>
                        }
                      >
                        Execution History
                      </Header>
                    }
                  >
                    <Table
                      columnDefinitions={executionColumns}
                      items={executions}
                      loading={executionsLoading}
                      loadingText="Loading executions..."
                      empty={
                        <Box textAlign="center" color="inherit">
                          <b>No executions</b>
                          <Box padding={{ bottom: 's' }} variant="p" color="inherit">
                            Run the task to see execution history.
                          </Box>
                        </Box>
                      }
                      trackBy="executionId"
                    />
                  </Container>
                )
              }
            ]}
          />
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
};

export default TaskDetails;
