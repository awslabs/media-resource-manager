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

let apiUrl = '';

export const setApiUrl = (url: string) => {
  apiUrl = url;
};

export const apiCall = async (endpoint: string, options: RequestInit = {}) => {
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${apiUrl.replace(/\/$/, '')}${normalizedEndpoint}`;
  
  try {
    // nosemgrep: gitlab.nodejs_scan.javascript-ssrf-rule-node_ssrf
    // URL is from deployment config (apiUrl), not user input
    const response = await fetch(url, options);
    
    // Check for authentication errors without consuming the body
    if (!response.ok && response.status === 401) {
      // Clear session and redirect to login
      sessionStorage.removeItem('auth-user');
      sessionStorage.removeItem('auth-token');
      window.location.reload();
    }
    
    return response;
  } catch (error) {
    // Handle network errors that might contain auth failures
    if (error.message?.includes('No current user')) {
      sessionStorage.removeItem('auth-user');
      sessionStorage.removeItem('auth-token');
      window.location.reload();
    }
    throw error;
  }
};
