# Custom Domain Setup Guide

This guide covers configuring custom domains for both the web console (CloudFront) and DCV connections (Network Load Balancer).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Important: Dynamic Parameter Paths](#important-dynamic-parameter-paths)
- [Part 1: Web Console Custom Domain](#part-1-web-console-custom-domain)
- [Part 2: DCV Connection Gateway Custom Domain](#part-2-dcv-connection-gateway-custom-domain)
- [Cross-Account DNS Configuration](#cross-account-dns-configuration)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)

## Prerequisites

Before starting, ensure you have:

1. **ACM Certificate** - An SSL/TLS certificate in AWS Certificate Manager
   - For CloudFront: Certificate **must** be in `us-east-1` region
   - For NLB (DCV): Certificate must be in the same region as your deployment
   
2. **DNS Access** - Ability to create DNS records in your domain's hosted zone
   - If hosted zone is in a different AWS account, you'll need access to that account

3. **Domain Name** - Your custom domain names planned out:
   - Web console: e.g., `vdi.portal.company.com`
   - DCV connections: e.g., `dcv.company.com`

---

## Important: Dynamic Parameter Paths

This application uses dynamic SSM parameter paths based on the product name configured in `cdk.json`. Throughout this guide, you'll need to determine your parameter prefix first:

```bash
# Get the parameter prefix (e.g., MediaResourceManager)
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
echo "Parameter prefix: /${PARAM_PREFIX}"
```

All SSM parameters follow the pattern: `/${PARAM_PREFIX}/...`

---

## Part 1: Web Console Custom Domain

Configure a custom domain for the React web console instead of the default CloudFront URL.

### Step 1: Import or Request ACM Certificate

If you don't already have a certificate in ACM:

**Option A: Import existing certificate (us-east-1)**
```bash
aws acm import-certificate \
  --region us-east-1 \
  --certificate fileb://certificate.pem \
  --private-key fileb://private-key.pem \
  --certificate-chain fileb://certificate-chain.pem
```

**Option B: Request new certificate**
```bash
aws acm request-certificate \
  --region us-east-1 \
  --domain-name "vdi.portal.company.com" \
  --validation-method DNS
```

Note the certificate ARN for the next step.

### Step 2: Get CloudFront Distribution ID

```bash
# Get the parameter prefix
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")

# Get the distribution domain name from SSM
CLOUDFRONT_URL=$(aws ssm get-parameter \
  --name "/${PARAM_PREFIX}/Frontend/Url" \
  --query "Parameter.Value" \
  --output text)

echo "Current CloudFront URL: $CLOUDFRONT_URL"

# List distributions to find the ID
aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(DomainName, 'cloudfront.net')].{Id:Id,DomainName:DomainName}" \
  --output table
```

### Step 3: Update CloudFront Distribution

**Via AWS Console (Recommended):**

1. Navigate to **CloudFront** → **Distributions**
2. Select your distribution (matches the domain from Step 2)
3. Click **Edit**
4. Under **Alternate domain name (CNAME)**, click **Add item**
5. Enter your custom domain: `vdi.portal.company.com`
6. Under **Custom SSL certificate**, select your ACM certificate
7. Click **Save changes**
8. Wait for distribution status to change from "Deploying" to "Deployed" (5-15 minutes)

**Via AWS CLI:**

```bash
# Get current distribution config
DIST_ID="E1234567890ABC"  # Replace with your distribution ID

aws cloudfront get-distribution-config --id $DIST_ID > dist-config.json

# Extract ETag for update
ETAG=$(jq -r '.ETag' dist-config.json)

# Edit the config to add:
# - Aliases.Items: ["vdi.portal.company.com"]
# - Aliases.Quantity: 1
# - ViewerCertificate.ACMCertificateArn: "arn:aws:acm:us-east-1:..."
# - ViewerCertificate.SSLSupportMethod: "sni-only"
# - ViewerCertificate.MinimumProtocolVersion: "TLSv1.2_2021"

# Update distribution
aws cloudfront update-distribution \
  --id $DIST_ID \
  --if-match $ETAG \
  --distribution-config file://updated-config.json
```

### Step 4: Create DNS Record

Create a DNS record pointing your custom domain to CloudFront.

**If hosted zone is in the same account:**
```bash
# Get CloudFront domain name
CF_DOMAIN="d1234567890abc.cloudfront.net"  # From your distribution

# Get hosted zone ID
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name "company.com" \
  --query "HostedZones[0].Id" \
  --output text | sed 's|/hostedzone/||')

# Create ALIAS record (recommended for CloudFront)
aws route53 change-resource-record-sets \
  --hosted-zone-id $HOSTED_ZONE_ID \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "vdi.portal.company.com",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "'$CF_DOMAIN'",
          "EvaluateTargetHealth": false
        }
      }
    }]
  }'
```

**Note:** `Z2FDTNDATAQYW2` is the hosted zone ID for all CloudFront distributions.

For cross-account DNS setup, see [Cross-Account DNS Configuration](#cross-account-dns-configuration).

### Step 5: Update Frontend URL for CORS and Authentication

Update the frontend URL to enable CORS and Cognito authentication from your custom domain.

**Option A: Via parameters.json (Recommended)**

Add your custom domain to `parameters.json`:

```json
{
  "ParameterKey": "FrontendUrl",
  "ParameterValue": "https://vdi.portal.company.com"
}
```

Then redeploy:
```bash
./deploy.sh
```

**Option B: Manual SSM Parameter Update**

```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
aws ssm put-parameter \
  --name "/${PARAM_PREFIX}/Frontend/Url" \
  --value "https://vdi.portal.company.com" \
  --type String \
  --overwrite
```

This parameter update triggers an EventBridge rule that automatically:
1. Updates API Gateway CORS headers to allow requests from your custom domain
2. Updates Cognito User Pool Client callback/logout URLs for authentication

### Step 6: Regenerate Frontend Config

Force the config generator to update:

```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")

# Get the Lambda ARN
CONFIG_LAMBDA=$(aws ssm get-parameter \
  --name "/${PARAM_PREFIX}/Frontend/ConfigGeneratorArn" \
  --query "Parameter.Value" \
  --output text)

# Invoke it
aws lambda invoke \
  --function-name $CONFIG_LAMBDA \
  --payload '{}' \
  /dev/stdout
```

---

## Part 2: DCV Connection Gateway Custom Domain

Configure a custom domain for DCV browser connections to eliminate the security warning.

### Understanding the TLS Architecture

The DCV Connection Gateway uses **TCP passthrough** at the Network Load Balancer level, with TLS handled directly by the Connection Gateway instances. This architecture:

- Allows the Gateway to handle TLS internally (required by DCV protocol)
- Supports custom certificates stored in AWS Secrets Manager
- Enables automatic certificate deployment when Gateway instances scale or restart

**Certificate Flow:**
```
Client → NLB (TCP:8443) → Connection Gateway (TLS with custom cert) → Workstation
```

### Step 1: Prepare Your Certificate Files

You need two PEM files:
- **Certificate file**: The full certificate chain (your certificate + intermediate certificates)
- **Private key file**: The RSA private key

**Quick setup with the helper script:**

```bash
# Generate with Let's Encrypt (automatic DNS validation if Route53 is accessible)
./scripts/setup-dcv-certificate.sh --domain dcv.company.com --email admin@company.com

# Or import existing PEM files
./scripts/setup-dcv-certificate.sh --cert /path/to/fullchain.pem --key /path/to/privkey.pem

# Or import from ACM export (handles encrypted private key)
./scripts/setup-dcv-certificate.sh \
  --cert /path/to/certificate.pem \
  --chain /path/to/certificate_chain.pem \
  --key /path/to/private_key.txt \
  --passphrase 'YOUR_PASSPHRASE'
```

The script validates the cert/key pair and stores them in Secrets Manager at `/{PascalCase}/DCV/CertificateFiles`. For CodeBuild deployments, the buildspec automatically restores these files before deploying — no need to place files in `certs/` manually.

**Manual setup (if not using the helper script):**

Place these files in the `certs/` directory (already gitignored):

```bash
# Copy your certificate files
cp /path/to/your-certificate-fullchain.pem certs/dcv-certificate.pem
cp /path/to/your-private-key.pem certs/dcv-private-key.pem
```

**Certificate requirements:**
- Certificate must be in PEM format
- Private key must be in PEM format (RSA) and **unencrypted**
- Certificate should include the full chain (leaf + intermediates)
- Certificate must be valid for your custom domain (e.g., `*.portal.company.com` or `dcv.company.com`)

### Using Certificates Exported from AWS ACM

When you export a certificate from AWS Certificate Manager, you receive three separate files:
- `certificate.txt` - Your leaf certificate
- `certificate_chain.txt` - Intermediate CA certificates
- `private_key.txt` - Encrypted private key (passphrase required)

You need to process these files before they can be used with the Connection Gateway:

**Step 1: Create the fullchain certificate**

The Connection Gateway requires a single file containing the leaf certificate followed by the intermediate certificates:

```bash
# Combine leaf certificate + chain into fullchain
cat certs/certificate.txt certs/certificate_chain.txt > certs/fullchain.pem
```

**Step 2: Decrypt the private key**

ACM requires exportable certificates to have encrypted private keys. You must decrypt it:

```bash
# Decrypt the ACM-exported private key (replace YOUR_PASSPHRASE with the passphrase you used during export)
openssl rsa -in certs/private_key.txt -out certs/private_key_decrypted.pem -passin pass:'YOUR_PASSPHRASE'

# Verify the key is now unencrypted (should NOT show "ENCRYPTED")
head -1 certs/private_key_decrypted.pem
# Expected output: an unencrypted PEM header (RSA PRIVATE KEY or PRIVATE KEY)
# NOT: an ENCRYPTED PRIVATE KEY header
```

**Step 3: Verify certificate and key match**

```bash
# These two commands should output the same hash
openssl x509 -noout -modulus -in certs/fullchain.pem | md5sum
openssl rsa -noout -modulus -in certs/private_key_decrypted.pem | md5sum
```

**Step 4: Update parameters.json**

```json
{
  "ParameterKey": "DcvCertificateFile",
  "ParameterValue": "certs/fullchain.pem"
},
{
  "ParameterKey": "DcvPrivateKeyFile", 
  "ParameterValue": "certs/private_key_decrypted.pem"
}
```

**Why is decryption necessary?**
- The Connection Gateway startup script runs non-interactively and cannot prompt for a passphrase
- The script converts the key to PKCS#8 format using `openssl pkcs8 -nocrypt`, which requires an unencrypted input
- If the key is encrypted, the conversion fails silently and the Gateway service won't start

**Security note:** The decrypted private key is stored in AWS Secrets Manager during deployment, which encrypts it at rest. The `certs/` directory is gitignored to prevent accidental commits.

### Step 2: Update parameters.json

Configure the certificate file paths and domain name:

```json
[
  {
    "ParameterKey": "DcvCertificateArn",
    "ParameterValue": "arn:aws:acm:us-east-1:123456789012:certificate/abc123-...",
    "Description": "Required when using DcvDomainName: Existing ACM certificate ARN. If empty with DcvDomainName set, CDK will create a new certificate requiring DNS validation (may cause deployment to hang)."
  },
  {
    "ParameterKey": "DcvDomainName",
    "ParameterValue": "dcv.company.com",
    "Description": "Custom domain for DCV connections"
  },
  {
    "ParameterKey": "DcvCertificateFile",
    "ParameterValue": "certs/dcv-certificate.pem",
    "Description": "Path to certificate file (fullchain) for Connection Gateway TLS"
  },
  {
    "ParameterKey": "DcvPrivateKeyFile",
    "ParameterValue": "certs/dcv-private-key.pem",
    "Description": "Path to private key file for Connection Gateway TLS"
  }
]
```

**Important:** When using a custom domain (`DcvDomainName`), you should also provide `DcvCertificateArn` with an existing ACM certificate. If `DcvCertificateArn` is empty but `DcvDomainName` is set, CDK will attempt to create a new ACM certificate that requires DNS validation, which can cause the deployment to hang indefinitely waiting for validation.

### Step 3: Deploy DCV Stack

Deploy the stack to create the Secrets Manager secret and update the Connection Gateway configuration:

```bash
# Get your stack prefix from cdk.json
STACK_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '').replace(/([a-z])([A-Z])/g, '\$1-\$2').toUpperCase().substring(0,3)")
cdk deploy ${STACK_PREFIX}-Dcv-Infrastructure
```

This will:
- Read your certificate files from the `certs/` directory
- Create a Secrets Manager secret at `/{ProductName}/DCV/ConnectionGateway/TlsCertificate`
- Update the Connection Gateway user data to pull certificates on startup
- Configure the Gateway to use your custom certificate instead of self-signed

### Step 4: Refresh Connection Gateway Instances

After deployment, existing Connection Gateway instances need to be refreshed to pick up the new certificate:

**Option A: Terminate and let ASG replace (recommended):**
```bash
# Find the Connection Gateway instance
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:aws:autoscaling:groupName,Values=*ConnectionGateway*" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text)

# Terminate it (ASG will launch a new one with the certificate)
aws ec2 terminate-instances --instance-ids $INSTANCE_ID
```

**Option B: Start an instance refresh:**
```bash
ASG_NAME=$(aws autoscaling describe-auto-scaling-groups \
  --query "AutoScalingGroups[?contains(AutoScalingGroupName, 'ConnectionGateway')].AutoScalingGroupName" \
  --output text)

aws autoscaling start-instance-refresh --auto-scaling-group-name $ASG_NAME
```

### Step 5: Create DNS Record for NLB

Get the NLB DNS name:

```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")

NLB_DNS=$(aws elbv2 describe-load-balancers \
  --names "*connection-gateway*" \
  --query "LoadBalancers[0].DNSName" \
  --output text 2>/dev/null || \
  aws ssm get-parameter \
    --name "/${PARAM_PREFIX}/DCV/ConnectionGateway/Endpoint" \
    --query "Parameter.Value" \
    --output text)

echo "NLB DNS: $NLB_DNS"
```

Create a CNAME record pointing your domain to the NLB:

**Same account (Route 53):**
```bash
# Get hosted zone ID
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name "company.com" \
  --query "HostedZones[0].Id" \
  --output text | sed 's|/hostedzone/||')

# Create CNAME record
aws route53 change-resource-record-sets \
  --hosted-zone-id $HOSTED_ZONE_ID \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "dcv.company.com",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [{"Value": "'$NLB_DNS'"}]
      }
    }]
  }'
```

**Cross-account or external DNS:**
Create a CNAME record manually in your DNS provider pointing to the NLB DNS name.

**Note:** Use CNAME records for NLB endpoints. Alias records only work within the same AWS account.

### Step 6: Verify Certificate Configuration

Check that the Connection Gateway is using your certificate:

```bash
# Test TLS connection and verify certificate
echo | openssl s_client -connect dcv.company.com:8443 -servername dcv.company.com 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates

# Expected output should show your certificate details, not "self-signed"
```

### Updating Certificates

When your certificate expires or needs to be updated:

1. **Update the certificate files:**
   ```bash
   cp /path/to/new-certificate-fullchain.pem certs/dcv-certificate.pem
   cp /path/to/new-private-key.pem certs/dcv-private-key.pem
   ```

2. **Redeploy to update the secret:**
   ```bash
   # Get your stack prefix
   STACK_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '').replace(/([a-z])([A-Z])/g, '\$1-\$2').toUpperCase().substring(0,3)")
   cdk deploy ${STACK_PREFIX}-Dcv-Infrastructure
   ```

3. **Refresh Connection Gateway instances:**
   ```bash
   # Terminate existing instance to pick up new certificate
   INSTANCE_ID=$(aws ec2 describe-instances \
     --filters "Name=tag:aws:autoscaling:groupName,Values=*ConnectionGateway*" \
               "Name=instance-state-name,Values=running" \
     --query "Reservations[0].Instances[0].InstanceId" \
     --output text)
   
   aws ec2 terminate-instances --instance-ids $INSTANCE_ID
   ```

### How It Works (Technical Details)

1. **During CDK deployment:**
   - Certificate and private key files are read from the `certs/` directory
   - Content is stored in Secrets Manager as JSON: `{"certificate": "...", "privateKey": "..."}`
   - Connection Gateway IAM role is granted permission to read the secret

2. **During Connection Gateway startup:**
   - User data script checks if TLS secret is configured
   - If configured, retrieves certificate and key from Secrets Manager
   - Converts private key to PKCS#8 format (required by DCV Gateway)
   - Writes files to `/etc/dcv-connection-gateway/`
   - Configures Gateway with `cert-file` and `cert-key-file` options
   - Restarts Gateway service with custom certificate

3. **If no certificate is configured:**
   - Gateway generates and uses a self-signed certificate
   - Users will see browser security warnings

---

## Cross-Account DNS Configuration

If your Route 53 hosted zone is in a different AWS account than your VDI deployment:

### Option A: Manual Record Creation

1. Log into the AWS account containing the hosted zone
2. Navigate to Route 53 → Hosted zones → your domain
3. Create records manually:
   - For CloudFront: Create an ALIAS record (Type A) pointing to your CloudFront distribution
   - For NLB: Create a CNAME record pointing to the NLB DNS name

### Option B: Cross-Account IAM Role

1. **In the DNS account**, create an IAM role that trusts the VDI account:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "AWS": "arn:aws:iam::VDI_ACCOUNT_ID:root"
    },
    "Action": "sts:AssumeRole"
  }]
}
```

2. Attach a policy allowing Route 53 changes:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "route53:ChangeResourceRecordSets",
      "route53:ListHostedZones",
      "route53:GetHostedZone"
    ],
    "Resource": "*"
  }]
}
```

3. **From the VDI account**, assume the role and create records:

```bash
# Assume role in DNS account
CREDS=$(aws sts assume-role \
  --role-arn "arn:aws:iam::DNS_ACCOUNT_ID:role/Route53AccessRole" \
  --role-session-name "DNSUpdate")

export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r '.Credentials.AccessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | jq -r '.Credentials.SecretAccessKey')
export AWS_SESSION_TOKEN=$(echo $CREDS | jq -r '.Credentials.SessionToken')

# Now run Route 53 commands as shown above
```

---

## Verification

### Verify Web Console Custom Domain

```bash
# Test DNS resolution
dig vdi.portal.company.com

# Test HTTPS connection
curl -I https://vdi.portal.company.com

# Verify CORS is working (should not see CORS errors)
# Open browser developer tools and check Network tab when logging in
```

### Verify DCV Custom Domain

```bash
# Test DNS resolution
dig dcv.company.com

# Test TLS connection
openssl s_client -connect dcv.company.com:8443 -servername dcv.company.com

# Test from browser - connect to a workstation and verify no security warning
```

---

## Troubleshooting

### CORS Errors After Custom Domain Setup

**Symptom:** Login fails, browser console shows CORS errors

**Solution:** Ensure SSM parameter is updated:
```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")
aws ssm get-parameter --name "/${PARAM_PREFIX}/Frontend/Url"
# Should show your custom domain, not CloudFront URL
```

### CloudFront Returns 403 Forbidden

**Symptom:** Custom domain returns 403 error

**Possible causes:**
1. Alternate domain name not added to distribution
2. DNS not propagated yet (wait 5-10 minutes)
3. Certificate not valid for the domain

**Check:**
```bash
aws cloudfront get-distribution --id YOUR_DIST_ID \
  --query "Distribution.DistributionConfig.Aliases"
```

### DCV Browser Still Shows Security Warning

**Symptom:** Browser shows "Connection not secure" for DCV

**Possible causes:**
1. Certificate files not found or invalid
2. Connection Gateway instance hasn't been refreshed after deployment
3. Certificate not valid for the domain name
4. Private key format issue (must be convertible to PKCS#8)

**Diagnostic steps:**

```bash
PARAM_PREFIX=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')")

# 1. Verify the secret exists in Secrets Manager
aws secretsmanager describe-secret \
  --secret-id "/${PARAM_PREFIX}/DCV/ConnectionGateway/TlsCertificate"

# 2. Check if certificate content is valid
aws secretsmanager get-secret-value \
  --secret-id "/${PARAM_PREFIX}/DCV/ConnectionGateway/TlsCertificate" \
  --query 'SecretString' --output text | jq -r '.certificate' | head -5

# 3. Check Connection Gateway instance logs via SSM
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:aws:autoscaling:groupName,Values=*ConnectionGateway*" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text)

aws ssm send-command \
  --instance-ids $INSTANCE_ID \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["cat /var/log/dcv-connection-gwy-install.log | grep -i tls"]'

# 4. Verify the certificate being served
echo | openssl s_client -connect dcv.company.com:8443 -servername dcv.company.com 2>/dev/null | \
  openssl x509 -noout -subject -issuer

# 5. Check Gateway service status
aws ssm send-command \
  --instance-ids $INSTANCE_ID \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["systemctl status dcv-connection-gateway --no-pager"]'
```

**Solutions:**

1. **If secret doesn't exist:** Ensure `DcvCertificateFile` and `DcvPrivateKeyFile` are set in `parameters.json` and files exist in `certs/` directory, then redeploy.

2. **If instance hasn't picked up certificate:** Terminate the instance to force ASG to launch a new one with updated user data.

3. **If certificate shows as self-signed:** Check Gateway logs for errors retrieving from Secrets Manager. Verify IAM permissions.

4. **If Gateway service fails to start:** Check `/var/log/dcv-connection-gateway/gateway.log` for TLS errors. Common issue is private key format - the key is automatically converted to PKCS#8 format during startup.

### DNS Not Resolving

**Symptom:** `dig` or `nslookup` returns NXDOMAIN

**Solutions:**
1. Verify record was created in correct hosted zone
2. Check for typos in domain name
3. Wait for DNS propagation (up to 48 hours for some resolvers)
4. Try flushing local DNS cache

---

## Quick Reference

| Component | Configuration | Description |
|-----------|---------------|-------------|
| Web Console URL | SSM: `/{ProductName}/Frontend/Url` | Custom domain for CORS |
| DCV Gateway Endpoint | SSM: `/{ProductName}/DCV/ConnectionGateway/Endpoint` | Custom domain for connection URLs |
| DCV TLS Certificate | Secrets Manager: `/{ProductName}/DCV/ConnectionGateway/TlsCertificate` | Certificate and private key for Gateway TLS |
| Certificate Files | `certs/dcv-certificate.pem`, `certs/dcv-private-key.pem` | Local certificate files (gitignored) |
| CloudFront | AWS Console | Alternate domain + ACM certificate |
| NLB | TCP passthrough on port 8443 | Routes traffic to Connection Gateway |

### Parameters.json Reference

```json
{
  "DcvDomainName": "dcv.company.com",
  "DcvCertificateArn": "arn:aws:acm:us-east-1:...",
  "DcvCertificateFile": "certs/dcv-certificate.pem",
  "DcvPrivateKeyFile": "certs/dcv-private-key.pem"
}
```
<!-- pragma: allowlist secret - DcvPrivateKeyFile is a file path, not a key value -->

- `DcvDomainName`: Custom domain for DCV connections (required for custom cert)
- `DcvCertificateArn`: Existing ACM certificate ARN (required when using DcvDomainName to prevent CDK from creating a new cert)
- `DcvCertificateFile`: Path to fullchain certificate PEM file (unencrypted)
- `DcvPrivateKeyFile`: Path to private key PEM file (must be unencrypted - see [Decrypting ACM-Exported Private Keys](#decrypting-acm-exported-private-keys))
