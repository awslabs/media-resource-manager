// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'child_process';
import * as path from 'path';

describe('scripts/create-multipart-upload.py', () => {
  it('passes its Python unit tests (required bucket argument)', () => {
    const result = spawnSync('python3', ['-m', 'unittest', path.join(__dirname, 'python', 'test_create_multipart_upload.py')], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`);
    }
    expect(result.stderr).toMatch(/OK/);
  });
});
