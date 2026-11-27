// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The admin override control for the native client protocol (#138): Default
 * saves null, QUIC and TCP save their value, and a failed save shows the
 * error and goes back to the stored value.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import NativeClientProtocolOverride from './NativeClientProtocolOverride';
import type { NativeClientTransportOverride } from '../utils/dcvClient';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver; the Select dropdown's virtual list uses one.
(globalThis as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function render(value: NativeClientTransportOverride, onSave: (v: NativeClientTransportOverride) => Promise<void>) {
  act(() => {
    root.render(
      <NativeClientProtocolOverride value={value} onSave={onSave} defaultLabel="Settings" help="help text" />,
    );
  });
}

function shown(): string {
  // Ant Design 6 shows the selected label in .ant-select-content.
  return container.querySelector('.ant-select-content')?.getAttribute('title') ?? '';
}

async function choose(label: string) {
  const selector = container.querySelector('.ant-select') as HTMLElement;
  await act(async () => {
    selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  const option = Array.from(document.querySelectorAll('.ant-select-item-option'))
    .find((o) => o.textContent === label) as HTMLElement | undefined;
  if (!option) throw new Error(`no option "${label}"`);
  await act(async () => {
    option.click();
  });
}

describe('NativeClientProtocolOverride', () => {
  it('shows Default for no override and the protocol for a stored one', () => {
    render(null, vi.fn());
    expect(shown()).toBe('Default (Settings)');
    render('websocket', vi.fn());
    expect(shown()).toBe('TCP (WebSocket)');
  });

  it('saves TCP as websocket and Default as null', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(null, onSave);
    await choose('TCP (WebSocket)');
    expect(onSave).toHaveBeenLastCalledWith('websocket');
    expect(shown()).toBe('TCP (WebSocket)');
    await choose('Default (Settings)');
    expect(onSave).toHaveBeenLastCalledWith(null);
    await choose('QUIC (UDP)');
    expect(onSave).toHaveBeenLastCalledWith('quic');
  });

  it('shows the error and keeps the stored value when the save fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Access denied. Administrator privileges required.'));
    render('quic', onSave);
    await choose('TCP (WebSocket)');
    expect(shown()).toBe('QUIC (UDP)');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Access denied. Administrator privileges required.');
  });
});
