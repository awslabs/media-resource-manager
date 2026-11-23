// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Session setup for the in-browser viewer (/connect/:instanceId). The viewer
 * starts its own DCV session through POST /dcv and keeps the connection token
 * in memory only: never in a URL, sessionStorage or localStorage.
 */
import { apiCall } from './api';
import { getAuthToken } from './auth';

/** What the viewer needs to connect. `authToken` is the DCV connection token. */
export interface ViewerSession {
  sessionId: string;
  authToken: string;
  /** Origin the browser connects to: the gateway's CloudFront domain, or the gateway itself. */
  serverUrl: string;
  /** True when the browser connects straight to the gateway (no CloudFront in front). */
  direct: boolean;
  /**
   * True when the direct gateway likely has MRM's default self-signed
   * certificate (a load balancer hostname, no custom DCV domain). A browser
   * can't click through a certificate warning on a WebSocket, so the viewer
   * offers to open the gateway once to accept it.
   */
  untrustedCertificateLikely: boolean;
}

/** The fields of a POST /dcv `create-session` response the viewer reads. */
export interface CreateSessionResponse {
  sessionId?: string;
  connectionToken?: string;
  connectionUrl?: string;
  browserGatewayUrl?: string;
}

const LOAD_BALANCER_HOST = /\.elb\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/i;

function httpsOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Build the viewer session from a `create-session` response. Falls back to the
 * gateway origin from `connectionUrl` when `browserGatewayUrl` is missing
 * (a regional hub not yet updated, or an older session manager).
 */
export function viewerSessionFromResponse(data: CreateSessionResponse): ViewerSession {
  const gatewayOrigin = httpsOrigin(data.connectionUrl);
  const serverUrl = httpsOrigin(data.browserGatewayUrl) ?? gatewayOrigin;
  if (!data.sessionId || !data.connectionToken || !serverUrl) {
    // MRM always returns these; a gap is a server-side bug, not a sign-in issue.
    throw new Error('The session response was incomplete. Choose Retry to start a new session.');
  }
  const direct = serverUrl === gatewayOrigin;
  return {
    sessionId: data.sessionId,
    authToken: data.connectionToken,
    serverUrl,
    direct,
    untrustedCertificateLikely: direct && LOAD_BALANCER_HOST.test(new URL(serverUrl).hostname),
  };
}

/** The session name the Connect buttons use. */
export function sessionNameFor(user: { firstName?: string; lastName?: string; email?: string } | null | undefined): string {
  return `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || user?.email?.split('@')[0] || 'User';
}

/** What Connect shows while it waits for a console session that is still starting. */
export const STARTING_SESSION_MESSAGE = 'Starting your session. This can take a minute on a new workstation...';

/** How many times Connect asks again while the console session is still starting. */
export const SESSION_START_RETRIES = 4;
const DEFAULT_RETRY_AFTER_SECONDS = 5;

export interface CreateSessionOptions {
  /** Called before each retry, so the page can say the session is starting. */
  onStarting?: () => void;
  /** Wait between retries (tests pass a fake). */
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * POST /dcv `create-session` for the workstation's console session. A new
 * console session can take a minute to reach READY; until then the API
 * answers 409 `{status: 'session-starting', retryAfterSeconds}`, and this asks
 * again up to SESSION_START_RETRIES times. Returns the last response.
 */
export async function postCreateSession(
  instanceId: string,
  sessionName: string,
  { onStarting, wait = sleep }: CreateSessionOptions = {},
): Promise<Response> {
  const token = getAuthToken();
  if (!token) throw new Error('No current user');

  for (let attempt = 0; ; attempt++) {
    const response = await apiCall('/dcv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: 'create-session',
        serverId: instanceId,
        sessionName,
        sessionType: 'console',
      }),
    });
    if (response.status !== 409 || attempt >= SESSION_START_RETRIES) return response;
    const data = await response.clone().json().catch(() => ({}));
    if (data.status !== 'session-starting') return response;
    const seconds = Number(data.retryAfterSeconds);
    const delay = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 30) : DEFAULT_RETRY_AFTER_SECONDS;
    onStarting?.();
    await wait(delay * 1000);
  }
}

/** Start (or reuse) the workstation's console session through POST /dcv. */
export async function createViewerSession(
  instanceId: string,
  sessionName: string,
  options: CreateSessionOptions = {},
): Promise<ViewerSession> {
  const response = await postCreateSession(instanceId, sessionName, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.error || `The session request failed (HTTP ${response.status})`);
  }
  return viewerSessionFromResponse(data);
}
