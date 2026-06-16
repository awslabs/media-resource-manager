# User Data Centralization Progress

## Completed Tasks

### 1. Centralized User Data Scripts
- Created `user-data/session-manager-install.sh` - installs DCV Session Manager from AWS CloudFront
- Created `user-data/connection-gateway-install.sh` - installs DCV Connection Gateway from AWS CloudFront
- Created `user-data/README.md` - documents usage
- Created symlink: `lambda/generate-regional-hub-template/user-data` → `../../user-data`

### 2. Updated Primary Region (dcv-infrastructure-stack.ts)
- Replaced inline user data with centralized scripts
- Uses `export` statements to set environment variables before script runs
- Environment variables: `PRODUCT_NAME`, `DYNAMODB_TABLE_PREFIX`, `TLS_SECRET_NAME`
- No longer pulls from GitHub aws-samples repo

### 3. Updated Regional Hub Template Generator (generate-regional-hub-template/index.js)
- `generateSessionManagerUserData()` - uses centralized script with export prepend
- `generateConnectionGatewayUserData()` - uses centralized script with export prepend
- Removed duplicate inline `generateConnectionGatewayUserData()` function

### 4. Fixed Session Manager Endpoint Storage
- Removed `Endpoint` write from session-manager-install.sh
- Endpoint is now set by CloudFormation/CDK with NLB DNS name (not instance private DNS)
- Connection Gateway uses NLB DNS for stability

### 5. Updated Default Product Name
- Changed fallback default from "TegnaFleetCommand" to "MediaResourceManager"

### 6. TLS Certificate Replication for Regional Hubs (COMPLETED)
- Added `TlsCertReplicatorRole` - IAM role for Lambda to read from primary region and write to regional hub
- Added `TlsCertReplicatorFunction` - Lambda that copies TLS secret from primary region
- Added `TlsCertReplication` - Custom resource that triggers the replication
- Added `generateTlsCertReplicatorLambdaCode()` - inline Lambda code for the custom resource
- Resources are conditional on `dcvDomainName` being provided (via `tlsSecretName` check)
- Connection Gateway reads TLS cert from local region (resilient if primary region down)

## Architecture Summary

### TLS Certificate Flow for Regional Hubs
1. User provides `dcvDomainName` when creating regional hub (e.g., `dcv-vdi-usw2.portal.tegna.com`)
2. Template generator determines `tlsSecretName` = `/${productName}/DCV/ConnectionGateway/TlsCertificate`
3. CloudFormation creates `TlsCertReplicatorFunction` Lambda with:
   - `SOURCE_REGION` = primary region (e.g., `us-east-1`)
   - `SOURCE_SECRET_NAME` = the TLS secret path
4. Custom resource `TlsCertReplication` invokes Lambda to copy secret to regional hub region
5. Connection Gateway user data reads TLS cert from local region's Secrets Manager
6. If source secret doesn't exist, Lambda succeeds gracefully (uses self-signed cert)

### Primary Region (us-east-1)
- Session Manager + Connection Gateway in ASGs with Launch Templates
- TLS cert stored in Secrets Manager: `/${ProductName}/DCV/ConnectionGateway/TlsCertificate`
- SSM Parameter `/${ProductName}/DCV/SessionManager/Endpoint` = NLB DNS name
- DynamoDB table prefix: `dcv-session-manager-`

### Regional Hubs (e.g., us-west-2)
- Same user data scripts via symlink
- DynamoDB table prefix: `dcv-sm-regional-` (separate tables per region)
- SSM Parameter `/${ProductName}/DCV/SessionManager/Endpoint` = regional NLB DNS name
- TLS cert: Replicated from primary region to local Secrets Manager

## Git Commits Made This Session
1. `feat: deploy DCV Lambdas to regional hubs for VPC access to Session Manager API`
2. `refactor: centralize user data scripts in user-data/ directory`
3. `refactor: use centralized user data scripts in dcv-infrastructure-stack`
4. `refactor: align regional hub user data with primary region approach`
5. `fix: update default product name to MediaResourceManager in user data scripts`
6. `fix: remove Endpoint write from session manager script - use NLB DNS from CloudFormation`

## Uncommitted Changes (Ready for Commit)
- TLS certificate replication for regional hubs:
  - Added `generateTlsCertReplicatorLambdaCode()` function
  - Added CloudFormation resources for TLS cert replication (conditional on dcvDomainName)
  - Removed duplicate inline `generateConnectionGatewayUserData()` function
  - Connection Gateway reads from local region (resilient architecture)
- Removed `DcvCertificateArn` field from regional hub creation:
  - Removed from frontend form (RegionManagement.tsx)
  - Removed from CloudFormation template parameters
  - ACM certs can't be used for Connection Gateway (needs PEM files)
  - TLS cert is now automatically replicated from primary region
- Fixed connection-gateway-install.sh to match old inline script:
  - Added QUIC configuration on port 8444
  - Added `chown dcvcgw:dcvcgw` for cert permissions
  - Added `openssl pkcs8` conversion for private key (required by DCV Gateway)
  - Added `jq` installation for JSON parsing

## Verification Complete
All critical features from the old inline user data scripts have been verified present in the new centralized scripts:

**Connection Gateway Script:**
- ✅ QUIC on port 8444 (`quic-listen-endpoints = ["0.0.0.0:8444"]`)
- ✅ PKCS8 conversion (`openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt`)
- ✅ Proper ownership (`chown dcvcgw:dcvcgw`)
- ✅ jq installation for JSON parsing
- ✅ Cross-region TLS secret access support (`TLS_SECRET_REGION` env var)

**Session Manager Script:**
- ✅ DynamoDB persistence configuration
- ✅ API client registration with retry logic
- ✅ SSM parameter storage for credentials
- ✅ Endpoint parameter NOT written (set by CloudFormation with NLB DNS)
- ✅ CloudWatch Logs integration (`log_message` function sends to `/aws/ec2/dcv-session-manager`)
