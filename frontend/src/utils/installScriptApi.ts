// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Install Script Agent API Utility
 * 
 * Provides functions for interacting with the Install Script Agent API.
 */

import { apiCall } from './api';
import { getAuthToken } from './auth';

export interface GenerateScriptOptions {
  softwareName: string;
  version?: string;
  platform: 'Windows' | 'Linux';
  mediaS3Uri?: string;
  licenseKey?: string;
  testAutomatically?: boolean;
  maxAttempts?: number;
  timeoutMinutes?: number;
}

export interface GenerateScriptResponse {
  executionId: string;
  sessionId: string;
  status: string;
  progressUrl: string;
}

export interface ProgressEvent {
  eventId?: string;
  phase: string;
  message: string;
  percent: number;
  timestamp: string;
}

export interface CompletionEvent {
  status: 'completed' | 'failed' | 'cancelled';
  script?: string;
  componentArn?: string;
  error?: string;
  attempts: number;
  logs?: string[];
}

export interface ExecutionState {
  executionId: string;
  status: string;
  currentPhase: string;
  currentAttempt: number;
  maxAttempts: number;
}

/**
 * Start script generation for a software item
 */
export async function generateScript(
  softwareId: string,
  options: GenerateScriptOptions
): Promise<GenerateScriptResponse> {
  const token = getAuthToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const response = await apiCall(`/images/software/${softwareId}/generate-script`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...options,
      testAutomatically: options.testAutomatically ?? true,
      maxAttempts: options.maxAttempts ?? 3,
      timeoutMinutes: options.timeoutMinutes ?? 15,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to start generation: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Subscribe to progress updates for a script generation
 * Returns a cleanup function to stop polling
 */
export function subscribeToProgress(
  softwareId: string,
  executionId: string,
  callbacks: {
    onProgress?: (event: ProgressEvent) => void;
    onState?: (state: ExecutionState) => void;
    onComplete?: (event: CompletionEvent) => void;
    onError?: (error: Error) => void;
  }
): () => void {
  let cancelled = false;
  let lastEventId: string | undefined;

  const poll = async () => {
    if (cancelled) return;

    try {
      const token = getAuthToken();
      if (!token) {
        callbacks.onError?.(new Error('Not authenticated'));
        return;
      }

      const url = `/images/software/${softwareId}/generation-progress?executionId=${executionId}${lastEventId ? `&lastEventId=${lastEventId}` : ''}`;
      const response = await apiCall(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get progress: ${response.statusText}`);
      }

      const text = await response.text();
      const events = parseSSEEvents(text);

      for (const event of events) {
        if (cancelled) return;

        switch (event.type) {
          case 'progress':
            callbacks.onProgress?.(event.data as ProgressEvent);
            if (event.data.eventId) {
              lastEventId = event.data.eventId;
            }
            break;
          case 'state':
            callbacks.onState?.(event.data as ExecutionState);
            break;
          case 'complete':
            callbacks.onComplete?.(event.data as CompletionEvent);
            return; // Stop polling on completion
        }
      }

      // Continue polling if not complete
      if (!cancelled) {
        setTimeout(poll, 2000);
      }
    } catch (error) {
      if (!cancelled) {
        callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        // Retry with longer delay on error
        setTimeout(poll, 5000);
      }
    }
  };

  // Start polling
  poll();

  // Return cleanup function
  return () => {
    cancelled = true;
  };
}

/**
 * Cancel an ongoing script generation
 */
export async function cancelGeneration(
  softwareId: string,
  executionId: string,
  reason?: string
): Promise<{ message: string; cleanup: { instancesTerminated: string[]; errors: string[] } }> {
  const token = getAuthToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const response = await apiCall(`/images/software/${softwareId}/cancel-generation`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ executionId, reason }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to cancel: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Parse SSE events from response text
 */
function parseSSEEvents(text: string): Array<{ type: string; data: any }> {
  const events: Array<{ type: string; data: any }> = [];
  const lines = text.split('\n');
  let currentEvent: { type?: string; data?: string } = {};

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent.type = line.substring(7);
    } else if (line.startsWith('data: ')) {
      currentEvent.data = line.substring(6);
    } else if (line === '' && currentEvent.type && currentEvent.data) {
      try {
        const data = JSON.parse(currentEvent.data);
        events.push({ type: currentEvent.type, data });
      } catch (e) {
        console.warn('Failed to parse SSE event:', currentEvent);
      }
      currentEvent = {};
    }
  }

  return events;
}

/**
 * Get the current status of a script generation
 */
export async function getGenerationStatus(
  softwareId: string,
  executionId: string
): Promise<ExecutionState> {
  const token = getAuthToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const response = await apiCall(
    `/images/software/${softwareId}/generation-progress?executionId=${executionId}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to get status: ${response.statusText}`);
  }

  const text = await response.text();
  const events = parseSSEEvents(text);
  const stateEvent = events.find((e) => e.type === 'state');

  if (!stateEvent) {
    throw new Error('No state event found');
  }

  return stateEvent.data as ExecutionState;
}
