// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Runs the macOS Phase 2 (auto-login) SSM document in bash with stub
 * commands on the PATH. Checks that the admin password is read in the
 * Region of the secret's ARN, that a failed read fails the step and keeps
 * the AWS CLI's error, and that the password reaches the kcpassword encoder
 * on stdin, never as a command-line argument or in the output.
 */

const doc = require('../ssm-documents/macos-phase2-auto-login.js');
const runCommand: string[] = doc.mainSteps[0].inputs.runCommand;

// Spaces, '$' and '%' check that the value is passed through unchanged.
const PASSWORD = 'not a real %s pa$$word-123'; // pragma: allowlist secret
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:/MediaResourceManager/Workstation/StandaloneAdminPassword-AbCdEf'; // pragma: allowlist secret
const KCPASSWORD_KEY = [0x7D, 0x89, 0x52, 0x23, 0xD2, 0xBC, 0xDD, 0xEA, 0xA3, 0xB9, 0x1F];

/** Real tools the script uses. Each is wrapped so its arguments are logged. */
const REAL_TOOLS = ['cat', 'cut', 'mktemp', 'mv', 'python3', 'rm', 'tee'];

/**
 * Extra lines for a tool's wrapper, run before the real tool. PYTHON_FAIL
 * makes the encoder fail with no output ("empty") or after part of it
 * ("partial").
 */
const WRAPPER_PRELUDE: Record<string, string> = {
  python3: [
    'if [ "$PYTHON_FAIL" = "empty" ]; then cat > /dev/null; echo "Traceback: encoder failed" >&2; exit 1; fi',
    'if [ "$PYTHON_FAIL" = "partial" ]; then cat > /dev/null; printf "\\x01\\x02\\x03"; echo "Traceback: encoder failed" >&2; exit 1; fi',
  ].join('\n'),
};

const STUBS: Record<string, string> = {
  sudo: 'echo "sudo $*" >> "$STUB_DIR/calls.log"\nexec "$@"',
  dscl: 'echo "dscl $*" >> "$STUB_DIR/calls.log"\n[ -n "$NO_USER" ] && exit 56\nexit 0',
  chmod: 'echo "chmod $*" >> "$STUB_DIR/calls.log"',
  chown: 'echo "chown $*" >> "$STUB_DIR/calls.log"',
  defaults: 'echo "defaults $*" >> "$STUB_DIR/calls.log"\n[ "$1" = "read" ] && echo "ec2-user"\nexit 0',
  // Instance metadata would report the instance's own Region.
  curl: 'echo "curl $*" >> "$STUB_DIR/calls.log"\necho "us-west-2"',
  aws: [
    'echo "aws $*" >> "$STUB_DIR/calls.log"',
    '[ -n "$AWS_FAIL" ] && { echo "An error occurred (AccessDeniedException) when calling the GetSecretValue operation: not authorized" >&2; exit 254; }',
    'printf "%s\\n" "$SECRET_VALUE"',
  ].join('\n'),
};

interface RunResult {
  status: number | null;
  output: string;
  calls: string;
  kcpassword: Buffer | undefined;
  tempFiles: string[];
}

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-macos-phase2-'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function which(tool: string): string {
  return spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
}

function run(env: Record<string, string> = {}): RunResult {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);

  for (const tool of REAL_TOOLS) {
    const real = which(tool);
    fs.writeFileSync(path.join(bin, tool),
      `#!/bin/bash\necho "${tool} $*" >> "$STUB_DIR/calls.log"\n${WRAPPER_PRELUDE[tool] ?? ''}\nexec "${real}" "$@"\n`, { mode: 0o755 });
  }
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }

  const kcpassword = path.join(dir, 'kcpassword');
  const script = runCommand.join('\n')
    .replace('{{Username}}', 'ec2-user')
    .replace('{{AdminPasswordSecretArn}}', SECRET_ARN)
    .split('/usr/local/bin/aws').join(path.join(bin, 'aws'))
    .split('/etc/kcpassword').join(kcpassword);
  const scriptPath = path.join(dir, 'phase2.sh');
  fs.writeFileSync(scriptPath, script);

  const result = spawnSync(which('bash'), [scriptPath], {
    encoding: 'utf8',
    env: { PATH: bin, HOME: dir, STUB_DIR: dir, SECRET_VALUE: PASSWORD, ...env },
  });
  const calls = path.join(dir, 'calls.log');
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
    kcpassword: fs.existsSync(kcpassword) ? fs.readFileSync(kcpassword) : undefined,
    tempFiles: fs.readdirSync(dir).filter(f => f.startsWith('kcpassword.')),
  };
}

/** Decodes a kcpassword file: XOR with the key, then drop the zero padding. */
function decodeKcpassword(encoded: Buffer): string {
  const bytes = Buffer.from(encoded.map((b, i) => b ^ KCPASSWORD_KEY[i % KCPASSWORD_KEY.length]));
  return bytes.toString('utf8').replace(/\0+$/, '');
}

const describeBash = process.platform === 'win32' || !which('python3') ? describe.skip : describe;

describeBash('macOS phase 2: auto-login password', () => {
  it('writes a kcpassword file that decodes to the admin password', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.output).toContain('Phase 2 complete!');
    expect(r.kcpassword).toBeDefined();
    expect(r.kcpassword!.length % 12).toBe(0);
    expect(decodeKcpassword(r.kcpassword!)).toBe(PASSWORD);
  });

  it('reads the secret in the Region of its ARN, not from instance metadata', () => {
    const r = run();
    expect(r.calls).toMatch(/^aws secretsmanager get-secret-value .*--region us-east-1 /m);
    expect(r.calls).not.toContain('169.254.169.254');
  });

  it('never passes the password as a command-line argument or prints it', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain(PASSWORD);
    expect(r.output).not.toContain(PASSWORD);
  });

  it('fails the step and keeps the AWS CLI error when the secret cannot be read', () => {
    const r = run({ AWS_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('AccessDeniedException');
    expect(r.output).toContain('ERROR: Failed to retrieve password from Secrets Manager (Region us-east-1)');
    expect(r.output).not.toContain('Phase 2 complete!');
    expect(r.kcpassword).toBeUndefined();
  });

  it.each(['empty', 'partial'])('fails the step and writes no kcpassword file when the encoder fails (%s output)', mode => {
    const r = run({ PYTHON_FAIL: mode });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('ERROR: Failed to encode the auto-login password');
    expect(r.output).not.toContain('Phase 2 complete!');
    expect(r.kcpassword).toBeUndefined();
    expect(r.tempFiles).toEqual([]);
    expect(r.calls).not.toContain('defaults write');
  });

  it('leaves no temporary file after a successful run', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.tempFiles).toEqual([]);
  });

  it('fails the step when the secret is empty', () => {
    const r = run({ SECRET_VALUE: '' });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('ERROR: Failed to retrieve password from Secrets Manager');
    expect(r.kcpassword).toBeUndefined();
  });
});

describe('macOS phase 2 document text', () => {
  const script = runCommand.join('\n');

  it('does not trace commands or discard the password read error', () => {
    expect(script).not.toMatch(/^\s*set -[a-z]*x/m);
    expect(script).not.toMatch(/get-secret-value[^\n]*2>\/dev\/null/);
  });
});
