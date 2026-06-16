# CDK DCV Infrastructure vs Regional Hub CloudFormation Template - Final Parity Analysis

## Executive Summary

This document compares the synthesized CDK CloudFormation template (`TFC-Dcv-Infrastructure.template.json`) against the regional hub CloudFormation template generator (`generate-regional-hub-template/index.js`).

**Overall Status: ✅ PARITY ACHIEVED (including EventBridge/Cleanup infrastructure)**

---

## Regional Cleanup Infrastructure

The regional hub template now includes EventBridge rules and Lambda functions for DCV cleanup, matching the primary region's `dcv-cleanup-stack.ts` and `eventbridge-stack.ts` functionality.

### Why Regional Cleanup is Required

1. **EventBridge is regional** - Rules only capture events in their own region
2. **Cleanup Lambdas need VPC access** - Must connect to regional Session Manager API (port 8443)
3. **DynamoDB updates go cross-region** - Lambdas update the primary region's workstation table

### Regional Cleanup Resources

| Resource | Purpose | Primary Region Equivalent |
|----------|---------|---------------------------|
| `DcvSessionCleanupFunction` | Cleans up DCV sessions on stop/terminate | `dcv-session-cleanup` Lambda |
| `DcvServerCleanupFunction` | Removes DCV servers on terminate | `dcv-cleanup` Lambda |
| `Ec2StateHandlerFunction` | Updates DynamoDB on EC2 state changes | `ec2-state-handler` Lambda |
| `SessionCleanupRule` | EventBridge rule for stop/terminate | `SessionCleanupRule` |
| `ServerCleanupRule` | EventBridge rule for terminate only | `ServerCleanupRule` |
| `Ec2StateChangeRule` | EventBridge rule for all state changes | `EC2StateChangeRule` |
| `CleanupLambdaSecurityGroup` | Allows Lambda to reach Session Manager | Workstation SG |
| `CleanupLambdaRole` | IAM role with SSM, EC2, DynamoDB permissions | Cleanup Lambda roles |
| `Ec2StateHandlerRole` | IAM role for DynamoDB cross-region access | State handler role |

### Cross-Region DynamoDB Access

The regional cleanup Lambdas update the workstation table in the **primary region**:
- `PRIMARY_REGION` environment variable specifies the target region
- `WORKSTATION_TABLE_NAME` environment variable specifies the table name
- DynamoDB client is configured with `region_name=primary_region`

---

## Resource Comparison

### Security Groups

| Resource | CDK Stack | Regional Hub | Match |
|----------|-----------|--------------|-------|
| Session Manager SG | ✅ | ✅ | ✅ |
| - TCP 8443 (CLI to Broker) | 0.0.0.0/0 | 0.0.0.0/0 | ✅ |
| - TCP 8445 (Agent to Broker) | 0.0.0.0/0 | 0.0.0.0/0 | ✅ |
| - TCP 8447 (Gateway to Broker) | VPC CIDR | VPC CIDR | ✅ |
| - Self-ingress (Broker to Broker) | All traffic | All traffic | ✅ |
| - TCP 8447 from Gateway SG | ✅ | ✅ | ✅ |
| Connection Gateway SG | ✅ | ✅ | ✅ |
| - TCP 8443 (DCV TCP) | 0.0.0.0/0 | 0.0.0.0/0 | ✅ |
| - UDP 8443 (DCV UDP) | 0.0.0.0/0 | 0.0.0.0/0 | ✅ |
| - UDP 8444 (QUIC) | 0.0.0.0/0 | 0.0.0.0/0 | ✅ |
| - TCP 8989 (Health check) | 0.0.0.0/0 | 0.0.0.0/0 | ✅ |
| Workstation SG | ✅ | ✅ | ✅ |
| - TCP 8443 from VPC | VPC CIDR | VPC CIDR | ✅ |
| - UDP 8443 from VPC | VPC CIDR | VPC CIDR | ✅ |
| - UDP 8444 from VPC | VPC CIDR | VPC CIDR | ✅ |
| - TCP 445 (SMB) | VPC CIDR | VPC CIDR | ✅ |
| - TCP 8443 from Gateway SG | ✅ | ✅ | ✅ |
| - UDP 8443 from Gateway SG | ✅ | ✅ | ✅ |
| - UDP 8444 from Gateway SG | ✅ | ✅ | ✅ |

### Load Balancers

| Resource | CDK Stack | Regional Hub | Match |
|----------|-----------|--------------|-------|
| Session Manager NLB | ✅ | ✅ | ✅ |
| - Type | network | network | ✅ |
| - Scheme | internal | internal | ✅ |
| - Cross-zone enabled | true | true | ✅ |
| - Access logs enabled | true | true | ✅ |
| Connection Gateway NLB | ✅ | ✅ | ✅ |
| - Type | network | network | ✅ |
| - Scheme | internet-facing | internet-facing | ✅ |
| - Cross-zone enabled | true | true | ✅ |
| - Access logs enabled | true | true | ✅ |

