// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Non-GPU Linux console sessions run on the distribution's Xorg. Serving them
// from Xdcv-console left modifier keys held on the XTEST keyboard with DCV
// 2026.0, so mouse clicks turned into Super+drag window moves.

const phase2: string = require('../ssm-documents/linux-phase2-gpu-setup').mainSteps[0].inputs.runCommand.join('\n');
const phase3: string = require('../ssm-documents/linux-phase3-start-services').mainSteps[0].inputs.runCommand.join('\n');

describe('Linux console session X server', () => {
  test('phase 2 leaves /usr/bin/Xorg in place on Ubuntu', () => {
    expect(phase2).not.toMatch(/dpkg-divert/);
    expect(phase2).not.toMatch(/Xdcv-console/);
  });

  test('phase 2 does not switch Rocky/RHEL console sessions to Xdcv', () => {
    expect(phase2).not.toMatch(/xdcv-console-update\.service/);
    expect(phase2).not.toMatch(/xdcv-console\.path/);
  });

  test('phase 3 waits for Xorg', () => {
    expect(phase3).toMatch(/pgrep -x Xorg/);
  });
});
