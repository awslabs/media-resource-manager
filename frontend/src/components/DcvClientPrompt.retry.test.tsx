// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retry over TCP (#139 Stage A): after a QUIC link opens, the prompt hook
 * polls the session's connection count. No connection after about 20 seconds
 * shows "The DCV client didn't connect" with Retry over TCP. The launcher and
 * the API are mocked; the dialogs are the real Ant Design Modals.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const launch = vi.fn();
const getSessionConnections = vi.fn();

vi.mock('../utils/dcvClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/dcvClient')>()),
  launchDcvClient: (...args: unknown[]) => launch(...args),
}));
vi.mock('../utils/dcvApi', () => ({
  DcvApiService: { getSessionConnections: (...args: unknown[]) => getSessionConnections(...args) },
}));

import { useDcvClientPrompt } from './DcvClientPrompt';
import { NATIVE_CONNECT_CHECK_MS, NATIVE_CONNECT_LATE_MS, type NativeConnectionCheck } from '../utils/dcvClient';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const QUIC_URL = 'dcv://gw.example.com:8444/?authToken=t&webPort=8443#sess-1';
const CHECK: NativeConnectionCheck = {
  serverId: 'i-1234567890abcdef0',
  sessionId: 'sess-1',
  tcpUrl: 'dcv://gw.example.com:8443/?authToken=t&transport=websocket#sess-1',
};

let connect: (dcvUrl: string, instanceId?: string, check?: NativeConnectionCheck) => Promise<void>;
let openTitle: string | undefined;

function Harness() {
  const prompt = useDcvClientPrompt(true);
  connect = prompt.connectWithClient;
  // The title of the open dialog, from the Modals' props: a closing Modal
  // stays in the DOM for its animation.
  const modals = React.Children.toArray(
    (prompt.promptModal as React.ReactElement<{ children: React.ReactNode }>).props.children,
  ) as React.ReactElement<{ open?: boolean; title?: string }>[];
  openTitle = modals.find((m) => m.props.open)?.props.title;
  return prompt.promptModal;
}

function title(): string | undefined {
  return openTitle;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found as HTMLButtonElement;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('Retry over TCP', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    launch.mockReset().mockResolvedValue('launched');
    getSessionConnections.mockReset().mockResolvedValue(0);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
      }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  async function connectQuic(check: NativeConnectionCheck | null = CHECK) {
    await act(async () => {
      await connect(QUIC_URL, CHECK.serverId, check ?? undefined);
    });
  }

  it('shows the message with Retry over TCP when no client connected after about 20 seconds', async () => {
    await connectQuic();
    await advance(NATIVE_CONNECT_CHECK_MS - 1000);
    expect(title()).toBeUndefined();
    await advance(1000);
    expect(title()).toBe("The DCV client didn't connect");
    expect(getSessionConnections).toHaveBeenCalledWith(CHECK.serverId, CHECK.sessionId);
    const footer = Array.from(document.querySelectorAll('.ant-modal-footer button')).map((b) => b.textContent?.trim());
    expect(footer).toEqual(['Close', 'Connect in browser', 'Retry over TCP']);
  });

  it('Retry over TCP opens the same session as a TCP link and closes the message', async () => {
    await connectQuic();
    await advance(NATIVE_CONNECT_CHECK_MS);
    await act(async () => {
      button('Retry over TCP').click();
    });
    expect(launch).toHaveBeenLastCalledWith(CHECK.tcpUrl);
    expect(launch).toHaveBeenCalledTimes(2);
    await advance(1000);
    expect(title()).toBeUndefined();
    // The TCP launch isn't checked again: nothing more to offer.
    getSessionConnections.mockClear();
    await advance(NATIVE_CONNECT_CHECK_MS + NATIVE_CONNECT_LATE_MS);
    expect(getSessionConnections).not.toHaveBeenCalled();
  });

  it('shows nothing when the client connects', async () => {
    getSessionConnections.mockResolvedValueOnce(0).mockResolvedValue(1);
    await connectQuic();
    await advance(NATIVE_CONNECT_CHECK_MS);
    expect(title()).toBeUndefined();
    expect(getSessionConnections).toHaveBeenCalledTimes(2);
  });

  it('closes the message when the client connects late', async () => {
    await connectQuic();
    await advance(NATIVE_CONNECT_CHECK_MS);
    expect(title()).toBe("The DCV client didn't connect");
    getSessionConnections.mockResolvedValue(1);
    await advance(5000);
    await advance(1000);
    expect(title()).toBeUndefined();
  });

  it('shows nothing when the check itself fails, for example a hub without the new action', async () => {
    getSessionConnections.mockRejectedValue(new Error('DCV API call failed: 400'));
    await connectQuic();
    await advance(NATIVE_CONNECT_CHECK_MS + 1000);
    expect(title()).toBeUndefined();
  });

  it('does not check a TCP link, or a launch that was not detected', async () => {
    await connectQuic(null);
    await advance(NATIVE_CONNECT_CHECK_MS + 1000);
    expect(getSessionConnections).not.toHaveBeenCalled();

    launch.mockResolvedValue('not-detected');
    await connectQuic();
    await advance(NATIVE_CONNECT_CHECK_MS + 1000);
    expect(getSessionConnections).not.toHaveBeenCalled();
    expect(title()).toBe("DCV client didn't open");
  });

  it('stops checking when the page unmounts', async () => {
    await connectQuic();
    await advance(4000);
    const calls = getSessionConnections.mock.calls.length;
    act(() => root.unmount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_CONNECT_CHECK_MS);
    });
    expect(getSessionConnections.mock.calls.length).toBe(calls);
    root = createRoot(container);
  });
});
