// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * DCV Session Manager install script (user-data/session-manager-install.sh,
 * used by the primary stack and the regional hub template): setup that a
 * restart interrupts runs again on the next boot and finishes, reusing the
 * API client it already registered. A failure stops with an ERROR line.
 *
 * Each test emulates one instance. The first boot runs the user data (the
 * exports plus the script), as cloud-init's scripts_user does once per
 * instance. A restart runs only the scripts in the per-boot folder, as
 * cloud-init's scripts_per_boot does on every boot. A stub (dnf or aws) that
 * is told to "restart" kills the running script and its parents, like a
 * reboot would. Stub commands come first on PATH, so nothing on the host is
 * touched.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.join(__dirname, '../user-data/session-manager-install.sh');

// Same exports as lib/dcv-infrastructure-stack.ts puts above the script.
const USER_DATA_HEADER = `#!/bin/bash
export PRODUCT_NAME="MediaResourceManager"
export ACRONYM="mrm"
export DYNAMODB_TABLE_PREFIX="dcv-session-manager-"

`;

// The lines of the broker's default config that the script edits.
const DEFAULT_CONFIG = `enable-gateway = false
# gateway-to-broker-connector-https-port = 8447
# gateway-to-broker-connector-bind-host = 0.0.0.0
enable-persistence = false
# persistence-db = dynamodb
# dynamodb-region = us-east-1
# dynamodb-table-rcu = 10
# dynamodb-table-wcu = 10
# dynamodb-table-name-prefix = DcvSm-
`;

// Kills the script that called the stub, and its parent shells up to jest.
const RESTART = `restart_now() {
  echo "RESTART" >> "$STUB_LOG"
  pids=""; p=$PPID
  while [ -n "$p" ] && [ "$p" != "$TEST_PID" ] && [ "$p" -gt 1 ]; do
    pids="$pids $p"; p=$(ps -o ppid= -p "$p" | tr -d ' ')
  done
  kill -9 $pids
  exit 137
}
count() { n=$(( $(cat "$STUB_DIR/$1" 2>/dev/null || echo 0) + 1 )); echo $n > "$STUB_DIR/$1"; }`;

const STUBS: Record<string, string> = {
  // IMDS, the broker's local port (BROKER_MODE) and downloads (CURL_MODE).
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
case "$url" in
  *169.254.169.254*/api/token) echo token ;;
  *169.254.169.254*/instance-id) echo ws-test-instance ;;
  *169.254.169.254*/placement/region) echo us-east-1 ;;
  https://localhost:8443/) [ "$BROKER_MODE" = "down" ] && exit 7; exit 0 ;;
  *)
    echo "curl $url" >> "$STUB_LOG"
    case "$CURL_MODE" in
      timeout) echo "curl: (28) Connection timed out after 10001 milliseconds" >&2; exit 28 ;;
      empty) : > "$out" ;;
      *) echo data > "$out" ;;
    esac ;;
esac`,
  dnf: `echo "dnf $*" >> "$STUB_LOG"
[ "$RESTART_AT" = "dnf" ] && restart_now
exit "\${DNF_EXIT:-0}"`,
  systemctl: `echo "systemctl $*" >> "$STUB_LOG"
case "$1" in
  cat) exit "\${UNIT_EXIT:-0}" ;;
  enable) touch "$STUB_DIR/enabled" ;;
esac
exit 0`,
  sudo: '[ "$1" = "-u" ] && shift 2; exec "$@"',
  'dcv-session-manager-broker': `[ "$1" = "register-api-client" ] || exit 0
count registrations
echo "register $3" >> "$STUB_LOG"
[ -n "$REGISTER_EXIT" ] && exit "$REGISTER_EXIT"
echo "client-id: test-client-id-000$n"
echo "client-password: test-client-password-000$n"`,
  // Records SSM writes; PUT_FAIL_AT=N fails the Nth one, RESTART_AT=put
  // restarts at the first one. CloudWatch Logs calls succeed silently.
  aws: `[ "$1 $2" = "ssm put-parameter" ] || exit 0
