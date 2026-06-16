// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { apiCall } from './api';
import { getAuthToken } from './auth';

// Types for Storage API
export interface S3Bucket {
  name: string;
  region: string;
  arn: string;
  creationDate?: string;
}

export interface StorageConfig {
  workstationRoleArn: string;
  accountId: string;
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

// S3 Buckets API function for Mountpoint S3 storage creation
export const listStorageS3Buckets = async (): Promise<S3Bucket[]> => {
  const response = await apiCall('storage/s3-buckets', {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list S3 buckets');
  }
  return await response.json();
};

// Storage Config API function - returns workstation role ARN for cross-account bucket policy
export const getStorageConfig = async (): Promise<StorageConfig> => {
  const response = await apiCall('storage/config', {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get storage config');
  }
  return await response.json();
};
