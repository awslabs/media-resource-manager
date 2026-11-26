// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useRef, useState } from 'react';
import { Button, Modal, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import {
  DCV_CLIENT_DOWNLOAD_URL,
  NATIVE_CONNECT_LATE_MS,
  launchDcvClient,
  openBrowserViewer,
  waitForNativeConnection,
  type NativeConnectionCheck,
} from '../utils/dcvClient';
import { DcvApiService } from '../utils/dcvApi';

const { Paragraph, Link } = Typography;

interface PendingLaunch {
  dcvUrl: string;
  /** Workstation to open in the in-browser viewer instead. */
  instanceId?: string;
}

interface NotConnected {
  check: NativeConnectionCheck;
  instanceId?: string;
}

/**
 * Launch the DCV client and, when the launch isn't detected, ask the user
 * to install it. Shared by the Ant Design Workstations, Dashboard and
 * Workstation details pages.
 *
 * With a `check` (a QUIC link), it then asks the backend whether a client
 * connected to the session. When none has after about 20 seconds, it offers
 * Retry over TCP (#139).
 *
 * `connectWithClient` resolves once the launch is detected or the prompt is
 * shown, so callers can keep their "connecting" spinner until then. The
 * connection check runs after that.
 */
export function useDcvClientPrompt(browserSessionsEnabled: boolean) {
  const [pending, setPending] = useState<PendingLaunch | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [notConnected, setNotConnected] = useState<NotConnected | null>(null);
  // The Try again launch still running, so closing the dialog can stop it.
  const retryLaunch = useRef<AbortController | null>(null);
  // The connection check still running; a new connect or unmount stops it.
  const connectionCheck = useRef<AbortController | null>(null);

  useEffect(() => () => connectionCheck.current?.abort(), []);

  const watchConnection = async (check: NativeConnectionCheck, instanceId?: string) => {
    connectionCheck.current?.abort();
    const controller = new AbortController();
    connectionCheck.current = controller;
    const count = () => DcvApiService.getSessionConnections(check.serverId, check.sessionId);
    const result = await waitForNativeConnection(count, { signal: controller.signal });
    if (result !== 'not-connected' || controller.signal.aborted) return;
    setNotConnected({ check, instanceId });
    // Keep checking, so the message goes away if the client connects late.
    const late = await waitForNativeConnection(count, { signal: controller.signal, timeoutMs: NATIVE_CONNECT_LATE_MS });
    if (late === 'connected' && !controller.signal.aborted) {
      setNotConnected((current) => (current?.check === check ? null : current));
    }
  };

  const connectWithClient = async (dcvUrl: string, instanceId?: string, check?: NativeConnectionCheck) => {
    connectionCheck.current?.abort();
    setNotConnected(null);
    const result = await launchDcvClient(dcvUrl);
    if (result === 'not-detected') setPending({ dcvUrl, instanceId });
    else if (check) void watchConnection(check, instanceId);
  };

  const close = () => {
    retryLaunch.current?.abort();
    retryLaunch.current = null;
    setPending(null);
  };

  // Runs inside the click handler, so the launch has a fresh user gesture.
  const tryAgain = async () => {
    if (!pending) return;
    retryLaunch.current?.abort();
    const controller = new AbortController();
    retryLaunch.current = controller;
    setRetrying(true);
    try {
      const result = await launchDcvClient(pending.dcvUrl, { signal: controller.signal });
      if (result === 'launched' && !controller.signal.aborted) close();
    } finally {
      if (retryLaunch.current === controller) retryLaunch.current = null;
      setRetrying(false);
    }
  };

  const closeNotConnected = () => {
    connectionCheck.current?.abort();
    connectionCheck.current = null;
    setNotConnected(null);
  };

  // Also runs inside the click handler. A TCP link that doesn't open falls
  // through to the install prompt, like any other launch.
  const retryOverTcp = async () => {
    if (!notConnected) return;
    const { check, instanceId } = notConnected;
    closeNotConnected();
    await connectWithClient(check.tcpUrl, instanceId);
  };

  const connectInBrowser = () => {
    if (pending?.instanceId) openBrowserViewer(pending.instanceId);
    close();
  };

  const connectNotConnectedInBrowser = () => {
    if (notConnected?.instanceId) openBrowserViewer(notConnected.instanceId);
    closeNotConnected();
  };

  const showBrowserOption = browserSessionsEnabled && !!pending?.instanceId;
  const showNotConnectedBrowserOption = browserSessionsEnabled && !!notConnected?.instanceId;

  const promptModal = (
    <>
      <Modal
        open={!!pending}
        title="DCV client didn't open"
        okText="Try again"
        cancelText="Cancel"
        onOk={tryAgain}
        onCancel={close}
        // Not confirmLoading: Ant Design ignores Cancel while that is set, and
        // Cancel must be able to stop a running Try again. autoFocus puts the
        // initial focus on Try again; destroyOnHidden remounts the content so
        // that happens on every open, not only the first.
        okButtonProps={{ loading: retrying, autoFocus: true }}
        destroyOnHidden
        footer={(_, { OkBtn, CancelBtn }) => (
          <>
            <CancelBtn />
            {showBrowserOption && <Button onClick={connectInBrowser}>Connect in browser</Button>}
            <OkBtn />
          </>
        )}
      >
        <Paragraph>Install the Amazon DCV client, then try again.</Paragraph>
        <Paragraph>
          <Link
            href={DCV_CLIENT_DOWNLOAD_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ whiteSpace: 'nowrap' }}
          >
            <DownloadOutlined /> Download the DCV client
          </Link>
        </Paragraph>
      </Modal>
      <Modal
        open={!!notConnected}
        title="The DCV client didn't connect"
        okText="Retry over TCP"
        cancelText="Close"
        onOk={retryOverTcp}
        onCancel={closeNotConnected}
        okButtonProps={{ autoFocus: true }}
        destroyOnHidden
        footer={(_, { OkBtn, CancelBtn }) => (
          <>
            <CancelBtn />
            {showNotConnectedBrowserOption && (
              <Button onClick={connectNotConnectedInBrowser}>Connect in browser</Button>
            )}
            <OkBtn />
          </>
        )}
      >
        <Paragraph>
          The DCV client opened, but no connection reached the workstation. This usually
          means UDP is blocked between the client and the workstation, so QUIC can't connect.
        </Paragraph>
        <ul>
          <li>Retry over TCP opens the same session over TCP port 8443 instead of QUIC (UDP port 8444).</li>
          <li>
            If TCP works and you need it every time, ask an administrator to set the native
            client protocol to TCP for this workstation or for your user.
          </li>
          <li>If the client is still asking you to trust a certificate or sign in, finish that and close this message.</li>
        </ul>
      </Modal>
    </>
  );

  return { connectWithClient, promptModal };
}
