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
  "cloudformation delete-stack") rm -f "$STUB_DIR/stacks/$(arg_after --stack-name "$@")" ;;
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
  fs.writeFileSync(path.join(stubDir, 'aws'), AWS_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(stubDir, 'calls.log'), '');
  fs.writeFileSync(path.join(stubDir, 'describe-count'), '0');
  fs.writeFileSync(path.join(stubDir, 'listed'), opts.listed.join('\t'));
  for (const name of opts.live ?? opts.listed) {
    fs.writeFileSync(path.join(stubDir, 'stacks', name), 'CREATE_COMPLETE');
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
    AWS_DEFAULT_REGION: 'us-east-1',
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

  test('rejects an acronym with characters that are not letters or digits', () => {
    const r = run({ args: ['MRM`x'], listed: [] });
    expect(r.status).toBe(1);
    expect(r.calls).not.toMatch(/list-stacks/);
  });
});
