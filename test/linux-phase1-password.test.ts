// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Runs the start of the Linux Phase 1 SSM document (everything before the
 * desktop and DCV install) in bash with stub commands on the PATH. Checks
 * that phase 1 installs the AWS CLI when the image has none, sets the user
 * password from Secrets Manager, never exposes the password, and fails the
 * command instead of carrying on without a password (#78).
 */

const doc = require('../ssm-documents/linux-phase1-base-install.js');
const runCommand: string[] = doc.mainSteps[0].inputs.runCommand;

const PASSWORD = 'not-a-real-password'; // pragma: allowlist secret
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:/MediaResourceManager/Workstation/StandaloneAdminPassword-AbCdEf'; // pragma: allowlist secret
// The fingerprint the document pins; the last test checks it against the embedded key block.
const AWS_CLI_KEY_FPR = (runCommand.join('\n').match(/^AWS_CLI_KEY_FPR="([0-9A-F]{40})"$/m) || [])[1] ?? '';

/** Real tools the script section and the stubs need. */
const REAL_TOOLS = ['cat', 'chmod', 'cp', 'cut', 'grep', 'mkdir', 'mktemp', 'rm'];

const STUBS: Record<string, string> = {
  sudo: 'exec "$@"',
  uname: 'echo "${UNAME_M:-x86_64}"',
  sleep: 'exit 0',
  'apt-get': 'exit 0',
  dnf: 'exit 0',
  id: 'exit 0',
  useradd: 'exit 0',
  usermod: 'exit 0',
  chpasswd: 'cat >> "$STUB_DIR/chpasswd.stdin"',
  // curl -fsSL ... -o <file> <url>
  curl: [
    '[ -n "$CURL_FAIL" ] && exit 22',
    'out=""; prev=""',
    'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
    'echo "curl ${@: -1}" >> "$STUB_DIR/calls.log"',
    '[ -n "$out" ] && echo fake > "$out"',
    'exit 0',
  ].join('\n'),
  gpg: [
    'case " $* " in',
    '  *" --verify "*)',
    '    if [ "$GPG_MODE" = "bad" ]; then echo "[GNUPG:] BADSIG A6310ACC4672475C AWS CLI Team"; exit 1; fi',
    `    echo "[GNUPG:] VALIDSIG ${AWS_CLI_KEY_FPR} 2026-11-21 0 0 4 0 1 10 00 ${AWS_CLI_KEY_FPR}" ;;`,
    'esac',
  ].join('\n'),
  // unzip -q <zip> -d <dir>: unpack a fake installer that puts a working aws in -b <dir>
  unzip: [
    'dest="${@: -1}"',
    'mkdir -p "$dest/aws"',
    'cat > "$dest/aws/install" << \'EOF\'',
    '#!/bin/bash',
    'echo "install $*" >> "$STUB_DIR/calls.log"',
    'bin=""; prev=""',
    'for a in "$@"; do [ "$prev" = "-b" ] && bin="$a"; prev="$a"; done',
    'mkdir -p "$bin" && cp "$STUB_DIR/aws.stub" "$bin/aws" && chmod +x "$bin/aws"',
    'EOF',
    'chmod +x "$dest/aws/install"',
  ].join('\n'),
};

/** The aws command the fake installer drops in, or the one already on the image. */
const AWS_STUB = [
  '#!/bin/bash',
  'echo "aws $*" >> "$STUB_DIR/calls.log"',
  'if [ "$1" = "--version" ]; then echo "aws-cli/2.0.0"; exit 0; fi',
  '[ -n "$AWS_FAIL" ] && { echo "An error occurred (AccessDeniedException)" >&2; exit 254; }',
  'printf "%s\\n" "$SECRET_VALUE"',
].join('\n');

interface RunOptions {
  distro?: 'ubuntu' | 'rocky';
  awsInstalled?: boolean;
  env?: Record<string, string>;
}

interface RunResult {
  status: number | null;
  output: string;
  calls: string;
  chpasswd: string;
}

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-phase1-'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function run(opts: RunOptions = {}): RunResult {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  const bin = path.join(dir, 'bin');
  const installDir = path.join(dir, 'usr-local-bin');
  fs.mkdirSync(bin);

  for (const tool of REAL_TOOLS) {
    const real = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(real, path.join(bin, tool));
  }
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dir, 'aws.stub'), AWS_STUB + '\n', { mode: 0o755 });
  if (opts.awsInstalled) fs.copyFileSync(path.join(dir, 'aws.stub'), path.join(bin, 'aws'));

  const osRelease = path.join(dir, 'os-release');
  const distro = opts.distro ?? 'ubuntu';
  fs.writeFileSync(osRelease, distro === 'ubuntu'
    ? 'ID=ubuntu\nVERSION_ID="22.04"\n'
    : 'ID="rocky"\nVERSION_ID="9.4"\n');

  // Everything before the desktop/DCV install, with SSM parameters filled in
  // and the OS and install paths pointed into the sandbox.
  const end = runCommand.findIndex(l => l.includes('Detect major version for package selection'));
  expect(end).toBeGreaterThan(0);
  const script = runCommand.slice(0, end).join('\n')
    .replace('{{SessMgrDNS}}', 'sm.example.internal')
    .replace('{{AdminPasswordSecretArn}}', SECRET_ARN)
    .split('/etc/os-release').join(osRelease)
    .replace('AWS_CLI_BIN_DIR="/usr/local/bin"', `AWS_CLI_BIN_DIR="${installDir}"`)
    + '\necho "REACHED_END_OF_PASSWORD_STEP"\n';
  const scriptPath = path.join(dir, 'phase1.sh');
  fs.writeFileSync(scriptPath, script);

  const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
  const result = spawnSync(bash, [scriptPath], {
    encoding: 'utf8',
    env: {
      PATH: bin,
      HOME: dir,
      TMPDIR: dir,
      STUB_DIR: dir,
      SECRET_VALUE: PASSWORD,
      ...opts.env,
    },
  });
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    calls: read('calls.log'),
    chpasswd: read('chpasswd.stdin'),
  };
}