name=""; value=""
while [ $# -gt 0 ]; do
  case "$1" in --name) name="$2"; shift 2 ;; --value) value="$2"; shift 2 ;; *) shift ;; esac
done
count puts
[ "$RESTART_AT" = "put" ] && restart_now
[ "$PUT_FAIL_AT" = "$n" ] && { echo "put $name FAILED" >> "$STUB_LOG"; exit 255; }
echo "put $name" >> "$STUB_LOG"
echo "$name=$value" >> "$STUB_DIR/params"`,
  hostname: 'echo ws-test',
  flock: 'exit 0',
  rpm: 'exit 0',
  gpg: 'exit 0',
  sleep: 'exit 0',
};

interface Boot { status: number | null; signal: string | null; output: string }

class Instance {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-install-test-'));
  readonly stateDir = path.join(this.dir, 'state');
  readonly perBootDir = path.join(this.dir, 'per-boot');
  readonly perBootCopy = path.join(this.perBootDir, 'mrm-session-manager-setup.sh');
  readonly config = path.join(this.dir, 'broker.properties');
  readonly userData = path.join(this.dir, 'part-001');
  private readonly bin = path.join(this.dir, 'bin');
  private readonly stubDir = path.join(this.dir, 'stub');
  private readonly stubLog = path.join(this.dir, 'calls.log');

  constructor() {
    fs.mkdirSync(this.bin);
    fs.mkdirSync(this.stubDir);
    for (const [name, body] of Object.entries(STUBS)) {
      fs.writeFileSync(path.join(this.bin, name), `#!/bin/bash\n${RESTART}\n${body}\n`, { mode: 0o755 });
    }
    fs.writeFileSync(path.join(this.dir, 'os-release'), 'ID="amzn"\nVERSION_ID="2023"\n');
    fs.writeFileSync(this.config, DEFAULT_CONFIG);
    fs.writeFileSync(this.stubLog, '');
    fs.writeFileSync(this.userData, USER_DATA_HEADER + fs.readFileSync(SCRIPT, 'utf8'), { mode: 0o700 });
  }

  /** First boot: cloud-init runs the user data once. */
  firstBoot(env: Record<string, string> = {}): Boot {
    return this.exec(this.userData, env);
  }

  /** A restart: cloud-init runs the per-boot scripts, not the user data. */
  restart(env: Record<string, string> = {}): Boot[] {
    if (!fs.existsSync(this.perBootDir)) return [];
    return fs.readdirSync(this.perBootDir).sort()
      .map(name => this.exec(path.join(this.perBootDir, name), env));
  }

  calls(): string[] {
    return fs.readFileSync(this.stubLog, 'utf8').split('\n').filter(Boolean);
  }

  params(): Record<string, string> {
    const file = path.join(this.stubDir, 'params');
    if (!fs.existsSync(file)) return {};
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  }

  registrations(): number {
    return this.calls().filter(c => c.startsWith('register ')).length;
  }

  enabled(): boolean { return fs.existsSync(path.join(this.stubDir, 'enabled')); }
  done(): boolean { return fs.existsSync(path.join(this.stateDir, 'session-manager-setup.done')); }
  clientFile(): string { return path.join(this.stateDir, 'sm-client.env'); }

  cleanup(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private exec(file: string, env: Record<string, string>): Boot {
    const result = spawnSync('bash', [file], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        PATH: `${this.bin}:/usr/bin:/bin`,
        TMPDIR: this.dir,
        LOG_PATH: path.join(this.dir, 'install.log'),
        OS_RELEASE_FILE: path.join(this.dir, 'os-release'),
        CONFIG_FILE: this.config,
        MRM_SM_STATE_DIR: this.stateDir,
        MRM_PER_BOOT_DIR: this.perBootDir,
        MRM_SM_LOCK_FILE: path.join(this.dir, 'setup.lock'),
        STUB_LOG: this.stubLog,
        STUB_DIR: this.stubDir,
        TEST_PID: String(process.pid),
        ...env,
      },
    });
    return { status: result.status, signal: result.signal, output: `${result.stdout}${result.stderr}` };
  }
}

