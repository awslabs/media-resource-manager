// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { apiCall } from './api';
import { getAuthToken } from './auth';

// Types for DataSync API
export interface DataSyncLocation {
  locationId: string;
  locationArn: string;
  name: string;
  locationType: 'S3' | 'FSX_ONTAP' | 'FSX_WINDOWS';
  status: 'available' | 'creating' | 'deleting' | 'error';
  bucketArn?: string;
  isCrossAccount?: boolean;
  subdirectory?: string;
  storageId?: string;
  fsxFileSystemArn?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DataSyncTask {
  taskId: string;
  taskArn: string;
  name: string;
  status: 'available' | 'creating' | 'running' | 'deleting' | 'error' | 'invalid';
  sourceLocationId: string;
  sourceLocationArn: string;
  destinationLocationId: string;
  destinationLocationArn: string;
  options: TaskOptions;
  lastExecutionId?: string;
  lastExecutionStatus?: string;
  lastExecutionTime?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskOptions {
  transferMode: 'CHANGED' | 'ALL';
  verifyMode: 'ONLY_FILES_TRANSFERRED' | 'POINT_IN_TIME_CONSISTENT' | 'NONE';
  overwriteMode: 'ALWAYS' | 'NEVER';
  preserveDeletedFiles: 'PRESERVE' | 'REMOVE';
  bytesPerSecond?: number;
  logLevel: 'OFF' | 'BASIC' | 'TRANSFER';
}

export interface TaskExecution {
  executionId: string;
  executionArn: string;
  taskId: string;
  status: 'QUEUED' | 'LAUNCHING' | 'PREPARING' | 'TRANSFERRING' | 'VERIFYING' | 'SUCCESS' | 'ERROR';
  startTime: string;
  endTime?: string;
  bytesTransferred?: number;
  filesTransferred?: number;
  duration?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface S3Bucket {
  name: string;
  region: string;
  arn: string;
}

export interface CreateLocationRequest {
  name: string;
  type: 'S3' | 'FSX_ONTAP' | 'FSX_WINDOWS';
  s3Config?: {
    bucketArn: string;
    subdirectory?: string;
    isCrossAccount: boolean;
  };
  fsxConfig?: {
    storageId: string;
    subdirectory?: string;
  };
}

export interface CreateTaskRequest {
  name: string;
  sourceLocationId: string;
  destinationLocationId: string;
  options?: Partial<TaskOptions>;
}

export interface UpdateTaskRequest {
  name?: string;
  options?: Partial<TaskOptions>;
}

// Helper to get auth headers
const getAuthHeaders = () => {
  const token = getAuthToken();
  if (!token) throw new Error('No current user');
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
};

// Location API functions
export const listDataSyncLocations = async (): Promise<DataSyncLocation[]> => {
  const response = await apiCall('datasync/locations', {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list locations');
  }
  // Lambda returns array directly, not wrapped in { locations: [...] }
  return await response.json();
};

export const createDataSyncLocation = async (request: CreateLocationRequest): Promise<DataSyncLocation> => {
  const response = await apiCall('datasync/locations', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create location');
  }
  const data = await response.json();
  return data.data;
};

export const deleteDataSyncLocation = async (locationId: string): Promise<void> => {
  const response = await apiCall(`datasync/locations/${locationId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to delete location');
  }
};

// Task API functions
export const listDataSyncTasks = async (): Promise<DataSyncTask[]> => {
  const response = await apiCall('datasync/tasks', {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list tasks');
  }
  // Lambda returns array directly, not wrapped in { tasks: [...] }
  return await response.json();
};

export const createDataSyncTask = async (request: CreateTaskRequest): Promise<DataSyncTask> => {
  const response = await apiCall('datasync/tasks', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create task');
  }
  const data = await response.json();
  return data.data;
};

export const updateDataSyncTask = async (taskId: string, request: UpdateTaskRequest): Promise<DataSyncTask> => {
  const response = await apiCall(`datasync/tasks/${taskId}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to update task');
  }
  const data = await response.json();
  return data.data;
};

export const deleteDataSyncTask = async (taskId: string): Promise<void> => {
  const response = await apiCall(`datasync/tasks/${taskId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to delete task');
  }
};

// Execution API functions
export const startTaskExecution = async (taskId: string): Promise<TaskExecution> => {
  const response = await apiCall(`datasync/tasks/${taskId}/execute`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to start execution');
  }
  const data = await response.json();
  return data.data;
};

export const getTaskExecutions = async (taskId: string): Promise<TaskExecution[]> => {
  const response = await apiCall(`datasync/tasks/${taskId}/executions`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get executions');
  }
  const data = await response.json();
  return data.data || [];
};

// S3 Buckets API function
export const listS3Buckets = async (): Promise<S3Bucket[]> => {
  const response = await apiCall('datasync/s3-buckets', {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list S3 buckets');
  }
  // Lambda returns array directly, not wrapped in { buckets: [...] }
  return await response.json();
};

// DataSync Config API function - returns role ARN and other config
export interface DataSyncConfig {
  dataSyncRoleArn: string;
  accountId: string;
}

export const getDataSyncConfig = async (): Promise<DataSyncConfig> => {
  const response = await apiCall('datasync/config', {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get DataSync config');
  }
  return await response.json();
};
