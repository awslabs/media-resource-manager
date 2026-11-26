// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Runs delete-stacks.sh in bash with a stub `aws` on the PATH. The stub keeps
 * one file per live stack, so describe-stacks and delete-stack behave like
 * CloudFormation, and can make every call fail with ExpiredToken after a set
 * number of describe-stacks calls. Covers: the SSM path when an acronym is
 * given, the empty-path guard, and stopping on AWS errors instead of reporting
 * stacks as deleted.
 */

const SCRIPT = path.join(__dirname, '..', 'delete-stacks.sh');

const AWS_STUB = `#!/bin/bash
echo "aws $*" >> "$STUB_DIR/calls.log"
arg_after() { k=$1; shift; while [ $# -gt 0 ]; do if [ "$1" = "$k" ]; then echo "$2"; return; fi; shift; done; }
expired() {
  echo "An error occurred (ExpiredToken) when calling the $1 operation: The security token included in the request is expired" >&2
  exit 254
}
if [ -f "$STUB_DIR/expired" ]; then expired "$1 $2"; fi
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012 ;;
  "cloudformation list-stacks")
    if [ "$(arg_after --output "$@")" = table ]; then echo "(remaining stacks table)"; else cat "$STUB_DIR/listed"; fi ;;
  "cloudformation describe-stacks")
    n=$(( $(cat "$STUB_DIR/describe-count") + 1 )); echo "$n" > "$STUB_DIR/describe-count"
    if [ -f "$STUB_DIR/expire-after" ] && [ "$n" -gt "$(cat "$STUB_DIR/expire-after")" ]; then
      touch "$STUB_DIR/expired"; expired DescribeStacks
    fi
    name=$(arg_after --stack-name "$@")
    if [ -f "$STUB_DIR/stacks/$name" ]; then cat "$STUB_DIR/stacks/$name"
    else echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id $name does not exist" >&2; exit 254; fi ;;
  "cloudformation delete-stack")
    name=$(arg_after --stack-name "$@")
    refused() {
      echo "An error occurred (ValidationError) when calling the DeleteStack operation: Stack [$name] cannot be deleted while TerminationProtection is enabled" >&2
      exit 254
    }
    case "$(cat "$STUB_DIR/delete-mode/$name" 2>/dev/null)" in
      refuse) refused ;;
      ignore) ;;
      ignore-then-refuse)
        if [ -f "$STUB_DIR/delete-mode/$name.called" ]; then refused; fi
        touch "$STUB_DIR/delete-mode/$name.called" ;;
      fail) echo DELETE_FAILED > "$STUB_DIR/stacks/$name" ;;
      *) rm -f "$STUB_DIR/stacks/$name" ;;
    esac ;;
  "cloudformation wait")
    if [ -f "$STUB_DIR/stacks/$(arg_after --stack-name "$@")" ]; then
      echo "Waiter StackDeleteComplete failed: stub" >&2; exit 255
    fi ;;
  "ssm get-parameters-by-path")
    if [ -f "$STUB_DIR/ssm-fail" ]; then expired GetParametersByPath; fi
    if [ -f "$STUB_DIR/ssm-params" ]; then cat "$STUB_DIR/ssm-params"; fi ;;
  "ssm delete-parameter") ;;
  "logs describe-log-groups") ;;
  "dynamodb list-tables") ;;
  "imagebuilder "*)
    if [ "$(arg_after --query "$@")" = nextToken ]; then echo None; fi ;;
  "s3api head-bucket")
    echo "An error occurred (404) when calling the HeadBucket operation: Not Found" >&2; exit 254 ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`;

