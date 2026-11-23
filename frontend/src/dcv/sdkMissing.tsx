// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stand-in for the Amazon DCV Web UI SDK in dev and test builds made without
 * running scripts/fetch-dcv-web-sdk.sh. A production build without the SDK
 * fails in vite.config.ts instead.
 */
import type { DCVViewerProps } from 'dcv-ui';

export function DCVViewer({ dcv }: DCVViewerProps) {
  // Report it the way the real viewer reports a failed connect.
  queueMicrotask(() =>
    dcv.onDisconnect?.({ message: 'The Amazon DCV Web Client SDK is not in this build. Run scripts/fetch-dcv-web-sdk.sh.' }),
  );
  return null;
}
