#!/bin/bash
# DCV Session Manager Installation Script
# This script installs and configures DCV Session Manager broker
# 
# Required environment variables (set by CloudFormation/CDK):
#   PRODUCT_NAME - Product name for SSM parameter paths (e.g., TegnaFleetCommand)
#   DYNAMODB_TABLE_PREFIX - Prefix for DynamoDB tables (e.g., dcv-session-manager-)
#
# The script will:
# 1. Install DCV Session Manager from AWS CloudFront
# 2. Configure DynamoDB persistence
# 3. Register an API client
# 4. Store credentials in SSM Parameter Store

LOG_PATH="/var/log/dcv-session-manager-install.log"
LOG_GROUP="/aws/ec2/${ACRONYM:-mrm}-dcv-session-manager"

# Get instance metadata using IMDSv2
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || echo "")
if [ -n "$TOKEN" ]; then
  INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "unknown")
  REGION=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null)
else
  INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "unknown")
  REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null)
fi

# Setup CloudWatch logging for better debugging
if [ "$INSTANCE_ID" != "unknown" ]; then
  aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$REGION" 2>/dev/null || true
  aws logs create-log-stream --log-group-name "$LOG_GROUP" --log-stream-name "$INSTANCE_ID" --region "$REGION" 2>/dev/null || true
fi

# Logging function - writes to both local file and CloudWatch
log_message() {
  echo "$(date -u) $1" | tee -a "$LOG_PATH"
  if [ "$INSTANCE_ID" != "unknown" ]; then
    aws logs put-log-events --log-group-name "$LOG_GROUP" --log-stream-name "$INSTANCE_ID" \
      --log-events "timestamp=$(date +%s000),message=$1" --region "$REGION" 2>/dev/null || true
  fi
}

log_message "Starting DCV Session Manager installation..."
log_message "Instance: $INSTANCE_ID, Region: $REGION"

# Detect OS type and version
read -r system version <<<$(echo $(cat /etc/os-release | grep "^ID=\|^VERSION_ID=" | sort | cut -d"=" -f2 | tr -d "\"" | tr '[:upper:]' '[:lower:]'))
major_version="${version%.*}"
CLOUDFRONT_PREFIX="https://d1uj6qtbmh3dt5.cloudfront.net"
TMP_DIR="$(mktemp -d /tmp/dcv-install-XXXXXX)"

log_message "Detected OS: $system $version (major: $major_version)"

# Determine package type based on OS
case $system in
    amzn)
        if [ "$major_version" = "2" ]; then
            package_type="el7"
            package_manager="yum"
        else
            # Amazon Linux 2023
            package_type="el9"
            package_manager="dnf"
        fi
        package_extension="rpm"
        ;;
    centos|rhel)
        if [[ "$major_version" =~ ^(7|8|9) ]]; then
            package_type="el$major_version"
            if [[ "$major_version" =~ ^(8|9) ]]; then
                package_manager="dnf"
            else
                package_manager="yum"
            fi
            package_extension="rpm"
        fi
        ;;
    ubuntu)
        if [ "$major_version" = "22" ] || [ "$major_version" = "20" ]; then
            package_type="ubuntu$(echo $version | tr -d '.')"
            package_manager="apt"
            package_extension="deb"
        fi
        ;;
    *)
        log_message "ERROR: Unsupported OS '$system'"
        exit 1
        ;;
esac

if [ -z "$package_type" ]; then
    log_message "ERROR: Unsupported OS version '$system $version'"
    exit 1
fi

log_message "Using package type: $package_type, manager: $package_manager"

# Download and install DCV Session Manager
log_message "Downloading DCV Session Manager..."
if [ "$package_manager" = "apt" ]; then
    curl -o "$TMP_DIR/NICE-GPG-KEY" "$CLOUDFRONT_PREFIX/NICE-GPG-KEY"
    gpg --import "$TMP_DIR/NICE-GPG-KEY"
    curl -o "$TMP_DIR/nice-dcv-session-manager-broker.$package_extension" "$CLOUDFRONT_PREFIX/nice-dcv-session-manager-broker_all.$package_type.$package_extension"
else
    rpm --import "$CLOUDFRONT_PREFIX/NICE-GPG-KEY"
    curl -o "$TMP_DIR/nice-dcv-session-manager-broker.$package_extension" "$CLOUDFRONT_PREFIX/nice-dcv-session-manager-broker-$package_type.noarch.$package_extension"
fi

log_message "Installing DCV Session Manager..."
$package_manager install -y "$TMP_DIR/nice-dcv-session-manager-broker.$package_extension"

# Clean up temp files
rm -rf "$TMP_DIR"

# Enable and start the service initially
log_message "Starting DCV Session Manager service..."
systemctl enable dcv-session-manager-broker
systemctl start dcv-session-manager-broker

# Wait for service to be running
log_message "Waiting for DCV Session Manager to start..."
for i in {1..30}; do
    if systemctl is-active --quiet dcv-session-manager-broker; then
        log_message "DCV Session Manager is running (attempt $i)"
        break
    fi
    echo "Attempt $i: waiting 10 seconds..."
    sleep 10
done

# Stop service to configure it
log_message "Stopping service for configuration..."
systemctl stop dcv-session-manager-broker

# Configure DCV Session Manager
CONFIG_FILE="/etc/dcv-session-manager-broker/session-manager-broker.properties"
log_message "Configuring DCV Session Manager..."

# Enable gateway
sed -i '/^enable-gateway/s/=.*$/= true/' "$CONFIG_FILE"