interface RunOptions {
  args?: string[];
  /** Stacks list-stacks returns. */
  listed: string[];
  /** Stacks that exist (describe-stacks returns their status). */
  live?: string[];
  productName?: string;
  /** Number of describe-stacks calls that succeed before every call returns ExpiredToken. */
  expireAfter?: number;
  /** Fail sts get-caller-identity from the start. */
  expiredAtStart?: boolean;
  ssmParams?: string[];
  ssmFail?: boolean;
  /** Status describe-stacks returns for a live stack (default CREATE_COMPLETE). */
  statusOf?: Record<string, string>;
  /**
   * How delete-stack behaves per stack (default: the stack is deleted).
   * refuse: the call fails. ignore: the call succeeds and nothing changes.
   * ignore-then-refuse: the first call succeeds and changes nothing, later calls fail.
   * fail: the stack goes to DELETE_FAILED.
   */
  deleteMode?: Record<string, 'refuse' | 'ignore' | 'ignore-then-refuse' | 'fail'>;
  /** AWS_DEFAULT_REGION (default us-east-1). Another Region also runs the us-east-1 stack step. */
  region?: string;
}

interface RunResult {
  status: number | null;
  output: string;
  calls: string;
  liveAfter: string[];
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-delete-stacks-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function run(opts: RunOptions): RunResult {
  const stubDir = path.join(root, 'stub');
  const workDir = path.join(root, 'work');
  fs.mkdirSync(path.join(stubDir, 'stacks'), { recursive: true });
  fs.mkdirSync(workDir);
  fs.mkdirSync(path.join(stubDir, 'delete-mode'));
  fs.writeFileSync(path.join(stubDir, 'aws'), AWS_STUB, { mode: 0o755 });
  // The wait loop sleeps 30 s between polls; log instead of sleeping.
  fs.writeFileSync(path.join(stubDir, 'sleep'), '#!/bin/bash\necho "sleep $*" >> "$STUB_DIR/calls.log"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stubDir, 'calls.log'), '');
  fs.writeFileSync(path.join(stubDir, 'describe-count'), '0');
  fs.writeFileSync(path.join(stubDir, 'listed'), opts.listed.join('\t'));
  for (const name of opts.live ?? opts.listed) {
    fs.writeFileSync(path.join(stubDir, 'stacks', name), opts.statusOf?.[name] ?? 'CREATE_COMPLETE');
  }
  for (const [name, mode] of Object.entries(opts.deleteMode ?? {})) {
    fs.writeFileSync(path.join(stubDir, 'delete-mode', name), mode);
  }
  if (opts.expireAfter !== undefined) fs.writeFileSync(path.join(stubDir, 'expire-after'), String(opts.expireAfter));
  if (opts.expiredAtStart) fs.writeFileSync(path.join(stubDir, 'expired'), '');
  if (opts.ssmParams) fs.writeFileSync(path.join(stubDir, 'ssm-params'), opts.ssmParams.join('\t'));
  if (opts.ssmFail) fs.writeFileSync(path.join(stubDir, 'ssm-fail'), '');
  if (opts.productName !== undefined) {
    fs.writeFileSync(path.join(workDir, 'cdk.json'), JSON.stringify({ context: { productName: opts.productName } }));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stubDir}:${process.env.PATH}`,
    STUB_DIR: stubDir,
    AWS_DEFAULT_REGION: opts.region ?? 'us-east-1',
  };
  const result = spawnSync('bash', [SCRIPT, ...(opts.args ?? [])], {
    cwd: workDir, env, input: 'y\nn\n', encoding: 'utf8', timeout: 60000,
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: fs.readFileSync(path.join(stubDir, 'calls.log'), 'utf8'),
    liveAfter: fs.readdirSync(path.join(stubDir, 'stacks')),
  };
}

describe('delete-stacks.sh', () => {
  test('with an acronym argument, deletes the stacks and cleans SSM under the default product path', () => {
    const r = run({ args: ['MRM'], listed: ['MRM-Api', 'MRM-Infrastructure'], ssmParams: ['/MediaResourceManager/a'] });
    expect(r.status).toBe(0);
    expect(r.liveAfter).toEqual([]);
    expect(r.output).toMatch(/Cleanup complete!/);
    expect(r.output).not.toMatch(/Teardown incomplete/);
    expect(r.output).toMatch(/Stack MRM-Api successfully deleted/);
    expect(r.calls).toMatch(/ssm get-parameters-by-path --path \/MediaResourceManager --recursive/);
    expect(r.calls).not.toMatch(/--path \/ /);
    expect(r.calls).toMatch(/ssm delete-parameter --name \/MediaResourceManager\/a/);
  });

  test('with an acronym argument, takes the SSM path from cdk.json productName', () => {
    const r = run({ args: ['MRM'], listed: ['MRM-Api'], productName: 'Studio Tools' });
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/ssm get-parameters-by-path --path \/StudioTools --recursive/);
    expect(r.output).toMatch(/No SSM parameters found/);
  });

  test('refuses the SSM step when the product name gives an empty path', () => {
    const r = run({ args: ['MRM'], listed: ['MRM-Api'], productName: '!!!' });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/Refusing to delete SSM parameters/);
    expect(r.calls).not.toMatch(/ssm get-parameters-by-path/);
  });

  test('treats a stack that does not exist as already deleted', () => {
    const r = run({ args: ['MRM'], listed: ['MRM-Api', 'MRM-Events'], live: ['MRM-Api'] });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/Stack MRM-Events does not exist or already deleted/);
    expect(r.output).toMatch(/Stack MRM-Api successfully deleted/);
  });

  test('stops when credentials expire mid-run instead of reporting live stacks as deleted', () => {
    // MRM-Events: check + status poll (2 calls), then MRM-Api's check fails.
    const r = run({ args: ['MRM'], listed: ['MRM-Events', 'MRM-Api', 'MRM-Infrastructure'], expireAfter: 2 });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/ExpiredToken/);
    expect(r.output).toMatch(/refresh them and rerun/);
    expect(r.output).not.toMatch(/MRM-Api does not exist or already deleted/);
    expect(r.output).not.toMatch(/MRM-Api successfully deleted/);
    expect(r.liveAfter.sort()).toEqual(['MRM-Api', 'MRM-Infrastructure']);
    expect(r.calls).not.toMatch(/ssm /);
    expect(r.output).not.toMatch(/No SSM parameters found/);
  });

  test('stops before discovery when the credentials check fails', () => {
    const r = run({ args: ['MRM'], listed: ['MRM-Api'], expiredAtStart: true });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/AWS credentials check/);
    expect(r.calls).not.toMatch(/list-stacks/);
    expect(r.liveAfter).toEqual(['MRM-Api']);
  });

  test('stops instead of printing "No SSM parameters found" when the SSM list call fails', () => {
    const r = run({ args: ['MRM'], listed: ['MRM-Api'], ssmFail: true });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/Listing SSM parameters under \/MediaResourceManager failed/);
    expect(r.output).not.toMatch(/No SSM parameters found/);
    expect(r.calls).not.toMatch(/logs describe-log-groups/);
  });

  test('without an argument, derives the acronym from cdk.json', () => {
    const r = run({ listed: ['SPT-Api'], productName: 'Studio Production Tools' });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/Generated Acronym: SPT/);
    expect(r.calls).toMatch(/--path \/StudioProductionTools /);
    expect(r.liveAfter).toEqual([]);
  });

  const deleteCalls = (calls: string, name: string) =>
    calls.split('\n').filter((l) => l.startsWith(`aws cloudformation delete-stack --stack-name ${name} `)).length;

  test('gives up on a stack CloudFormation does not start deleting, and names an earlier DELETE_FAILED stack', () => {
    const r = run({
      args: ['MRM'],
      listed: ['MRM-Dcv-Infrastructure', 'MRM-Infrastructure'],
      statusOf: { 'MRM-Infrastructure': 'UPDATE_COMPLETE' },
      deleteMode: { 'MRM-Dcv-Infrastructure': 'fail', 'MRM-Infrastructure': 'ignore' },
    });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/Teardown incomplete. These stacks were not deleted[^\n]*\n {2}- MRM-Dcv-Infrastructure\n {2}- MRM-Infrastructure\n/);
    expect(r.output).not.toMatch(/Cleanup complete!/);
    expect(r.output).toMatch(/Stack MRM-Dcv-Infrastructure deletion failed \(DELETE_FAILED\)/);
    expect(r.output).toMatch(/Stacks later in the order may be blocked by it/);
    expect(r.output).toMatch(/Giving up on MRM-Infrastructure: its status is still UPDATE_COMPLETE after 3 retries of delete-stack/);
    expect(r.output).toMatch(/another stack still imports this stack's exports/);
    expect(r.output).toMatch(/Earlier stacks that ended DELETE_FAILED: MRM-Dcv-Infrastructure/);
    // The first call plus 3 retries, then the script moves on to the cleanup steps.
    expect(deleteCalls(r.calls, 'MRM-Infrastructure')).toBe(4);
    expect(r.liveAfter.sort()).toEqual(['MRM-Dcv-Infrastructure', 'MRM-Infrastructure']);
    expect(r.calls).toMatch(/ssm get-parameters-by-path/);
  });

  test('prints the error and moves on when delete-stack is refused', () => {
    const r = run({ args: ['MRM'], listed: ['MRM-Api', 'MRM-Infrastructure'], deleteMode: { 'MRM-Api': 'refuse' } });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/Teardown incomplete. These stacks were not deleted[^\n]*\n {2}- MRM-Api\nFix the cause/);
    expect(r.output).toMatch(/Failed to initiate deletion of MRM-Api:/);
    expect(r.output).toMatch(/cannot be deleted while TerminationProtection is enabled/);
    expect(r.output).toMatch(/Stack MRM-Infrastructure successfully deleted/);
    expect(deleteCalls(r.calls, 'MRM-Api')).toBe(1);
    expect(r.liveAfter).toEqual(['MRM-Api']);
  });

  test('prints the error of a refused retry and still gives up after 3 retries', () => {
    const r = run({
      args: ['MRM'],
      listed: ['MRM-Infrastructure'],
      statusOf: { 'MRM-Infrastructure': 'UPDATE_COMPLETE' },
      deleteMode: { 'MRM-Infrastructure': 'ignore-then-refuse' },
    });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/Teardown incomplete. These stacks were not deleted[^\n]*\n {2}- MRM-Infrastructure\n/);
    expect(r.output).toMatch(/retrying deletion \(1 of 3\)/);
    expect(r.output).toMatch(/delete-stack for MRM-Infrastructure failed:\n.*TerminationProtection/);
    expect(r.output).toMatch(/Giving up on MRM-Infrastructure/);
    expect(r.output).not.toMatch(/Earlier stacks that ended DELETE_FAILED/);
    expect(deleteCalls(r.calls, 'MRM-Infrastructure')).toBe(4);
  });

  test('lists a us-east-1 stack whose delete was refused in the summary and exits 1', () => {
    // The stub's list-stacks returns the same stacks for every Region.
    const r = run({ args: ['MRM'], region: 'us-west-2', listed: ['MRM-Waf'], deleteMode: { 'MRM-Waf': 'refuse' } });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/Deleting us-east-1 stack: MRM-Waf\n.*Failed to initiate deletion of MRM-Waf:\n.*TerminationProtection/);
    expect(r.calls).not.toMatch(/cloudformation wait/);
    expect(r.output).toMatch(/Teardown incomplete[^\n]*\n {2}- MRM-Waf\n {2}- MRM-Waf \(us-east-1\)\n/);
  });

  test('rejects an acronym with characters that are not letters or digits', () => {
    const r = run({ args: ['MRM`x'], listed: [] });
    expect(r.status).toBe(1);
    expect(r.calls).not.toMatch(/list-stacks/);
  });
});
