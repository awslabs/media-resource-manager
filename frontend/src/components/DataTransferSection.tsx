// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useCallback } from 'react';
import {
  SpaceBetween,
  Button,
  Table,
  Box,
  Badge,
  Header,
  ExpandableSection,
  Alert,
  ButtonDropdown,
  StatusIndicator,
  Link
} from '@cloudscape-design/components';
import {
  DataSyncTask,
  DataSyncLocation,
  S3Bucket,
  listDataSyncTasks,
  listDataSyncLocations,
  listS3Buckets,
  deleteDataSyncTask,
  deleteDataSyncLocation,
  startTaskExecution
} from '../utils/datasyncApi';
import CreateLocationModal from './CreateLocationModal';
import CreateTaskModal from './CreateTaskModal';

interface StorageResource {
  storageId: string;
  name: string;
  type: string;
  status: string;
}

interface DataTransferSectionProps {
  isAdmin: boolean;
  storageResources: StorageResource[];
}

const DataTransferSection: React.FC<DataTransferSectionProps> = ({ isAdmin, storageResources }) => {
  const [tasks, setTasks] = useState<DataSyncTask[]>([]);
  const [locations, setLocations] = useState<DataSyncLocation[]>([]);
  const [s3Buckets, setS3Buckets] = useState<S3Bucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTasks, setSelectedTasks] = useState<DataSyncTask[]>([]);
  const [selectedLocations, setSelectedLocations] = useState<DataSyncLocation[]>([]);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  
  // Modal states
  const [showCreateTaskModal, setShowCreateTaskModal] = useState(false);
  const [showCreateLocationModal, setShowCreateLocationModal] = useState(false);
  const [editingTask, setEditingTask] = useState<DataSyncTask | null>(null);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [tasksData, locationsData, bucketsData] = await Promise.all([
        listDataSyncTasks(),
        listDataSyncLocations(),
        listS3Buckets().catch(() => []) // S3 buckets are optional
      ]);
      setTasks(tasksData);
      setLocations(locationsData);
      setS3Buckets(bucketsData);
    } catch (error: any) {
      setAlert({ type: 'error', message: `Failed to load data: ${error.message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRunTask = async (task: DataSyncTask) => {
    try {
      setRunningTaskId(task.taskId);
      await startTaskExecution(task.taskId);
      setAlert({ type: 'success', message: `Task "${task.name}" execution started` });
      fetchData(); // Refresh to show updated status
    } catch (error: any) {
      setAlert({ type: 'error', message: `Failed to start task: ${error.message}` });
    } finally {
      setRunningTaskId(null);
    }
  };

  const handleDeleteTasks = async () => {
    try {
      await Promise.all(selectedTasks.map(task => deleteDataSyncTask(task.taskId)));
      setAlert({ type: 'success', message: `Deleted ${selectedTasks.length} task(s)` });
      setSelectedTasks([]);
      fetchData();
    } catch (error: any) {
      setAlert({ type: 'error', message: `Failed to delete tasks: ${error.message}` });
    }
  };

  const handleDeleteLocations = async () => {
    try {
      await Promise.all(selectedLocations.map(loc => deleteDataSyncLocation(loc.locationId)));
      setAlert({ type: 'success', message: `Deleted ${selectedLocations.length} location(s)` });
      setSelectedLocations([]);
      fetchData();
    } catch (error: any) {
      setAlert({ type: 'error', message: `Failed to delete locations: ${error.message}` });
    }
  };

  const getLocationName = (locationId: string) => {
    const location = locations.find(l => l.locationId === locationId);
    return location?.name || locationId;
  };

  const getStatusBadge = (status: string) => {
    const colorMap: Record<string, 'green' | 'blue' | 'grey' | 'red'> = {
      available: 'green',
      creating: 'blue',
      running: 'blue',
      deleting: 'grey',
      error: 'red',
      invalid: 'red',
      SUCCESS: 'green',
      ERROR: 'red',
      TRANSFERRING: 'blue',
      VERIFYING: 'blue',
      PREPARING: 'blue',
      LAUNCHING: 'blue',
      QUEUED: 'grey'
    };
    return (
      <Badge color={colorMap[status] || 'grey'}>
        {status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}
      </Badge>
    );
  };

  const getLocationTypeBadge = (type: string) => {
    const colorMap: Record<string, 'blue' | 'green' | 'grey'> = {
      S3: 'green',
      FSX_ONTAP: 'blue',
      FSX_WINDOWS: 'grey'
    };
    const labelMap: Record<string, string> = {
      S3: 'S3',
      FSX_ONTAP: 'FSx ONTAP',
      FSX_WINDOWS: 'FSx Windows'
    };
    return (
      <Badge color={colorMap[type] || 'grey'}>
        {labelMap[type] || type}
      </Badge>
    );
  };

  const taskColumns = [
    {
      id: 'name',
      header: 'Name',
      cell: (item: DataSyncTask) => (
        <Link 
          variant="primary"
          onFollow={(event) => {
            event.preventDefault();
            window.location.href = `/datasync/tasks/${item.taskId}`;
          }}
        >
          {item.name}
        </Link>
      ),
      sortingField: 'name'
    },
    {
      id: 'source',
      header: 'Source',
      cell: (item: DataSyncTask) => getLocationName(item.sourceLocationId)
    },
    {
      id: 'destination',
      header: 'Destination',
      cell: (item: DataSyncTask) => getLocationName(item.destinationLocationId)
    },
    {
      id: 'status',
      header: 'Status',
      cell: (item: DataSyncTask) => getStatusBadge(item.status)
    },
    {
      id: 'lastRun',
      header: 'Last Run',
      cell: (item: DataSyncTask) => {
        if (!item.lastExecutionTime) return '-';
        return (
          <SpaceBetween direction="horizontal" size="xs">
            {item.lastExecutionStatus && getStatusBadge(item.lastExecutionStatus)}
            <span>{new Date(item.lastExecutionTime).toLocaleString()}</span>
          </SpaceBetween>
        );
      }
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (item: DataSyncTask) => (
        <SpaceBetween direction="horizontal" size="xs">
          <Button
            variant="inline-icon"
            iconName="caret-right-filled"
            onClick={() => handleRunTask(item)}
            disabled={item.status !== 'available' || runningTaskId === item.taskId}
            loading={runningTaskId === item.taskId}
            ariaLabel="Run task"
          />
          <Button
            variant="inline-icon"
            iconName="edit"
            onClick={() => {
              setEditingTask(item);
              setShowCreateTaskModal(true);
            }}
            disabled={!isAdmin}
            ariaLabel="Edit task"
          />
        </SpaceBetween>
      )
    }
  ];

  const locationColumns = [
    {
      id: 'name',
      header: 'Name',
      cell: (item: DataSyncLocation) => item.name,
      sortingField: 'name'
    },
    {
      id: 'type',
      header: 'Type',
      cell: (item: DataSyncLocation) => getLocationTypeBadge(item.locationType)
    },
    {
      id: 'details',
      header: 'Details',
      cell: (item: DataSyncLocation) => {
        if (item.locationType === 'S3') {
          return item.bucketArn?.split(':').pop() || '-';
        }
        return item.storageId || '-';
      }
    },
    {
      id: 'status',
      header: 'Status',
      cell: (item: DataSyncLocation) => getStatusBadge(item.status)
    },
    {
      id: 'createdAt',
      header: 'Created',
      cell: (item: DataSyncLocation) => 
        item.createdAt ? new Date(item.createdAt).toLocaleString() : '-'
    }
  ];

  return (
    <SpaceBetween size="l">
      {alert && (
        <Alert
          type={alert.type}
          dismissible
          onDismiss={() => setAlert(null)}
        >
          {alert.message}
        </Alert>
      )}

      {/* DataSync Tasks Table */}
      <Table
        header={
          <Header
            variant="h2"
            counter={`(${tasks.length})`}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  iconName="refresh"
                  onClick={fetchData}
                  loading={loading}
                />
                <Button
                  onClick={() => {
                    if (selectedTasks.length === 1) {
                      setEditingTask(selectedTasks[0]);
                      setShowCreateTaskModal(true);
                    }
                  }}
                  disabled={selectedTasks.length !== 1 || !isAdmin}
                >
                  Edit
                </Button>
                <Button
                  onClick={handleDeleteTasks}
                  disabled={selectedTasks.length === 0 || !isAdmin}
                >
                  Delete
                </Button>
                <Button
                  onClick={() => {
                    if (selectedTasks.length === 1) {
                      handleRunTask(selectedTasks[0]);
                    }
                  }}
                  disabled={selectedTasks.length !== 1 || selectedTasks[0]?.status !== 'available' || runningTaskId !== null}
                  loading={runningTaskId === selectedTasks[0]?.taskId}
                >
                  Run task
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setEditingTask(null);
                    setShowCreateTaskModal(true);
                  }}
                  disabled={!isAdmin || locations.length < 2}
                >
                  Create task
                </Button>
              </SpaceBetween>
            }
            description="Configure and run DataSync tasks to transfer data between S3 and FSx storage"
          >
            Data Transfer Tasks
          </Header>
        }
        columnDefinitions={taskColumns}
        items={tasks}
        loading={loading}
        loadingText="Loading tasks..."
        selectionType="multi"
        selectedItems={selectedTasks}
        onSelectionChange={({ detail }) => setSelectedTasks(detail.selectedItems)}
        empty={
          <Box textAlign="center" color="inherit">
            <b>No tasks</b>
            <Box padding={{ bottom: 's' }} variant="p" color="inherit">
              Create a task to transfer data between locations.
            </Box>
          </Box>
        }
        trackBy="taskId"
      />

      {/* DataSync Locations (Expandable) */}
      <ExpandableSection
        headerText={`DataSync Locations (${locations.length})`}
        variant="container"
      >
        <Table
          header={
            <Header
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    onClick={handleDeleteLocations}
                    disabled={selectedLocations.length === 0 || !isAdmin}
                  >
                    Delete
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => setShowCreateLocationModal(true)}
                    disabled={!isAdmin}
                  >
                    Create location
                  </Button>
                </SpaceBetween>
              }
            >
              Locations
            </Header>
          }
          columnDefinitions={locationColumns}
          items={locations}
          loading={loading}
          loadingText="Loading locations..."
          selectionType="multi"
          selectedItems={selectedLocations}
          onSelectionChange={({ detail }) => setSelectedLocations(detail.selectedItems)}
          empty={
            <Box textAlign="center" color="inherit">
              <b>No locations</b>
              <Box padding={{ bottom: 's' }} variant="p" color="inherit">
                Create S3 or FSx locations to use in data transfer tasks.
              </Box>
            </Box>
          }
          trackBy="locationId"
        />
      </ExpandableSection>

      {/* Modals */}
      <CreateTaskModal
        visible={showCreateTaskModal}
        onDismiss={() => {
          setShowCreateTaskModal(false);
          setEditingTask(null);
        }}
        onSuccess={() => {
          setShowCreateTaskModal(false);
          setEditingTask(null);
          fetchData();
        }}
        locations={locations}
        editingTask={editingTask}
      />

      <CreateLocationModal
        visible={showCreateLocationModal}
        onDismiss={() => setShowCreateLocationModal(false)}
        onSuccess={() => {
          setShowCreateLocationModal(false);
          fetchData();
        }}
        storageResources={storageResources}
        s3Buckets={s3Buckets}
      />
    </SpaceBetween>
  );
};

export default DataTransferSection;
