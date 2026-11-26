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

- Optional, for installations that ran v1.4.3 or earlier: the log group
  `/aws/lambda/<acronym>-create-admin-groups` in the primary Region may still
  hold admin email addresses from earlier deploys. You can delete it or set a
  short retention on it. See
  [Installations that ran v1.4.3 or earlier](docs/UPGRADING.md#installations-that-ran-v143-or-earlier-old-adminsetup-log-group).
  ([#148](https://github.com/awslabs/media-resource-manager/pull/148),
  [#82](https://github.com/awslabs/media-resource-manager/issues/82))

### Fixed

- Deleting a regional hub is refused while workstations remain in its
  Region. The API returns 409 with the count, for example "Terminate the 2
  workstations in us-west-2 before deleting its regional hub.", and lists
  the workstations by hostname and instance ID (up to 20, then "and N
  more"). The hub stays as it is, and no workstation is deleted. Records of
  terminated workstations and failed creates don't count. The delete dialog
  on **Regions** shows each Region's workstation count, lists the
  workstations after a refused delete, and says to snapshot or copy any data
  you need from them, then terminate them before deleting the hub. Before,
  the delete started, and the hub stack's VPC, subnets and security group
  couldn't be removed while those workstations still used them.
  ([#147](https://github.com/awslabs/media-resource-manager/pull/147),
  [#145](https://github.com/awslabs/media-resource-manager/issues/145))
- A workstation launch that fails for lack of capacity doesn't use up a
  hostname number. Windows and Linux creates keep the number they reserved
  when they retry in the next subnet, and give it back to the counter when
  the last subnet fails or the launch fails with another error. macOS
  creates try every subnet with one number and give it back when no
  instance launches. A number goes back only while it's still the newest
  one; if another workstation has taken a later number in the meantime, the
  number stays unused. Before, each failed attempt used up a number, so
  hostnames skipped numbers.
  ([#5](https://github.com/awslabs/media-resource-manager/issues/5))
- Deleting a storage resource whose record has no MRM storage stack works.
  When `cloudFormationStackName` is empty or doesn't start with
  `<Acronym>-Storage-` (for example `N/A` on a record for a file system MRM
  didn't create), MRM removes the record and the DataSync tasks and
  locations it created for that storage, and leaves the file system as it
  is. **Storage** says that only the MRM record was removed. Before, the
  delete returned HTTP 500 and the record stayed. MRM now checks a storage
  stack before it removes the DataSync tasks and locations, so a delete that
  fails or is refused leaves them in place. **Storage** shows the error when
  a delete fails.
  ([#149](https://github.com/awslabs/media-resource-manager/pull/149),
  [#143](https://github.com/awslabs/media-resource-manager/issues/143))
- Deleting FSx for Windows File Server storage or an FSx for ONTAP volume
  that MRM created, from **Storage**, says that a final backup will be kept
  until it's deleted. The delete dialog mentions it, and after the delete the
  API response and the
  **Storage** page give the file system or volume ID, its Region and the
  commands to find and delete the backup. See
  [Deleting Storage](docs/USER_GUIDE.md#deleting-storage).
  ([#152](https://github.com/awslabs/media-resource-manager/pull/152),
  [#118](https://github.com/awslabs/media-resource-manager/issues/118))
- On Windows, `scripts/analyze-vpc.ps1` checks `PrivateSubnetIds`,
  `PublicSubnetIds` and `AvailabilityZones` when `PrivateSubnetIds` is set in
  `parameters.json`, and keeps them, as `scripts/analyze-vpc.sh` does: each
  subnet must be in the VPC, one per AZ, in the order of `AvailabilityZones`.
  It stops without changing `parameters.json` when the subnets differ from
  the ones the install is deployed on, or are in a different order, since
  that would replace the Managed AD directory.
  ([#150](https://github.com/awslabs/media-resource-manager/pull/150),
  [#144](https://github.com/awslabs/media-resource-manager/issues/144))
- The existing-VPC analyzer (`scripts/analyze-vpc.sh` and
  `scripts/analyze-vpc.ps1`) counts a subnet whose default route goes to an
  internet gateway as public, even when it doesn't assign public IPs, so it
  isn't offered or picked as a private subnet.
  ([#117](https://github.com/awslabs/media-resource-manager/pull/117))
- With Cognito sign-in, the console keeps an active user signed in past the
  1-hour ID token lifetime. It keeps the Cognito refresh token in the tab's
  `sessionStorage`, next to the ID token, and gets a new ID token 5 minutes
  before the current one expires, when a page loads with an expired one, and
  when the API answers 401. Calls made during a refresh wait for it and are
  sent with the new token. When Cognito refuses the refresh token (expired
  or revoked), the console clears the session and shows the sign-in page.
  **Sign out** clears all three values and revokes the refresh token. A new
  tab or window still needs its own sign-in. The refresh time comes from the
  token's lifetime, counted from when the tab received it (5 minutes before
  the end, or halfway for tokens that last 10 minutes or less), so a computer
  clock that is wrong doesn't change it, and at most one background refresh
  starts per minute. AD sessions use the same timing.
  ([#85](https://github.com/awslabs/media-resource-manager/issues/85))
- With AD sign-in (`useCognitoAuth=false`), the console renews the 1-hour
  session token through the new `POST /auth/ldap/refresh` route, about 5
  minutes before it expires, for up to 12 hours after sign-in. The route is
  behind the API's JWT authorizer. The `ldap-auth` Lambda verifies the
  current token again (only the `HS256` header MRM issues, the signature and
  the expiry), reads the user's AD record with the AD service account, and
  refuses a deleted, disabled or expired account. The new token carries the
  admin status from the user's current AD groups. The 12-hour cap is counted
  from a new `auth_time` claim set at sign-in; it is fixed, not a setting.
  Tokens issued before this version have no `auth_time` and can't be
  renewed, so those sessions end at their 1-hour expiry, as before. No
  password or other secret is stored in the browser. The JWT authorizer now
  accepts only that same `HS256` header for AD tokens, and neither Lambda
  logs sign-in names.
  ([#85](https://github.com/awslabs/media-resource-manager/issues/85))

### Security

- The AD sign-in Lambda (`ldap-auth`) logs sign-in requests, LDAP binds and
  user record updates without the sign-in name.
  ([#146](https://github.com/awslabs/media-resource-manager/pull/146))

## [1.6.0] - 2026-11-25

Fixes for SMB storage on Windows workstations, the `ResourceAdmin` password
with AWS Managed Microsoft AD, the DCV Connection Gateway install, console
sessions and **Connect** in regional hubs, the existing-VPC analyzer and the
stack cleanup scripts. The pipeline template changed. This release updates
regional hubs and replaces the DCV Connection Gateways in the primary Region
and in each hub, so DCV sessions disconnect once and users reconnect from the
console. Plan the upgrade outside working hours.

### Upgrade steps

- The pipeline template changed: the `AdMode` parameter defaults to empty
  ([#125](https://github.com/awslabs/media-resource-manager/pull/125)).
  Update the pipeline stack with `scripts/deploy-pipeline.yaml` from the
  release tag before you start the build. Follow the full path in
  [Upgrading](docs/UPGRADING.md), not the quick path.
- After the deploy finishes, open **Regions** in the MRM console and click
  **Update** on each regional hub. The hub update brings in the Windows
  auto-login change
  ([#119](https://github.com/awslabs/media-resource-manager/pull/119)),
  the hub console session check and **Connect** retry
  ([#120](https://github.com/awslabs/media-resource-manager/pull/120))
  and the gateway install checks
  ([#136](https://github.com/awslabs/media-resource-manager/pull/136)).
  It replaces the hub's DCV Connection Gateway, which disconnects DCV
  sessions on that gateway.
- The deploy replaces the primary Region's DCV Connection Gateways one at a
  time (the gateway install change in
  [#136](https://github.com/awslabs/media-resource-manager/pull/136)). DCV
  sessions on a gateway that is being replaced disconnect, and users
  reconnect from the console. Plan the deploy and the hub updates outside
  working hours.
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
- With an existing VPC, check before you upgrade that each subnet in
  `PrivateSubnetIds` has a `0.0.0.0/0` route to a NAT gateway, NAT instance,
  transit gateway, firewall endpoint or Cloud WAN core network (see the VPC
  analyzer fix below,
  [#135](https://github.com/awslabs/media-resource-manager/pull/135)). An
  install whose subnets are already saved in `PrivateSubnetIds` and
  `PrivateRouteTableIds` gets a warning in the build log for a subnet without
  that route, and the upgrade continues. The check stops the deployment when
  the analyzer picks or validates the subnets: on a first deploy, when
  `PrivateSubnetIds` changes, and on every deploy of an install that has no
  `PrivateRouteTableIds` saved (its private subnets use the VPC main route
  table) or no `PrivateSubnetIds` and one private subnet per AZ. Add the
  missing route to fix either case; changing `PrivateSubnetIds` on a
  deployed install replaces the Managed AD directory.

### Added

- [Upgrading](docs/UPGRADING.md), a step-by-step guide to upgrading an
  installation to a new release: the pipeline template from the release tag,
  a change set preview, the build, regional hub updates, checks and rollback.
  The README's upgrade notes moved there, and the user guide now says when a
  regional hub **Update** replaces the hub's DCV Connection Gateway.
  ([#126](https://github.com/awslabs/media-resource-manager/pull/126))

### Changed

- `scripts/create-multipart-upload.py` takes the target bucket, object key
  and file size as required arguments, and the part size as an option
  (default 500 MB):
  `python3 scripts/create-multipart-upload.py <bucket> <key> <file_size_bytes> [--part-size MB]`.
  ([#134](https://github.com/awslabs/media-resource-manager/pull/134))

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
  ([#129](https://github.com/awslabs/media-resource-manager/pull/129),
  [#128](https://github.com/awslabs/media-resource-manager/issues/128))
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
  credentials with a signed Secrets Manager request using the workstation's
  instance role, which takes under a second instead of the minute or more it
  took to load AWS Tools for PowerShell, and runs at normal priority. The
  workstation needs a route to Secrets Manager in its own Region (a NAT
  gateway or a Secrets Manager interface endpoint with private DNS), as the
  existing credential reads do.
  ([#131](https://github.com/awslabs/media-resource-manager/pull/131))
- The web console loads the new release on the next page load after an
  upgrade, without a hard refresh. `index.html` and `config.json` are served
  with `Cache-Control: no-cache`, and the hashed bundles under `assets/` with
  a one-year immutable `Cache-Control`.
  ([#124](https://github.com/awslabs/media-resource-manager/pull/124))
- `delete-stacks.sh` with an acronym argument (`./delete-stacks.sh MRM`)
  cleans up only the product's own SSM parameters. It takes the product name
  from `cdk.json`, or the default name, whether or not you pass an acronym,
  and refuses the SSM step if the parameter path would be `/`. Before, passing
  an acronym left the product name empty, and the SSM step listed and deleted
  every parameter in the Region.
  ([#133](https://github.com/awslabs/media-resource-manager/pull/133))
- `delete-stacks.sh` stops on AWS CLI errors. It checks your credentials
  before it starts, counts a stack as deleted only when CloudFormation says
  it does not exist, and stops with the error when a list call in the cleanup
  steps fails. Before, an error such as expired credentials made it report
  live stacks as already deleted and the cleanup steps as finding nothing. If
  your credentials expire during a run, refresh them and run the script again.
  ([#133](https://github.com/awslabs/media-resource-manager/pull/133))
- A DCV Connection Gateway that can't download or install its package is
  replaced instead of staying in service. The install script stops with an
  `ERROR` line in `/var/log/dcv-connection-gateway-install.log` when a
  download fails, times out or is empty, when the package install fails, or
  when the `dcv-connection-gateway` service isn't installed. Downloads retry
  and time out instead of hanging. The gateway Auto Scaling groups in the
  primary Region and in regional hubs use ELB health checks with a
  15-minute grace period, so a gateway that fails its load balancer health
  checks is replaced. A gateway that can never install (for example, with no
  outbound internet access) is replaced again after each grace period until
  the cause is fixed. The script no longer downloads the unused DCV server
  bundle, and the unused `scripts/connection-gwy-user-data.sh` is removed.
  Regional hubs get the change when you **Update** them, which replaces the
  hub's gateway.
  ([#136](https://github.com/awslabs/media-resource-manager/pull/136))
- Deleting the DCV infrastructure stack succeeds when a workstation record
  points to an instance that is already terminated or no longer exists. The
  stack's cleanup step terminates only the workstation instances that still
  exist and aren't already shutting down or terminated, and counts the rest
  as cleaned up. Other EC2 errors, such as a denied request, still fail the
  delete. Before, EC2's `InvalidInstanceID.NotFound` error for an instance
  that was already gone failed the cleanup step and left the stack in
  `DELETE_FAILED`.
  ([#137](https://github.com/awslabs/media-resource-manager/pull/137))
- With an existing VPC (`VpcId`), the VPC analyzer checks that each private
  subnet has outbound internet access. `scripts/analyze-vpc.sh` (and
  `scripts/analyze-vpc.ps1`) looks at the subnet's route table, or the VPC
  main route table when the subnet has none of its own, for a `0.0.0.0/0`
  route that is not a blackhole to a NAT gateway, transit gateway, NAT
  instance, network interface, VPC endpoint (AWS Network Firewall or Gateway
  Load Balancer) or Cloud WAN core network. An internet gateway, VPC peering
  or no default route fails the check. The DCV Connection Gateway and
  workstations can launch in any private subnet, and an instance in a subnet
  without that route could not download its software and never became
  ready. The check runs in two modes:
  - When the analyzer picks or validates the subnets (given in
    `PrivateSubnetIds`, one per AZ, or chosen at the prompt), a failed check
    stops the deployment and leaves `parameters.json` unchanged.
  - When the subnets are already saved and `deploy.sh` (or `deploy.ps1`)
    skips the analyzer, it runs only this check
    (`scripts/analyze-vpc.sh --check-egress`), prints a warning and continues.

  Both name the subnet, its AZ, the route table and the route that is
  needed. A default route the analyzer cannot verify, such as a virtual
  private gateway, gets a warning.
  ([#135](https://github.com/awslabs/media-resource-manager/pull/135))
- On Windows, `scripts/analyze-vpc.ps1` analyzes an existing VPC's subnets
  and NACLs. Its subnet and NACL checks read the VPC data they are given
  (they failed with `SyntaxError: ... is not valid JSON`), and the analyzer
  stops `deploy.ps1` with an error when a step fails instead of exiting 0.
  ([#135](https://github.com/awslabs/media-resource-manager/pull/135))

- In regional hubs, a new workstation shows **Ready** only after its DCV
  console session is READY. The check makes its Session Manager calls
  through the hub's `dcv-session-manager`, which accepts them only from a
  direct invoke and only for the describe calls and one `CONSOLE` session on
  that instance. Until a hub is updated, its workstations are created as
  before. **Connect** returns within API Gateway's 29-second limit: when a
  new console session isn't ready after 15 seconds, the API returns 409
  `session-starting`, and the browser viewer and the native client
  **Connect** buttons retry up to 4 times with "Starting your session". The
  hub DCV Lambda role can read AMIs in the hub Region
  (`ec2:DescribeImages`). Needs a hub **Update**.
  ([#120](https://github.com/awslabs/media-resource-manager/pull/120),
  [#114](https://github.com/awslabs/media-resource-manager/issues/114))
- The pipeline template's `AdMode` parameter defaults to empty, which keeps
  the mode in the stored deployment config, like the other optional pipeline
  parameters. A new install still gets `managed`. A pipeline stack that set
  `connector` through `MRM_PARAM_OVERRIDES` keeps it when the stack is
  updated with the new template. If your pipeline stack already has
  `AdMode=managed` set and the deployment runs in connector mode, set
  `AdMode` to `connector` or leave it empty when you update the stack.
  ([#125](https://github.com/awslabs/media-resource-manager/pull/125))
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
- Windows SMB mounts that need a credential (FSx for Windows on standalone
  workstations, FSx for ONTAP with an SMB user) read it at logon from a
  secret for that workstation,
  `/<ProductName>/Workstation/<instanceId>/SmbMount`. The Run Command and the logon script carry the secret's ARN, and the
  script maps each drive with `New-PSDrive -Persist` and a PSCredential. The
  secret's resource policy allows reads only from that instance's role
  session, FSx for ONTAP mounts get only the SMB user, and the secret is
  deleted when none of the workstation's mounts needs a credential and when
  the workstation is deleted. Each such
  workstation has one secret (Secrets Manager list price USD 0.40 per secret
  per month). Running workstations get the new logon script the next time
  the mount manager runs for them, for example when their storage settings
  are saved.
  ([#122](https://github.com/awslabs/media-resource-manager/pull/122))
- On standalone Windows workstations, auto-login sets the Administrator
  password in the PowerShell process with `Set-LocalUser` and a SecureString,
  as macOS auto-login does. It sets the account password before it writes
  `DefaultPassword` to the Winlogon key, and stops with an error when the
  secret is empty or the password can't be set. Hub workstations get the
  change with a hub **Update**.
  ([#119](https://github.com/awslabs/media-resource-manager/pull/119))

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

[Unreleased]: https://github.com/awslabs/media-resource-manager/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/awslabs/media-resource-manager/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/awslabs/media-resource-manager/compare/v1.4.4...v1.5.0
[1.4.4]: https://github.com/awslabs/media-resource-manager/compare/v1.4.3...v1.4.4
[1.4.3]: https://github.com/awslabs/media-resource-manager/compare/v1.4.2...v1.4.3
[1.4.2]: https://github.com/awslabs/media-resource-manager/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/awslabs/media-resource-manager/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/awslabs/media-resource-manager/compare/v1.3.4...v1.4.0