# Uncomment gateway connector settings
sed -i '/gateway-to-broker-connector-https-port/s/^#\s*//g' "$CONFIG_FILE"
sed -i '/gateway-to-broker-connector-bind-host/s/^#\s*//g' "$CONFIG_FILE"

# Enable DynamoDB persistence
sed -i 's/^enable-persistence = false/enable-persistence = true/' "$CONFIG_FILE"
sed -i 's/^# persistence-db = dynamodb/persistence-db = dynamodb/' "$CONFIG_FILE"
sed -i "s/^# dynamodb-region = us-east-1/dynamodb-region = $REGION/" "$CONFIG_FILE"
sed -i 's/^# dynamodb-table-rcu = 10/dynamodb-table-rcu = 5/' "$CONFIG_FILE"
sed -i 's/^# dynamodb-table-wcu = 10/dynamodb-table-wcu = 5/' "$CONFIG_FILE"

# Set DynamoDB table prefix (use env var if set, otherwise default)
TABLE_PREFIX="${DYNAMODB_TABLE_PREFIX:-dcv-session-manager-}"
sed -i "s/^# dynamodb-table-name-prefix = DcvSm-/dynamodb-table-name-prefix = $TABLE_PREFIX/" "$CONFIG_FILE"

# Start service with new configuration
log_message "Starting DCV Session Manager with new configuration..."
systemctl start dcv-session-manager-broker

# Wait for broker to be fully ready (responding on port 8443)
log_message "Waiting for broker to be fully initialized..."
BROKER_READY=false
for i in {1..60}; do
    if systemctl is-active --quiet dcv-session-manager-broker; then
        if curl -sk --connect-timeout 2 https://localhost:8443/ >/dev/null 2>&1; then
            log_message "Broker is fully ready (attempt $i)"
            BROKER_READY=true
            break
        fi
    fi
    echo "Attempt $i/60: Broker not ready yet, waiting 5 seconds..."
    sleep 5
done

if [ "$BROKER_READY" = "false" ]; then
    log_message "WARNING: Broker may not be fully ready after 5 minutes"
fi

# Register API client with retry logic
log_message "Registering DCV API client..."
MAX_RETRIES=3
RETRY_COUNT=0
SUCCESS=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ] && [ "$SUCCESS" = "false" ]; do
    log_message "Registration attempt $((RETRY_COUNT + 1)) of $MAX_RETRIES"
    CLIENT_NAME="client-$(hostname)-$(date +%s)-retry${RETRY_COUNT}"
    
    DCV_OUTPUT=$(sudo -u root dcv-session-manager-broker register-api-client --client-name "$CLIENT_NAME" 2>&1)
    DCV_EXIT_CODE=$?
    
    log_message "DCV exit code: $DCV_EXIT_CODE"
    
    if [ $DCV_EXIT_CODE -eq 0 ]; then
        CLIENT_ID=$(echo "$DCV_OUTPUT" | grep -E "^\s*client-id:" | sed 's/.*client-id:\s*//' | tr -d ' \n\r')
        CLIENT_PASSWORD=$(echo "$DCV_OUTPUT" | grep -E "^\s*client-password:" | sed 's/.*client-password:\s*//' | tr -d ' \n\r')
        
        if [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_PASSWORD" ] && [ ${#CLIENT_ID} -gt 10 ] && [ ${#CLIENT_PASSWORD} -gt 10 ]; then
            log_message "Successfully parsed credentials"
            SUCCESS=true
        else
            log_message "ERROR: Failed to parse credentials from output"
        fi
    else
        log_message "ERROR: register-api-client failed"
    fi
    
    if [ "$SUCCESS" = "false" ]; then
        RETRY_COUNT=$((RETRY_COUNT + 1))
        if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
            log_message "Retrying in 10 seconds..."
            sleep 10
        fi
    fi
done

# Store credentials in SSM Parameter Store
if [ "$SUCCESS" = "true" ]; then
    log_message "Storing credentials in SSM Parameter Store..."
    
    # Use PRODUCT_NAME env var if set, otherwise default
    PARAM_PREFIX="/${PRODUCT_NAME:-MediaResourceManager}/DCV/SessionManager"
    
    aws ssm put-parameter --name "$PARAM_PREFIX/ClientName" --value "$CLIENT_NAME" --type "String" --overwrite --region "$REGION" || { log_message "Failed to store ClientName"; exit 1; }
    aws ssm put-parameter --name "$PARAM_PREFIX/ClientId" --value "$CLIENT_ID" --type "String" --overwrite --region "$REGION" || { log_message "Failed to store ClientId"; exit 1; }
    aws ssm put-parameter --name "$PARAM_PREFIX/ClientPassword" --value "$CLIENT_PASSWORD" --type "SecureString" --overwrite --region "$REGION" || { log_message "Failed to store ClientPassword"; exit 1; }
    aws ssm put-parameter --name "$PARAM_PREFIX/ClientExitCode" --value "$DCV_EXIT_CODE" --type "String" --overwrite --region "$REGION" || { log_message "Failed to store ClientExitCode"; exit 1; }
    # Note: Endpoint parameter is set by CloudFormation/CDK with the NLB DNS name (not instance private DNS)
    
    log_message "SUCCESS: DCV Session Manager installed and configured"
else
    log_message "FATAL: Failed to register API client after $MAX_RETRIES attempts"
    aws ssm put-parameter --name "/${PRODUCT_NAME:-MediaResourceManager}/DCV/SessionManager/ClientExitCode" --value "1" --type "String" --overwrite --region "$REGION" || true
    exit 1
fi
