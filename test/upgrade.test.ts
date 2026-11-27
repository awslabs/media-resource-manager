// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Runs scripts/upgrade.sh in bash with a stub `aws`, `git` and `sleep` on the
 * PATH, the same way test/delete-stacks.test.ts does. The aws stub answers
 * from files in the stub folder and logs every call; the git stub "clones"
 * the target tag by copying a fixture folder with releases.json and
 * deploy-pipeline.yaml. Covers: the dry run makes no write calls, a refused
 * confirmation, path selection from release metadata (quick, full when a
 * release in between changed the pipeline template or has no metadata), the
 * hubs a fingerprint change makes stale, the AdMode check and clone installs.
 */

const SCRIPT = path.join(__dirname, '..', 'scripts', 'upgrade.sh');

const AWS_STUB = `#!/bin/bash
echo "aws $*" >> "$STUB_DIR/calls.log"
arg_after() { k=$1; shift; while [ $# -gt 0 ]; do if [ "$1" = "$k" ]; then echo "$2"; return; fi; shift; done; }
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012 ;;
  "configure get") echo us-east-1 ;;
  "cloudformation describe-stacks")
    if [ -z "$(arg_after --stack-name "$@")" ]; then cat "$STUB_DIR/pipeline-stacks"
    elif [ -n "$(arg_after --query "$@")" ]; then echo UPDATE_ROLLBACK_COMPLETE
    else cat "$STUB_DIR/stack.json"; fi ;;
  "cloudformation get-template") echo "previous-template" ;;
  "cloudformation validate-template") cat "$STUB_DIR/template-params" ;;
  "cloudformation create-change-set")
    p=$(arg_after --parameters "$@"); cp "\${p#file://}" "$STUB_DIR/change-set-parameters.json"
    echo "arn:aws:cloudformation:us-east-1:123456789012:changeSet/x" ;;
  "cloudformation wait") ;;
  "cloudformation describe-change-set") cat "$STUB_DIR/change-set.json" ;;
  "cloudformation delete-change-set"|"cloudformation execute-change-set") ;;
  "s3 cp") ;;
  "codebuild list-builds-for-project")
    n=$(( $(cat "$STUB_DIR/list-count") + 1 )); echo "$n" > "$STUB_DIR/list-count"
    if [ "$n" -eq 1 ]; then echo build-old; else echo build-new; fi ;;
  "codebuild batch-get-builds")
    case "$(arg_after --query "$@")" in
      *currentPhase*) printf 'SUCCEEDED\\tCOMPLETED\\n' ;;
      *) cat "$STUB_DIR/last-build-status" ;;
    esac ;;
  "codebuild start-build") echo build-started ;;
  "dynamodb scan")
    if [ -f "$STUB_DIR/hubs.json" ]; then cat "$STUB_DIR/hubs.json"
    else echo "An error occurred (ResourceNotFoundException) when calling the Scan operation: Requested resource not found" >&2; exit 254; fi ;;
  "lambda get-function-configuration") cat "$STUB_DIR/deployed-fingerprint" ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`;

const GIT_STUB = `#!/bin/bash
echo "git $*" >> "$STUB_DIR/calls.log"
case "$1" in
  clone) for a in "$@"; do dest=$a; done; mkdir -p "$dest"; cp -R "$STUB_DIR/release/." "$dest/" ;;
  ls-remote) for t in $(cat "$STUB_DIR/tags"); do printf '0000000\\trefs/tags/%s\\n' "$t"; done ;;
  rev-parse)
    case "$2" in
      --is-inside-work-tree) [ -f "$STUB_DIR/is-clone" ] && echo true || exit 128 ;;
      --abbrev-ref) echo HEAD ;;
      *) echo abc1234 ;;
    esac ;;
  describe) cat "$STUB_DIR/clone-tag" ;;
  remote) echo https://github.com/awslabs/media-resource-manager.git ;;
  status) ;;
  fetch|checkout) ;;
  *) echo "unexpected git call: $*" >&2; exit 99 ;;
esac
`;

interface Release {
  version: string;
  pipelineTemplateChanged?: boolean;
  hubUpdate?: boolean;
  hubFingerprint?: string | null;
  sessionsDisconnect?: boolean;
  adminAction?: boolean;
  notes?: string;
}

interface Hub { region: string; status: string; templateVersion?: string }

