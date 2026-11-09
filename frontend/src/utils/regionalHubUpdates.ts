// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Regional hubs that run older code than this deployment (the API sets
// updateAvailable on each hub). Shown to admins as a banner on every page and
// a badge on Regions in the sidebar. The list is cached for the browser
// session, so moving between pages doesn't call the API each time.

import { useEffect, useState } from 'react';
import { apiCall } from './api';
import { getAuthToken } from './auth';

export interface HubNeedingUpdate {
  region: string;
  displayName: string;
}

const CACHE_KEY = 'mrm-regional-hubs-needing-update';
const CACHE_TTL_MS = 5 * 60 * 1000;
const CHANGED_EVENT = 'mrm:regional-hub-updates-changed';

interface CacheEntry {
  fetchedAt: number;
  hubs: HubNeedingUpdate[];
}

function readCache(): CacheEntry | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    const entry = raw ? (JSON.parse(raw) as CacheEntry) : null;
    return entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS ? entry : null;
  } catch {
    return null;
  }
}

/** Hubs from GET /regions that need an update. */
export function hubsNeedingUpdate(hubs: any[]): HubNeedingUpdate[] {
  return (Array.isArray(hubs) ? hubs : [])
    .filter((hub) => hub?.updateAvailable === true && !hub.isPrimary)
    .map((hub) => ({ region: hub.region, displayName: hub.displayName || hub.region }));
}

/**
 * Store the result of a GET /regions the caller already made, so the banner
 * and badge update without another request.
 */
export function rememberRegionalHubs(hubs: any[]): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), hubs: hubsNeedingUpdate(hubs) }));
  } catch {
    // Storage unavailable; the next page load fetches again.
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/** Forget the cached list, for example after an update starts. */
export function forgetRegionalHubUpdates(): void {
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // Nothing cached.
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

async function fetchHubsNeedingUpdate(): Promise<HubNeedingUpdate[]> {
  const token = getAuthToken();
  if (!token) return [];
  const response = await apiCall('regions', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return [];
  const data = await response.json();
  const hubs = data?.success ? data.data : Array.isArray(data) ? data : [];
  rememberRegionalHubs(hubs);
  return hubsNeedingUpdate(hubs);
}

/** Hubs that need an update. Always empty for non-admins. */
export function useHubsNeedingUpdate(isAdmin: boolean): HubNeedingUpdate[] {
  const [hubs, setHubs] = useState<HubNeedingUpdate[]>(() => (isAdmin ? readCache()?.hubs || [] : []));

  useEffect(() => {
    if (!isAdmin) {
      setHubs([]);
      return undefined;
    }
    let cancelled = false;
    const refresh = () => {
      const cached = readCache();
      if (cached) {
        setHubs(cached.hubs);
        return;
      }
      fetchHubsNeedingUpdate()
        .then((result) => { if (!cancelled) setHubs(result); })
        .catch(() => { /* Leave the banner as it is if the check fails. */ });
    };
    refresh();
    window.addEventListener(CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(CHANGED_EVENT, refresh);
    };
  }, [isAdmin]);

  return hubs;
}
