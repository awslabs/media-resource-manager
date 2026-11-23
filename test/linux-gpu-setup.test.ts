// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const phase2: string[] = require('../ssm-documents/linux-phase2-gpu-setup').mainSteps[0].inputs.runCommand;
const phase3: string[] = require('../ssm-documents/linux-phase3-start-services').mainSteps[0].inputs.runCommand;

const indexOf = (lines: string[], text: string, from = 0) => {
  const i = lines.findIndex((line, n) => n >= from && line.includes(text));
  if (i < 0) throw new Error(`line not found: ${text}`);
  return i;
};

describe('Linux phase 2 GPU setup (Ubuntu)', () => {
  const ubuntu = indexOf(phase2, 'if [ "$DISTRO" = "ubuntu" ]');
  const rocky = indexOf(phase2, '# ========== ROCKY/RHEL ==========');
  const ubuntuLines = phase2.slice(ubuntu, rocky);

  it('installs the extra kernel modules for the running kernel before the driver', () => {
    const extra = indexOf(ubuntuLines, 'apt-get install -y linux-modules-extra-$(uname -r)');
    const driver = indexOf(ubuntuLines, 'apt-get install -y "$NVIDIA_PKG"');
    expect(extra).toBeLessThan(driver);
    // Not optional: without it nvidia_drm cannot load.
    expect(ubuntuLines[extra]).not.toContain('||');
  });

  it('installs the extra modules even when a driver is already installed', () => {
    const extra = indexOf(ubuntuLines, 'linux-modules-extra-$(uname -r)');
    const guard = indexOf(ubuntuLines, 'if [ "$NVIDIA_INSTALLED" = "false" ]');
    expect(extra).toBeLessThan(guard);
  });

  it('keeps the extra modules for future kernels with the AWS metapackage, on AWS kernels only', () => {
    const meta = indexOf(ubuntuLines, 'apt-get install -y linux-modules-extra-aws');
    expect(ubuntuLines[meta]).toContain('|| echo "WARNING');
    expect(ubuntuLines.slice(0, meta).some(l => l.includes('case "$(uname -r)" in'))).toBe(true);
    expect(ubuntuLines[meta - 2].trim()).toBe('*-aws)');
  });

  it('does not change the Rocky/RHEL path', () => {
    expect(phase2.slice(rocky).join('\n')).not.toContain('linux-modules-extra');
  });

  it('is valid bash', () => {
    const result = spawnSync('bash', ['-n'], { input: phase2.join('\n'), encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

describe('Linux phase 3 nvidia_drm check', () => {
  const start = indexOf(phase3, 'if [ "$DISTRO" = "ubuntu" ] && ! lsmod');
  const end = phase3.indexOf('  fi', start);
  const check = phase3.slice(start, end + 1).join('\n');

  it('runs inside the NVIDIA GPU branch, after waiting for the driver', () => {
    const gpu = indexOf(phase3, 'if lspci | grep -qi nvidia; then');
    const wait = indexOf(phase3, 'for i in {1..30}; do', gpu);
    expect(start).toBeGreaterThan(wait);
    expect(phase3[end + 1]).toBe('fi');
  });

  it('is valid bash', () => {
    const result = spawnSync('bash', ['-n'], { input: phase3.join('\n'), encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  /** Run the check with stub lsmod, modprobe, sudo and dmesg commands. */
  function run(distro: string, loaded: boolean, modprobeOk: boolean) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-drm-'));
    const stub = (name: string, body: string) =>
      fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    stub('lsmod', loaded ? 'echo "nvidia_drm 1 0"; echo "nvidia 1 0"' : 'echo "nvidia 1 0"');
    stub('modprobe', `exit ${modprobeOk ? 0 : 1}`);
    stub('sudo', '"$@"');
    stub('dmesg', 'echo "nvidia_drm: Unknown symbol example (err -2)"');
    try {
      return spawnSync('bash', ['-c', `set -e\nDISTRO=${distro}\n${check}\necho passed`], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }

  it('passes on Ubuntu when nvidia_drm is loaded', () => {
    const result = run('ubuntu', true, false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('passed');
  });

  it('passes on Ubuntu when nvidia_drm loads with modprobe', () => {
    expect(run('ubuntu', false, true).status).toBe(0);
  });

  it('fails on Ubuntu when nvidia_drm cannot load', () => {
    const result = run('ubuntu', false, false);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('ERROR: the nvidia_drm kernel module did not load');
    expect(result.stdout).toContain('Unknown symbol example');
    expect(result.stdout).not.toContain('passed');
  });

  it('does not check other distributions', () => {
    expect(run('rocky', false, false).status).toBe(0);
  });
});
