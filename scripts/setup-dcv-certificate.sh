#!/bin/bash
# DCV Certificate Setup Script
# Generates or imports a TLS certificate for the DCV Connection Gateway
# and stores it in AWS Secrets Manager for CodeBuild deployments.
#
# Usage:
#   Generate with Let's Encrypt:
#     ./scripts/setup-dcv-certificate.sh --domain dcv.company.com --email admin@company.com
#
#   Import existing certificate files:
#     ./scripts/setup-dcv-certificate.sh --cert /path/to/fullchain.pem --key /path/to/privkey.pem
#
#   Import from ACM export (encrypted private key):
#     ./scripts/setup-dcv-certificate.sh \
#       --cert /path/to/certificate.pem \
#       --chain /path/to/certificate_chain.pem \
#       --key /path/to/private_key.txt \
#       --passphrase 'YOUR_PASSPHRASE'

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Defaults
PRODUCT_NAME=""
DOMAIN=""
EMAIL=""
CERT_FILE=""
KEY_FILE=""
CHAIN_FILE=""
PASSPHRASE=""
REGION=""

usage() {
    echo "Usage:"
    echo ""
    echo "  Generate with Let's Encrypt:"
    echo "    $0 --domain dcv.company.com --email admin@company.com"
    echo ""
    echo "  Import existing certificate files:"
    echo "    $0 --cert fullchain.pem --key privkey.pem"
    echo ""
    echo "  Import from ACM export (encrypted key):"
    echo "    $0 --cert certificate.pem --chain certificate_chain.pem --key private_key.txt --passphrase 'PASS'"
    echo ""
    echo "Options:"
    echo "  --domain        Domain name for Let's Encrypt certificate"
    echo "  --email         Email for Let's Encrypt registration"
    echo "  --cert          Path to certificate PEM file (or leaf cert if --chain is provided)"
    echo "  --key           Path to private key PEM file"
    echo "  --chain         Path to certificate chain PEM file (combined with --cert into fullchain)"
    echo "  --passphrase    Passphrase to decrypt an encrypted private key (e.g., ACM export)"
    echo "  --product-name  Product name (default: reads from cdk.json or 'Media Resource Manager')"
    echo "  --region        AWS region (default: current region)"
    exit 1
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --domain) DOMAIN="$2"; shift 2 ;;
        --email) EMAIL="$2"; shift 2 ;;
        --cert) CERT_FILE="$2"; shift 2 ;;
        --key) KEY_FILE="$2"; shift 2 ;;
        --chain) CHAIN_FILE="$2"; shift 2 ;;
        --passphrase) PASSPHRASE="$2"; shift 2 ;;
        --product-name) PRODUCT_NAME="$2"; shift 2 ;;
        --region) REGION="$2"; shift 2 ;;
        --help|-h) usage ;;
        *) echo -e "${RED}Unknown option: $1${NC}"; usage ;;
    esac
done

# Determine product name
if [ -z "$PRODUCT_NAME" ]; then
    if [ -f cdk.json ]; then
        PRODUCT_NAME=$(node -p "require('./cdk.json').context.productName" 2>/dev/null || echo "")
    fi
    if [ -z "$PRODUCT_NAME" ]; then
        PRODUCT_NAME="Media Resource Manager"
    fi
fi

PASCAL_CASE=$(echo "$PRODUCT_NAME" | sed 's/ //g; s/[^a-zA-Z0-9]//g')
SECRET_NAME="/${PASCAL_CASE}/DCV/CertificateFiles"

echo -e "${GREEN}Product: ${PRODUCT_NAME} (${PASCAL_CASE})${NC}"
echo -e "${GREEN}Secret:  ${SECRET_NAME}${NC}"
echo ""

# Determine region
if [ -z "$REGION" ]; then
    REGION=$(aws configure get region 2>/dev/null || echo "")
    if [ -z "$REGION" ]; then
        REGION="us-east-1"
    fi
fi

TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# ============================================================
# Mode 1: Generate with Let's Encrypt
# ============================================================
if [ -n "$DOMAIN" ]; then
    if [ -z "$EMAIL" ]; then
        echo -e "${RED}Error: --email is required for Let's Encrypt${NC}"
        usage
    fi

    echo -e "${YELLOW}Generating Let's Encrypt certificate for ${DOMAIN}...${NC}"
    echo ""
    echo "This will use DNS validation. You'll need to create a TXT record"
    echo "in your DNS provider when prompted."
    echo ""

    # Check if certbot is installed
    if ! command -v certbot &> /dev/null; then
        echo "Installing certbot..."
        pip3 install certbot 2>/dev/null || pip install certbot 2>/dev/null
    fi

    # Check if we have Route53 access for automatic DNS validation
    if pip3 list 2>/dev/null | grep -q certbot-dns-route53 || pip list 2>/dev/null | grep -q certbot-dns-route53; then
        HAS_ROUTE53_PLUGIN=true
    else
        HAS_ROUTE53_PLUGIN=false
        # Try to install it
        pip3 install certbot-dns-route53 2>/dev/null && HAS_ROUTE53_PLUGIN=true || true
    fi

    CERTBOT_ARGS="certonly --non-interactive --agree-tos --email $EMAIL -d $DOMAIN"
    CERTBOT_ARGS="$CERTBOT_ARGS --config-dir $TEMP_DIR/certbot --work-dir $TEMP_DIR/work --logs-dir $TEMP_DIR/logs"

    if [ "$HAS_ROUTE53_PLUGIN" = true ]; then
        echo -e "${GREEN}Using Route53 DNS plugin for automatic validation${NC}"
        certbot $CERTBOT_ARGS --dns-route53
    else
        echo -e "${YELLOW}Using manual DNS validation (you'll need to create a TXT record)${NC}"
        certbot $CERTBOT_ARGS --preferred-challenges dns --manual
    fi

    CERT_CONTENT=$(cat "$TEMP_DIR/certbot/live/$DOMAIN/fullchain.pem")
    KEY_CONTENT=$(cat "$TEMP_DIR/certbot/live/$DOMAIN/privkey.pem")

    echo -e "${GREEN}Certificate generated successfully${NC}"

