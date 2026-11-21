# Development Guide

This guide is for contributors. It covers how to build and test the project,
how a change moves from a branch to a release, the architecture rules a change
must follow, and how regional hubs pick up code changes. To deploy a branch to
a test account, see the [Test-Deploy Runbook](TEST_DEPLOY.md).

- [Prerequisites](#prerequisites)
- [Build and Test](#build-and-test)
- [Frontend Development](#frontend-development)
- [How a Change Goes](#how-a-change-goes)
- [Versioning and Releases](#versioning-and-releases)
- [Architecture Rules](#architecture-rules)
- [Regional Hubs](#regional-hubs)
- [Deploying a Branch for Testing](#deploying-a-branch-for-testing)

## Prerequisites

- Node.js 20 or later and npm
- The AWS CDK CLI comes from the root `devDependencies`; run it with `npx cdk`
- For synth or deploy: `cdk.json` and `parameters.json` in the repo root. Both
  are gitignored. Start from `cdk.example.json` and `parameters.example.json`.

## Build and Test

Run each block from the repo root. All three parts should pass before you open
a pull request.

### CDK app and Lambda unit tests (Jest)

```bash
npm ci
npm run build    # tsc: writes a .js next to each .ts (lib/, bin/, test/, ...)
npx jest
```

Build **before** running Jest. `tsc` writes a `.js` file next to every `.ts`
file, and Jest resolves `.js` before `.ts`. So `require('../lib/<module>')` in
a test loads the compiled `lib/<module>.js`. If you skip the build, the tests
run against the last compiled code, not your edits, and can pass or fail for
the wrong reason.

Some tests load Lambda handlers directly, and those handlers have their own
`package.json` files that npm does not hoist to the root. Install them once
(and again after their lockfiles change):

```bash
for d in configure-ontap-cifs fsx-nfs-mount-manager jwt-authorizer volume-manager; do
  (cd "lambda/$d" && npm ci)
done
```

`npm test` runs `scripts/install-test-deps.sh` and then Jest. That script runs
`npm install` only in Lambda folders that have no `node_modules` yet, so it
does not pick up lockfile changes, and `npm test` does not build. Prefer the
explicit steps above.

### Frontend

```bash
cd frontend
npm ci
npx tsc --noEmit -p .   # type check
npx vite build          # production build
npx vitest run          # unit tests
```

The frontend has existing type errors. `tsc --noEmit` must not report any
**new** ones: count the errors on `main` and on your branch and compare, for
example with `npx tsc --noEmit -p . | grep -c 'error TS'`.

### Synth

```bash
npx cdk synth --quiet --profile <your-profile> -o <output-dir>
```

For dependency or CDK upgrades, synth before and after the change and diff the
templates, ignoring asset hashes. Any other difference needs an explanation in
the pull request.

## Frontend Development

### Environment Setup

The frontend uses environment variables to configure the API endpoint for development.

1. **Automatic Setup (Recommended)**
   ```bash
   ./deploy.sh  # This automatically creates frontend/.env.local with the correct API URL
   ```

2. **Manual Setup**
   ```bash
   cp frontend/.env.example frontend/.env.local
   # Edit frontend/.env.local and set VITE_API_URL to your API Gateway URL
   ```

### Running Development Server

```bash
cd frontend
npm run dev
```

The development server will:
- Run on `http://localhost:3000`
- Proxy `/api` requests to your deployed API Gateway
- Use the API URL from `VITE_API_URL` environment variable

### Configuration Files

- `vite.config.ts.template` - Template for Vite configuration (commit this)
- `vite.config.ts` - Generated from template (do not commit)
- `.env.local` - Local environment variables (do not commit)
- `.env.example` - Example environment file (commit this)

### Important Notes

- Never commit `frontend/.env.local` or hardcoded API URLs
- The deploy script automatically updates your local environment
- Use `process.env.VITE_API_URL` in vite.config.ts for the proxy target

## How a Change Goes

1. **Branch from `main`.** Name the branch by type and topic, for example
   `fix/<topic>`, `feat/<topic>` or `docs/<topic>`.
2. **Build and test** as in [Build and Test](#build-and-test). Add a test for
   each fix, and confirm the test fails on the old code before you apply the
   fix.
3. **Commit** with [Conventional Commits](https://www.conventionalcommits.org/):
   `<type>(<scope>): <summary>`, lowercase after the scope, for example
   `fix(regions): stop flagging hubs for an update after every deploy`. Use
   `fix` for changes that ship in a patch release. Keep one topic per pull
   request; open a follow-up issue instead of widening a pull request.
4. **Deploy the branch to a test account** and check it live (see
   [Deploying a Branch for Testing](#deploying-a-branch-for-testing)).
5. **Open a pull request** with these sections:
   - **Summary**: what changed and why
   - **Fixes**: the issues it closes
   - **Upgrade notes**: anything an operator must do when upgrading, or "None"
   - **Live test results**: what you deployed and checked, and how
   - **Security review**: semgrep on the changed files, IAM changes, and
     authorization on any new or changed API routes
   - **Follow-ups**: issues filed for work left out
   - **Release plan**: which release ships it, or "No release"
6. **Release** (maintainers). After review and a passing CodeQL check, merge
   the pull request, then run `./scripts/release.sh patch` (or `minor`,
   `major`, or an explicit `X.Y.Z`). The script bumps the version in the root
   and frontend `package.json` files, commits `release: vX.Y.Z` and tags
   `vX.Y.Z`. It does not push. Push `main` and the tag, then create the GitHub
   release from the tag. To choose the bump and write the release notes, see
   [Versioning and Releases](#versioning-and-releases).

Never commit account IDs, credentials, hostnames of real deployments or
customer details, and never force-push or rewrite pushed history.

## Versioning and Releases

Operators deploy and upgrade their own installations, so a version number
tells an operator what an upgrade asks of them. Pick the bump by the most
demanding change in the release:

- **Patch (`1.4.x`)**: bug and security fixes. Upgrading is a normal redeploy,
  with no new settings and no admin action.
- **Minor (`1.x.0`)**: new features; new or changed settings in
  `parameters.json` or `cdk.json`; new stacks; or anything an admin must act
  on after the deploy. A change to the regional hub template is a minor
  release, because admins must update each hub from the **Update** banner on
  the Regions page.
- **Major (`x.0.0`)**: breaking upgrades, such as a removed or renamed
  setting, a manual migration step, possible loss of data or sessions, or
  dropped support for a platform.

**Cadence.** Release once per batch of related work, not after every pull
request. Security fixes are the exception: they ship as a patch release as
soon as they merge. Group changes that each need a regional hub update into
one release, so admins update their hubs once.

**Release notes.** Title the release `vX.Y.Z — <theme>` and use these
sections. Leave out any that would be empty, except **Upgrade notes**, which
every release has:

- **What's new**: one or two sentences on what the release does.
- **Fixes**: each bug or security fix, and what an operator would have seen.
- **New**: each new feature or setting.
- **Upgrade notes**: always say plainly whether an operator needs to do
  anything, even when the answer is "No action needed; redeploy." Call out
  any regional hub update, and list any new or changed setting with its
  default.
- **Follow-ups**: one line of the issue numbers filed for work left out.
- **Full changelog**: the compare link,
  `https://github.com/awslabs/media-resource-manager/compare/vA.B.C...vX.Y.Z`.

## Architecture Rules

- **The API stack is at the CloudFormation resource limit.** The `<ACRONYM>-Api`
  stack is close to CloudFormation's limit of 500 resources per stack, so a
  change that adds API routes fails to deploy until
  [#59](https://github.com/awslabs/media-resource-manager/issues/59) is fixed.
  Check the resource count in the synthesized template before you add routes.
- **Shared Lambda code lives in `lambda/shared/`.** A Lambda that requires a
  shared module (for example `require('../shared/log-redact')`) must be
  defined with `lambdaCodeWithShared('<dir>')` from `lib/lambda-code.ts` in
  place of `code` and `handler`. That packages the Lambda's folder together
  with `shared/`, so each shared module exists once in the repo.
- **Never log raw events, request bodies, tokens or presigned URLs.** This
  includes a custom resource's `ResponseURL`. Log
  `redactForLog(event)` from `lambda/shared/log-redact.js`, which replaces
  sensitive keys, JWTs and URL credentials with `[REDACTED]`.
- **Write and admin API routes call `requireAdmin`.** Each Lambda behind such a
  route checks the caller with `requireAdmin(event)` from its own `authz.js`
  and returns the denial if there is one. The `authz.js` copies are to move to
  `lambda/shared/` in
  [#58](https://github.com/awslabs/media-resource-manager/issues/58); until
  then, a new Lambda copies an existing one.
- **The Log-Retention stack deploys last.** `<ACRONYM>-Log-Retention` sets the
  retention of every Lambda log group, so `bin/media-resource-manager.ts`
  makes it depend on every other stack. The `lambdaLogRetentionDays` context
  value sets the retention (`cdk.example.json` uses 365); `0` turns the stack
  off. A new stack needs no extra wiring: the dependency loop picks it up.
- **cdk-nag does not run in the build yet**
  ([#61](https://github.com/awslabs/media-resource-manager/issues/61)), so do
  not rely on it to catch IAM or encryption mistakes. See
  [CDK_NAG.md](CDK_NAG.md).

## Regional Hubs

A regional hub extends MRM into another AWS Region. It is a CloudFormation
stack named `<ACRONYM>-Regional-Hub-<regioncode>` (for example
`...-Regional-Hub-uswest2`). The stack is not part of the CDK app: the
`lambda/generate-regional-hub-template` Lambda builds its template, and the
hub runs copies of the Lambdas listed in `REGIONAL_HUB_LAMBDAS` in
`lib/regional-hub-version.ts`.

### Deploys don't update hubs

Deploying MRM updates the primary Region only. Existing hubs keep running the
code they were created or last updated with. Each hub record stores a
`templateVersion`, a fingerprint of the hub source code (the template
generator, its SSM documents and user data, and the hub Lambdas). When the
deployed code's fingerprint differs from a hub's, the Regions page shows an
update banner and the sidebar shows a badge. An administrator then clicks
**Update** on that hub in the Regions page, which regenerates the template
and updates the hub's stack.

So any change to a hub Lambda, the template generator or its SSM documents
needs a hub update test: deploy, update a test hub, and check it.

### Preview an update with a change set

Before you click **Update** on a hub that matters, preview the change:

1. Invoke `<acronym>-generate-regional-hub-template` in the primary Region
   with the hub record's fields (`region`, `displayName`, `vpcCidr`,
   `availabilityZones`, subnet masks, `dcvDomainName`, `enableWindows`,
   `enableLinux`, `enableMacOS`) plus `"isUpdate": true`. It uploads a
   template and returns `stackName`, `templateUrl` and `parameters`.
2. In the hub's Region, run `aws cloudformation create-change-set` on that
   stack with the returned template URL and parameters,
   `--capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM`, and
   `--role-arn` set to the `CFN_SERVICE_ROLE_ARN` environment variable of
   `<acronym>-update-regional-hub-cfn`.
3. `aws cloudformation describe-change-set` and check for
   `"Replacement": "True"` on any resource. Replacing IAM roles, instance
   profiles or SSM documents breaks running workstations.
4. Delete the change set.

After an update, check the stack events (no failures, no replacements), the
hub record (status `available` and the new `templateVersion`), and that
existing workstations kept their instance profile.

### Template rules

- **SSM documents use `UpdateMethod: NewVersion`.** It updates a document in
  place. The default, `Replace`, fails on update because each hub document
  has a fixed name.
- **Keep deployed IAM names.** CloudFormation replaces a role or instance
  profile whose name changes. Older hubs use different names, so an update
  keeps the names the deployed stack already has (see
  `lambda/generate-regional-hub-template/deployed-names.js`). Don't rename
  hub IAM resources.
- **The fingerprint excludes `node_modules`.** `FINGERPRINT_EXCLUDE` in
  `lib/regional-hub-version.ts` leaves out installed and generated files,
  because a native dependency build (`ssh2` in `configure-ontap-cifs`) writes
  different files on every build. `package-lock.json` is still included, so a
  dependency update still flags hubs for an update.

## Deploying a Branch for Testing

The [Test-Deploy Runbook](TEST_DEPLOY.md) covers deploying a branch to a
sandbox account through the deploy pipeline, checking that CloudFront serves
the new build, smoke-testing, and redeploying `main` afterwards. Use a
dedicated test account, never a production one.
