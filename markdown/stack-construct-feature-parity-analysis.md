# User Data Scripts: CDK vs Regional Hub - Feature Parity Analysis

**Status: ✅ PARITY ACHIEVED**

Both Session Manager and Connection Gateway user data scripts have been updated to match the CDK stack functionality.

## Session Manager User Data

### CDK Stack (dcv-infrastructure-stack.ts)

| Feature | Present | Details |
|---------|---------|---------|
| CloudWatch Log Group Creation | ✅ | Creates `/aws/ec2/dcv-session-manager` log group |
| CloudWatch Log Stream | ✅ | Creates stream per instance ID |
| CloudWatch Logging Function | ✅ | `log_message()` function sends to CloudWatch |
| IMDSv2 Token Handling | ✅ | Uses token-based metadata retrieval |
| Bootstrap Script Download | ✅ | Downloads from aws-samples GitHub |
| Wait for Service Start | ✅ | 30 attempts, 10 second intervals |
| DynamoDB Persistence Config | ✅ | Enables persistence, sets region |
| DynamoDB Table Prefix | ✅ | `dcv-session-manager-` |
| DynamoDB RCU/WCU Config | ✅ | Sets to 5/5 |
| Wait for Broker Ready | ✅ | 60 attempts, 5 second intervals, tests port 8443 |
| API Client Registration | ✅ | With retry logic (3 retries) |
| Credential Validation | ✅ | Checks length > 10 characters |
| SSM Parameters Stored | ✅ | ClientName, ClientId, ClientPassword, ClientExitCode |
| Error Handling | ✅ | Exits with code 1 on failure |

### Regional Hub Template (generate-regional-hub-template/index.js) - UPDATED

| Feature | Present | Details |
|---------|---------|---------|
| CloudWatch Log Group Creation | ✅ | Creates `/aws/ec2/dcv-session-manager-regional` log group |
| CloudWatch Log Stream | ✅ | Creates stream per instance ID |
| CloudWatch Logging Function | ✅ | `log_message()` function sends to CloudWatch |
| IMDSv2 Token Handling | ✅ | Uses token-based metadata retrieval |
| Bootstrap Script Download | ✅ | Downloads from aws-samples GitHub |
| Wait for Service Start | ✅ | 30 attempts, 10 second intervals |
| DynamoDB Persistence Config | ✅ | Enables persistence, sets region |
| DynamoDB Table Prefix | ✅ | `dcv-sm-regional-` (different prefix to avoid conflicts) |
| DynamoDB RCU/WCU Config | ✅ | Sets to 5/5 |
| Wait for Broker Ready | ✅ | 60 attempts, 5 second intervals |
| API Client Registration | ✅ | With retry logic (3 retries) |
| Credential Validation | ✅ | Checks length > 10 characters |
| SSM Parameters Stored | ✅ | ClientName, ClientId, ClientPassword, ClientExitCode |
| Error Handling | ✅ | Exits with code 1 on failure |

---

## Connection Gateway User Data

### CDK Stack

| Feature | Present | Details |
|---------|---------|---------|
| IMDSv2 Token Handling | ✅ | Uses token-based metadata |
| OS Detection | ✅ | Detects system, version, arch |
| Package Type Detection | ✅ | Sets el7, package manager |
| GPG Key Import | ✅ | Imports NICE GPG key |
| Package Download | ✅ | Downloads gateway + server packages |
| Web Viewer Install | ✅ | Installs nice-dcv-web-viewer |
| Gateway Install | ✅ | Installs connection gateway |
| Web Viewer Config | ✅ | Sets local-resources-path |
| Service Enable/Start | ✅ | Enables and starts gateway |
| Broker DNS Retrieval | ✅ | Gets from SSM with retry loop |
| Health Check Config | ✅ | Configures port 8989 |
| TLS Strict Disable | ✅ | Sets tls-strict = false |
| Resolver TLS Config | ✅ | Adds tls-strict to resolver section |
| Broker URL Config | ✅ | Points to broker:8447 |
| QUIC Config | ✅ | Configures port 8444 |
| TLS Certificate from Secrets Manager | ✅ | Optional custom cert support |
| Service Restart | ✅ | Restarts after config |
| Cleanup | ✅ | Removes temp directory |

### Regional Hub Template - UPDATED

| Feature | Present | Details |
|---------|---------|---------|
| IMDSv2 Token Handling | ✅ | Uses token-based metadata |
| OS Detection | ✅ | Detects system, version, arch |
| Package Type Detection | ✅ | Sets el7, package manager |
| GPG Key Import | ✅ | Imports NICE GPG key |
| Package Download | ✅ | Downloads gateway + server packages |
| Web Viewer Install | ✅ | Installs nice-dcv-web-viewer |
| Gateway Install | ✅ | Installs connection gateway |
| Web Viewer Config | ✅ | Sets local-resources-path |
| Service Enable/Start | ✅ | Enables and starts gateway |
| Broker DNS Retrieval | ✅ | Gets from SSM with TCP connectivity check |
| Health Check Config | ✅ | Configures port 8989 |
| TLS Strict Disable | ✅ | Sets tls-strict = false |
| Resolver TLS Config | ✅ | Adds tls-strict to resolver section |
| Broker URL Config | ✅ | Points to broker:8447 |
| QUIC Config | ✅ | Configures port 8444 |
| TLS Certificate from Secrets Manager | ✅ | Optional custom cert support (graceful fallback) |
| Service Restart | ✅ | Restarts after config |
| Cleanup | ✅ | Removes temp directory |

---

## Summary of Changes Made

### Session Manager Script
1. ✅ Added IMDSv2 token handling
2. ✅ Added CloudWatch logging (log group, stream, log_message function)
3. ✅ Added retry logic (3 retries with 10 second delays)
4. ✅ Added credential length validation (> 10 chars)
5. ✅ Added DynamoDB RCU/WCU configuration
6. ✅ Added all 4 SSM parameters (ClientName, ClientId, ClientPassword, ClientExitCode)

### Connection Gateway Script
1. ✅ Added OS detection (system, version, arch)
2. ✅ Added TLS certificate support from Secrets Manager
3. ✅ Added Secrets Manager IAM permission to role
4. ✅ Improved broker connectivity check (TCP test instead of just SSM lookup)
5. ✅ Added PKCS#8 key conversion for DCV Gateway compatibility
