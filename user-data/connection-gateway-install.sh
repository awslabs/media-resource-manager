#!/bin/bash
# DCV Connection Gateway Installation Script
# This script installs and configures DCV Connection Gateway
#
# Required environment variables (set by CloudFormation/CDK):
#   PRODUCT_NAME - Product name for SSM parameter paths (e.g., TegnaFleetCommand)
#   TLS_SECRET_NAME - (Optional) Secrets Manager secret name for TLS certificate
#   TLS_SECRET_REGION - (Optional) Region where TLS secret is stored (for cross-region access)
#
# The script will:
# 1. Install DCV Connection Gateway from AWS CloudFront
# 2. Configure it to connect to the Session Manager broker
# 3. Optionally configure custom TLS certificate

LOG_PATH="/var/log/dcv-connection-gateway-install.log"
echo "$(date -u) Starting DCV Connection Gateway installation..." | tee -a "$LOG_PATH"

# Get instance metadata using IMDSv2
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || echo "")
if [ -n "$TOKEN" ]; then
  INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "unknown")
  REGION=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null)
else
  INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "unknown")
  REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null)
fi

echo "$(date -u) Instance: $INSTANCE_ID, Region: $REGION" | tee -a "$LOG_PATH"

# Detect OS type and version
read -r system version <<<$(echo $(cat /etc/os-release | grep "^ID=\|^VERSION_ID=" | sort | cut -d"=" -f2 | tr -d "\"" | tr '[:upper:]' '[:lower:]'))
major_version="${version%.*}"
arch="$(arch)"
CLOUDFRONT_PREFIX="https://d1uj6qtbmh3dt5.cloudfront.net"
TMP_DIR="$(mktemp -d /tmp/dcv-install-XXXXXX)"

echo "$(date -u) Detected OS: $system $version, arch: $arch" | tee -a "$LOG_PATH"

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
        echo "$(date -u) ERROR: Unsupported OS '$system'" | tee -a "$LOG_PATH"
        exit 1
        ;;
esac

if [ -z "$package_type" ]; then
    echo "$(date -u) ERROR: Unsupported OS version '$system $version'" | tee -a "$LOG_PATH"
    exit 1
fi

echo "$(date -u) Using package type: $package_type, manager: $package_manager" | tee -a "$LOG_PATH"

# Download packages
echo "$(date -u) Downloading DCV Connection Gateway..." | tee -a "$LOG_PATH"
if [ "$package_manager" = "apt" ]; then
    curl -o "$TMP_DIR/NICE-GPG-KEY" "$CLOUDFRONT_PREFIX/NICE-GPG-KEY"
    gpg --import "$TMP_DIR/NICE-GPG-KEY"
    if [ "$arch" != "x86_64" ]; then
        deb_arch="arm64"
        curl -o "$TMP_DIR/nice-dcv-server.tgz" "$CLOUDFRONT_PREFIX/nice-dcv-ubuntu2204-aarch64.tgz"
    else
        deb_arch="amd64"
        curl -o "$TMP_DIR/nice-dcv-server.tgz" "$CLOUDFRONT_PREFIX/nice-dcv-$package_type-$arch.tgz"
    fi
    curl -o "$TMP_DIR/nice-dcv-connection-gateway.$package_extension" "$CLOUDFRONT_PREFIX/nice-dcv-connection-gateway_$deb_arch.$package_type.$package_extension"
else
    rpm --import "$CLOUDFRONT_PREFIX/NICE-GPG-KEY"
    curl -o "$TMP_DIR/nice-dcv-connection-gateway.$package_extension" "$CLOUDFRONT_PREFIX/nice-dcv-connection-gateway-$package_type.$arch.$package_extension"
    curl -o "$TMP_DIR/nice-dcv-server.tgz" "$CLOUDFRONT_PREFIX/nice-dcv-$package_type-$arch.tgz"
fi

# Install packages
echo "$(date -u) Installing DCV Connection Gateway..." | tee -a "$LOG_PATH"
tar -xvzf "$TMP_DIR/nice-dcv-server.tgz" -C "$TMP_DIR"

# Install web viewer first, then connection gateway
for package_pattern in "nice-dcv-web-viewer*" "nice-dcv-connection-gateway.$package_extension"; do
    package_full_path=$(find "$TMP_DIR" -name "$package_pattern")
    if [ -n "$package_full_path" ]; then
        $package_manager install -y "$package_full_path"
    fi
done

# Clean up temp files
rm -rf "$TMP_DIR"

# Enable web access through the gateway
CONFIG_FILE="/etc/dcv-connection-gateway/dcv-connection-gateway.conf"
sed -i 's|url = "https://localhost:8080"|local-resources-path = "/usr/share/dcv/www"|' "$CONFIG_FILE"

