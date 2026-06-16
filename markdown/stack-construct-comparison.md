# DCV Infrastructure: CDK Stack vs Regional Hub CloudFormation Template Comparison

This document compares the working CDK-generated DCV infrastructure (`dcv-infrastructure-stack.ts`) against the regional hub CloudFormation template (`generate-regional-hub-template/index.js`) to identify discrepancies.

## Summary of Findings

| Component | CDK Stack | Regional Hub Template | Status |
|-----------|-----------|----------------------|--------|
| Session Manager SG | ✅ Complete | ⚠️ Missing self-ingress | **NEEDS FIX** |
| Connection Gateway SG | ✅ Complete | ✅ Complete | OK |
| Workstation SG | ✅ Complete | ✅ Complete (fixed) | OK |
| Session Manager IAM | ✅ Complete | ⚠️ Missing CloudWatch Logs | **NEEDS FIX** |
| Session Manager NLB | ✅ 3 target groups | ✅ 3 target groups | OK |
| Connection Gateway NLB | ✅ TCP + UDP | ✅ TCP + UDP | OK |
| User Data Scripts | ✅ Detailed | ⚠️ Simplified | **REVIEW** |
| NLB Access Logging | ✅ Enabled | ✅ Enabled (fixed) | OK |
| IMDSv2 | ✅ Required | ❌ Missing | **NEEDS FIX** |

---

## Detailed Comparison

### 1. Security Groups

#### Session Manager Security Group

**CDK Stack:**
```typescript
// Self-referencing rule for broker-to-broker communication
sessionManagerSg.addIngressRule(
  sessionManagerSg,
  ec2.Port.allTraffic(),
  'allow Broker to Broker communication'
);

// Connection Gateway to Session Manager resolver communication
sessionManagerSg.addIngressRule(
  connectionGatewaySg,
  ec2.Port.tcp(8447),
  'allow Gateway to Broker resolver communication'
);

// Allow Gateway to Broker communication through NLB (NLB doesn't preserve source SG)
sessionManagerSg.addIngressRule(
  ec2.Peer.ipv4(vpcCidr),
  ec2.Port.tcp(8447),
  'allow Gateway to Broker communication from NLB within VPC'
);

// CLI to Broker communication (external access)
sessionManagerSg.addIngressRule(
  ec2.Peer.anyIpv4(),
  ec2.Port.tcp(8443),
  'allow CLI to Broker communication'
);

// Agent to Broker communication (workstations)
sessionManagerSg.addIngressRule(
  ec2.Peer.anyIpv4(),
  ec2.Port.tcp(8445),
  'allow Agent to Broker communication'
);
```

**Regional Hub Template:**
```javascript
SecurityGroupIngress: [
  { IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443, CidrIp: '0.0.0.0/0', Description: 'CLI to Broker API' },
  { IpProtocol: 'tcp', FromPort: 8445, ToPort: 8445, CidrIp: '0.0.0.0/0', Description: 'Agent to Broker' },
  { IpProtocol: 'tcp', FromPort: 8447, ToPort: 8447, CidrIp: { Ref: 'VpcCidr' }, Description: 'Gateway to Broker resolver' }
]

// Self-ingress added separately
SessionManagerSGSelfIngress: {
  Type: 'AWS::EC2::SecurityGroupIngress',
  Properties: {
    GroupId: { Ref: 'SessionManagerSecurityGroup' },
    IpProtocol: '-1',
    SourceSecurityGroupId: { Ref: 'SessionManagerSecurityGroup' },
    Description: 'Broker to Broker communication'
  }
}
```

**Status:** ✅ OK - Self-ingress is added via separate resource

---

#### Workstation Security Group

