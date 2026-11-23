// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The parts of the Amazon DCV Web UI SDK (`dcv-ui.js`) that MRM uses. The SDK
 * ships without type definitions; it is fetched at build time and aliased as
 * `dcv-ui` in vite.config.ts. Reference:
 * https://docs.aws.amazon.com/dcv/latest/websdkguide/dcv-viewer.html
 */
/** The Amazon DCV Web Client SDK (`dcv.js`), aliased as `dcv`; only what MRM uses. */
declare module 'dcv' {
  export type DcvLogLevel = number;
  const dcv: {
    LogLevel: { TRACE: DcvLogLevel; DEBUG: DcvLogLevel; INFO: DcvLogLevel; WARN: DcvLogLevel; ERROR: DcvLogLevel; SILENT: DcvLogLevel };
  };
  export default dcv;
}

declare module 'dcv-ui' {
  import type { ComponentType } from 'react';

  /** What the Web Client SDK passes to `onDisconnect` (a close reason, or the error that rejected `connect`). */
  export interface DcvDisconnectReason {
    code?: number;
    message?: string;
  }

  export interface DCVViewerProps {
    dcv: {
      sessionId: string;
      authToken: string;
      serverUrl: string;
      baseUrl: string;
      resourceBaseUrl?: string;
      onDisconnect?: (reason: DcvDisconnectReason) => void;
      onConnectionEstablished?: (connection: unknown) => void;
      /** A `dcv.LogLevel` value. Required in practice: the viewer throws without it. */
      logLevel: number;
      customTitle?: string;
    };
    uiConfig?: {
      toolbar?: {
        visible?: boolean;
        fullscreenButton?: boolean;
        multimonitorButton?: boolean;
      };
    };
  }

  export const DCVViewer: ComponentType<DCVViewerProps>;
}
