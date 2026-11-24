# Changelog

All notable changes to Media Resource Manager are listed here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). See
[Versioning and Releases](docs/DEVELOPMENT.md#versioning-and-releases) for what
makes a patch, minor or major release.

Each version lists changes under **Added**, **Changed**, **Fixed** and
**Security**. **Upgrade steps** lists what administrators must do when they
upgrade to that version; a version without it needs only a redeploy.

## [Unreleased]

### Upgrade steps

- No action needed for the `ResourceAdmin` password fix below. With
  `AdMode=managed`, the first deploy of this version sets the `ResourceAdmin`
  password to the value stored in its Secrets Manager secret. The value does
  not change, so nothing that uses the secret needs updating.
- With AD sign-in (`useCognitoAuth=false`), domain-joined Windows workstations
  mount FSx for Windows storage with the signed-in user's AD identity. Before
  you upgrade, check that the users, or an AD group they belong to, have share
  and NTFS permissions on each FSx for Windows file share. See
  [#130](https://github.com/awslabs/media-resource-manager/issues/130) for
  how to grant them.

### Added

- [Upgrading](docs/UPGRADING.md), a step-by-step guide to upgrading an
  installation to a new release: the pipeline template from the release tag,
  a change set preview, the build, regional hub updates, checks and rollback.
  The README's upgrade notes moved there, and the user guide now says when a
  regional hub **Update** replaces the hub's DCV Connection Gateway.
  ([#126](https://github.com/awslabs/media-resource-manager/pull/126))

### Fixed

- Windows workstation records store the **Join Domain** setting
  (`joinDomain`). The FSx SMB mount manager and the workstation start
  workflow use it to choose integrated authentication and the domain-joined
  start path. For records created by earlier versions, the mount manager
  reads the instance's computer name from SSM and stores the answer;
  otherwise both use the console's Join Domain default for the deployment's
  sign-in mode.
  ([#123](https://github.com/awslabs/media-resource-manager/pull/123))
- With `AdMode=managed`, MRM keeps the `ResourceAdmin` password from
  expiring. AWS Managed Microsoft AD expires passwords after the directory's
  maximum password age (42 days by default), and an expired `ResourceAdmin`
  password stopped FSx for Windows File Server storage creation,
  `ResourceAdmin` sign-in, SMB mounts and DataSync SMB locations. MRM now sets
  the password to its stored value on the first deploy of this version and
  every 30 days after that, through the AWS Directory Service API. A failed
  scheduled reset raises the
  `<Acronym>-ResourceAdmin-Password-Refresh-Failed` CloudWatch alarm, and a
  failed reset during deployment fails the deployment.
  ([#128](https://github.com/awslabs/media-resource-manager/issues/128))
- On standalone Windows workstations, attaching storage a few seconds after
  detaching it mounts the drive. The mount manager waits until the
  workstation's previous SMB mount secret is fully removed before it writes
  the new one, and if it can't write the secret it reports an error instead
  of sending a logon script without credentials. On Windows workstations, a
  mount requested while the previous one is still running now runs after it
  instead of being skipped, so attaching and then detaching quickly ends
  with the drive removed, and a Run Command that can't start the mount
  reports a failure. If storage is attached or detached again while the
  mount manager is still preparing a workstation's script, it starts over
  from the current setting instead of sending the older script. The mount
  log on the workstation (`C:\Windows\Temp\fsx-mount-log.txt`) shows the
  time of each step and how long the credential read took, and says
  "completed with errors" when a mount failed. The logon script reads its
  credentials through the AWS SDK for .NET assemblies already installed with
  AWS Tools for PowerShell, which takes seconds instead of the minutes the
  first load of the full module can take.
  ([#131](https://github.com/awslabs/media-resource-manager/pull/131))

### Removed

- The unused `GET /auth/validate` route and its `validate-jwt` Lambda.
  Protected routes validate tokens with the API's JWT authorizer.
  ([#121](https://github.com/awslabs/media-resource-manager/pull/121))

### Security

- `POST /auth/ldap` validates the sign-in request (a JSON body with a string
  username and password, bounded lengths, and only characters allowed in an
  AD account name) and returns the existing generic 400 otherwise. The API
  stage throttles the route at 10 requests per second with a burst of 20.
  ([#121](https://github.com/awslabs/media-resource-manager/pull/121))

## [1.5.0] - 2026-11-23

Browser sessions open in a viewer page in the MRM console and reach a
token-only DCV Connection Gateway through CloudFront. The native DCV client
gets a TCP option, regional hubs get scoped IAM, and Linux workstation setup
and the deployment pipeline get several fixes. Regional hubs need an update.

### Upgrade steps

- Don't create, update or delete a regional hub while the deploy runs. The
  deploy changes the policies of the hub CloudFormation role, and a hub
  operation in progress at that moment can fail with `AccessDenied`.
- If you deploy through the CodeBuild pipeline, update the pipeline stack
  (for example `MRM-DeployPipeline`) with the new
  `scripts/deploy-pipeline.yaml` first, then start a build yourself with
  `aws codebuild start-build --project-name <project-name>`. A stack update
  may not start a build, and the new build steps run only in a build started
  after the update.
- After the deploy finishes, open **Regions** in the MRM console and click
  **Update** on each regional hub. The banner lists the hubs that need it.
  The hub update brings in the scoped hub IAM roles
  ([#99](https://github.com/awslabs/media-resource-manager/pull/99)), the new
  gateway browser path
  ([#103](https://github.com/awslabs/media-resource-manager/pull/103)) and the
  hub session manager fix
  ([#115](https://github.com/awslabs/media-resource-manager/pull/115)).
- Connection gateways are replaced one at a time: the primary Region's
  gateways during the deploy, and each hub's gateway during its **Update**.
  DCV sessions on a gateway that is being replaced disconnect, and users
  reconnect from the console. Plan the deploy and the hub updates outside
  working hours.
- If your account uses VPC Block Public Access, read
  [Deploying in accounts with VPC Block Public Access](README.md#deploying-in-accounts-with-vpc-block-public-access)
  before you deploy.
- With `DcvBrowserPath=cloudfront` (the default), a new install or a hub
  **Update** takes about 15 minutes longer while the CloudFront distribution
  deploys, and each gateway Region adds an Application Load Balancer (about
  USD 16 per month plus LCUs in us-east-1). Set `DcvBrowserPath=direct` to
  connect browsers to the gateway directly instead.

### Added

- Browser sessions open in a viewer page served by the MRM console:
  **Connect → Browser** opens `/connect/<instanceId>` in a new tab, signed in
  with the console session. The page uses the Amazon DCV Web UI SDK and
  connects with the DCV session token only. `deploy.sh` fetches the pinned
  Amazon DCV Web Client SDK at build time and checks its GPG signature and
  SHA-256; `deploy.ps1` runs the same step through `bash` (Git Bash or WSL).
  ([#104](https://github.com/awslabs/media-resource-manager/pull/104))
- New setting `DcvBrowserPath`: `cloudfront` (default) or `direct`. With
  `cloudfront`, each gateway Region gets a CloudFront distribution with a VPC
  origin and an internal Application Load Balancer in front of the gateway.
  See [Gateway browser path](docs/GATEWAY_BROWSER_PATH.md).
  ([#103](https://github.com/awslabs/media-resource-manager/pull/103))
- New optional setting `DcvHostedZoneId`: a DNS-validated ACM certificate on
  the load balancer, so CloudFront connects to it over HTTPS.
  ([#103](https://github.com/awslabs/media-resource-manager/pull/103))
- New optional settings `DcvAllowedClientCidrs` and `DcvAllowedPrefixListIds`
  limit the gateway's TCP 8443 and UDP 8444 to those sources, in the primary
  Region and in hubs.
  ([#103](https://github.com/awslabs/media-resource-manager/pull/103))
- The pipeline template (`scripts/deploy-pipeline.yaml`) has the parameters
  `DcvBrowserPath`, `DcvHostedZoneId`, `DcvAllowedClientCidrs` and
  `DcvAllowedPrefixListIds`. Empty keeps the stored value.
  ([#111](https://github.com/awslabs/media-resource-manager/pull/111))
- **Settings → Session Management → Native client protocol**: **QUIC (UDP)**,
  the default, or **TCP (WebSocket)** for networks that block UDP.
  ([#104](https://github.com/awslabs/media-resource-manager/pull/104),
  [#47](https://github.com/awslabs/media-resource-manager/issues/47))
- New pipeline parameters `PrivateSubnetIds` and `PublicSubnetIds` (default
  empty) choose the subnets in an imported VPC that has more than one private
  subnet per Availability Zone. The analyzer validates the choice and stops
  the build with a clear message when it's missing or invalid.
  ([#89](https://github.com/awslabs/media-resource-manager/pull/89),
  [#18](https://github.com/awslabs/media-resource-manager/issues/18))

### Changed

- The DCV Connection Gateway accepts DCV session-token connections only and
  serves no web client page. Browser sessions use the console viewer; native
  clients connect as before.
  ([#103](https://github.com/awslabs/media-resource-manager/pull/103))
- The gateway Auto Scaling group has a rolling update policy, so a launch
  template change replaces running gateways one at a time.
  ([#103](https://github.com/awslabs/media-resource-manager/pull/103))
- Gateway and Session Manager security groups: the health check and Session
  Manager ports accept only the VPC's IPv4 CIDR blocks, including secondary
  blocks, and the unused gateway UDP 8443 rule is removed. The primary Region
  keeps the VPC's blocks in a `<ProductName>-VpcCidrs` prefix list.
  ([#103](https://github.com/awslabs/media-resource-manager/pull/103))
- The session API returns `browserGatewayUrl`, the address the browser viewer
  connects to. Hubs created before this release use the gateway's own address
  until their next **Update**.
  ([#104](https://github.com/awslabs/media-resource-manager/pull/104))
- The `<ACRONYM>-Api` stack creates one Lambda invoke permission per function,
  which brings it from 497 to 356 of CloudFormation's 500 resources per stack.
  ([#92](https://github.com/awslabs/media-resource-manager/pull/92),
  [#59](https://github.com/awslabs/media-resource-manager/issues/59))
- Lambdas load `authz.js` from `lambda/shared/` instead of per-Lambda copies.
  ([#93](https://github.com/awslabs/media-resource-manager/pull/93),
  [#58](https://github.com/awslabs/media-resource-manager/issues/58))
- cdk-nag runs only with `-c nag=true` (`npm run nag`), and
  `scripts/generate-nag-report.sh` reads the current CDK CLI output.
  ([#88](https://github.com/awslabs/media-resource-manager/pull/88),
  [#61](https://github.com/awslabs/media-resource-manager/issues/61))
- The frontend dev server binds to `127.0.0.1`.
  ([#104](https://github.com/awslabs/media-resource-manager/pull/104))

### Fixed

- Linux workstations: phase 1 installs AWS CLI v2 when the image has none,
  after checking the installer's PGP signature, and setup fails when the
  default user's password can't be set.
  ([#86](https://github.com/awslabs/media-resource-manager/pull/86),
  [#78](https://github.com/awslabs/media-resource-manager/issues/78))
- Linux workstations show **Ready** only after a DCV console session reaches
  READY, so the first **Connect** finds a working desktop.
  ([#97](https://github.com/awslabs/media-resource-manager/pull/97),
  [#95](https://github.com/awslabs/media-resource-manager/issues/95))
- Ubuntu GPU workstations install `linux-modules-extra` for the running
  kernel, so `nvidia_drm` loads and the desktop starts.
  ([#96](https://github.com/awslabs/media-resource-manager/pull/96),
  [#94](https://github.com/awslabs/media-resource-manager/issues/94))
- Linux workstations without a GPU serve the console session from Xdcv, so
  the session can be resized past 800x600.
  ([#101](https://github.com/awslabs/media-resource-manager/pull/101),
  [#100](https://github.com/awslabs/media-resource-manager/issues/100))
- The README's pipeline deploy commands include `--s3-bucket`, which
  CloudFormation requires for templates over 51,200 bytes.
  ([#91](https://github.com/awslabs/media-resource-manager/pull/91),
  [#90](https://github.com/awslabs/media-resource-manager/issues/90))
- The CodeBuild pipeline keeps the deployment config in SSM: it stores
  `parameters.json` as compact JSON, checks that it fits the 8,192-byte
  parameter limit, and fails the build when saving the config or `cdk.json`
  fails. Values set with `MRM_PARAM_OVERRIDES` or in the SSM parameter are
  kept by later builds. The README says that creating the pipeline stack
  starts the first build.
  ([#111](https://github.com/awslabs/media-resource-manager/pull/111))
- Creating a workstation in a regional hub whose IAM role names have a Region
  suffix works. The instance-create Lambdas can pass the hub workstation
  role in each naming form, only to EC2. Hubs need no update for this fix.
  ([#113](https://github.com/awslabs/media-resource-manager/pull/113))
- In regional hubs, the session manager reads the workstation tables in the
  primary Region. Linux and macOS hub workstations get the right default
  session owner, and assigned users can connect to hub workstations. Needs a
  hub **Update**.
  ([#115](https://github.com/awslabs/media-resource-manager/pull/115))
- `npm run build` compiles the tests again after a `StorageStack` prop was
  removed.
  ([#110](https://github.com/awslabs/media-resource-manager/pull/110))

### Security

- Lambda logs record only method, resource and request ID for API requests.
  The sign-in trigger, the storage CloudFormation worker and the workstation
  list Lambdas log summary fields such as the trigger source, group counts and
  stack name.
  ([#87](https://github.com/awslabs/media-resource-manager/pull/87))
- FSx for Windows self-managed AD credentials are read through CloudFormation
  dynamic references. The template generator handles only the secret's name
  or ARN.
  ([#98](https://github.com/awslabs/media-resource-manager/pull/98))
- The regional hub CloudFormation role uses scoped policies, and every IAM
  role in a hub carries the `<ProductName>-RegionalHub-Boundary` permissions
  boundary. The same hub update includes code-scanning fixes in the hub's
  `configure-ontap-cifs` Lambda.
  ([#99](https://github.com/awslabs/media-resource-manager/pull/99),
  [#62](https://github.com/awslabs/media-resource-manager/issues/62))
- The external developer policy in `scripts/codecommit-repo-setup.yaml`
  applies its protected-branch deny to `main` and to `deploy/*` separately,
  following the AWS CodeCommit branch-protection example. Pushes, merges,
  branch deletes and file writes on those branches are denied; git pushes to
  other branches are allowed.
  ([#112](https://github.com/awslabs/media-resource-manager/pull/112))

## [1.4.4] - 2026-11-22

First-use fixes for admin invites, the first Windows connect, and the DCV
client prompt.

### Added

- When **Connect via client** doesn't open the Amazon DCV client, the console
  shows a dialog with a download link, **Try again**, and **Connect in
  browser** when browser sessions are on.
  ([#80](https://github.com/awslabs/media-resource-manager/pull/80),
  [#69](https://github.com/awslabs/media-resource-manager/issues/69))
- The deploy warns when `AdminEmails` is empty, and the Frontend stack has an
  `AdminOnboardingCommands` output with the commands to add the first admin.
  ([#83](https://github.com/awslabs/media-resource-manager/pull/83),
  [#20](https://github.com/awslabs/media-resource-manager/issues/20))

### Changed

- Windows workstations can take a minute or two longer to reach **Ready**,
  while the console session starts.
- The upgrade attaches the user pool's Lambda triggers again if a manual
  `aws cognito-idp update-user-pool` call removed them.

### Fixed

- Admin invite emails link to the web console, or to your custom frontend URL.
  Admin accounts are created after the frontend URL is known.
  ([#83](https://github.com/awslabs/media-resource-manager/pull/83),
  [#8](https://github.com/awslabs/media-resource-manager/issues/8))
- The first **Connect** to a new Windows workstation in the primary Region
  works: creation waits for a ready DCV console session after the post-setup
  reboot.
  ([#81](https://github.com/awslabs/media-resource-manager/pull/81),
  [#6](https://github.com/awslabs/media-resource-manager/issues/6))

## [1.4.3] - 2026-11-22

### Added

- `docs/DEVELOPMENT.md`: a contributor guide for building, testing, the
  architecture rules and regional hubs
  ([#71](https://github.com/awslabs/media-resource-manager/pull/71)), and the
  versioning and release policy
  ([#76](https://github.com/awslabs/media-resource-manager/pull/76)).
- `docs/FSXN_IMPLEMENTATION_GUIDE.md` names the ONTAP credentials secret and
  its keys. ([#79](https://github.com/awslabs/media-resource-manager/pull/79))

### Changed

- Scanner configurations are trimmed to current entries, and
  `docs/SECURITY_SCANNING.md` documents the suppressions.
  ([#74](https://github.com/awslabs/media-resource-manager/pull/74))

### Fixed

- The regional hub fingerprint test is stable when two files share a cached
  timestamp. ([#72](https://github.com/awslabs/media-resource-manager/pull/72))

### Security

- Each new FSx for NetApp ONTAP file system's storage stack generates its admin
  secret with Secrets Manager, and CloudFormation passes it to FSx through a
  dynamic reference. The `OntapAdminCredentials` secret keeps the same four
  keys. Existing file systems keep their credentials.
  ([#77](https://github.com/awslabs/media-resource-manager/pull/77))
- ONTAP passwords come from a cryptographically secure random source.
  ([#73](https://github.com/awslabs/media-resource-manager/pull/73))

## [1.4.2] - 2026-11-21

### Upgrade steps

- Click **Update** on each regional hub once more. The way hub versions are
  calculated changed, so each hub shows as needing an update one last time.

### Changed

- The CDK upgrade changes the deployed templates: Step Functions state machine
  roles trust Step Functions only for state machines in the same account and
  Region, Network Load Balancer listeners in `<ACRONYM>-Dcv-Infrastructure`
  get the stack's tags, and CDK's frontend deployment handler runs on arm64.
  ([#68](https://github.com/awslabs/media-resource-manager/pull/68))

### Fixed

- Regional hubs show as needing an update only when their code changes. The
  hub version covers source files and lockfiles only.
  ([#68](https://github.com/awslabs/media-resource-manager/pull/68))

### Security

- Dependency updates: `aws-cdk-lib` 2.278 and the `aws-cdk` CLI 2.1149
  (`brace-expansion`, `minimatch`), `@aws-sdk/xml-builder` 3.972.43
  (`fast-xml-parser`), and `vitest` 5.1.1 (`@vitest/mocker`).
  ([#68](https://github.com/awslabs/media-resource-manager/pull/68))

## [1.4.1] - 2026-11-21

### Upgrade steps

- Click **Update** on each regional hub the banner lists. Running workstations
  aren't affected. The update adds a launch template version with the current
  Amazon Linux 2023 AMI for the Session Manager and Connection Gateway,
  without replacing their running instances.
- 365-day log retention deletes events older than 365 days from Lambda log
  groups that had no retention. To use another period, set
  `lambdaLogRetentionDays` in `cdk.json` or `LambdaLogRetentionDays` in
  `parameters.json` (`0` turns it off). In the CodeBuild pipeline, start a
  build with `MRM_PARAM_OVERRIDES` set to `{"LambdaLogRetentionDays":"90"}`,
  with the value written as a string.

### Added

- Each regional hub records which code it runs. The Regions page has an
  **Update** button for each hub, and admins see a banner and a badge while a
  hub needs an update.
- New stack `<ACRONYM>-Log-Retention`, deployed last; `delete-stacks.sh`
  removes it.

### Changed

- IAM: the Log-Retention function can list Lambda functions and their tags,
  create log groups and set log retention. The regional hub list and get
  functions can read hub stack status, and the template generator can read
  hub stack templates.

### Fixed

- Regional hub updates change SSM documents in place and keep the hub's IAM
  role and instance profile names, so the update completes.
- A hub whose update has finished shows **Available**, or **Update failed**
  with the error.

### Security

- Lambda logs replace Cognito tokens, DCV connection tokens and other
  credentials with `[REDACTED]`, and the DCV session manager logs field names
  only. Step Functions task tokens and CloudFormation custom resource response
  URLs are left out of logs.
  ([#63](https://github.com/awslabs/media-resource-manager/pull/63))
- MRM Lambda log groups without a retention period, including those in
  regional hubs, get 365-day retention.
  ([#63](https://github.com/awslabs/media-resource-manager/pull/63))

## [1.4.0] - 2026-11-08

### Upgrade steps

- Check the Software Library. Installers uploaded more than 30 days before the
  upgrade may be gone; entries marked **Installer missing** need **Edit →
  Replace installer** before their pipelines can build.

### Added

- **Change base image** in Edit pipeline, for the pipeline's platform.
- **Replace installer** in Edit Software. A file with the same name replaces
  the installer in place; a different name creates a new component version.
- An **Installer missing** warning in the Software Library, and the failure
  reason of a failed pipeline in a tooltip.
- Base image descriptions give each OS's security support end date.
- Installers over 5 GB are rejected when the file is chosen.

### Changed

- Pipelines on a built-in base image (Windows Server, Ubuntu, Rocky Linux)
  build on the latest AWS AMI for that OS, starting with their next edit or
  build. Custom and golden-image bases stay pinned.
- The check for raw Amazon macOS AMIs as a pipeline base matches by owner
  alias.
- Installer file names with `/`, `\`, quotes, backticks, `$` or control
  characters are rejected, and Create pipeline accepts only a built-in base
  image ID or an AMI ID.
- IAM: the software-library Lambda gets `s3:ListBucket` on the uploads bucket.

### Fixed

- Image pipeline names with characters such as `/` work and are shown as
  entered ([#48](https://github.com/awslabs/media-resource-manager/issues/48)).
- Editing and building a pipeline keep working after AWS retires its original
  base AMI, and a deleted custom AMI shows a message to choose a new base
  ([#49](https://github.com/awslabs/media-resource-manager/issues/49)).
- **Images → Create Workstation** selects the image you clicked
  ([#53](https://github.com/awslabs/media-resource-manager/issues/53)).
- The uploads bucket keeps Software Library installers
  ([#54](https://github.com/awslabs/media-resource-manager/issues/54)).

Earlier releases are listed on the
[GitHub releases page](https://github.com/awslabs/media-resource-manager/releases).

[Unreleased]: https://github.com/awslabs/media-resource-manager/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/awslabs/media-resource-manager/compare/v1.4.4...v1.5.0
[1.4.4]: https://github.com/awslabs/media-resource-manager/compare/v1.4.3...v1.4.4
[1.4.3]: https://github.com/awslabs/media-resource-manager/compare/v1.4.2...v1.4.3
[1.4.2]: https://github.com/awslabs/media-resource-manager/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/awslabs/media-resource-manager/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/awslabs/media-resource-manager/compare/v1.3.4...v1.4.0
