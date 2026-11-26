#!/bin/bash
# DCV Session Manager Installation Script
# This script installs and configures DCV Session Manager broker
# 
# Required environment variables (set by CloudFormation/CDK):
#   PRODUCT_NAME - Product name for SSM parameter paths (e.g., MediaResourceManager)
#   DYNAMODB_TABLE_PREFIX - Prefix for DynamoDB tables (e.g., dcv-session-manager-)
#
# The script will:
# 1. Install DCV Session Manager from AWS CloudFront
# 2. Configure DynamoDB persistence
# 3. Register an API client
# 4. Store credentials in SSM Parameter Store
#
# Restarts: user data runs once per instance, so the script first copies
# itself (with the exports above it) to cloud-init's per-boot folder. If the
# instance restarts before setup ends, the copy runs setup again on the next
# boot. Every step can run twice. The registered API client is kept in a
# root-only file until its parameters are stored, so a rerun reuses it. At the
# end the script enables the broker, writes a done marker and removes the copy
# and the client file, so later boots do nothing.
#
# A failure logs an ERROR line, stops the broker and exits non-zero without the
# marker. The next boot retries, and the ASG's ELB health checks replace an
# instance that never becomes healthy.

LOG_PATH="${LOG_PATH:-/var/log/dcv-session-manager-install.log}"
LOG_GROUP="/aws/ec2/${ACRONYM:-mrm}-dcv-session-manager"
STATE_DIR="${MRM_SM_STATE_DIR:-/var/lib/mrm}"
DONE_MARKER="$STATE_DIR/session-manager-setup.done"
CLIENT_FILE="$STATE_DIR/sm-client.env"
PER_BOOT_DIR="${MRM_PER_BOOT_DIR:-/var/lib/cloud/scripts/per-boot}"
PER_BOOT_COPY="$PER_BOOT_DIR/mrm-session-manager-setup.sh"
LOCK_FILE="${MRM_SM_LOCK_FILE:-/run/mrm-sm-setup.lock}"
CONFIG_FILE="${CONFIG_FILE:-/etc/dcv-session-manager-broker/session-manager-broker.properties}"
SERVICE="dcv-session-manager-broker"

# One run at a time, and nothing to do once setup has finished.
if command -v flock >/dev/null 2>&1 && exec 9>"$LOCK_FILE"; then
  flock -n 9 || { echo "$(date -u) Session Manager setup is already running" | tee -a "$LOG_PATH"; exit 0; }
fi
if [ -f "$DONE_MARKER" ]; then
  rm -f "$PER_BOOT_COPY" "$CLIENT_FILE"
  exit 0
fi

# Run again on every boot until setup finishes.
SELF="$(readlink -f "$0")"
mkdir -p "$PER_BOOT_DIR"
if ! [ "$SELF" -ef "$PER_BOOT_COPY" ]; then
  install -m 0700 "$SELF" "$PER_BOOT_COPY" \
    || echo "$(date -u) WARNING: Could not copy setup to $PER_BOOT_COPY; a restart won't resume it" | tee -a "$LOG_PATH"
fi
install -d -m 0700 "$STATE_DIR"

INSTANCE_ID="unknown"

# Logging function - writes to both local file and CloudWatch
log_message() {
  echo "$(date -u) $1" | tee -a "$LOG_PATH"
  if [ "$INSTANCE_ID" != "unknown" ]; then
    aws logs put-log-events --log-group-name "$LOG_GROUP" --log-stream-name "$INSTANCE_ID" \
      --log-events "timestamp=$(date +%s000),message=$1" --region "$REGION" 2>/dev/null || true
  fi
}

# Stop the broker so the instance fails its target group health checks.
fail() {
  log_message "ERROR: $*"
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  exit 1
}

# download URL FILE: fails on an HTTP error, a timeout or an empty file.
download() {
  curl -fsS --connect-timeout 10 --max-time 600 --retry 5 --retry-delay 5 --retry-connrefused -o "$2" "$1" \
    || fail "Download failed: $1. Check that the instance has outbound HTTPS access (NAT gateway or proxy)."
  [ -s "$2" ] || fail "Download is missing or empty: $1"
}

# Get instance metadata using IMDSv2
IMDS_CURL=(curl -fsS --connect-timeout 2 --retry 3)
TOKEN=$("${IMDS_CURL[@]}" -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || echo "")
if [ -n "$TOKEN" ]; then
  INSTANCE_ID=$("${IMDS_CURL[@]}" -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "unknown")
  REGION=$("${IMDS_CURL[@]}" -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null)
