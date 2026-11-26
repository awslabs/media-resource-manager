// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// TODO: Refactor to create dedicated API client files for each domain:
// - storageApi.ts (storage resources CRUD)
// - workstationApi.ts (workstation management)
// - userApi.ts (user/group management)
// - imageApi.ts (AMI/pipeline management)
// - regionApi.ts (regional hub management)
// This would match the pattern used in dcvApi.ts and datasyncApi.ts for better
// type safety, centralized error handling, and cleaner component code.

import { canRefreshSession, clearSession, getFreshAuthToken, refreshSession } from './auth';

let apiUrl = '';

export const setApiUrl = (url: string) => {
  apiUrl = url;
};

const hasBearer = (options: RequestInit) => /^Bearer\s/i.test(new Headers(options.headers).get('Authorization') || '');

/** The same request options with the Authorization header set to this token. */
const withToken = (options: RequestInit, token: string): RequestInit => {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...options, headers };
};

const endSession = () => {
  clearSession();
  window.location.reload();
};

export const apiCall = async (endpoint: string, options: RequestInit = {}) => {
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${apiUrl.replace(/\/$/, '')}${normalizedEndpoint}`;
  
  try {
    // A signed-in request goes out with a current ID token: refreshed first
    // when it is about to expire and the session can be renewed (#85).
    let request = options;
    if (hasBearer(options) && canRefreshSession()) {
      const token = await getFreshAuthToken();
      if (!token) {
        endSession();
        return new Response(null, { status: 401 });
      }
      request = withToken(options, token);
    }

    // nosemgrep: gitlab.nodejs_scan.javascript-ssrf-rule-node_ssrf
    // URL is from deployment config (apiUrl), not user input
    let response = await fetch(url, request);
    
    // Check for authentication errors without consuming the body
    if (!response.ok && response.status === 401) {
      // The API refused the token: refresh once (shared with concurrent
      // calls) and retry. When the session can't be renewed (AD sign-in), or the refresh is
      // refused, the session ends and the reload shows sign-in.
      const refreshed = hasBearer(options) && canRefreshSession()
        ? await refreshSession().catch(() => null)
        : null;
      if (refreshed) {
        // nosemgrep: gitlab.nodejs_scan.javascript-ssrf-rule-node_ssrf
        // URL is from deployment config (apiUrl), not user input
        response = await fetch(url, withToken(options, refreshed));
      }
      if (!response.ok && response.status === 401) {
        endSession();
      }
    }
    
    return response;
  } catch (error) {
    // Handle network errors that might contain auth failures
    if (error.message?.includes('No current user')) {
      endSession();
    }
    throw error;
  }
};
