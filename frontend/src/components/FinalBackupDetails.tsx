// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Typography } from 'antd';

/** `finalBackup` in the DELETE /storage/{storageId} response. */
export interface FinalBackupNotice {
  resourceType: string;
  resourceId?: string;
  region?: string;
  message: string;
  findCommand?: string;
  deleteCommand?: string;
}

/**
 * The final backups FSx keeps after a storage delete, with the commands to
 * find and delete each one. FSx takes the backup during the delete, so its ID
 * isn't known yet when the console shows this.
 */
export const FinalBackupDetails: React.FC<{ notices: FinalBackupNotice[] }> = ({ notices }) => (
  <div data-testid="final-backup-details">
    {notices.map((n, i) => (
      <div key={n.resourceId || i} style={{ marginTop: i ? 12 : 0 }}>
        <Typography.Paragraph style={{ marginBottom: 4 }}>{n.message}</Typography.Paragraph>
        {n.findCommand && (
          <>
            <Typography.Text type="secondary">Find the backup ID:</Typography.Text>
            <Typography.Paragraph copyable={{ text: n.findCommand }} style={{ marginBottom: 4 }}>
              <code>{n.findCommand}</code>
            </Typography.Paragraph>
          </>
        )}
        {n.deleteCommand && (
          <>
            <Typography.Text type="secondary">Delete it when you no longer need it:</Typography.Text>
            <Typography.Paragraph copyable={{ text: n.deleteCommand }} style={{ marginBottom: 0 }}>
              <code>{n.deleteCommand}</code>
            </Typography.Paragraph>
          </>
        )}
      </div>
    ))}
  </div>
);
