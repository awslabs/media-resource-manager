// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { Button, Modal, Space, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { DCV_CLIENT_DOWNLOAD_URL, launchDcvClient } from '../utils/dcvClient';

const { Paragraph } = Typography;

interface PendingLaunch {
  dcvUrl: string;
  browserUrl?: string;
}

/**
 * Launch the DCV client and, when the launch isn't detected, ask the user
 * whether it opened. Shared by the Ant Design Workstations, Dashboard and
 * Workstation details pages.
 *
 * `connectWithClient` resolves once the launch is detected or the prompt is
 * shown, so callers can keep their "connecting" spinner until then.
 */
export function useDcvClientPrompt(browserSessionsEnabled: boolean) {
  const [pending, setPending] = useState<PendingLaunch | null>(null);
  const [retrying, setRetrying] = useState(false);

  const connectWithClient = async (dcvUrl: string, browserUrl?: string) => {
    const result = await launchDcvClient(dcvUrl);
    if (result === 'not-detected') setPending({ dcvUrl, browserUrl });
  };

  const close = () => setPending(null);

  // Runs inside the click handler, so the launch has a fresh user gesture.
  const tryAgain = async () => {
    if (!pending) return;
    setRetrying(true);
    try {
      if ((await launchDcvClient(pending.dcvUrl)) === 'launched') close();
    } finally {
      setRetrying(false);
    }
  };

  const connectInBrowser = () => {
    if (pending?.browserUrl) window.open(pending.browserUrl, '_blank', 'noopener');
    close();
  };

  const showBrowserOption = browserSessionsEnabled && !!pending?.browserUrl;

  const promptModal = (
    <Modal
      open={!!pending}
      title="Didn't the Amazon DCV client open?"
      onCancel={close}
      footer={
        <Space wrap>
          <Button onClick={close}>Cancel</Button>
          {showBrowserOption && <Button onClick={connectInBrowser}>Connect in browser</Button>}
          <Button onClick={tryAgain} loading={retrying}>
            Try again
          </Button>
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            href={DCV_CLIENT_DOWNLOAD_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Download the DCV client
          </Button>
        </Space>
      }
    >
      <Paragraph>
        If your browser asked whether to open Amazon DCV, choose Open. If the client isn't installed, download and
        install it, then choose Try again.
      </Paragraph>
      {showBrowserOption && <Paragraph>You can also connect in a browser tab instead.</Paragraph>}
    </Modal>
  );

  return { connectWithClient, promptModal };
}