# Enable and start gateway initially
echo "$(date -u) Starting DCV Connection Gateway service..." | tee -a "$LOG_PATH"
systemctl enable dcv-connection-gateway
systemctl start dcv-connection-gateway

# Get broker endpoint from SSM Parameter Store
PARAM_PREFIX="/${PRODUCT_NAME:-MediaResourceManager}/DCV/SessionManager"
echo "$(date -u) Retrieving broker endpoint from SSM: $PARAM_PREFIX/Endpoint" | tee -a "$LOG_PATH"

# Wait for broker endpoint to be available (Session Manager may still be starting)
MAX_WAIT=60
WAIT_COUNT=0
BROKER_ENDPOINT=""

while [ -z "$BROKER_ENDPOINT" ] && [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    BROKER_ENDPOINT=$(aws ssm get-parameter --name "$PARAM_PREFIX/Endpoint" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "")
    if [ -z "$BROKER_ENDPOINT" ] || [ "$BROKER_ENDPOINT" = "None" ]; then
        BROKER_ENDPOINT=""
        echo "$(date -u) Waiting for broker endpoint (attempt $((WAIT_COUNT + 1))/$MAX_WAIT)..." | tee -a "$LOG_PATH"
        sleep 10
        WAIT_COUNT=$((WAIT_COUNT + 1))
    fi
done

if [ -z "$BROKER_ENDPOINT" ]; then
    echo "$(date -u) ERROR: Could not retrieve broker endpoint after $MAX_WAIT attempts" | tee -a "$LOG_PATH"
    exit 1
fi

echo "$(date -u) Broker endpoint: $BROKER_ENDPOINT" | tee -a "$LOG_PATH"

# Wait for broker to be reachable
echo "$(date -u) Waiting for broker to be reachable..." | tee -a "$LOG_PATH"
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if timeout 2 bash -c "cat < /dev/null > /dev/tcp/$BROKER_ENDPOINT/8447" 2>/dev/null; then
        echo "$(date -u) Broker is reachable" | tee -a "$LOG_PATH"
        break
    fi
    echo "$(date -u) Broker not reachable, waiting (attempt $((RETRY_COUNT + 1))/$MAX_RETRIES)..." | tee -a "$LOG_PATH"
    sleep 10
    RETRY_COUNT=$((RETRY_COUNT + 1))
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo "$(date -u) WARNING: Could not reach broker, proceeding anyway..." | tee -a "$LOG_PATH"
fi

# Configure Connection Gateway
echo "$(date -u) Configuring Connection Gateway..." | tee -a "$LOG_PATH"

# Enable health check
sed -i 's/^#\[health-check\]/[health-check]/g' "$CONFIG_FILE"
sed -i 's|#bind-addr = "::"|bind-addr = "::"|' "$CONFIG_FILE"

# Add health check port if not present
if ! grep -q "^port = 8989" "$CONFIG_FILE"; then
    sed -i '/bind-addr = "::"/a port = 8989' "$CONFIG_FILE"
fi

# Configure TLS settings
sed -i 's|#tls-strict = false|tls-strict = false|' "$CONFIG_FILE"

# Add tls-strict to resolver section if not present
if ! grep -A5 '\[resolver\]' "$CONFIG_FILE" | grep -q 'tls-strict'; then
    sed -i '/\[resolver\]/a tls-strict = false' "$CONFIG_FILE"
fi

# Configure broker URL
sed -i "s|url = \"https://localhost:8081\"|url = \"https://$BROKER_ENDPOINT:8447\"|" "$CONFIG_FILE"

# Configure QUIC on port 8444 for UDP streaming (separate from TCP 8443)
# NLB forwards TCP 8443 for HTTPS and UDP 8444 for QUIC
# IMPORTANT: quic-listen-endpoints defaults to [] (empty), which DISABLES QUIC
# We must explicitly set it to enable QUIC support
echo "$(date -u) Configuring QUIC endpoint on port 8444..." | tee -a "$LOG_PATH"

# Ensure [gateway] section exists and add QUIC configuration
if grep -q '^\[gateway\]' "$CONFIG_FILE"; then
    # Remove any existing quic-port and quic-listen-endpoints lines
    sed -i '/^quic-port\s*=/d' "$CONFIG_FILE"
    sed -i '/^quic-listen-endpoints\s*=/d' "$CONFIG_FILE"
    # Add QUIC configuration after [gateway] section
    sed -i '/^\[gateway\]/a quic-port = 8444\nquic-listen-endpoints = ["0.0.0.0:8444", "[::]:8444"]' "$CONFIG_FILE"
else
    # Add [gateway] section with QUIC configuration
    echo "" >> "$CONFIG_FILE"
    echo "[gateway]" >> "$CONFIG_FILE"
    echo 'quic-port = 8444' >> "$CONFIG_FILE"
    echo 'quic-listen-endpoints = ["0.0.0.0:8444", "[::]:8444"]' >> "$CONFIG_FILE"
fi

echo "$(date -u) QUIC enabled on port 8444 with endpoints 0.0.0.0:8444 and [::]:8444" | tee -a "$LOG_PATH"

# Configure custom TLS certificate if secret name is provided
if [ -n "$TLS_SECRET_NAME" ]; then
    echo "$(date -u) Configuring custom TLS certificate from Secrets Manager..." | tee -a "$LOG_PATH"
    
    # Use TLS_SECRET_REGION if set (for cross-region access), otherwise use current region
    SECRET_REGION="${TLS_SECRET_REGION:-$REGION}"
    echo "$(date -u) Retrieving TLS secret from region: $SECRET_REGION" | tee -a "$LOG_PATH"
    
    # Install jq for JSON parsing if not present
    $package_manager install -y jq 2>/dev/null || true
    
    # Retrieve certificate from Secrets Manager
    SECRET_VALUE=$(aws secretsmanager get-secret-value --secret-id "$TLS_SECRET_NAME" --region "$SECRET_REGION" --query 'SecretString' --output text 2>/dev/null || echo "")
    
    if [ -n "$SECRET_VALUE" ]; then
        # Extract certificate and private key from JSON
        CERT_CONTENT=$(echo "$SECRET_VALUE" | jq -r '.certificate // empty')
        KEY_CONTENT=$(echo "$SECRET_VALUE" | jq -r '.privateKey // empty')
        
        if [ -n "$CERT_CONTENT" ] && [ "$CERT_CONTENT" != "null" ] && [ -n "$KEY_CONTENT" ] && [ "$KEY_CONTENT" != "null" ]; then
            # Write certificate to file
            echo "$CERT_CONTENT" > /etc/dcv-connection-gateway/dcv-certificate.pem
            
            # Write key to temp file and convert to PKCS#8 format (required by DCV Gateway)
            echo "$KEY_CONTENT" > /tmp/dcv-private-key-temp.pem
            openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in /tmp/dcv-private-key-temp.pem -out /etc/dcv-connection-gateway/dcv-private-key.pem
            rm -f /tmp/dcv-private-key-temp.pem
            
            # Set proper permissions (dcvcgw is the user that runs the Gateway service)
            chown dcvcgw:dcvcgw /etc/dcv-connection-gateway/dcv-certificate.pem /etc/dcv-connection-gateway/dcv-private-key.pem
            chmod 644 /etc/dcv-connection-gateway/dcv-certificate.pem
            chmod 600 /etc/dcv-connection-gateway/dcv-private-key.pem
            
            # Configure Connection Gateway to use custom certificate
            echo "$(date -u) Configuring Connection Gateway to use custom TLS certificate..." | tee -a "$LOG_PATH"
            
            # Add cert-file and cert-key-file to [gateway] section
            if grep -q '\[gateway\]' "$CONFIG_FILE"; then
                sed -i '/\[gateway\]/a cert-file = "/etc/dcv-connection-gateway/dcv-certificate.pem"' "$CONFIG_FILE"
                sed -i '/\[gateway\]/a cert-key-file = "/etc/dcv-connection-gateway/dcv-private-key.pem"' "$CONFIG_FILE"
            else
                echo "[gateway]" >> "$CONFIG_FILE"
                echo 'cert-file = "/etc/dcv-connection-gateway/dcv-certificate.pem"' >> "$CONFIG_FILE"
                echo 'cert-key-file = "/etc/dcv-connection-gateway/dcv-private-key.pem"' >> "$CONFIG_FILE"
            fi
            
            echo "$(date -u) Custom TLS certificate configured successfully" | tee -a "$LOG_PATH"
        else
            echo "$(date -u) WARNING: Could not parse certificate/key from secret, using self-signed" | tee -a "$LOG_PATH"
        fi
    else
        echo "$(date -u) WARNING: Could not retrieve TLS secret, using self-signed certificate" | tee -a "$LOG_PATH"
    fi
fi

# Restart Connection Gateway with new configuration
echo "$(date -u) Restarting Connection Gateway service..." | tee -a "$LOG_PATH"
systemctl restart dcv-connection-gateway

if systemctl is-active --quiet dcv-connection-gateway; then
    echo "$(date -u) SUCCESS: DCV Connection Gateway installed and configured" | tee -a "$LOG_PATH"
else
    echo "$(date -u) ERROR: Connection Gateway failed to start" | tee -a "$LOG_PATH"
    exit 1
fi
