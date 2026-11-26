// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Launch the Amazon DCV native client from a `dcv://` link and guess whether
 * it opened.
 *
 * Browsers don't tell a page whether an app handles a URL scheme. When the
 * client opens, the page becomes hidden (`visibilitychange`), or the browser
 * window loses focus (`blur`) and is still unfocused at the timeout. Otherwise
 * we report `not-detected`. That is a guess: a user who takes longer than the
 * timeout to answer the browser's "Open Amazon DCV?" prompt also gets
 * `not-detected`, so callers should word their UI as a question.
 */

/** Official Amazon DCV client download page. */
export const DCV_CLIENT_DOWNLOAD_URL = 'https://www.amazondcv.com/';

export const DCV_LAUNCH_TIMEOUT_MS = 3500;

export type DcvLaunchResult = 'launched' | 'not-detected';

/**
 * - `top`: set `window.location.href`. Chromium (Chrome, Edge) hands an
 *   external scheme to the OS without leaving the page, and it does so even
 *   after the POST /dcv round-trip has used up the click's user activation.
 *   Chromium can block an external-protocol launch from an iframe without
 *   fresh user activation, so `top` is the safe choice there.
 * - `iframe`: navigate a hidden iframe. Firefox replaces the whole page with
 *   "The address wasn't understood" when a top-level navigation hits an
 *   unregistered scheme; inside an iframe that error stays hidden.
 */
export type DcvLaunchMethod = 'top' | 'iframe';

export function defaultLaunchMethod(userAgent: string = navigator.userAgent): DcvLaunchMethod {
  return /firefox\//i.test(userAgent) ? 'iframe' : 'top';
}

/** Turn the `connectionUrl` / `quicConnectionUrl` from POST /dcv into a `dcv://` link. */
export function toDcvClientUrl(connectionUrl: string): string {
  return connectionUrl.replace(/^https:\/\//, 'dcv://');
}

/*
 * Shared connect-URL helper. Every Connect button in the console goes
 * through `nativeClientUrl` (native client) or `openBrowserViewer` (browser).
 */

/**
 * How the native client reaches the Connection Gateway: `quic` (UDP, the
 * `quicConnectionUrl` port) or `websocket` (TCP, the `connectionUrl` port), for
 * networks that block UDP. Admins choose it in Settings
 * (`nativeClientTransport` in GET /settings).
 */
export type NativeClientTransport = 'quic' | 'websocket';

export const DEFAULT_NATIVE_CLIENT_TRANSPORT: NativeClientTransport = 'quic';

/** Read the transport from a GET /settings response; anything unknown means QUIC. */
export function parseNativeClientTransport(value: unknown): NativeClientTransport {
  return value === 'websocket' ? 'websocket' : DEFAULT_NATIVE_CLIENT_TRANSPORT;
}

/** The URLs that POST /dcv `create-session` returns for the native client. */
export interface NativeClientUrls {
  connectionUrl?: string;
  quicConnectionUrl?: string;
  /**
   * The protocol resolved for this caller and workstation (#138): a set
   * workstation or user override over the Settings value, and TCP when the
   * two overrides differ.
   * When present it wins over the `fallbackTransport` argument of `nativeClientUrl`.
   */
  nativeClientTransport?: unknown;
}

/** A workstation or user override: a protocol, or `null` for no override at that level. */
export type NativeClientTransportOverride = NativeClientTransport | null;

/** Read an override from an API response; anything unknown means no override. */
export function parseNativeClientTransportOverride(value: unknown): NativeClientTransportOverride {
  return value === 'quic' || value === 'websocket' ? value : null;
}

/**
 * The `dcv://` link that opens this session in the native client. The Amazon
 * DCV clients read two optional query parameters from it:
 * - `webPort`: the gateway's TCP (WebSocket/HTTPS) port. Without it the client
 *   assumes the URL's port, which for QUIC links is UDP-only on the gateway.
 *   Clients use it for HTTPS resources, and some retry a failed QUIC connection
 *   over WebSocket on it.
 * - `transport=websocket`: connect over TCP and skip QUIC entirely (#47). This
 *   is the reliable choice when UDP is blocked.
 *
 * `fallbackTransport` is the Settings value from GET /settings. The session's own
 * `nativeClientTransport`, resolved by POST /dcv, wins when present.
 */
export function nativeClientUrl(
  session: NativeClientUrls,
  fallbackTransport: NativeClientTransport = DEFAULT_NATIVE_CLIENT_TRANSPORT,
): string {
  const { connectionUrl, quicConnectionUrl } = session;
  const transport = session.nativeClientTransport === undefined
    ? fallbackTransport
    : parseNativeClientTransport(session.nativeClientTransport);
  if (transport === 'websocket' || !quicConnectionUrl) {
    if (!connectionUrl) throw new Error('The session response has no connection URL');
    const url = toDcvClientUrl(connectionUrl);
    return transport === 'websocket' ? withQueryParam(url, 'transport', 'websocket') : url;
  }
  const webPort = connectionUrl ? new URL(connectionUrl).port : '';
  const url = toDcvClientUrl(quicConnectionUrl);
  return webPort ? withQueryParam(url, 'webPort', webPort) : url;
}

/*
 * Did the native client connect? (#139 Stage A)
 *
 * The launch detection above only tells whether an app opened. After a QUIC
 * link opens, the console asks POST /dcv get-session-connections for the
 * session's connection count. When no client has connected after about 20
 * seconds, it offers Retry over TCP with the same session.
 */

/** Wait this long for a native client connection before offering Retry over TCP. */
export const NATIVE_CONNECT_CHECK_MS = 20000;
/** Keep checking this long after that, so the message closes if the client connects late. */
export const NATIVE_CONNECT_LATE_MS = 40000;
export const NATIVE_CONNECT_POLL_MS = 4000;

/** What the console needs to check a QUIC launch and retry it over TCP. */
export interface NativeConnectionCheck {
  serverId: string;
  sessionId: string;
  /** The same session as a TCP (`transport=websocket`) link. */
  tcpUrl: string;
}

/**
 * The check for a create-session response, or undefined when there is
 * nothing to retry: the link is already TCP, or the response lacks a URL or
 * session ID.
 */
export function nativeConnectionCheck(
  session: NativeClientUrls & { sessionId?: unknown },
  serverId: string | undefined,
  fallbackTransport: NativeClientTransport = DEFAULT_NATIVE_CLIENT_TRANSPORT,
): NativeConnectionCheck | undefined {
  const transport = session.nativeClientTransport === undefined
    ? fallbackTransport
    : parseNativeClientTransport(session.nativeClientTransport);
  if (transport !== 'quic' || !session.quicConnectionUrl || !session.connectionUrl) return undefined;
  if (!serverId || typeof session.sessionId !== 'string' || !session.sessionId) return undefined;
  return {
    serverId,
    sessionId: session.sessionId,
    tcpUrl: nativeClientUrl({ ...session, nativeClientTransport: 'websocket' }),
  };
}

export type NativeConnectionResult = 'connected' | 'not-connected' | 'unknown';

/**
 * Poll the connection count until a client connects or `timeoutMs` passes.
 * `unknown` when no poll got an answer (for example a regional hub that
 * hasn't been updated to the version with get-session-connections), so the
 * console only reports a failure it actually saw.
 */
export async function waitForNativeConnection(
  getConnectionCount: () => Promise<number>,
  {
    timeoutMs = NATIVE_CONNECT_CHECK_MS,
    intervalMs = NATIVE_CONNECT_POLL_MS,
    signal,
  }: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<NativeConnectionResult> {
  const deadline = Date.now() + timeoutMs;
  let answered = false;
  while (!signal?.aborted) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(intervalMs, Math.max(0, deadline - Date.now())));
      signal?.addEventListener('abort', done);
    });
    if (signal?.aborted) break;
    try {
      const count = await getConnectionCount();
      answered = true;
      if (count > 0) return 'connected';
    } catch {
      // A failed poll proves nothing either way.
    }
    if (Date.now() >= deadline) break;
  }
  return answered && !signal?.aborted ? 'not-connected' : 'unknown';
}

