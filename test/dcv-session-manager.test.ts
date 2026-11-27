// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'child_process';
import * as path from 'path';

describe('dcv-session-manager Lambda', () => {
  it('passes its Python unit tests (browserGatewayUrl)', () => {
    const result = spawnSync('python3', ['-m', 'unittest', path.join(__dirname, 'python', 'test_dcv_session_manager_browser_gateway.py')], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`);
    }
    expect(result.stderr).toMatch(/OK/);
  });

  it('passes its Python unit tests (session wait and console session check calls)', () => {
    const result = spawnSync('python3', ['-m', 'unittest', path.join(__dirname, 'python', 'test_dcv_session_manager_session_wait.py')], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`);
    }
    expect(result.stderr).toMatch(/OK/);
  });

  it('passes its Python unit tests (native client protocol override)', () => {
    const result = spawnSync('python3', ['-m', 'unittest', path.join(__dirname, 'python', 'test_dcv_session_manager_native_transport.py')], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`);
    }
    expect(result.stderr).toMatch(/OK/);
  });

  it('passes its Python unit tests (get-session-connections)', () => {
    const result = spawnSync('python3', ['-m', 'unittest', path.join(__dirname, 'python', 'test_dcv_session_manager_session_connections.py')], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`);
    }
    expect(result.stderr).toMatch(/OK/);
  });

  it('passes its Python unit tests (workstation table in the primary Region)', () => {
    const result = spawnSync('python3', ['-m', 'unittest', path.join(__dirname, 'python', 'test_dcv_session_manager_primary_region.py')], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`);
    }
    expect(result.stderr).toMatch(/OK/);
  });
});