else
  INSTANCE_ID=$("${IMDS_CURL[@]}" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "unknown")
  REGION=$("${IMDS_CURL[@]}" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null)
fi
[ -n "$INSTANCE_ID" ] || INSTANCE_ID="unknown"
[ -n "$REGION" ] || { INSTANCE_ID="unknown"; fail "Could not read the Region from instance metadata"; }

# Setup CloudWatch logging for better debugging
if [ "$INSTANCE_ID" != "unknown" ]; then
  aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$REGION" 2>/dev/null || true
  aws logs create-log-stream --log-group-name "$LOG_GROUP" --log-stream-name "$INSTANCE_ID" --region "$REGION" 2>/dev/null || true
fi

log_message "Starting DCV Session Manager installation..."
log_message "Instance: $INSTANCE_ID, Region: $REGION"

# Detect OS type and version
read -r system version <<<$(echo $(cat "${OS_RELEASE_FILE:-/etc/os-release}" | grep "^ID=\|^VERSION_ID=" | sort | cut -d"=" -f2 | tr -d "\"" | tr '[:upper:]' '[:lower:]'))
major_version="${version%.*}"
CLOUDFRONT_PREFIX="https://d1uj6qtbmh3dt5.cloudfront.net"
TMP_DIR="$(mktemp -d -t dcv-install-XXXXXX)" || fail "Could not create a temporary directory"

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
        fail "Unsupported OS '$system'"
        ;;
esac

[ -n "$package_type" ] || fail "Unsupported OS version '$system $version'"

log_message "Using package type: $package_type, manager: $package_manager"

# Download and install DCV Session Manager
log_message "Downloading DCV Session Manager..."
download "$CLOUDFRONT_PREFIX/NICE-GPG-KEY" "$TMP_DIR/NICE-GPG-KEY"
if [ "$package_manager" = "apt" ]; then
    gpg --import "$TMP_DIR/NICE-GPG-KEY" || fail "Could not import the NICE GPG key"
    package_url="$CLOUDFRONT_PREFIX/nice-dcv-session-manager-broker_all.$package_type.$package_extension"
else
    rpm --import "$TMP_DIR/NICE-GPG-KEY" || fail "Could not import the NICE GPG key"
    package_url="$CLOUDFRONT_PREFIX/nice-dcv-session-manager-broker-$package_type.noarch.$package_extension"
fi
package_file="$TMP_DIR/nice-dcv-session-manager-broker.$package_extension"
download "$package_url" "$package_file"

log_message "Installing DCV Session Manager..."
$package_manager install -y "$package_file" || fail "Package install failed: $package_file"

# Clean up temp files
rm -rf "$TMP_DIR"

systemctl cat "$SERVICE.service" >/dev/null 2>&1 || fail "$SERVICE.service is not installed"

# Start the service once before configuring it. It is enabled only when
# setup has finished, so a restart before then leaves it stopped.
log_message "Starting DCV Session Manager service..."
systemctl start "$SERVICE"

# Wait for service to be running
log_message "Waiting for DCV Session Manager to start..."
for i in {1..30}; do
    if systemctl is-active --quiet "$SERVICE"; then
        log_message "DCV Session Manager is running (attempt $i)"
        break
    fi
    echo "Attempt $i: waiting 10 seconds..."
    sleep 10
done

# Stop service to configure it
log_message "Stopping service for configuration..."
systemctl stop "$SERVICE"

# Configure DCV Session Manager. Each edit matches only the unedited line,
# so a second run changes nothing.
[ -f "$CONFIG_FILE" ] || fail "Broker config file is missing: $CONFIG_FILE"
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
systemctl start "$SERVICE"

# Wait for broker to be fully ready (responding on port 8443)
log_message "Waiting for broker to be fully initialized..."
BROKER_READY=false
for i in {1..60}; do
    if systemctl is-active --quiet "$SERVICE"; then
        if curl -sk --connect-timeout 2 https://localhost:8443/ >/dev/null 2>&1; then
            log_message "Broker is fully ready (attempt $i)"
            BROKER_READY=true
            break
        fi
    fi
    echo "Attempt $i/60: Broker not ready yet, waiting 5 seconds..."
    sleep 5
done

