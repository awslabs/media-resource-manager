// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Connect, Cancel, Connect again must show the prompt again (PR #80 live
 * test). Renders the real hook and Ant Design Modal with react-dom + act.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useDcvClientPrompt } from './DcvClientPrompt';
import { DCV_LAUNCH_TIMEOUT_MS } from '../utils/dcvClient';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let connect: (dcvUrl: string, browserUrl?: string) => Promise<void>;
let modalOpen = false;

function Harness() {
  const prompt = useDcvClientPrompt(true);
  connect = prompt.connectWithClient;
  modalOpen = (prompt.promptModal as React.ReactElement<{ open?: boolean }>).props.open === true;
  return prompt.promptModal;
}

/** The dialog's `open` prop from the latest render. */
function promptVisible(): boolean {
  return modalOpen;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found as HTMLButtonElement;
}

async function connectAndTimeOut(duringLaunch?: () => void) {
  let done!: Promise<void>;
  await act(async () => {
    done = connect('dcv://ws.example.com:8444/?authToken=t#s', 'https://ws.example.com:8443/?authToken=t#s');
    duringLaunch?.();
  });
  await act(async () => {
    vi.advanceTimersByTime(DCV_LAUNCH_TIMEOUT_MS);
    await done;
  });
}

describe('useDcvClientPrompt', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows the prompt again on a second connect after Cancel', async () => {
    await connectAndTimeOut();
    expect(promptVisible()).toBe(true);

    await act(async () => {
      button('Cancel').click();
      vi.advanceTimersByTime(1000);
    });
    expect(promptVisible()).toBe(false);

    await connectAndTimeOut();
    expect(promptVisible()).toBe(true);
  });

  it('shows the prompt again when the second connect only blurs the window briefly', async () => {
    // The browser window keeps focus overall: a blur from a browser or OS
    // prompt, or DevTools, that hands focus straight back.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    await connectAndTimeOut();
    expect(promptVisible()).toBe(true);

    await act(async () => {
      button('Cancel').click();
      vi.advanceTimersByTime(1000);
    });
    expect(promptVisible()).toBe(false);

    await connectAndTimeOut(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(promptVisible()).toBe(true);
  });
});