### Target Groups

| Resource | CDK Stack | Regional Hub | Match |
|----------|-----------|--------------|-------|
| SM Agent TG (8445/TCP) | ✅ | ✅ | ✅ |
| SM API TG (8443/TCP) | ✅ | ✅ | ✅ |
| SM Resolver TG (8447/TCP) | ✅ | ✅ | ✅ |
| CG TCP TG (8443/TCP) | ✅ | ✅ | ✅ |
| CG UDP TG (8444/UDP) | ✅ | ✅ | ✅ |

### Listeners

| Resource | CDK Stack | Regional Hub | Match |
|----------|-----------|--------------|-------|
| SM Agent Listener (8445/TCP) | ✅ | ✅ | ✅ |
| SM API Listener (8443/TCP) | ✅ | ✅ | ✅ |
| SM Resolver Listener (8447/TCP) | ✅ | ✅ | ✅ |
| CG TCP Listener (8443/TCP) | ✅ | ✅ | ✅ |
| CG UDP Listener (8444/UDP) | ✅ | ✅ | ✅ |

### Launch Templates

| Resource | CDK Stack | Regional Hub | Match |
|----------|-----------|--------------|-------|
| Session Manager LT | ✅ | ✅ | ✅ |
| - Instance Type | m6g.large | m6g.large | ✅ |
| - AMI | AL2023 ARM64 | AL2023 ARM64 | ✅ |
| - IMDSv2 Required | HttpTokens: required | HttpTokens: required | ✅ |
| Connection Gateway LT | ✅ | ✅ | ✅ |
| - Instance Type | c7g.large | c7g.large | ✅ |
| - AMI | AL2023 ARM64 | AL2023 ARM64 | ✅ |
| - IMDSv2 Required | HttpTokens: required | HttpTokens: required | ✅ |
| Workstation LT | ✅ | ✅ | ✅ |
| - IMDSv2 Required | HttpTokens: required | HttpTokens: required | ✅ |

### Auto Scaling Groups

| Resource | CDK Stack | Regional Hub | Match |
|----------|-----------|--------------|-------|
| Session Manager ASG | ✅ | ✅ | ✅ |
| - Min/Max | 1/1 | 1/1 | ✅ |
| - Target Groups | 3 | 3 | ✅ |
| Connection Gateway ASG | ✅ | ✅ | ✅ |
| - Min/Max | 1/3 | 1/3 | ✅ |
| - Target Groups | 2 | 2 | ✅ |

### IAM Roles

| Resource | CDK Stack | Regional Hub | Match |
|----------|-----------|--------------|-------|
| Session Manager Role | ✅ | ✅ | ✅ |
| - AmazonSSMManagedInstanceCore | ✅ | ✅ | ✅ |
| - DynamoDB access | ✅ | ✅ | ✅ |
| - SSM Parameter access | ✅ | ✅ | ✅ |
| - CloudWatch Logs | ✅ | ✅ | ✅ |
| Connection Gateway Role | ✅ | ✅ | ✅ |
| - AmazonSSMManagedInstanceCore | ✅ | ✅ | ✅ |
| - SSM Parameter access | ✅ | ✅ | ✅ |
| - Secrets Manager access | ✅ | ✅ | ✅ |
| Workstation Role | ✅ | ✅ | ✅ |
| - AmazonSSMManagedInstanceCore | ✅ | ✅ | ✅ |
| - CloudWatchAgentServerPolicy | ✅ | ✅ | ✅ |
| - SSM Parameter access | ✅ | ✅ | ✅ |
| - DCV License S3 access | ✅ | ✅ | ✅ |

### SSM Parameters

| Resource | CDK Stack | Regional Hub | Match |
|----------|-----------|--------------|-------|
| Session Manager Endpoint | ✅ | ✅ | ✅ |
| Connection Gateway Endpoint | ✅ | ✅ | ✅ |
| VPC ID | N/A (imported) | ✅ | ✅ |
| Private Subnet IDs | N/A (imported) | ✅ | ✅ |
| Security Group ID | ✅ | ✅ | ✅ |
| Launch Template ID | ✅ | ✅ | ✅ |

### S3 Buckets

