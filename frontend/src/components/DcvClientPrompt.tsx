// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useRef, useState } from 'react';
import { Button, Modal, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { DCV_CLIENT_DOWNLOAD_URL, launchDcvClient, openBrowserViewer } from '../utils/dcvClient';

const { Paragraph, Link } = Typography;

interface PendingLaunch {
  dcvUrl: string;
  /** Workstation to open in the in-browser viewer instead. */
  instanceId?: string;
}

/**
 * Launch the DCV client and, when the launch isn't detected, ask the user
 * to install it. Shared by the Ant Design Workstations, Dashboard and
 * Workstation details pages.
 *
 * `connectWithClient` resolves once the launch is detected or the prompt is
 * shown, so callers can keep their "connecting" spinner until then.
 */
export function useDcvClientPrompt(browserSessionsEnabled: boolean) {
  const [pending, setPending] = useState<PendingLaunch | null>(null);
  const [retrying, setRetrying] = useState(false);
  // The Try again launch still running, so closing the dialog can stop it.
  const retryLaunch = useRef<AbortController | null>(null);

  const connectWithClient = async (dcvUrl: string, instanceId?: string) => {
    const result = await launchDcvClient(dcvUrl);
    if (result === 'not-detected') setPending({ dcvUrl, instanceId });
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

  const connectInBrowser = () => {
    if (pending?.instanceId) openBrowserViewer(pending.instanceId);
    close();
  };

  const showBrowserOption = browserSessionsEnabled && !!pending?.instanceId;

  const promptModal = (
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
  );

  return { connectWithClient, promptModal };
}
