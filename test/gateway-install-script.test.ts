// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DCV Connection Gateway install script (user-data/connection-gateway-install.sh,
 * used by the primary stack and the regional hub template): a failed download
 * or install stops the script with an ERROR line and a non-zero exit.
 *
 * Runs the script with stub commands (curl, dnf, systemctl, aws, ...) first on
 * PATH, so it touches nothing on the host.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.join(__dirname, '../user-data/connection-gateway-install.sh');

const STUBS: Record<string, string> = {
  // IMDS answers; package downloads follow CURL_MODE (ok, empty or timeout).
  curl: `
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H|-X|--connect-timeout|--max-time|--retry|--retry-delay) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
echo "curl $url" >> "$STUB_LOG"
case "$url" in
  *169.254.169.254*/api/token) echo token ;;
  *169.254.169.254*/instance-id) echo i-test ;;
  *169.254.169.254*/placement/region) echo us-east-1 ;;
  *)
    case "$CURL_MODE" in
      timeout) echo "curl: (28) Connection timed out after 10001 milliseconds" >&2; exit 28 ;;
      empty) : > "$out" ;;
      *) echo data > "$out" ;;
    esac ;;
esac`,
  dnf: 'echo "dnf $*" >> "$STUB_LOG"; exit "${DNF_EXIT:-0}"',
  systemctl: `echo "systemctl $*" >> "$STUB_LOG"
[ "$1" = "cat" ] && exit "\${UNIT_EXIT:-0}"
exit 0`,
  aws: 'echo broker.example.internal',
  arch: 'echo aarch64',
  rpm: 'exit 0',
  gpg: 'exit 0',
  timeout: 'exit 0',
  sleep: 'exit 0',
  openssl: 'exit 0',
};

interface Run { status: number | null; output: string; calls: string[] }

function run(env: Record<string, string>): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-install-test-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    for (const [name, body] of Object.entries(STUBS)) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    }
    const osRelease = path.join(dir, 'os-release');
    fs.writeFileSync(osRelease, 'ID="amzn"\nVERSION_ID="2023"\n');
    const stubLog = path.join(dir, 'calls.log');
    fs.writeFileSync(stubLog, '');
    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        TMPDIR: dir,
        LOG_PATH: path.join(dir, 'install.log'),
        OS_RELEASE_FILE: osRelease,
        STUB_LOG: stubLog,
        PRODUCT_NAME: 'MediaResourceManager',
        ...env,
      },
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      calls: fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('connection gateway install script', () => {
  it('stops with an error when a download times out, and installs nothing', () => {
    const r = run({ CURL_MODE: 'timeout' });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('ERROR: Download failed: https://d1uj6qtbmh3dt5.cloudfront.net/NICE-GPG-KEY');
    expect(r.output).not.toContain('SUCCESS');
    expect(r.calls.some(c => c.startsWith('dnf '))).toBe(false);
    expect(r.calls.some(c => c.startsWith('systemctl '))).toBe(false);
  });

  it('stops with an error when a download is empty', () => {
    const r = run({ CURL_MODE: 'empty' });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('ERROR: Download is missing or empty');
    expect(r.calls.some(c => c.startsWith('dnf '))).toBe(false);
  });

  it('downloads only the gateway package, and stops with an error when its install fails', () => {
    const r = run({ CURL_MODE: 'ok', DNF_EXIT: '1' });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('ERROR: Package install failed');
    const downloads = r.calls.filter(c => c.includes('cloudfront.net'));
    expect(downloads).toEqual([
      'curl https://d1uj6qtbmh3dt5.cloudfront.net/NICE-GPG-KEY',
      'curl https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-connection-gateway-el9.aarch64.rpm',
    ]);
  });

  it('stops with an error when the package left no systemd unit', () => {
    const r = run({ CURL_MODE: 'ok', UNIT_EXIT: '1' });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('ERROR: dcv-connection-gateway.service is not installed');
    expect(r.calls).not.toContain('systemctl start dcv-connection-gateway');
  });
});