| Resource | CDK Stack | Regional Hub | Match |
|----------|-----------|--------------|-------|
| NLB Access Logs Bucket | ✅ | ✅ | ✅ |
| - Encryption | S3 Managed | AES256 | ✅ |
| - Public Access Block | All blocked | All blocked | ✅ |
| - Versioning | Enabled | Enabled | ✅ |
| - Lifecycle (90 days) | ✅ | ✅ | ✅ |
| - SSL Enforcement | ✅ | ✅ | ✅ |

---

## Differences (Expected)

These differences are intentional due to the different deployment contexts:

| Feature | CDK Stack | Regional Hub | Reason |
|---------|-----------|--------------|--------|
| VPC | Imported from SSM | Created inline | Regional hub creates its own VPC |
| Subnets | Imported from SSM | Created inline | Regional hub creates its own subnets |
| NAT Gateway | Imported | Created inline | Regional hub creates its own NAT |
| DynamoDB Table Prefix | `dcv-session-manager-` | `dcv-sm-regional-` | Avoid conflicts with primary region |
| CloudWatch Log Group | `/aws/ec2/dcv-session-manager` | `/aws/ec2/dcv-session-manager-regional` | Distinguish regional logs |
| SSM Document | Created | Not needed | Workstations use primary region's document |
| Cleanup Construct | Created | Not needed | Regional cleanup handled by stack deletion |
| Standalone Admin Secret | Created | Not needed | Workstations use primary region's secret |

---

## User Data Scripts Comparison

### Session Manager User Data

| Feature | CDK Stack | Regional Hub | Match |
|---------|-----------|--------------|-------|
| IMDSv2 token handling | ✅ | ✅ | ✅ |
| CloudWatch log group creation | ✅ | ✅ | ✅ |
| CloudWatch log stream | ✅ | ✅ | ✅ |
| log_message() function | ✅ | ✅ | ✅ |
| Bootstrap script download | ✅ | ✅ | ✅ |
| Wait for service (30 attempts) | ✅ | ✅ | ✅ |
| DynamoDB persistence config | ✅ | ✅ | ✅ |
| DynamoDB RCU/WCU (5/5) | ✅ | ✅ | ✅ |
| Wait for broker ready (60 attempts) | ✅ | ✅ | ✅ |
| API client retry logic (3 retries) | ✅ | ✅ | ✅ |
| Credential length validation | ✅ | ✅ | ✅ |
| Store ClientName | ✅ | ✅ | ✅ |
| Store ClientId | ✅ | ✅ | ✅ |
| Store ClientPassword | ✅ | ✅ | ✅ |
| Store ClientExitCode | ✅ | ✅ | ✅ |

### Connection Gateway User Data

| Feature | CDK Stack | Regional Hub | Match |
|---------|-----------|--------------|-------|
| IMDSv2 token handling | ✅ | ✅ | ✅ |
| OS detection | ✅ | ✅ | ✅ |
| GPG key import | ✅ | ✅ | ✅ |
| Package download | ✅ | ✅ | ✅ |
| Web viewer install | ✅ | ✅ | ✅ |
| Gateway install | ✅ | ✅ | ✅ |
| Web viewer config | ✅ | ✅ | ✅ |
| Service enable/start | ✅ | ✅ | ✅ |
| Broker DNS retrieval with retry | ✅ | ✅ | ✅ |
| TCP connectivity check | ✅ | ✅ | ✅ |
| Health check config (8989) | ✅ | ✅ | ✅ |
| TLS strict disable | ✅ | ✅ | ✅ |
| Resolver TLS config | ✅ | ✅ | ✅ |
| Broker URL config | ✅ | ✅ | ✅ |
| QUIC config (8444) | ✅ | ✅ | ✅ |
| TLS cert from Secrets Manager | ✅ | ✅ | ✅ |
| PKCS#8 key conversion | ✅ | ✅ | ✅ |
| Service restart | ✅ | ✅ | ✅ |
| Temp directory cleanup | ✅ | ✅ | ✅ |

---

## Conclusion

The regional hub CloudFormation template now has **full feature parity** with the CDK-generated DCV infrastructure stack. All security groups, load balancers, target groups, listeners, IAM roles, launch templates, auto scaling groups, and user data scripts match the production CDK configuration.

**Regional Cleanup Infrastructure Added:**
- EventBridge rules for EC2 state changes (session cleanup, server cleanup, state handler)
- Lambda functions deployed in regional VPC with access to Session Manager
- Cross-region DynamoDB updates to primary region's workstation table
- Proper IAM roles and security groups for cleanup operations

The only differences are intentional:
1. VPC/subnet creation (regional hub creates its own)
2. DynamoDB table prefix (to avoid conflicts)
3. CloudWatch log group name (to distinguish regional logs)
4. Resources not needed in satellite regions (SSM Document, Admin Secret)
5. Auto-shutdown and status-sync remain in primary region (can query all regions)
