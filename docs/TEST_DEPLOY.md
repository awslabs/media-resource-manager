# Test-Deploy Runbook

How to deploy an arbitrary branch of Media Resource Manager (a feature branch, a fork, a dependabot PR) to a non-prod MRM sandbox for end-to-end verification before merging to `main`.

## When to use this

- A dependency PR changes a **runtime** package (not just a lockfile). Examples: `react-router`, `antd`, `@cloudscape-design/*`, `@aws-sdk/*`, `vite`.
- A frontend or CDK refactor whose blast radius isn't obvious from `tsc` + `jest` alone.
- Any change where "the build passes" isn't strong enough evidence.

For lockfile-only patch bumps on transitive devDeps (e.g. `postcss`, `browserslist`, `brace-expansion`), `npm ci` + `npm run build` + `npm test` are sufficient. Skip this runbook.

## ⚠️ Safety

This runbook deploys code and mutates AWS resources. It is **only** appropriate against a **non-prod** MRM sandbox — an account you own and that no customers or shared users hit.

- Set up a dedicated sandbox account for this. Do not run against any account that hosts customer workloads.
- Before every `codebuild start-build` or `cloudformation update-stack` command, run `aws sts get-caller-identity` and confirm the account ID matches your sandbox.
- Deploys take ~15-20 min per iteration. Budget ~40 min per PR you test (deploy + redeploy `main`).
- The CodeBuild role in `scripts/deploy-pipeline.yaml` uses `AdministratorAccess` by design — the deploy touches ~19 CloudFormation stacks. Treat everything this runbook touches as high-privilege.

## Configuration

The runbook uses environment variables so nothing account-specific ends up in the repo. Set these in your shell (a per-machine `.envrc`, `~/.zshrc`, or a sourced-manually file — do **not** commit them):

```bash
export MRM_TEST_PROFILE="<your-non-prod-aws-cli-profile>"
export MRM_TEST_REGION="us-east-1"
```

The deploy pipeline stack and CodeBuild project names are derived from `context.productName` in your local `cdk.json` — first-letter-of-each-word, uppercased. `"Media Resource Manager"` gives you `MRM-DeployPipeline` and `MRM-DeployPipeline-build`. If your fork uses different names, add the overrides below:

```bash
export MRM_TEST_PIPELINE_STACK="<acronym>-DeployPipeline"    # only if fork renamed it
export MRM_TEST_PIPELINE_PROJECT="<acronym>-DeployPipeline-build"
```

For steps below, replace `MRM-DeployPipeline` and `MRM-DeployPipeline-build` with `$MRM_TEST_PIPELINE_STACK` / `$MRM_TEST_PIPELINE_PROJECT` if you set overrides.

You **don't** need to set `MRM_TEST_FRONTEND_URL` — the Playwright suite in Step 5 auto-discovers the CloudFront URL from the frontend stack's `WebsiteUrl` output using the same `AWS_PROFILE` / `AWS_REGION`. If you want to confirm it manually:

```bash
aws --profile "$MRM_TEST_PROFILE" --region "$MRM_TEST_REGION" \
  cloudformation describe-stacks --stack-name "<Acronym>-Frontend" \
  --query 'Stacks[0].Outputs[?OutputKey==`WebsiteUrl`].OutputValue' \
  --output text
```

## Runbook

### Step 1 — Verify identity and pipeline state

```bash
aws sts get-caller-identity --profile "$MRM_TEST_PROFILE" \
  --query '{Account:Account,Arn:Arn}' --output table

aws --profile "$MRM_TEST_PROFILE" --region "$MRM_TEST_REGION" \
  cloudformation describe-stacks --stack-name "$MRM_TEST_PIPELINE_STACK" \
  --query 'Stacks[0].Parameters[?ParameterKey==`GitBranch` || ParameterKey==`RepoUrl`]' \
  --output table
```

### Step 2 — Kick off a build against the branch under test

Prefer overriding the CodeBuild env vars for a single build over mutating the CloudFormation stack. This keeps the stack pointed at `main` (its steady-state), leaves no cleanup work, and finishes in one command.

