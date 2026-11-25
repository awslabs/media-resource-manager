// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deleting a regional hub from the Regions page while workstations remain in
 * its Region: the API answers 409 with the workstations, and the delete dialog
 * stays open and lists them by hostname and instance ID, with "and N more"
 * and the hint. The API and the layout are mocked; the page, its table and
 * modal are real.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HINT = 'Snapshot or copy any data you need from these workstations, then terminate them before deleting the hub.';
const instanceId = (n: number) => `i-${String(n).padStart(17, '0')}`;

let deleteResponse: { status: number; body: Record<string, unknown> };
const deleteCalls: string[] = [];
const json = (status: number, body: unknown) => ({ ok: status < 400, status, statusText: '', json: async () => body }) as Response;

vi.mock('../utils/api', () => ({
  apiCall: vi.fn(async (endpoint: string, options: RequestInit = {}) => {
    if (options.method === 'DELETE') {
      deleteCalls.push(endpoint);
      return json(deleteResponse.status, deleteResponse.body);
    }
    if (endpoint === 'regions') {
      return json(200, {
        success: true,
        data: [{ region: 'us-west-2', displayName: 'Oregon', status: 'available', workstationCount: 22 }],
      });
    }
    return json(200, {});
  }),
}));
vi.mock('../utils/auth', () => ({ getAuthToken: () => 'token' }));
vi.mock('../utils/regionalHubUpdates', () => ({ rememberRegionalHubs: vi.fn(), forgetRegionalHubUpdates: vi.fn() }));
vi.mock('../components/AppLayoutAntd', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line import/first
import RegionManagementAntd from './RegionManagementAntd';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  deleteCalls.length = 0;
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const buttonIn = (scope: ParentNode, label: string) =>
  Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

async function deleteHub() {
  await act(async () => {
    root.render(<RegionManagementAntd user={{}} isAdmin onSignOut={() => undefined} config={{ region: 'us-east-1' }} />);
  });
  await flush();
  const rowCheckbox = container.querySelector('tbody input[type="checkbox"]') as HTMLInputElement;
  expect(rowCheckbox).toBeTruthy();
  await act(async () => { rowCheckbox.click(); });
  await act(async () => { buttonIn(container, 'Delete').click(); });
  await flush();
  const dialog = document.querySelector('.ant-modal') as HTMLElement;
  expect(dialog.textContent).toContain(HINT);
  await act(async () => { buttonIn(dialog.querySelector('.ant-modal-footer')!, 'Delete').click(); });
  await flush();
  return dialog;
}

describe('RegionManagementAntd hub delete', () => {
  it('keeps the dialog open and lists the workstations, "and N more" and the hint on a 409', async () => {
    const workstations = Array.from({ length: 20 }, (_, i) => ({ hostname: `ws-${String(i + 1).padStart(4, '0')}`, instanceId: instanceId(i + 1) }));
    deleteResponse = {
      status: 409,
      body: { error: 'Terminate the 22 workstations in us-west-2 before deleting its regional hub.', hint: HINT, workstationCount: 22, workstations, moreCount: 2 },
    };
    const dialog = await deleteHub();
    expect(deleteCalls).toEqual(['regions/us-west-2']);
    const refusal = dialog.querySelector('[data-testid="hub-delete-refusal"]') as HTMLElement;
    expect(refusal).toBeTruthy();
    expect(refusal.textContent).toContain('Oregon (us-west-2): Terminate the 22 workstations in us-west-2 before deleting its regional hub.');
    expect(refusal.querySelectorAll('li')).toHaveLength(20);
    expect(refusal.textContent).toContain(`ws-0001 (${instanceId(1)})`);
    expect(refusal.textContent).toContain('and 2 more');
    expect(refusal.textContent).toContain(HINT);
    expect(document.body.textContent).not.toContain('Deletion started');
  });

  it('closes the dialog when the deletion starts', async () => {
    deleteResponse = { status: 202, body: { success: true, status: 'deleting' } };
    await deleteHub();
    expect(document.querySelector('[data-testid="hub-delete-refusal"]')).toBeNull();
    expect(document.body.textContent).toContain('Deletion started for 1 regional hub(s)');
  });
});