# ============================================================
# Mode 2: Import existing certificate files
# ============================================================
elif [ -n "$CERT_FILE" ] && [ -n "$KEY_FILE" ]; then
    # Validate files exist
    if [ ! -f "$CERT_FILE" ]; then
        echo -e "${RED}Error: Certificate file not found: ${CERT_FILE}${NC}"
        exit 1
    fi
    if [ ! -f "$KEY_FILE" ]; then
        echo -e "${RED}Error: Private key file not found: ${KEY_FILE}${NC}"
        exit 1
    fi

    # Build fullchain if separate chain file provided
    if [ -n "$CHAIN_FILE" ]; then
        if [ ! -f "$CHAIN_FILE" ]; then
            echo -e "${RED}Error: Chain file not found: ${CHAIN_FILE}${NC}"
            exit 1
        fi
        echo "Combining certificate + chain into fullchain..."
        CERT_CONTENT=$(cat "$CERT_FILE" "$CHAIN_FILE")
    else
        CERT_CONTENT=$(cat "$CERT_FILE")
    fi

    # Handle encrypted private key
    if head -1 "$KEY_FILE" | grep -q "ENCRYPTED"; then
        if [ -z "$PASSPHRASE" ]; then
            echo -e "${YELLOW}Private key is encrypted. Provide passphrase with --passphrase${NC}"
            read -s -p "Enter passphrase: " PASSPHRASE
            echo ""
        fi
        echo "Decrypting private key..."
        KEY_CONTENT=$(openssl rsa -in "$KEY_FILE" -passin "pass:$PASSPHRASE" 2>/dev/null) || {
            # Try PKCS#8 format
            KEY_CONTENT=$(openssl pkcs8 -in "$KEY_FILE" -passin "pass:$PASSPHRASE" 2>/dev/null) || {
                echo -e "${RED}Error: Failed to decrypt private key. Check passphrase.${NC}"
                exit 1
            }
        }
    else
        KEY_CONTENT=$(cat "$KEY_FILE")
    fi

    echo -e "${GREEN}Certificate files loaded${NC}"
else
    echo -e "${RED}Error: Provide either --domain (Let's Encrypt) or --cert and --key (import)${NC}"
    echo ""
    usage
fi

# Verify cert and key match
CERT_MOD=$(echo "$CERT_CONTENT" | openssl x509 -noout -modulus 2>/dev/null | md5sum | awk '{print $1}')
KEY_MOD=$(echo "$KEY_CONTENT" | openssl rsa -noout -modulus 2>/dev/null | md5sum | awk '{print $1}')

if [ "$CERT_MOD" != "$KEY_MOD" ]; then
    echo -e "${RED}Error: Certificate and private key do not match${NC}"
    echo "  Cert modulus hash: $CERT_MOD"
    echo "  Key modulus hash:  $KEY_MOD"
    exit 1
fi

# Show certificate details
echo ""
echo "Certificate details:"
echo "$CERT_CONTENT" | openssl x509 -noout -subject -issuer -dates 2>/dev/null | sed 's/^/  /'
echo ""

# Build JSON payload
SECRET_VALUE=$(jq -n \
    --arg cert "$CERT_CONTENT" \
    --arg key "$KEY_CONTENT" \
    '{certificate: $cert, privateKey: $key}')

# Store in Secrets Manager
echo -e "${YELLOW}Storing certificate in Secrets Manager at: ${SECRET_NAME}${NC}"

# Check if secret already exists
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" &>/dev/null; then
    aws secretsmanager update-secret \
        --secret-id "$SECRET_NAME" \
        --secret-string "$SECRET_VALUE" \
        --region "$REGION"
    echo -e "${GREEN}Updated existing secret${NC}"
else
    aws secretsmanager create-secret \
        --name "$SECRET_NAME" \
        --secret-string "$SECRET_VALUE" \
        --region "$REGION" \
        --description "DCV Connection Gateway TLS certificate and private key"
    echo -e "${GREEN}Created new secret${NC}"
fi

echo ""
echo -e "${GREEN}Done! Certificate stored in Secrets Manager.${NC}"
echo ""
echo "Next steps:"
echo "  1. Set DcvDomainName and DcvCertificateArn in your deployment config"
echo "  2. Trigger a CodeBuild build (or run deploy.sh for local deployments)"
echo "  3. The buildspec will automatically restore cert files from Secrets Manager"
echo ""
echo "  Example (CodeBuild one-liner):"
echo "    aws codebuild start-build --project-name <project-name> \\"
echo "      --environment-variables-override \\"
echo "        'name=MRM_PARAM_OVERRIDES,value={\"DcvDomainName\":\"${DOMAIN:-dcv.company.com}\",\"DcvCertificateArn\":\"arn:aws:acm:...\"},type=PLAINTEXT'"