/** Add `name=value` to a URL's query, leaving the rest (the token) exactly as it is. */
function withQueryParam(url: string, name: string, value: string): string {
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : url.slice(hashAt);
  const separator = base.includes('?') ? (base.endsWith('?') ? '' : '&') : '?';
  return `${base}${separator}${encodeURIComponent(name)}=${encodeURIComponent(value)}${fragment}`;
}

/** Console path of the in-browser viewer for a workstation. */
export function browserViewerPath(instanceId: string): string {
  return `/connect/${encodeURIComponent(instanceId)}`;
}

/**
 * Open the in-browser viewer in a new tab. Call it straight from the click
 * handler, before any `await`, so popup blockers allow it. The viewer page
 * starts the DCV session itself.
 *
 * No `noopener`: the page is this console's own origin, and keeping the opener
 * makes the browser copy this tab's sessionStorage, where the console keeps
 * its sign-in, into the new tab (HTML "copy session storage" on window.open).
 * A tab opened another way shows the sign-in page first.
 */
export function openBrowserViewer(instanceId: string): void {
  window.open(browserViewerPath(instanceId), '_blank');
}

export interface LaunchDcvClientOptions {
  timeoutMs?: number;
  method?: DcvLaunchMethod;
  /** Aborting stops detection at once: listeners, timer and iframe are removed and the result is `not-detected`. */
  signal?: AbortSignal;
}

export function launchDcvClient(
  url: string,
  { timeoutMs = DCV_LAUNCH_TIMEOUT_MS, method = defaultLaunchMethod(), signal }: LaunchDcvClientOptions = {},
): Promise<DcvLaunchResult> {
  if (signal?.aborted) return Promise.resolve('not-detected');
  return new Promise((resolve) => {
    let iframe: HTMLIFrameElement | null = null;
    let settled = false;

    const finish = (result: DcvLaunchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      signal?.removeEventListener('abort', onAbort);
      iframe?.remove();
      iframe = null;
      resolve(result);
    };
    // A blur alone isn't proof: a browser or OS prompt, or a click into
    // DevTools, blurs the window briefly and hands focus back. So a blur is
    // only counted if the window still doesn't have focus at the deadline.
    let blurred = false;
    const onBlur = () => {
      blurred = true;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') finish('launched');
    };

    const onAbort = () => finish('not-detected');

    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    signal?.addEventListener('abort', onAbort);
    const timeoutId = setTimeout(
      () => finish(blurred && !document.hasFocus() ? 'launched' : 'not-detected'),
      timeoutMs,
    );

    try {
      if (method === 'iframe') {
        iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
        iframe.src = url;
      } else {
        window.location.href = url;
      }
    } catch (error) {
      console.error('Could not open the DCV client link:', error);
      finish('not-detected');
    }
  });
}