const describeBash = process.platform === 'win32' ? describe.skip : describe;

describeBash('Linux phase 1: AWS CLI and user password (#78)', () => {
  it('installs AWS CLI v2 when the image has none, then sets the ubuntu password', () => {
    const r = run({ distro: 'ubuntu', awsInstalled: false });
    expect(r.status).toBe(0);
    expect(r.output).toContain('AWS CLI v2 installer signature verified');
    expect(r.calls).toContain('curl https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip\n');
    expect(r.calls).toMatch(/^install --update /m);
    expect(r.chpasswd).toBe(`ubuntu:${PASSWORD}\n`);
    expect(r.output).toContain('REACHED_END_OF_PASSWORD_STEP');
  });

  it('downloads the installer for the instance architecture', () => {
    const r = run({ awsInstalled: false, env: { UNAME_M: 'aarch64' } });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('curl https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip\n');
    expect(r.calls).toContain('curl https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip.sig\n');
    expect(r.chpasswd).toBe(`ubuntu:${PASSWORD}\n`);
  });

  it('skips the install when the image already has the AWS CLI', () => {
    const r = run({ awsInstalled: true });
    expect(r.status).toBe(0);
    expect(r.output).not.toContain('installing AWS CLI v2');
    expect(r.calls).not.toMatch(/^install /m);
    expect(r.chpasswd).toBe(`ubuntu:${PASSWORD}\n`);
  });

  it('sets the rocky password on Rocky Linux', () => {
    const r = run({ distro: 'rocky', awsInstalled: false });
    expect(r.status).toBe(0);
    expect(r.chpasswd).toBe(`rocky:${PASSWORD}\n`);
  });

  it('reads the secret in the Region of its ARN, not from instance metadata', () => {
    const r = run({ awsInstalled: true });
    expect(r.calls).toMatch(/aws secretsmanager get-secret-value .*--region us-east-1 /);
    expect(r.calls).not.toContain('169.254.169.254');
  });

  it('fails phase 1 when the installer cannot be downloaded', () => {
    const r = run({ awsInstalled: false, env: { CURL_FAIL: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('ERROR: Could not download the AWS CLI v2 installer after 3 attempts');
    expect(r.output).toContain('ERROR: Phase 1 failed');
    expect(r.chpasswd).toBe('');
    expect(r.output).not.toContain('REACHED_END_OF_PASSWORD_STEP');
  });

  it('does not run an installer whose signature does not verify', () => {
    const r = run({ awsInstalled: false, env: { GPG_MODE: 'bad' } });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('signature check failed');
    expect(r.calls).not.toMatch(/^install /m);
    expect(r.chpasswd).toBe('');
  });

  it('fails phase 1 instead of skipping the password when the secret cannot be read', () => {
    const r = run({ awsInstalled: true, env: { AWS_FAIL: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('ERROR: Phase 1 failed: could not read the admin password');
    expect(r.output).not.toContain('User password set successfully');
    expect(r.chpasswd).toBe('');
  });

  it('fails phase 1 when the secret is empty', () => {
    const r = run({ awsInstalled: true, env: { SECRET_VALUE: '' } });
    expect(r.status).not.toBe(0);
    expect(r.chpasswd).toBe('');
  });

  it('never prints the password or passes it as a command-line argument', () => {
    for (const r of [run({ awsInstalled: false }), run({ distro: 'rocky', awsInstalled: true })]) {
      expect(r.status).toBe(0);
      expect(r.output).not.toContain(PASSWORD);
      expect(r.calls).not.toContain(PASSWORD);
    }
  });
});

describe('Linux phase 1 document text', () => {
  const script = runCommand.join('\n');

  it('does not trace commands or swallow the password read error', () => {
    expect(script).not.toMatch(/^\s*set -[a-z]*x/m);
    expect(script).not.toMatch(/get-secret-value[^\n]*2>\/dev\/null/);
  });

  it('pins the AWS CLI Team key that the embedded public key block contains', () => {
    expect(AWS_CLI_KEY_FPR).toMatch(/^[0-9A-F]{40}$/);
    const gpg = spawnSync('bash', ['-c', 'command -v gpg'], { encoding: 'utf8' }).stdout.trim();
    if (!gpg) return; // gpg not installed on this machine: the fingerprint check needs it
    const block = script.slice(
      script.indexOf('-----BEGIN PGP PUBLIC KEY BLOCK-----'),
      script.indexOf('-----END PGP PUBLIC KEY BLOCK-----') + '-----END PGP PUBLIC KEY BLOCK-----'.length,
    );
    const shown = spawnSync(gpg, ['--batch', '--with-colons', '--show-keys'], { input: block, encoding: 'utf8' });
    expect(shown.stdout).toContain(`fpr:::::::::${AWS_CLI_KEY_FPR}:`);
  });
});