**CDK Stack:**
```typescript
workstationSg.addIngressRule(
  connectionGatewaySg,
  ec2.Port.tcp(8443),
  'allow DCV streaming traffic from Gateway'
);

// UDP DCV streaming traffic for workstations
workstationSg.addIngressRule(
  connectionGatewaySg,
  ec2.Port.udp(8443),
  'allow DCV streaming traffic from Gateway'
);

// UDP DCV streaming traffic on port 8444 for QUIC when TLS is enabled
workstationSg.addIngressRule(
  connectionGatewaySg,
  ec2.Port.udp(8444),
  'allow DCV/QUIC streaming traffic from Gateway (TLS mode)'
);

// Allow DCV traffic from NLB within VPC (NLB doesn't preserve source SG)
workstationSg.addIngressRule(
  ec2.Peer.ipv4(vpcCidr),
  ec2.Port.tcp(8443),
  'allow DCV traffic from NLB within VPC'
);

workstationSg.addIngressRule(
  ec2.Peer.ipv4(vpcCidr),
  ec2.Port.udp(8443),
  'allow DCV traffic from NLB within VPC'
);

// UDP port 8444 for QUIC when TLS is enabled
workstationSg.addIngressRule(
  ec2.Peer.ipv4(vpcCidr),
  ec2.Port.udp(8444),
  'allow DCV/QUIC traffic from NLB within VPC (TLS mode)'
);

// Allow SMB traffic for FSx file systems
workstationSg.addIngressRule(
  ec2.Peer.ipv4(vpcCidr),
  ec2.Port.tcp(445),
  'allow SMB access to FSx file systems'
);
```

**Regional Hub Template:**
```javascript
SecurityGroupIngress: [
  { IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443, CidrIp: { Ref: 'VpcCidr' }, Description: 'DCV TCP from VPC' },
  { IpProtocol: 'udp', FromPort: 8443, ToPort: 8443, CidrIp: { Ref: 'VpcCidr' }, Description: 'DCV UDP from VPC' },
  { IpProtocol: 'udp', FromPort: 8444, ToPort: 8444, CidrIp: { Ref: 'VpcCidr' }, Description: 'DCV QUIC from VPC' },
  { IpProtocol: 'tcp', FromPort: 445, ToPort: 445, CidrIp: { Ref: 'VpcCidr' }, Description: 'SMB for FSx' }
]

// From Gateway SG added separately (TCP + UDP)
WorkstationSGFromGateway: { ... IpProtocol: 'tcp', FromPort: 8443 ... }
WorkstationSGFromGatewayUdp8443: { ... IpProtocol: 'udp', FromPort: 8443 ... }
WorkstationSGFromGatewayUdp8444: { ... IpProtocol: 'udp', FromPort: 8444 ... }
```

**Status:** ✅ OK - All rules now present

---

### 2. IAM Roles

#### Session Manager Role

**CDK Stack includes:**
- `AmazonSSMManagedInstanceCore`
- DynamoDB full access
- SSM Parameter read/write
- CloudWatch Logs (CreateLogGroup, CreateLogStream, PutLogEvents)

**Regional Hub Template includes:**
- `AmazonSSMManagedInstanceCore`
- DynamoDB full access
- SSM Parameter read/write
- CloudWatch Logs ✅

**Status:** ✅ OK

---

### 3. Launch Template Configuration

#### IMDSv2 Requirement

**CDK Stack:**
```typescript
requireImdsv2: true,
```

**Regional Hub Template:**
```javascript
MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 2 },
```

**Status:** ✅ OK - Both require IMDSv2

---

### 4. NLB Access Logging

**CDK Stack:**
```typescript
// CKV_AWS_91: S3 bucket for NLB access logs
const nlbAccessLogsBucket = new s3.Bucket(this, 'NlbAccessLogsBucket', {...});
sessionManagerNlb.logAccessLogs(nlbAccessLogsBucket, 'session-manager-nlb');
this.networkLoadBalancer.logAccessLogs(nlbAccessLogsBucket, 'dcv-nlb');
```

**Regional Hub Template:**
- ❌ No access logging configured

**Status:** ⚠️ NEEDS FIX - Should add S3 bucket and enable access logging for compliance

---

### 5. User Data Scripts

#### Session Manager User Data

**CDK Stack:** ~150 lines with:
- CloudWatch logging setup
- Retry logic for API client registration
- Detailed error handling
- Multiple SSM parameters stored

**Regional Hub Template:** ~50 lines with:
- Basic installation
- Single retry for API client registration
- Stores credentials in regional SSM

**Status:** ⚠️ REVIEW - Regional template is simpler but functional. May want to add CloudWatch logging.

---

## Recommended Fixes

### Fix 1: ✅ DONE - Added Missing Workstation SG Rules

Added UDP rules from Connection Gateway for QUIC streaming support.

### Fix 2: ✅ DONE - Added NLB Access Logging

Added S3 bucket with proper bucket policy for NLB access logs, and configured both Session Manager NLB and Connection Gateway NLB to write access logs. This satisfies CKV_AWS_91 compliance.

---

## Conclusion

The regional hub template is now complete with:
- All necessary security group rules for DCV streaming including QUIC support
- NLB access logging for compliance (CKV_AWS_91)