interface RunOptions {
  args: string[];
  /** Answers to the prompts, one per line. */
  input?: string;
  /** Pipeline stack parameters, added to or replacing DEFAULT_PARAMS. */
  stackParams?: Record<string, string>;
  /** DEFAULT_PARAMS keys the stack doesn't have. */
  dropParams?: string[];
  /** releases.json entries at the target tag; omit for a tag without the file. */
  releases?: Release[];
  tags?: string[];
  hubs?: Hub[];
  deployedFingerprint?: string;
  /** Parameter keys the target template declares (full path). */
  templateParams?: string[];
  /** Change set parameters (default: the stack's, with the overrides applied). */
  changeSetParams?: Record<string, string>;
  lastBuildStatus?: string;
  /** Run as a deploy.sh install: the working folder is a clone at this tag. */
  cloneTag?: string;
}

interface RunResult {
  status: number | null;
  output: string;
  calls: string;
  workFiles: string[];
  changeSetParameters: unknown;
}

const WRITE_CALL = /create-change-set|execute-change-set|delete-change-set|s3 cp|start-build|update-stack|^git (fetch|checkout)|deploy\.sh ran/m;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-upgrade-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const DEFAULT_PARAMS = { GitBranch: 'v1.6.0', RepoUrl: 'https://github.com/awslabs/media-resource-manager.git', ProductName: 'Media Resource Manager', AdMode: 'connector' };

