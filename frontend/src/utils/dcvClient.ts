// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Launch the Amazon DCV native client from a `dcv://` link and guess whether
 * it opened.
 *
 * Browsers don't tell a page whether an app handles a URL scheme. When the
 * client opens, the browser window loses focus (`blur`) or the page becomes
 * hidden (`visibilitychange`). If neither happens within the timeout, we
 * report `not-detected`. That is a guess: a user who takes longer than the
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

export interface LaunchDcvClientOptions {
  timeoutMs?: number;
  method?: DcvLaunchMethod;
}

export function launchDcvClient(
  url: string,
  { timeoutMs = DCV_LAUNCH_TIMEOUT_MS, method = defaultLaunchMethod() }: LaunchDcvClientOptions = {},
): Promise<DcvLaunchResult> {
  return new Promise((resolve) => {
    let iframe: HTMLIFrameElement | null = null;
    let settled = false;

    const finish = (result: DcvLaunchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      iframe?.remove();
      iframe = null;
      resolve(result);
    };
    const onBlur = () => finish('launched');
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') finish('launched');
    };

    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const timeoutId = setTimeout(() => finish('not-detected'), timeoutMs);

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