```bash
TARGET_BRANCH="<your-branch>"   # e.g. a dependabot branch, a feature branch, or a fork branch

BUILD_ID=$(aws --profile "$MRM_TEST_PROFILE" --region "$MRM_TEST_REGION" \
  codebuild start-build \
  --project-name "$MRM_TEST_PIPELINE_PROJECT" \
  --environment-variables-override "name=GIT_BRANCH,value=$TARGET_BRANCH,type=PLAINTEXT" \
  --query 'build.id' --output text)
echo "Build: $BUILD_ID"
```

The env-var override applies only to this build. The next build (whether manual or from a subsequent stack update) resets to whatever `GitBranch` the CloudFormation stack has.

**When to update the CloudFormation stack instead:** only if you want the sandbox to persistently track a non-`main` branch (a long-running feature branch you'll iterate on). For one-shot PR testing, always use `start-build --environment-variables-override`.

To also change the repo (fork testing), add `name=REPO_URL,value=https://github.com/<owner>/<repo>.git,type=PLAINTEXT` to the override. `REPO_TYPE` (`github`/`codecommit`) is overridable the same way.

### Step 3 — Poll the CodeBuild deploy

```bash
# If you didn't capture $BUILD_ID in Step 2, fetch the latest build:
#   BUILD_ID=$(aws --profile "$MRM_TEST_PROFILE" --region "$MRM_TEST_REGION" \
#     codebuild list-builds-for-project --project-name "$MRM_TEST_PIPELINE_PROJECT" \
#     --query 'ids[0]' --output text)

while :; do
  STATUS=$(aws --profile "$MRM_TEST_PROFILE" --region "$MRM_TEST_REGION" \
    codebuild batch-get-builds --ids "$BUILD_ID" \
    --query 'builds[0].buildStatus' --output text)
  echo "$(date '+%H:%M:%S')  $STATUS"
  case "$STATUS" in
    SUCCEEDED) echo "Deploy complete."; break ;;
    FAILED|FAULT|STOPPED|TIMED_OUT) echo "Deploy failed."; exit 1 ;;
    IN_PROGRESS) sleep 30 ;;
    *) sleep 30 ;;
  esac
done
```

Deep link to the CloudWatch build logs:

```bash
aws --profile "$MRM_TEST_PROFILE" --region "$MRM_TEST_REGION" \
  codebuild batch-get-builds --ids "$BUILD_ID" \
  --query 'builds[0].logs.deepLink' --output text
```

### Step 4 — Verify CloudFront serves the new build

CloudFront may take a minute or two to invalidate. Confirm the new bundle rolled by checking the JS asset hash and `last-modified`:

```bash
FRONTEND_URL=$(aws --profile "$MRM_TEST_PROFILE" --region "$MRM_TEST_REGION" \
  cloudformation describe-stacks --stack-name "<Acronym>-Frontend" \
  --query 'Stacks[0].Outputs[?OutputKey==`WebsiteUrl`].OutputValue' --output text)

curl -s "$FRONTEND_URL/" \
  | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1 \
  | xargs -I {} curl -sI "$FRONTEND_URL/assets/{}" \
  | grep -iE "last-modified|etag"
```

The `last-modified` should reflect the build you just ran.

### Step 5 — Smoke-test

Run the Playwright e2e suite (see [`frontend/tests/e2e/README.md`](../frontend/tests/e2e/README.md)). It auto-discovers the frontend URL from the same profile/region:

```bash
cd frontend
AWS_PROFILE="$MRM_TEST_PROFILE" AWS_REGION="$MRM_TEST_REGION" npm run test:e2e
```

If auth state is stale (specs land on the login page instead of the dashboard), rerun the manual login setup:

```bash
AWS_PROFILE="$MRM_TEST_PROFILE" AWS_REGION="$MRM_TEST_REGION" npm run test:e2e:setup
```

### Step 6 — Redeploy `main` when needed

If you used `start-build --environment-variables-override` in Step 2, there is **no revert needed** — the CloudFormation stack still says `GitBranch=main`, and the next normal deploy will bring `main` back.

To force `main` back onto CloudFront immediately (e.g. after a red test that deployed a broken bundle), start a build with no env override:

```bash
BUILD_ID=$(aws --profile "$MRM_TEST_PROFILE" --region "$MRM_TEST_REGION" \
  codebuild start-build --project-name "$MRM_TEST_PIPELINE_PROJECT" \
  --query 'build.id' --output text)
echo "Redeploying main: $BUILD_ID"
```

Then poll the same way as Step 3.

If you had used the CloudFormation stack update path (only for long-running feature-branch testing), revert with a stack update setting `GitBranch=main` and `UsePreviousValue=true` on every other parameter.

## Decision matrix — merge or reject?

| Smoke test result | Action |
|---|---|
| All specs green, no new console errors | Merge PR, cut a patch release with `scripts/release.sh`, redeploy `main` on the sandbox |
| One or more specs red, failure looks transient (CloudFront invalidation lag, cold start) | Rerun once. Still red → treat as red |
| Specs red on router-related assertions | Close PR with `@dependabot ignore this major version` (for a dependabot PR), or file a fix commit on the PR branch |
| Deploy itself failed in CodeBuild | Read the CodeBuild logs, fix on the PR branch, re-run Step 2. Do not merge without a clean deploy |

## Common failures

**Build fails at `git clone`.**
Cause: branch doesn't exist on the remote yet, or `RepoType` is `github` but the branch is on a fork. Fix: push the branch to the configured remote, or override `REPO_URL` in the CodeBuild env vars.

**Build succeeds but CloudFront still serves the old bundle.**
Cause: CDN cache. Wait 60 s and retry. If it persists past 5 min, force an invalidation:

```bash
FRONTEND_URL=$(aws --profile "$MRM_TEST_PROFILE" --region "$MRM_TEST_REGION" \
  cloudformation describe-stacks --stack-name "<Acronym>-Frontend" \
  --query 'Stacks[0].Outputs[?OutputKey==`WebsiteUrl`].OutputValue' --output text)
DOMAIN="${FRONTEND_URL#https://}"

DIST_ID=$(aws --profile "$MRM_TEST_PROFILE" --region "$MRM_TEST_REGION" \
  cloudfront list-distributions \
  --query "DistributionList.Items[?contains(Aliases.Items || \`[]\`, '$DOMAIN') || DomainName=='$DOMAIN'].Id | [0]" \
  --output text)
aws --profile "$MRM_TEST_PROFILE" --region "$MRM_TEST_REGION" \
  cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*'
```

**Stack update fails with `Stack ROLLBACK_COMPLETE`.**
Something in the deploy CloudFormation stack itself failed, not the CDK app. Read the stack events:

```bash
aws --profile "$MRM_TEST_PROFILE" --region "$MRM_TEST_REGION" \
  cloudformation describe-stack-events --stack-name "$MRM_TEST_PIPELINE_STACK" \
  --query 'StackEvents[?ResourceStatus==`UPDATE_FAILED` || ResourceStatus==`CREATE_FAILED`]' \
  --output table
```

**Cognito login fails after deploy.**
If the deployed branch changed the user pool ID or client ID, the Cognito redirect URLs may be misconfigured. Check the `MRM-Api` stack outputs for the new pool ID and verify the frontend config was rebuilt.

## Related files

- [`scripts/deploy-pipeline.yaml`](../scripts/deploy-pipeline.yaml) — CloudFormation template that defines the pipeline stack, CodeBuild project, and BuildTrigger custom resource.
- [`deploy.sh`](../deploy.sh) / [`deploy.ps1`](../deploy.ps1) — what CodeBuild runs after `git clone`.
- [`frontend/tests/e2e/`](../frontend/tests/e2e/) — the Playwright smoke suite Step 5 invokes.
- [`scripts/release.sh`](../scripts/release.sh) — the release-cutting script used after a successful test.