[ "$BROKER_READY" = "true" ] || fail "Broker did not answer on port 8443 within 5 minutes"

client_valid() {
  [ -n "$CLIENT_NAME" ] && [ ${#CLIENT_ID} -gt 10 ] && [ ${#CLIENT_PASSWORD} -gt 10 ]
}

# Reuse the API client registered before a restart, if there is one.
SUCCESS=false
if [ -f "$CLIENT_FILE" ]; then
    { read -r CLIENT_NAME; read -r CLIENT_ID; read -r CLIENT_PASSWORD; } < "$CLIENT_FILE"
    if client_valid; then
        log_message "Reusing API client $CLIENT_NAME registered before the restart"
        DCV_EXIT_CODE=0
        SUCCESS=true
    else
        rm -f "$CLIENT_FILE"
    fi
fi

# Register API client with retry logic
MAX_RETRIES=3
RETRY_COUNT=0
[ "$SUCCESS" = "true" ] || log_message "Registering DCV API client..."

while [ $RETRY_COUNT -lt $MAX_RETRIES ] && [ "$SUCCESS" = "false" ]; do
    log_message "Registration attempt $((RETRY_COUNT + 1)) of $MAX_RETRIES"
    CLIENT_NAME="client-$(hostname)-$(date +%s)-retry${RETRY_COUNT}"
    
    DCV_OUTPUT=$(sudo -u root dcv-session-manager-broker register-api-client --client-name "$CLIENT_NAME" 2>&1)
    DCV_EXIT_CODE=$?
    
    log_message "DCV exit code: $DCV_EXIT_CODE"
    
    if [ $DCV_EXIT_CODE -eq 0 ]; then
        CLIENT_ID=$(echo "$DCV_OUTPUT" | grep -E "^\s*client-id:" | sed 's/.*client-id:\s*//' | tr -d ' \n\r')
        CLIENT_PASSWORD=$(echo "$DCV_OUTPUT" | grep -E "^\s*client-password:" | sed 's/.*client-password:\s*//' | tr -d ' \n\r')
        
        if client_valid; then
            log_message "Successfully parsed credentials"
            SUCCESS=true
            # Root-only copy until the parameters are stored (removed at the end).
            if ! (umask 077 && printf '%s\n' "$CLIENT_NAME" "$CLIENT_ID" "$CLIENT_PASSWORD" > "$CLIENT_FILE"); then
                rm -f "$CLIENT_FILE"
                log_message "WARNING: Could not save the API client; a restart before the end registers a new one"
            fi
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

# Use PRODUCT_NAME env var if set, otherwise default
PARAM_PREFIX="/${PRODUCT_NAME:-MediaResourceManager}/DCV/SessionManager"

if [ "$SUCCESS" = "false" ]; then
    aws ssm put-parameter --name "$PARAM_PREFIX/ClientExitCode" --value "1" --type "String" --overwrite --region "$REGION" || true
    fail "Failed to register API client after $MAX_RETRIES attempts"
fi

# Store credentials in SSM Parameter Store
log_message "Storing credentials in SSM Parameter Store..."
aws ssm put-parameter --name "$PARAM_PREFIX/ClientName" --value "$CLIENT_NAME" --type "String" --overwrite --region "$REGION" || fail "Failed to store ClientName"
aws ssm put-parameter --name "$PARAM_PREFIX/ClientId" --value "$CLIENT_ID" --type "String" --overwrite --region "$REGION" || fail "Failed to store ClientId"
aws ssm put-parameter --name "$PARAM_PREFIX/ClientPassword" --value "$CLIENT_PASSWORD" --type "SecureString" --overwrite --region "$REGION" || fail "Failed to store ClientPassword"
aws ssm put-parameter --name "$PARAM_PREFIX/ClientExitCode" --value "$DCV_EXIT_CODE" --type "String" --overwrite --region "$REGION" || fail "Failed to store ClientExitCode"
# Note: Endpoint parameter is set by CloudFormation/CDK with the NLB DNS name (not instance private DNS)

# Setup has finished: start the broker on later boots, and stop rerunning.
systemctl enable "$SERVICE" || fail "Could not enable $SERVICE.service"
touch "$DONE_MARKER" || fail "Could not write $DONE_MARKER"
rm -f "$CLIENT_FILE" "$PER_BOOT_COPY"

log_message "SUCCESS: DCV Session Manager installed and configured"
