// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-browser DCV viewer at /connect/:instanceId, rendered inside the console's
 * sign-in guard. It starts the session through POST /dcv and hands the session
 * ID and connection token straight to the Amazon DCV Web UI SDK's DCVViewer,
 * which connects with the token. The Connection Gateway accepts token
 * connections only, so the viewer never asks for credentials.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Result, Space, Spin, Typography } from 'antd';
import dcv from 'dcv';
import { DCVViewer } from 'dcv-ui';
import type { DcvDisconnectReason } from 'dcv-ui';
import { createViewerSession, sessionNameFor, STARTING_SESSION_MESSAGE, type ViewerSession } from '../utils/dcvViewer';

/** Where scripts/fetch-dcv-web-sdk.sh puts the Web Client SDK (dcv.js, workers, decoders). */
export const DCV_SDK_PATH = '/dcvsdk/dcvjs';

/**
 * The SDK's `baseUrl`, as an absolute URL. The Web Client SDK resolves any
 * `baseUrl` that doesn't start with `http` against the page's own directory,
 * so `/dcvsdk/dcvjs` on /connect/<id> became /connect/<id>/dcvsdk/dcvjs and
 * the decoder workers loaded the SPA's index.html instead of JavaScript.
 */
export function dcvSdkBaseUrl(origin: string = window.location.origin): string {
  return `${origin.replace(/\/+$/, '')}${DCV_SDK_PATH}`;
}

/** The part of the Web Client SDK's Connection used to release modifier keys. */
export interface ModifierKeyLatch {
  latchModifierKey(key: string, location: number, isDown: boolean): boolean;
}

function isModifierKeyLatch(connection: unknown): connection is ModifierKeyLatch {
  return typeof (connection as ModifierKeyLatch | null)?.latchModifierKey === 'function';
}

/** Every key and location the SDK's `latchModifierKey` accepts (KeyboardEvent.location values). */
export const MODIFIER_KEYS: ReadonlyArray<readonly [key: string, location: number]> = [
  ['Control', 1], ['Control', 2],
  ['Alt', 1], ['Alt', 2],
  ['AltGraph', 0],
  ['Meta', 1], ['Meta', 2],
  ['OS', 1], ['OS', 2],
  ['Shift', 1], ['Shift', 2],
];

/**
 * Sends a keyup for every modifier. The SDK releases held keys when its input
 * loses focus, but on page unload it only disconnects, so a modifier that is
 * down at that moment (Cmd during Cmd+R) stays held in the remote session.
 * A keyup for a key that is not down has no effect, so this is safe to repeat.
 */
export function releaseModifierKeys(connection: ModifierKeyLatch | null): void {
  if (!connection) return;
  for (const [key, location] of MODIFIER_KEYS) {
    try {
      connection.latchModifierKey(key, location, false);
    } catch {
      // The connection may already be closing; release the rest anyway.
    }
  }
}

type ViewerState =
  // waiting: the console session exists but isn't ready yet, so the request is retried.
  | { phase: 'starting'; waiting?: boolean }
  | { phase: 'session'; session: ViewerSession }
  | { phase: 'session-error'; message: string }
  | { phase: 'connect-error'; message: string; serverUrl: string; untrustedCertificateLikely: boolean }
  | { phase: 'disconnected'; message: string };

interface ConnectViewerProps {
  user: { firstName?: string; lastName?: string; email?: string };
}

function reasonText(reason: DcvDisconnectReason | undefined): string {
  return reason?.message || 'No reason was given.';
}

