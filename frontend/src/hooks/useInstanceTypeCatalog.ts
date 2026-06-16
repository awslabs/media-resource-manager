// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from 'react';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';

export interface InstanceTypeMeta {
  family: string;
  label: string;
  platforms: string[];
  vCpu?: number;
  memoryGb?: number;
  gpuInfo?: string;
  regions?: string[];
}

export type InstanceTypeCatalog = Record<string, InstanceTypeMeta>;

// Minimal fallback catalog for when API is unavailable
const FALLBACK_CATALOG: InstanceTypeCatalog = {
  'g4dn.xlarge': { family: 'GPU - NVIDIA T4', label: 'g4dn.xlarge (4 vCPU, 16 GB, T4)', platforms: ['windows', 'linux'] },
  'g4dn.2xlarge': { family: 'GPU - NVIDIA T4', label: 'g4dn.2xlarge (8 vCPU, 32 GB, T4)', platforms: ['windows', 'linux'] },
  'g5.xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.xlarge (4 vCPU, 16 GB, A10G)', platforms: ['windows', 'linux'] },
  'g5.2xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.2xlarge (8 vCPU, 32 GB, A10G)', platforms: ['windows', 'linux'] },
  'mac2.metal': { family: 'Apple Silicon', label: 'mac2.metal (M1, 8 CPU, 16 GB)', platforms: ['macos'] },
};

// Module-level cache to avoid refetching on every component mount
let cachedCatalog: InstanceTypeCatalog | null = null;
let fetchPromise: Promise<InstanceTypeCatalog> | null = null;

async function fetchCatalog(): Promise<InstanceTypeCatalog> {
  const token = getAuthToken();
  if (!token) return FALLBACK_CATALOG;

  try {
    const response = await apiCall('/instance-types/catalog', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.ok) {
      const data = await response.json();
      if (data.instanceTypes && Object.keys(data.instanceTypes).length > 0) {
        return data.instanceTypes;
      }
    }
  } catch (error) {
    console.error('Error fetching instance type catalog:', error);
  }
  
  return FALLBACK_CATALOG;
}

export function useInstanceTypeCatalog() {
  const [catalog, setCatalog] = useState<InstanceTypeCatalog>(cachedCatalog || FALLBACK_CATALOG);
  const [loading, setLoading] = useState(!cachedCatalog);

  useEffect(() => {
    if (cachedCatalog) {
      setCatalog(cachedCatalog);
      setLoading(false);
      return;
    }

    // Deduplicate concurrent fetches
    if (!fetchPromise) {
      fetchPromise = fetchCatalog().then((result) => {
        cachedCatalog = result;
        fetchPromise = null;
        return result;
      });
    }

    fetchPromise.then((result) => {
      setCatalog(result);
      setLoading(false);
    });
  }, []);

  return { catalog, loading };
}

// Helper to get label for an instance type (with fallback)
export function getInstanceTypeLabel(catalog: InstanceTypeCatalog, instanceType: string): string {
  return catalog[instanceType]?.label || instanceType;
}

// Helper to invalidate cache (e.g., after settings change)
export function invalidateInstanceTypeCatalogCache() {
  cachedCatalog = null;
  fetchPromise = null;
}