function run(opts: RunOptions): RunResult {
  const stubDir = path.join(root, 'stub');
  const workDir = path.join(root, 'work');
  // A test may run the script more than once; each run starts clean.
  fs.rmSync(stubDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stubDir, 'release', 'scripts'), { recursive: true });
  fs.mkdirSync(workDir);
  const write = (name: string, content: string, mode?: number) => fs.writeFileSync(path.join(stubDir, name), content, { mode });
  write('aws', AWS_STUB, 0o755);
  write('git', GIT_STUB, 0o755);
  write('sleep', '#!/bin/bash\necho "sleep $*" >> "$STUB_DIR/calls.log"\n', 0o755);
  write('calls.log', '');
  write('list-count', '0');
  write('last-build-status', `${opts.lastBuildStatus ?? 'SUCCEEDED'}\n`);
  write('tags', (opts.tags ?? ['v1.5.0', 'v1.6.0', 'v1.6.1']).join('\n'));
  write('deployed-fingerprint', `${opts.deployedFingerprint ?? 'None'}\n`);
  write('release/scripts/deploy-pipeline.yaml', 'Parameters: {}\n');
  if (opts.releases) write('release/releases.json', JSON.stringify({ schemaVersion: 1, releases: opts.releases }));
  if (opts.hubs) {
    write('hubs.json', JSON.stringify({
      Items: opts.hubs.map(h => ({
        region: { S: h.region }, status: { S: h.status }, displayName: { S: `Hub ${h.region}` },
        ...(h.templateVersion ? { templateVersion: { S: h.templateVersion } } : {}),
      })),
    }));
  }
  if (opts.cloneTag !== undefined) {
    write('pipeline-stacks', '\n');
    write('is-clone', '');
    write('clone-tag', `${opts.cloneTag}\n`);
    fs.writeFileSync(path.join(workDir, 'deploy.sh'), '#!/bin/bash\necho "deploy.sh ran $*" >> "$STUB_DIR/calls.log"\n', { mode: 0o755 });
  } else {
    const params: Record<string, string> = { ...DEFAULT_PARAMS, ...opts.stackParams };
    for (const k of opts.dropParams ?? []) delete params[k];
    write('pipeline-stacks', 'MRM-DeployPipeline\n');
    write('stack.json', JSON.stringify({
      Stacks: [{
        StackName: 'MRM-DeployPipeline',
        StackStatus: 'UPDATE_COMPLETE',
        Parameters: Object.entries(params).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
        Outputs: [
          { OutputKey: 'CodeBuildProjectName', OutputValue: 'MRM-DeployPipeline-build' },
          { OutputKey: 'ArtifactBucketName', OutputValue: 'artifact-bucket' },
        ],
      }],
    }));
    write('template-params', `${(opts.templateParams ?? Object.keys(params)).join('\t')}\n`);
    const csParams = opts.changeSetParams ?? { ...params, GitBranch: opts.args[0] };
    write('change-set.json', JSON.stringify({
      Status: 'CREATE_COMPLETE',
      Changes: [
        { ResourceChange: { Action: 'Modify', LogicalResourceId: 'DeployProject', ResourceType: 'AWS::CodeBuild::Project', Replacement: 'False' } },
        { ResourceChange: { Action: 'Modify', LogicalResourceId: 'BuildTrigger', ResourceType: 'AWS::CloudFormation::CustomResource', Replacement: 'False' } },
      ],
      Parameters: Object.entries(csParams).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
    }));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stubDir}:${process.env.PATH}`,
    STUB_DIR: stubDir,
    AWS_DEFAULT_REGION: 'us-east-1',
  };
  delete env.AWS_REGION;
  const result = spawnSync('bash', [SCRIPT, ...opts.args], {
    cwd: workDir, env, input: opts.input ?? '', encoding: 'utf8', timeout: 60000,
  });
  const csFile = path.join(stubDir, 'change-set-parameters.json');
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: fs.readFileSync(path.join(stubDir, 'calls.log'), 'utf8'),
    workFiles: fs.readdirSync(workDir).filter(f => f !== 'deploy.sh'),
    changeSetParameters: fs.existsSync(csFile) ? JSON.parse(fs.readFileSync(csFile, 'utf8')) : undefined,
  };
}

const release = (version: string, extra: Partial<Release> = {}): Release => ({
  version, pipelineTemplateChanged: false, hubUpdate: false, hubFingerprint: 'fp-160',
  sessionsDisconnect: false, adminAction: false, notes: `Notes for ${version}.`, ...extra,
});

const RELEASES_161 = [release('1.6.1'), release('1.6.0', { pipelineTemplateChanged: true, hubUpdate: true }), release('1.5.0')];

describe('upgrade.sh', () => {
  test('--dry-run shows the quick path plan and makes no write calls', () => {
    const r = run({ args: ['v1.6.1', '--dry-run'], releases: RELEASES_161, hubs: [{ region: 'us-west-2', status: 'available', templateVersion: 'fp-160' }] });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/Installed version: v1.6.0/);
    expect(r.output).toMatch(/1 release\(s\): v1.6.1/);
    expect(r.output).toMatch(/v1.6.1: pipeline template changed no, hub update no, DCV sessions disconnect no, admin action no/);
    expect(r.output).toMatch(/Path: quick/);
    expect(r.output).toMatch(/Regional hubs: none will need Update/);
    expect(r.output).toMatch(/DCV sessions: not expected to disconnect/);
    expect(r.output).toMatch(/Dry run: stopped before any change/);
    expect(r.calls).toMatch(/git clone --quiet --depth 1 --branch v1.6.1 https:\/\/github.com\/awslabs\/media-resource-manager.git/);
    expect(r.calls).not.toMatch(WRITE_CALL);
    expect(r.calls).not.toMatch(/get-template/);
    expect(r.workFiles).toEqual([]);
  });

  test('a refused confirmation stops before any change', () => {
    const r = run({ args: ['v1.6.1'], releases: RELEASES_161, input: 'n\n' });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/Start the upgrade\? \(y\/N\)/);
    expect(r.output).toMatch(/Stopped. Nothing was changed./);
    expect(r.calls).not.toMatch(WRITE_CALL);
    expect(r.workFiles).toEqual([]);
  });

  test('no answer (end of input) counts as no', () => {
    const r = run({ args: ['v1.6.1'], releases: RELEASES_161 });
    expect(r.status).toBe(1);
    expect(r.calls).not.toMatch(WRITE_CALL);
  });

  test('a hub fingerprint change lists the hubs that need Update, and the quick path keeps the template', () => {
    const releases = [release('1.6.1', { hubUpdate: true, hubFingerprint: 'fp-161', sessionsDisconnect: true }), ...RELEASES_161.slice(1)];
    const hubs = [
      { region: 'us-west-2', status: 'available', templateVersion: 'fp-160' },
      { region: 'eu-west-1', status: 'available', templateVersion: 'fp-161' },
    ];
    const dry = run({ args: ['v1.6.1', '--dry-run'], releases, hubs });
    expect(dry.status).toBe(0);
    expect(dry.output).toMatch(/Regional hubs that will need Update after the deploy:\n {2}us-west-2 \(Hub us-west-2, available\)\n(?! {2}eu-west-1)/);
    expect(dry.output).toMatch(/DCV sessions: may disconnect/);
    expect(dry.calls).not.toMatch(WRITE_CALL);

    const r = run({ args: ['v1.6.1', '--yes'], releases, hubs, deployedFingerprint: 'fp-161' });
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/create-change-set --stack-name MRM-DeployPipeline --change-set-name mrm-upgrade-v1-6-1-\S+ --change-set-type UPDATE --use-previous-template --capabilities CAPABILITY_NAMED_IAM/);
    expect(r.calls).not.toMatch(/s3 cp/);
    expect(r.changeSetParameters).toEqual([
      { ParameterKey: 'GitBranch', ParameterValue: 'v1.6.1' },
      { ParameterKey: 'RepoUrl', UsePreviousValue: true },
      { ParameterKey: 'ProductName', UsePreviousValue: true },
      { ParameterKey: 'AdMode', UsePreviousValue: true },
    ]);
    expect(r.output).toMatch(/parameter GitBranch: "v1.6.0" -> "v1.6.1"/);
    expect(r.calls).toMatch(/execute-change-set --stack-name MRM-DeployPipeline/);
    // The stack update started build-new, so the script doesn't start another.
    expect(r.calls).not.toMatch(/start-build/);
    expect(r.output).toMatch(/Build: build-new/);
    expect(r.output).toMatch(/Build succeeded/);
    expect(r.output).toMatch(/These regional hubs show Update available:\n {2}us-west-2 \(Hub us-west-2\)\nUpdate them in the MRM console/);
    expect(r.output).toMatch(/On the hub's row, click Update/);
    expect(r.output).not.toMatch(/eu-west-1 \(/);
    expect(r.calls).toMatch(/lambda get-function-configuration --function-name mrm-list-regional-hubs/);
    expect(r.workFiles.sort()).toEqual([
      expect.stringMatching(/^mrm-rollback-MRM-DeployPipeline-\d{8}T\d{6}Z\.json$/),
      expect.stringMatching(/^mrm-rollback-MRM-DeployPipeline-\d{8}T\d{6}Z\.yaml$/),
    ]);
    expect(r.output).toMatch(/To roll back to v1.6.0:\n.*aws s3 cp mrm-rollback-MRM-DeployPipeline-\S+\.yaml/);
    expect(r.output).toMatch(/--parameters file:\/\/mrm-rollback-MRM-DeployPipeline-\S+\.json/);
  });

  test('a pipeline template change in a skipped release takes the full path', () => {
    const releases = [
      release('1.8.0'),
      release('1.7.0', { pipelineTemplateChanged: true, hubUpdate: true, hubFingerprint: 'fp-170' }),
      ...RELEASES_161,
    ];
    const opts = {
      args: ['v1.8.0', '--yes'],
      releases,
      tags: ['v1.6.0', 'v1.6.1', 'v1.7.0', 'v1.8.0'],
      stackParams: { OldParam: 'x' },
      templateParams: ['GitBranch', 'RepoUrl', 'ProductName', 'AdMode', 'NewParam'],
      changeSetParams: { ...DEFAULT_PARAMS, GitBranch: 'v1.8.0', NewParam: '' },
    };
    const dry = run({ ...opts, args: ['v1.8.0', '--dry-run'] });
    expect(dry.status).toBe(0);
    expect(dry.output).toMatch(/3 release\(s\): v1.6.1 v1.7.0 v1.8.0/);
    expect(dry.output).toMatch(/Path: full, because the pipeline template changed in v1.7.0/);
    expect(dry.calls).not.toMatch(WRITE_CALL);

    const r = run(opts);
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/aws s3 cp \S+\/src\/scripts\/deploy-pipeline.yaml s3:\/\/artifact-bucket\/mrm-upgrade\/v1.8.0\/deploy-pipeline.yaml/);
    expect(r.calls).toMatch(/validate-template --template-url https:\/\/artifact-bucket.s3.us-east-1.amazonaws.com\/mrm-upgrade\/v1.8.0\/deploy-pipeline.yaml/);
    expect(r.calls).toMatch(/create-change-set .*--template-url https:\/\/artifact-bucket.s3.us-east-1.amazonaws.com\/mrm-upgrade\/v1.8.0\/deploy-pipeline.yaml/);
    // OldParam isn't in the new template; NewParam takes its default.
    expect(r.changeSetParameters).toEqual([
      { ParameterKey: 'GitBranch', ParameterValue: 'v1.8.0' },
      { ParameterKey: 'RepoUrl', UsePreviousValue: true },
      { ParameterKey: 'ProductName', UsePreviousValue: true },
      { ParameterKey: 'AdMode', UsePreviousValue: true },
    ]);
    expect(r.output).toMatch(/parameter NewParam: \(new\) -> ""/);
    expect(r.calls).toMatch(/execute-change-set/);
  });

  test('a release without metadata in between takes the full path', () => {
    const r = run({ args: ['v1.7.0', '--dry-run'], releases: [release('1.7.0'), ...RELEASES_161.slice(1)], tags: ['v1.6.0', 'v1.6.1', 'v1.7.0'] });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/v1.6.1: no release metadata/);
    expect(r.output).toMatch(/Path: full, because no release metadata for v1.6.1/);
    expect(r.output).toMatch(/DCV sessions: unknown/);
  });

  test('a GitBranch that is not a release tag takes the full path and pins the tag', () => {
    const r = run({ args: ['v1.6.1', '--dry-run'], releases: RELEASES_161, stackParams: { GitBranch: 'main' } });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/GitBranch is 'main', not a release tag/);
    expect(r.output).toMatch(/Path: full, because the installed version is unknown/);
  });

  test('refusing the change set deletes it and executes nothing', () => {
    const r = run({ args: ['v1.6.1'], releases: RELEASES_161, input: 'y\nn\n' });
    expect(r.status).toBe(1);
    expect(r.calls).toMatch(/create-change-set/);
    expect(r.calls).toMatch(/delete-change-set --stack-name MRM-DeployPipeline --change-set-name mrm-upgrade-v1-6-1-/);
    expect(r.calls).not.toMatch(/execute-change-set|start-build/);
    expect(r.output).toMatch(/Deleted the change set. The stack is unchanged./);
  });

  test('stops when the change set would set AdMode on a stack that had none, unless --param sets it', () => {
    const { AdMode: _adMode, ...withoutAdMode } = DEFAULT_PARAMS;
    const opts = {
      releases: [release('1.6.1', { pipelineTemplateChanged: true }), ...RELEASES_161.slice(1)],
      dropParams: ['AdMode'],
      templateParams: [...Object.keys(withoutAdMode), 'AdMode'],
      changeSetParams: { ...withoutAdMode, GitBranch: 'v1.6.1', AdMode: 'managed' },
    };
    const r = run({ ...opts, args: ['v1.6.1', '--yes'] });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/changes AdMode \(\(not set\) -> managed\)/);
    expect(r.output).toMatch(/Pass --param AdMode=<current mode>/);
    expect(r.calls).toMatch(/delete-change-set/);
    expect(r.calls).not.toMatch(/execute-change-set/);

    const set = run({
      ...opts,
      args: ['v1.6.1', '--yes', '--param', 'AdMode=connector'],
      changeSetParams: { ...withoutAdMode, GitBranch: 'v1.6.1', AdMode: 'connector' },
    });
    expect(set.status).toBe(0);
    expect(set.changeSetParameters).toContainEqual({ ParameterKey: 'AdMode', ParameterValue: 'connector' });
    expect(set.calls).toMatch(/execute-change-set/);
  });

  test('stops while a build is running', () => {
    const r = run({ args: ['v1.6.1', '--dry-run'], releases: RELEASES_161, lastBuildStatus: 'IN_PROGRESS' });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/Build build-old is still running/);
  });

  test('stops while a regional hub is updating', () => {
    const r = run({ args: ['v1.6.1', '--dry-run'], releases: RELEASES_161, hubs: [{ region: 'us-west-2', status: 'updating' }] });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/Regional hubs are busy: us-west-2 \(updating\)/);
  });

  test('does nothing when the installation already runs the target', () => {
    const r = run({ args: ['v1.6.0', '--yes'], releases: RELEASES_161 });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/Already at v1.6.0/);
    expect(r.calls).not.toMatch(/git clone/);
  });

  test('refuses a target that is not a release tag, and a downgrade', () => {
    const branch = run({ args: ['main'], releases: RELEASES_161 });
    expect(branch.status).toBe(1);
    expect(branch.output).toMatch(/must be a release tag/);
    expect(branch.calls).toBe('');
    const older = run({ args: ['v1.5.0', '--yes'], releases: RELEASES_161, stackParams: { GitBranch: 'v1.6.0' } });
    expect(older.status).toBe(1);
    expect(older.output).toMatch(/older than the installed v1.6.0/);
  });

  test('a deploy.sh clone: --dry-run plans deploy.sh and changes nothing; the upgrade checks out the tag and deploys', () => {
    const dry = run({ args: ['v1.6.1', '--dry-run'], releases: RELEASES_161, cloneTag: 'v1.6.0' });
    expect(dry.status).toBe(0);
    expect(dry.output).toMatch(/Install: deploy.sh from the clone/);
    expect(dry.output).toMatch(/Path: check out v1.6.1 in this clone and run .\/deploy.sh -y/);
    expect(dry.calls).not.toMatch(WRITE_CALL);

    const r = run({ args: ['v1.6.1', '--yes'], releases: RELEASES_161, cloneTag: 'v1.6.0' });
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/git fetch --quiet https:\/\/github.com\/awslabs\/media-resource-manager.git refs\/tags\/v1.6.1:refs\/tags\/v1.6.1\ngit checkout --quiet v1.6.1\ndeploy.sh ran -y/);
    expect(r.calls).not.toMatch(/cloudformation (create|execute)/);
    expect(r.output).toMatch(/No regional hub needs an update/);
  });
});
