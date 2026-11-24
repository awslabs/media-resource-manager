# Upgrading Media Resource Manager

How to upgrade an existing installation that deploys through the CodeBuild
pipeline (`scripts/deploy-pipeline.yaml`) to a new release. The pipeline stack
holds the build project and its build steps. A build then deploys MRM's own
`<ACRONYM>-*` stacks from the Git tag the stack points to.

An upgrade has two parts: update the pipeline stack with the new release's
template and tag, then let the build deploy the release. Regional hubs are
updated separately from the console.

The commands below use these shell variables. Set them first:

```bash
export AWS_REGION=<your-region>   # the Region of the pipeline stack
STACK=MRM-DeployPipeline          # your pipeline stack name
TAG=<tag>                         # the release you're upgrading to, e.g. v1.5.0
PROJECT=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='CodeBuildProjectName'].OutputValue" --output text)
```

## Choose your path

Each release's Upgrade notes say **Pipeline template changed: yes** or
**no**:

- **no**: take the [quick path](#quick-path) below.
- **yes**, or the notes don't say: follow the full path, steps
  [1](#1-before-you-start) to [9](#9-roll-back). For a
  [console-only path](#console-only-path), see the end of this page.

A build deploys the code at `GitBranch` with the CodeBuild project, build
steps and parameters already in the pipeline stack. Changes to the pipeline
template, such as new parameters, changed build steps or IAM changes, arrive
only through a stack update with the new template.

If you skip versions, take the quick path only when every release in between
also says **no**.

**Pin `GitBranch` to a release tag.** A rebuild then deploys the code you
tested, and rolling back is one parameter change. With `GitBranch=main`, each
build deploys whatever is on `main` when the build starts.

### Quick path

1. Do the checks in [Before you start](#1-before-you-start).
2. **If `GitBranch` is pinned to a tag**, set it to the new tag. This is a
   stack update too, but with the current template and only `GitBranch`
   changed. The update starts a build, so don't start another one.

   CLI:
   ```bash
   aws cloudformation update-stack \
     --stack-name "$STACK" \
     --use-previous-template \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameters ParameterKey=GitBranch,ParameterValue="$TAG" \
       $(aws cloudformation describe-stacks --stack-name "$STACK" \
           --query "Stacks[0].Parameters[?ParameterKey!='GitBranch'].ParameterKey" --output text \
         | xargs -n1 printf 'ParameterKey=%s,UsePreviousValue=true\n')
   aws cloudformation wait stack-update-complete --stack-name "$STACK"
   ```
   `update-stack` gives any parameter you don't list its template default,
   so the command lists every other parameter with `UsePreviousValue=true`.
   Don't use `aws cloudformation deploy` here: it needs a template file, and
   the file you have may not match the template the stack runs.

   Console: in the CloudFormation console, select the pipeline stack, choose
   **Update**, then **Use existing template**. Change only **GitBranch**,
   acknowledge that the template creates IAM resources with custom names, and
   choose **Update stack**.

   **If `GitBranch` is `main`**, leave the stack as it is and start a build:
   ```bash
   aws codebuild start-build --project-name "$PROJECT"
   ```
   Or, in the CodeBuild console, open the project and choose **Start build**.
3. [Follow the build](#6-follow-the-build) until it succeeds.
4. [Update regional hubs](#7-update-regional-hubs) and
   [verify](#8-verify).

To roll back, set `GitBranch` to the previous tag the same way. The pipeline
template didn't change between the two releases, so the stack's template
fits both.

## 1. Before you start

1. **Read the release's Upgrade notes.** Each
   [release](https://github.com/awslabs/media-resource-manager/releases) has
   them, and [CHANGELOG.md](../CHANGELOG.md) lists the same steps under
   **Upgrade steps**. If you skip versions, read the notes of every version
   between yours and the new one. They say which parameters to set, whether
   regional hubs need an update, and whether DCV sessions will disconnect.
2. **Check the account and Region:**
   ```bash
   aws sts get-caller-identity
   ```
3. **Note what you run now.** The console sidebar shows the version. Save the
   pipeline stack's current parameters; you need them to roll back:
   ```bash
   aws cloudformation describe-stacks --stack-name "$STACK" \
     --query 'Stacks[0].Parameters' --output table
   ```
   If `GitBranch` is `main`, every build deploys the newest code on `main`.
   Pin it to a release tag with this upgrade.
4. **Plan for DCV sessions.** If the release replaces the DCV Connection
   Gateway, sessions on that gateway disconnect while it is replaced, and users
   reconnect from the console. The Upgrade notes say when this happens. Plan
   such upgrades outside working hours.
5. **List your regional hubs.** Open **Regions** in the console and note each
   hub and its status. Don't create, update or delete a hub while the upgrade
   runs.
6. **Check that no build is running.** Two builds deploying at once fail.
   ```bash
   PROJECT=$(aws cloudformation describe-stacks --stack-name "$STACK" \
     --query "Stacks[0].Outputs[?OutputKey=='CodeBuildProjectName'].OutputValue" --output text)
   aws codebuild batch-get-builds \
     --ids "$(aws codebuild list-builds-for-project --project-name "$PROJECT" --query 'ids[0]' --output text)" \
     --query 'builds[0].buildStatus' --output text
   ```
   Wait if it prints `IN_PROGRESS`.

## 2. Get the pipeline template from the release tag

Download `scripts/deploy-pipeline.yaml` from the release tag, not from `main`.
The template holds the build steps, so it must match the code the build
deploys.

```bash
curl -fsSLo deploy-pipeline.yaml \
  "https://raw.githubusercontent.com/awslabs/media-resource-manager/$TAG/scripts/deploy-pipeline.yaml"
```

Or clone the tag and use `scripts/deploy-pipeline.yaml` from the clone:

```bash
git clone --depth 1 --branch "$TAG" https://github.com/awslabs/media-resource-manager.git
```

If the release page lists a checksum for the template, compare it with
`sha256sum deploy-pipeline.yaml`.

## 3. Create a change set

Create a change set for the pipeline stack without executing it:

```bash
BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue" --output text)

aws cloudformation deploy \
  --template-file deploy-pipeline.yaml \
  --s3-bucket "$BUCKET" \
  --stack-name "$STACK" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-execute-changeset \
  --parameter-overrides GitBranch="$TAG"
```

- The template is larger than the 51,200 bytes CloudFormation accepts inline,
  so `--s3-bucket` is required. The pipeline stack's own artifact bucket
  (output `ArtifactBucketName`) works, as does any bucket you own in the same
  Region.
- Add any parameter the Upgrade notes call out to `--parameter-overrides`, for
  example `GitBranch="$TAG" DcvBrowserPath=direct`.
- Parameters you don't name keep their current values.
- A parameter the release adds takes its default from the template. An empty
  default keeps the value in the stored deployment config
  (`/<PascalCase>/DeploymentConfig/parameters` in SSM, for example
  `/MediaResourceManager/DeploymentConfig/parameters`). A non-empty stack
  parameter that differs from the stored value replaces it on the next build.

The command prints the `describe-change-set` command for the new change set,
with its ARN. Keep the ARN:

```bash
CHANGE_SET=<change-set-arn>
```

## 4. Review the change set

```bash
aws cloudformation describe-change-set --change-set-name "$CHANGE_SET" \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]' \
  --output table
```

- Expected: `Modify` on `DeployProject` (the CodeBuild project: the new tag
  and build steps) and on `BuildTrigger` (the custom resource that starts a
  build). A release that changes them also modifies `BuildTriggerFunction`,
  `BuildTriggerRole` or `CodeBuildRole`.
- Look at the `Replacement` column. If any resource shows `True`, stop and
  check the release notes before you go on.

Check the parameter values the update will use:

```bash
aws cloudformation describe-change-set --change-set-name "$CHANGE_SET" \
  --query 'Parameters' --output table
```

This change set covers the pipeline stack only. The build changes MRM's own
stacks, and the Upgrade notes describe those changes.

**AD Connector installs.** If your installation uses AD Connector (`AdMode` is
`connector` in the stored deployment config), check that the change set's
`AdMode` is `connector`, and pass `AdMode=connector` if it isn't. A pipeline
stack created before v1.1.0 has no `AdMode` parameter, so the update gives it
the template's default. If that default is `managed`, the build switches the
installation to Managed Microsoft AD and replaces the AD Connector.

To change a parameter, run step 3 again with it and review the new change
set. Nothing changes until you execute one, and executing a change set
deletes the stack's other change sets.

## 5. Execute the change set

```bash
aws cloudformation execute-change-set --change-set-name "$CHANGE_SET"
aws cloudformation wait stack-update-complete --stack-name "$STACK"
```

## 6. Follow the build

A change to `GitBranch` starts a build during the stack update. Check that it
started and builds the new tag:

```bash
PROJECT=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='CodeBuildProjectName'].OutputValue" --output text)
BUILD_ID=$(aws codebuild list-builds-for-project --project-name "$PROJECT" --query 'ids[0]' --output text)
aws codebuild batch-get-builds --ids "$BUILD_ID" \
  --query "builds[0].[buildStatus,startTime,environment.environmentVariables[?name=='GIT_BRANCH'].value|[0]]" \
  --output text
```

If no new build started within a few minutes, start one yourself:

```bash
aws codebuild start-build --project-name "$PROJECT"
```

A build usually takes 30 to 45 minutes. Run the `batch-get-builds` command
again until the status is `SUCCEEDED`, or follow the build in the CodeBuild
console under the project's **Build history**.

## 7. Update regional hubs

Deploying MRM updates the primary Region only. After the build succeeds, open
**Regions** in the console. Each hub that runs older regional code shows
**Update available**, and the Upgrade notes say when a release changes hub
code. Click **Update** on each of those hubs, one at a time, and wait for the
status to return to **Available**. See
[Updating Regional Hubs](USER_GUIDE.md#updating-regional-hubs).

## 8. Verify

1. The console sidebar shows the new version. If it still shows the previous
   one, the browser has a cached copy of the console page: hard-refresh it
   (Ctrl+Shift+R, or Cmd+Shift+R on macOS).
2. Sign in.
3. On a running workstation, click **Connect** and open both **Browser** and
   **DCV Client** sessions.
4. Every MRM stack is in a `*_COMPLETE` state, with no `*_FAILED` or
   `*_ROLLBACK_*` states (replace `MRM-` with your stack prefix):
   ```bash
   aws cloudformation describe-stacks \
     --query "Stacks[?starts_with(StackName, 'MRM-')].[StackName,StackStatus]" --output table
   ```
5. Each regional hub shows **Available** on the **Regions** page.

## 9. Roll back

To go back to the previous release, repeat steps 2 to 7 with the previous tag:
download the template from that tag and set `GitBranch=<previous-tag>`. Use
the parameter values you saved in step 1. If you updated regional hubs, they
show **Update available** again after the build; click **Update** to bring
them back to the previous release's code.

MRM upgrades don't replace stateful resources, such as the directory, the
user pool, DynamoDB tables, file systems and workstations, unless the release
notes say so. A rollback deploys the previous code over the same resources.
Read the newer release's Upgrade notes before you roll back, in case they
list a step that has to be undone.

## Console-only path

1. In the CloudFormation console, in the pipeline stack's Region, select the
   pipeline stack.
2. Choose **Update stack** → **Create a change set**.
3. Choose **Replace existing template** → **Upload a template file**, and
   upload the `deploy-pipeline.yaml` you downloaded from the release tag
   (step 2).
4. On the parameters page, set **GitBranch** to the new tag, plus any
   parameter the Upgrade notes name. The other parameters show their current
   values; leave them.
5. Acknowledge that the template creates IAM resources with custom names, and
   create the change set.
6. On the change set's **Changes** tab, review the changes and the
   **Replacement** column as in step 4, then choose **Execute change set**.
7. When the stack is `UPDATE_COMPLETE`, open the CodeBuild project (the
   stack's `BuildConsoleUrl` output) and check that a new build started under
   **Build history**. If none did, choose **Start build**.
8. Continue with steps 7 to 9 above.

## Notes for specific upgrades

### Accounts with VPC Block Public Access

Starting with v1.5.0, browser sessions go through a CloudFront VPC origin by
default (`DcvBrowserPath=cloudfront`), including installations that never set
`DcvBrowserPath`. With
[VPC Block Public Access](../README.md#deploying-in-accounts-with-vpc-block-public-access)
on, create the exclusions for the two `PrivateSubnetIds` subnets before you
upgrade, or set `DcvBrowserPath=direct` to keep the previous browser path.
Without them, the VPC origin can't be created and the
`<ACRONYM>-Dcv-Infrastructure` update fails.

### Existing VPC with subnets set through `MRM_PARAM_OVERRIDES`

If you deployed into an existing VPC with several private subnets per
Availability Zone and passed `PrivateSubnetIds` and `PublicSubnetIds` through
`MRM_PARAM_OVERRIDES`, set the same subnets, in the same order, as the
pipeline stack's `PrivateSubnetIds` and `PublicSubnetIds` parameters. Changing
them replaces the Managed Microsoft AD directory. With the same subnets, the
upgrade replaces one resource: the DynamoDB gateway endpoint in
`<ACRONYM>-Infrastructure`, which is now attached to the private subnets'
route tables. The previous endpoint wasn't attached to any route table, so
DynamoDB access isn't interrupted. Nothing else in the VPC changes: the
directory, interface endpoints, load balancers, subnets and route tables stay
as they are.