const PARAM = '/MediaResourceManager/DCV/SessionManager';
const PUTS = ['ClientName', 'ClientId', 'ClientPassword', 'ClientExitCode'].map(n => `put ${PARAM}/${n}`);

// The script edits its config with GNU sed (as on the instance). BSD sed
// (macOS) reads `sed -i` differently, so skip there.
const describeGnu = spawnSync('sed', ['--version']).status === 0 ? describe : describe.skip;

describeGnu('session manager install script', () => {
  let vm: Instance;
  beforeEach(() => { vm = new Instance(); });
  afterEach(() => vm.cleanup());

  it('registers once, stores the 4 parameters, then enables the broker and marks setup done', () => {
    const boot = vm.firstBoot();
    expect(boot.status).toBe(0);
    expect(boot.output).toContain('SUCCESS: DCV Session Manager installed and configured');
    expect(vm.registrations()).toBe(1);
    const calls = vm.calls();
    expect(calls.filter(c => c.startsWith('put '))).toEqual(PUTS);
    // Started for configuration without being enabled; enabled after the writes.
    expect(calls.indexOf('systemctl start dcv-session-manager-broker'))
      .toBeLessThan(calls.indexOf(PUTS[0]));
    expect(calls.filter(c => c.startsWith('systemctl enable'))).toEqual(['systemctl enable dcv-session-manager-broker']);
    expect(calls.indexOf('systemctl enable dcv-session-manager-broker')).toBeGreaterThan(calls.indexOf(PUTS[3]));
    expect(vm.params()[`${PARAM}/ClientId`]).toBe('test-client-id-0001');
    expect(vm.params()[`${PARAM}/ClientExitCode`]).toBe('0');
    expect(vm.done()).toBe(true);
    expect(fs.existsSync(vm.perBootCopy)).toBe(false);
    expect(fs.existsSync(vm.clientFile())).toBe(false);
    expect(fs.readFileSync(vm.config, 'utf8')).toBe(`enable-gateway = true
gateway-to-broker-connector-https-port = 8447
gateway-to-broker-connector-bind-host = 0.0.0.0
enable-persistence = true
persistence-db = dynamodb
dynamodb-region = us-east-1
dynamodb-table-rcu = 5
dynamodb-table-wcu = 5
dynamodb-table-name-prefix = dcv-session-manager-
`);
  });

  it('does nothing on later boots once setup is done', () => {
    expect(vm.firstBoot().status).toBe(0);
    const before = vm.calls().length;
    expect(vm.restart()).toEqual([]);
    // Even if the user data ran again, it would stop at the marker.
    const again = vm.firstBoot();
    expect(again.status).toBe(0);
    expect(vm.calls()).toHaveLength(before);
    expect(vm.registrations()).toBe(1);
    expect(fs.existsSync(vm.perBootCopy)).toBe(false);
  });

  it('finishes setup on the next boot after a restart during the package install', () => {
    const boot = vm.firstBoot({ RESTART_AT: 'dnf' });
    expect(boot.signal).toBe('SIGKILL');
    expect(vm.calls()).toContain('RESTART');
    expect(vm.done()).toBe(false);
    expect(vm.enabled()).toBe(false);
    // The per-boot copy carries the exports from the user data.
    expect(fs.readFileSync(vm.perBootCopy, 'utf8')).toContain('export PRODUCT_NAME="MediaResourceManager"');

    const [rerun, ...others] = vm.restart();
    expect(others).toEqual([]);
    expect(rerun.status).toBe(0);
    expect(rerun.output).toContain('SUCCESS: DCV Session Manager installed and configured');
    expect(vm.registrations()).toBe(1);
    expect(Object.keys(vm.params()).sort()).toEqual(PUTS.map(p => p.slice(4)).sort());
    expect(vm.enabled()).toBe(true);
    expect(vm.done()).toBe(true);
    expect(fs.existsSync(vm.perBootCopy)).toBe(false);
  });

  it('reuses the registered API client after a restart before its parameters are stored', () => {
    const boot = vm.firstBoot({ RESTART_AT: 'put' });
    expect(boot.signal).toBe('SIGKILL');
    expect(vm.registrations()).toBe(1);
    expect(vm.params()).toEqual({});
    // The client is kept in a root-only file in a root-only folder.
    expect(fs.statSync(vm.stateDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(vm.clientFile()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(vm.clientFile(), 'utf8').split('\n')[1]).toBe('test-client-id-0001');
    const configAfterFirstBoot = fs.readFileSync(vm.config, 'utf8');

    const [rerun] = vm.restart();
    expect(rerun.status).toBe(0);
    expect(rerun.output).toContain('Reusing API client client-ws-test-');
    expect(vm.registrations()).toBe(1);
    expect(vm.params()[`${PARAM}/ClientId`]).toBe('test-client-id-0001');
    expect(vm.params()[`${PARAM}/ClientPassword`]).toBe('test-client-password-0001');
    expect(vm.params()[`${PARAM}/ClientExitCode`]).toBe('0');
    expect(vm.done()).toBe(true);
    expect(fs.existsSync(vm.clientFile())).toBe(false);
    // Running the config edits a second time changes nothing.
    expect(fs.readFileSync(vm.config, 'utf8')).toBe(configAfterFirstBoot);
  });

  it('stops the broker when a parameter write fails, and the next boot finishes with the same client', () => {
    const boot = vm.firstBoot({ PUT_FAIL_AT: '3' });
    expect(boot.status).not.toBe(0);
    expect(boot.output).toContain('ERROR: Failed to store ClientPassword');
    expect(vm.done()).toBe(false);
    expect(vm.enabled()).toBe(false);
    expect(vm.calls().filter(c => c.startsWith('systemctl ')).pop()).toBe('systemctl stop dcv-session-manager-broker');

    const [rerun] = vm.restart();
    expect(rerun.status).toBe(0);
    expect(vm.registrations()).toBe(1);
    expect(Object.keys(vm.params())).toHaveLength(4);
    expect(vm.done()).toBe(true);
  });

  it.each([
    ['a download times out', { CURL_MODE: 'timeout' }, 'ERROR: Download failed: https://d1uj6qtbmh3dt5.cloudfront.net/NICE-GPG-KEY'],
    ['a download is empty', { CURL_MODE: 'empty' }, 'ERROR: Download is missing or empty'],
    ['the package install fails', { DNF_EXIT: '1' }, 'ERROR: Package install failed'],
    ['the package left no systemd unit', { UNIT_EXIT: '1' }, 'ERROR: dcv-session-manager-broker.service is not installed'],
    ['the broker never answers on 8443', { BROKER_MODE: 'down' }, 'ERROR: Broker did not answer on port 8443 within 5 minutes'],
    ['registration fails 3 times', { REGISTER_EXIT: '1' }, 'ERROR: Failed to register API client after 3 attempts'],
  ] as [string, Record<string, string>, string][])('stops with an error when %s, and retries on the next boot', (_name, env, message) => {
    const boot = vm.firstBoot(env);
    expect(boot.status).not.toBe(0);
    expect(boot.output).toContain(message);
    expect(boot.output).not.toContain('SUCCESS');
    expect(vm.done()).toBe(false);
    expect(vm.enabled()).toBe(false);
    expect(vm.calls().filter(c => c.startsWith('systemctl ')).pop()).toBe('systemctl stop dcv-session-manager-broker');
    expect(fs.existsSync(vm.perBootCopy)).toBe(true);
    if (env.REGISTER_EXIT) {
      expect(vm.registrations()).toBe(3);
      expect(vm.params()).toEqual({ [`${PARAM}/ClientExitCode`]: '1' });
    } else {
      expect(vm.registrations()).toBe(0);
    }

    const [rerun] = vm.restart();
    expect(rerun.status).toBe(0);
    expect(vm.done()).toBe(true);
  });
});