export default function ConnectViewer({ user }: ConnectViewerProps) {
  const { instanceId } = useParams<{ instanceId: string }>();
  const [state, setState] = useState<ViewerState>({ phase: 'starting' });
  const [attempt, setAttempt] = useState(0);
  // Kept out of React state on purpose: the SDK holds references to the DOM it
  // rendered, so the viewer must not re-render when the connection opens.
  const connected = useRef(false);
  // The open connection, while there is one; used to release modifier keys.
  const connection = useRef<ModifierKeyLatch | null>(null);

  // Release modifiers when the page is hidden or unloaded. pagehide is caught
  // in the capture phase so it runs before the SDK's own pagehide disconnect.
  useEffect(() => {
    const onPageHide = () => releaseModifierKeys(connection.current);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') releaseModifierKeys(connection.current);
    };
    window.addEventListener('pagehide', onPageHide, { capture: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onPageHide, { capture: true });
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!instanceId) return;
    let cancelled = false;
    setState({ phase: 'starting' });
    createViewerSession(instanceId, sessionNameFor(user), {
      onStarting: () => {
        if (!cancelled) setState({ phase: 'starting', waiting: true });
      },
    })
      .then((session) => {
        connected.current = false;
        if (!cancelled) setState({ phase: 'session', session });
      })
      .catch((error: Error) => {
        if (!cancelled) setState({ phase: 'session-error', message: error.message });
      });
    return () => {
      cancelled = true;
    };
    // `user` is stable for the life of the page; a new attempt re-runs this.
  }, [instanceId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const onConnectionEstablished = useCallback((conn: unknown) => {
    connected.current = true;
    connection.current = isModifierKeyLatch(conn) ? conn : null;
  }, []);

  // Called when connect is rejected and when an open connection closes. The
  // token is dropped from state either way; Retry starts a new session.
  const onDisconnect = useCallback((reason: DcvDisconnectReason) => {
    connection.current = null;
    setState((prev) => {
      if (prev.phase !== 'session') return prev;
      if (connected.current) return { phase: 'disconnected', message: reasonText(reason) };
      return {
        phase: 'connect-error',
        message: reasonText(reason),
        serverUrl: prev.session.serverUrl,
        untrustedCertificateLikely: prev.session.untrustedCertificateLikely,
      };
    });
  }, []);

  const session = state.phase === 'session' ? state.session : null;
  // Stable props: built once per session, so DCVViewer never re-renders with new objects.
  const viewerProps = useMemo(() => session && {
    dcv: {
      sessionId: session.sessionId,
      authToken: session.authToken,
      serverUrl: session.serverUrl,
      baseUrl: dcvSdkBaseUrl(),
      logLevel: dcv.LogLevel.WARN,
      onConnectionEstablished,
      onDisconnect,
    },
    uiConfig: { toolbar: { visible: true, fullscreenButton: true, multimonitorButton: true } },
  }, [session, onConnectionEstablished, onDisconnect]);

  if (!instanceId) {
    return <Result status="404" title="No workstation was given" />;
  }

  if (state.phase === 'session') {
    if (!viewerProps) return null; // set whenever phase is 'session'
    return (
      <div style={{ height: '100vh', width: '100vw' }} data-testid="dcv-viewer" data-sdk-base-url={viewerProps.dcv.baseUrl}>
        <DCVViewer dcv={viewerProps.dcv} uiConfig={viewerProps.uiConfig} />
      </div>
    );
  }

  const page = (content: React.ReactNode) => (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {content}
    </div>
  );

  if (state.phase === 'starting') {
    return page(
      <Space direction="vertical" align="center">
        <Spin size="large" />
        <Typography.Text>
          {state.waiting ? STARTING_SESSION_MESSAGE : `Starting a session on ${instanceId}...`}
        </Typography.Text>
      </Space>,
    );
  }

  const retryButton = (
    <Button type="primary" onClick={retry} key="retry">
      Retry
    </Button>
  );

  if (state.phase === 'session-error') {
    return page(
      <Result
        status="error"
        title="Couldn't start the session"
        subTitle={state.message}
        extra={[retryButton]}
      />,
    );
  }

  if (state.phase === 'disconnected') {
    return page(
      <Result
        status="info"
        title="The session was disconnected"
        subTitle={state.message}
        extra={[<Button type="primary" onClick={retry} key="reconnect">Reconnect</Button>]}
      />,
    );
  }

  // connect-error: the gateway didn't accept or answer the connection.
  return page(
    <Result
      status="warning"
      title="Couldn't reach the workstation's gateway"
      subTitle={state.message}
      extra={[retryButton]}
    >
      <Space direction="vertical" style={{ maxWidth: 560 }}>
        <Typography.Paragraph>
          Check that your network allows HTTPS to the gateway, then choose Retry. If it keeps failing, ask your
          administrator to check the Connection Gateway.
        </Typography.Paragraph>
        {state.untrustedCertificateLikely && (
          <Typography.Paragraph data-testid="trust-gateway">
            Your browser may not trust this gateway&apos;s certificate yet. Open{' '}
            <Typography.Link href={`${state.serverUrl}/`} target="_blank" rel="noopener noreferrer">
              the gateway
            </Typography.Link>{' '}
            once, accept the certificate warning (the page itself is empty), then come back and choose Retry.
          </Typography.Paragraph>
        )}
      </Space>
    </Result>,
  );
}
