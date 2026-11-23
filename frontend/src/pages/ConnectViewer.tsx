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
import { createViewerSession, sessionNameFor, type ViewerSession } from '../utils/dcvViewer';

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

type ViewerState =
  | { phase: 'starting' }
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

  useEffect(() => {
    if (!instanceId) return;
    let cancelled = false;
    setState({ phase: 'starting' });
    createViewerSession(instanceId, sessionNameFor(user))
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

  const onConnectionEstablished = useCallback(() => {
    connected.current = true;
  }, []);

  // Called when connect is rejected and when an open connection closes. The
  // token is dropped from state either way; Retry starts a new session.
  const onDisconnect = useCallback((reason: DcvDisconnectReason) => {
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
        <Typography.Text>Starting a session on {instanceId}...</Typography.Text>
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
