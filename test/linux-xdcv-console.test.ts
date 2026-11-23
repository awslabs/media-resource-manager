// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const phase2: string[] = require('../ssm-documents/linux-phase2-gpu-setup').mainSteps[0].inputs.runCommand;
const phase3: string[] = require('../ssm-documents/linux-phase3-start-services').mainSteps[0].inputs.runCommand;

const XDCV_CONSOLE = '/usr/bin/Xdcv-console';

const indexOf = (lines: string[], text: string, from = 0) => {
  const i = lines.findIndex((line, n) => n >= from && line.includes(text));
  if (i < 0) throw new Error(`line not found: ${text}`);
  return i;
};

/** Lines from `start` to the first top-level `fi` after it. */
const block = (lines: string[], start: number) => lines.slice(start, lines.indexOf('fi', start) + 1);

interface Stubs {
  gpu: boolean;
  distro?: string;
  xdcvConsole: boolean;
  running?: string[];
}

/**
 * Run a script block with stub commands. sudo only records its arguments, so
 * nothing on the test machine is changed. /etc/os-release and
 * /usr/bin/Xdcv-console are pointed at files in a scratch directory.
 */
function run(script: string, stubs: Stubs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdcv-console-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'sudo.log');
  const stub = (name: string, body: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub('lspci', stubs.gpu
    ? 'echo "00:1e.0 3D controller: NVIDIA Corporation TU104GL [Tesla T4]"'
    : 'echo "00:03.0 VGA compatible controller: Amazon.com, Inc. Device 1111"');
  stub('sudo', `echo "$*" >> "${log}"`);
  const running = stubs.running ?? [];
  stub('pgrep', `[ "$1" = "-x" ] && case " ${running.join(' ')} " in *" $2 "*) echo 1234; exit 0;; esac; exit 1`);

  const osRelease = path.join(dir, 'os-release');
  if (stubs.distro) fs.writeFileSync(osRelease, `ID=${stubs.distro}\nVERSION_ID="1"\n`);
  const xdcvConsole = path.join(dir, 'Xdcv-console');
  if (stubs.xdcvConsole) fs.writeFileSync(xdcvConsole, '#!/bin/sh\n', { mode: 0o755 });

  const body = script.split('/etc/os-release').join(osRelease).split(XDCV_CONSOLE).join(xdcvConsole);
  try {
    const result = spawnSync('bash', ['-c', `set -e\nGDM_SERVICE=gdm\n${body}\necho passed`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const restore = (text: string) => text.split(xdcvConsole).join(XDCV_CONSOLE);
    const sudo = fs.existsSync(log) ? restore(fs.readFileSync(log, 'utf8')) : '';
    return { ...result, stdout: restore(result.stdout), sudo };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Linux phase 2 Xdcv console setup (non-GPU)', () => {
  const start = indexOf(phase2, 'if ! lspci | grep -qi nvidia; then');
  const noGpu = block(phase2, start);
  const script = noGpu.join('\n');

  it('sets up Xdcv only in the no-GPU branch, which exits before the GPU setup', () => {
    expect(noGpu[noGpu.length - 2].trim()).toBe('exit 0');
    const rest = [...phase2.slice(0, start), ...phase2.slice(start + noGpu.length)].join('\n');
    expect(rest).not.toContain('Xdcv');
  });

  it('diverts Xorg to Xdcv-console on Ubuntu', () => {
    const result = run(script, { gpu: false, distro: 'ubuntu', xdcvConsole: true });
    expect(result.status).toBe(0);
    // The branch ends with exit 0, so the GPU setup after it never runs.
    expect(result.stdout).not.toContain('passed');
    expect(result.sudo.trim().split('\n')).toEqual([
      'dpkg-divert --package nice-xdcv --divert /usr/bin/Xorg.orig --rename /usr/bin/Xorg',
      `ln -sf ${XDCV_CONSOLE} /usr/bin/Xorg`,
    ]);
  });

  it.each(['rocky', 'rhel', 'centos'])('enables the nice-xdcv console units on %s', (distro) => {
    const result = run(script, { gpu: false, distro, xdcvConsole: true });
    expect(result.status).toBe(0);
    expect(result.sudo.trim().split('\n')).toEqual([
      'systemctl enable --now xdcv-console-update.service',
      'systemctl enable xdcv-console.path',
    ]);
  });

  it('warns and changes nothing when Xdcv-console is not installed', () => {
    const result = run(script, { gpu: false, distro: 'ubuntu', xdcvConsole: false });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WARNING: /usr/bin/Xdcv-console not found');
    expect(result.sudo).toBe('');
  });

  it('warns and changes nothing on other distributions', () => {
    const result = run(script, { gpu: false, distro: 'debian', xdcvConsole: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WARNING: Xdcv console sessions are not set up on debian');
    expect(result.sudo).toBe('');
  });

  it('does nothing on a GPU instance', () => {
    const result = run(script, { gpu: true, distro: 'ubuntu', xdcvConsole: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('passed');
    expect(result.sudo).toBe('');
  });

  it('is valid bash', () => {
    const result = spawnSync('bash', ['-n'], { input: phase2.join('\n'), encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

describe('Linux phase 3 console X server check', () => {
  const start = indexOf(phase3, '# ========== NON-GPU: CONSOLE X SERVER CHECK ==========');
  const check = block(phase3, start).join('\n');

  it('accepts Xdcv as the X server when waiting for GDM and in the boot service', () => {
    expect(phase3[indexOf(phase3, 'for i in {1..3}; do') + 1])
      .toBe('  if pgrep -x Xorg > /dev/null || pgrep -x Xdcv > /dev/null; then');
    expect(phase3[indexOf(phase3, 'ExecStart=/bin/bash')])
      .toContain('pgrep -x Xorg || pgrep -x Xdcv || systemctl restart $GDM_SERVICE');
  });

  it('runs after the X server wait and before DCV starts', () => {
    expect(start).toBeGreaterThan(indexOf(phase3, 'echo "Verifying the X server is running..."'));
    expect(start).toBeLessThan(indexOf(phase3, 'echo "Starting DCV Server..."'));
  });

  it('passes on a non-GPU instance when Xdcv is running', () => {
    const result = run(check, { gpu: false, xdcvConsole: true, running: ['Xdcv'] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Console X server: Xdcv');
  });

  it('fails on a non-GPU instance when Xdcv-console is installed but Xdcv is not running', () => {
    const result = run(check, { gpu: false, xdcvConsole: true, running: ['Xorg'] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('ERROR: the Xdcv console X server is not running');
    expect(result.stdout).not.toContain('passed');
    expect(result.sudo).toContain('journalctl -b -u gdm --no-pager');
  });

  it('warns on a non-GPU instance without Xdcv-console', () => {
    const result = run(check, { gpu: false, xdcvConsole: false, running: ['Xorg'] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WARNING: /usr/bin/Xdcv-console not found');
  });

  it('does not check GPU instances', () => {
    const result = run(check, { gpu: true, xdcvConsole: true, running: ['Xorg'] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('passed');
  });

  it('is valid bash', () => {
    const result = spawnSync('bash', ['-n'], { input: phase3.join('\n'), encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
