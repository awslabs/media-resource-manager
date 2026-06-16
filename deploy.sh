#!/bin/bash

# Media Resource Manager CDK Deployment Script

set -e

# Parse command line arguments
AUTO_APPROVE=false
while getopts "yh" opt; do
    case $opt in
        y)
            AUTO_APPROVE=true
            ;;
        h)
            echo "Usage: ./deploy.sh [-y] [-h]"
            echo "  -y    Auto-approve deployment (skip confirmation prompt)"
            echo "  -h    Show this help message"
            exit 0
            ;;
        \?)
            echo "Invalid option: -$OPTARG" >&2
            exit 1
            ;;
    esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}$1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_status "🚀 Starting Media Resource Manager deployment"

# Validate deployment readiness
if [[ ! -f "package.json" ]]; then
    print_error "package.json not found. Are you in the correct directory?"
    exit 1
fi

# Check CDK CLI version compatibility with aws-cdk-lib
CDK_LIB_VERSION=$(node -p "require('./package.json').dependencies['aws-cdk-lib'] || ''" 2>/dev/null | sed 's/[\^~]//')
CDK_CLI_VERSION=$(cdk --version 2>/dev/null | awk '{print $1}')
if [[ -n "$CDK_LIB_VERSION" && -n "$CDK_CLI_VERSION" ]]; then
    CDK_LIB_MAJOR_MINOR=$(echo "$CDK_LIB_VERSION" | cut -d. -f1-2)
    CDK_CLI_MAJOR_MINOR=$(echo "$CDK_CLI_VERSION" | cut -d. -f1-2)
    CDK_LIB_MINOR=$(echo "$CDK_LIB_VERSION" | cut -d. -f2)
    CDK_CLI_MINOR=$(echo "$CDK_CLI_VERSION" | cut -d. -f2)
    if [[ "$CDK_CLI_MINOR" -lt "$CDK_LIB_MINOR" ]]; then
        print_error "CDK CLI version ($CDK_CLI_VERSION) is older than aws-cdk-lib ($CDK_LIB_VERSION)."
        print_error "This can cause silent deployment failures (assets not uploaded, schema mismatch)."
        echo ""
        echo "  Fix: sudo npm install -g aws-cdk@latest"
        echo ""
        exit 1
    fi
fi

# Check for required config files and copy from examples if missing
if [[ ! -f "cdk.json" ]]; then
    if [[ -f "cdk.example.json" ]]; then
        print_warning "cdk.json not found. Copying from cdk.example.json..."
        cp cdk.example.json cdk.json
        print_success "Created cdk.json from template"
        print_warning "Review cdk.json and update 'productName' if desired before continuing."
    else
        print_error "cdk.json not found and no cdk.example.json template available!"
        exit 1
    fi
fi

if [[ ! -f "parameters.json" ]]; then
    if [[ -f "parameters.example.json" ]]; then
        print_warning "parameters.json not found. Copying from parameters.example.json..."
        cp parameters.example.json parameters.json
        print_success "Created parameters.json from template"
        print_warning "Review parameters.json and update values for your environment before continuing."
        echo ""
        read -p "Press Enter to continue after reviewing config files, or Ctrl+C to abort..." 
    else
        print_error "parameters.json not found and no parameters.example.json template available!"
        exit 1
    fi
fi

# Analyze VPC if importing an existing one (handles multiple subnets per AZ)
VPC_ID=$(node -p "JSON.parse(require('fs').readFileSync('parameters.json')).find(p => p.ParameterKey === 'VpcId')?.ParameterValue || ''" 2>/dev/null)
if [[ -n "$VPC_ID" ]]; then
    print_status "🔍 Analyzing imported VPC for subnet configuration..."
    
    # Check if subnet IDs are already configured
    PRIVATE_SUBNET_IDS=$(node -p "JSON.parse(require('fs').readFileSync('parameters.json')).find(p => p.ParameterKey === 'PrivateSubnetIds')?.ParameterValue || ''" 2>/dev/null)
    PRIVATE_ROUTE_TABLE_IDS=$(node -p "JSON.parse(require('fs').readFileSync('parameters.json')).find(p => p.ParameterKey === 'PrivateRouteTableIds')?.ParameterValue || ''" 2>/dev/null)
    
    if [[ -z "$PRIVATE_SUBNET_IDS" ]] || [[ -n "$PRIVATE_SUBNET_IDS" && -z "$PRIVATE_ROUTE_TABLE_IDS" ]]; then
        # Run VPC analyzer — it writes subnet IDs to parameters.json for all VPC types
        if [[ -f "scripts/analyze-vpc.sh" ]]; then
            chmod +x scripts/analyze-vpc.sh
            ./scripts/analyze-vpc.sh
            ANALYZER_RESULT=$?
            
            if [[ $ANALYZER_RESULT -ne 0 ]]; then
                print_error "VPC analysis failed. For VPCs with multiple subnets per AZ, pre-configure PrivateSubnetIds and PublicSubnetIds in parameters.json."
                exit 1
            fi
            
            # Verify subnets were written
            PRIVATE_SUBNET_IDS=$(node -p "JSON.parse(require('fs').readFileSync('parameters.json')).find(p => p.ParameterKey === 'PrivateSubnetIds')?.ParameterValue || ''" 2>/dev/null)
            if [[ -n "$PRIVATE_SUBNET_IDS" ]]; then
                print_success "VPC subnet configuration complete"
            else
                print_warning "VPC analyzer did not write subnet IDs — CDK will use VPC lookup"
            fi
        fi
    else
        print_success "VPC subnet configuration already present in parameters.json"
    fi
fi

# Check Lambda concurrent executions quota and request increase if needed
print_status "🔍 Checking Lambda concurrent executions quota..."
LAMBDA_QUOTA_CODE="L-B99A9384"
DESIRED_QUOTA=2000

# Get current quota value
CURRENT_QUOTA=$(aws service-quotas get-service-quota \
    --service-code lambda \
    --quota-code "$LAMBDA_QUOTA_CODE" \
    --query 'Quota.Value' \
    --output text 2>/dev/null || echo "0")

if [[ "$CURRENT_QUOTA" == "None" ]] || [[ -z "$CURRENT_QUOTA" ]]; then
    CURRENT_QUOTA=0
fi

# Convert to integer for comparison
CURRENT_QUOTA_INT=${CURRENT_QUOTA%.*}

if [[ "$CURRENT_QUOTA_INT" -ge "$DESIRED_QUOTA" ]]; then
    print_success "Lambda concurrent executions quota is sufficient ($CURRENT_QUOTA_INT >= $DESIRED_QUOTA)"
else
    print_warning "Lambda concurrent executions quota is $CURRENT_QUOTA_INT (recommended: $DESIRED_QUOTA)"
    
    # Check for pending quota increase requests
    PENDING_REQUEST=$(aws service-quotas list-requested-service-quota-change-history-by-quota \
        --service-code lambda \
        --quota-code "$LAMBDA_QUOTA_CODE" \
        --query 'RequestedQuotas[?Status==`PENDING`].Id' \
        --output text 2>/dev/null || echo "")
    
    if [[ -n "$PENDING_REQUEST" ]]; then
        print_warning "A quota increase request is already pending (Request ID: $PENDING_REQUEST)"
        print_warning "Check status: aws service-quotas get-requested-service-quota-change --request-id $PENDING_REQUEST"
    else
        print_status "Submitting quota increase request to $DESIRED_QUOTA..."
        REQUEST_RESULT=$(aws service-quotas request-service-quota-increase \
            --service-code lambda \
            --quota-code "$LAMBDA_QUOTA_CODE" \
            --desired-value "$DESIRED_QUOTA" 2>&1) || true
        
        if echo "$REQUEST_RESULT" | grep -q "RequestedQuota"; then
            REQUEST_ID=$(echo "$REQUEST_RESULT" | grep -o '"Id": "[^"]*"' | cut -d'"' -f4)
            print_success "Quota increase request submitted (Request ID: $REQUEST_ID)"
            print_warning "Note: Quota increases may take time to be approved. Deployment will continue."
            print_warning "Check status: aws service-quotas get-requested-service-quota-change --request-id $REQUEST_ID"
        elif echo "$REQUEST_RESULT" | grep -q "QUOTA_EXCEEDED\|already exists"; then
            print_warning "A quota increase request already exists or quota is at maximum"
        else
            print_warning "Could not submit quota increase request: $REQUEST_RESULT"
            print_warning "You may need to request a quota increase manually via the AWS Console"
        fi
    fi
fi

# Install CDK dependencies first
print_status "📦 Installing CDK dependencies..."
if ! npm install; then
    print_error "CDK dependency installation failed!"
    exit 1
fi
print_success "CDK dependencies installed successfully"

# Install Lambda layer dependencies
print_status "📦 Installing Lambda layer dependencies..."
if [[ -d "layers/ldap/nodejs" ]]; then
    cd layers/ldap/nodejs
    npm install
    cd ../../..
    print_success "LDAP layer dependencies installed"
fi

# Install Lambda function dependencies (auto-detect all Lambdas with package.json)
print_status "📦 Installing Lambda function dependencies..."
for pkg in lambda/*/package.json; do
    if [[ -f "$pkg" ]]; then
        lambda_dir=$(dirname "$pkg")
        lambda_name=$(basename "$lambda_dir")
        print_status "  Installing dependencies for $lambda_name..."
        cd "$lambda_dir"
        npm install --omit=dev
        cd - > /dev/null
        print_success "  $lambda_name dependencies installed"
    fi
done

# Install frontend dependencies and build (needed for cdk diff)
print_status "📦 Installing frontend dependencies..."
cd frontend

if ! npm install 2>/dev/null; then
    print_warning "npm install failed, cleaning node_modules and retrying..."
    rm -rf node_modules package-lock.json
    if ! npm install; then
        print_error "Frontend dependency installation failed!"
        exit 1
    fi
fi
print_success "Frontend dependencies installed successfully"

print_status "🔨 Building frontend..."
if ! npm run build; then
    print_error "Frontend build failed!"
    exit 1
fi
cd ..
print_success "Frontend built successfully"

# Show what will change before deploying
print_status "🔍 Checking for changes..."
if ! cdk diff --all 2>/dev/null; then
    print_warning "Could not generate diff (normal on first deploy with imported VPC)"
fi

echo ""
if [[ "$AUTO_APPROVE" == "true" ]]; then
    print_status "Auto-approve enabled, proceeding with deployment..."
else
    read -p "Do you want to proceed with deployment? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_warning "Deployment cancelled by user"
        exit 0
    fi
fi

# Build CDK
print_status "🔨 Building CDK application..."
if ! npm run build; then
    print_error "CDK build failed!"
    exit 1
fi
print_success "CDK application built successfully"

# Check CDK bootstrap status
print_status "🔍 Checking CDK bootstrap status..."
CURRENT_REGION=$(aws configure get region 2>/dev/null || echo "${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}")
if aws ssm get-parameter --name "/cdk-bootstrap/hnb659fds/version" --region "$CURRENT_REGION" >/dev/null 2>&1; then
    print_success "CDK environment already bootstrapped"
elif aws cloudformation describe-stacks --stack-name CDKToolkit --region "$CURRENT_REGION" >/dev/null 2>&1; then
    print_success "CDK environment already bootstrapped (legacy bootstrap detected)"
else
    print_warning "CDK environment not bootstrapped. Bootstrapping now..."
    if ! cdk bootstrap; then
        print_error "CDK bootstrap failed!"
        exit 1
    fi
    print_success "CDK bootstrap completed successfully"
fi

# Ensure us-east-1 is also bootstrapped (required for WAF CloudFront stack)
if [ "$CURRENT_REGION" != "us-east-1" ]; then
    if aws ssm get-parameter --name "/cdk-bootstrap/hnb659fds/version" --region "us-east-1" >/dev/null 2>&1; then
        print_success "CDK environment bootstrapped in us-east-1 (required for WAF)"
    elif aws cloudformation describe-stacks --stack-name CDKToolkit --region "us-east-1" >/dev/null 2>&1; then
        print_success "CDK environment bootstrapped in us-east-1 (legacy)"
    else
        print_warning "Bootstrapping CDK in us-east-1 (required for WAF CloudFront stack)..."
        if ! cdk bootstrap aws://${CDK_DEFAULT_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}/us-east-1; then
            print_warning "CDK bootstrap in us-east-1 failed — WAF stack may not deploy"
        else
            print_success "CDK bootstrap in us-east-1 completed"
        fi
    fi
fi

# Deploy all stacks
print_status "🏗️  Deploying all infrastructure stacks..."
CDK_OUTPUT=$(mktemp)
if cdk deploy --all --require-approval never 2>&1 | tee "$CDK_OUTPUT"; then
    print_success "All stacks deployed successfully"
else
    print_error "Failed to deploy stacks"
    print_warning "Check the error messages above for details"
    rm -f "$CDK_OUTPUT"
    exit 1
fi

print_success "🎉 All stacks deployed successfully!"

# Only run CORS updater if the API stack had changes (new routes need CORS headers)
# When the API stack has no changes, CDK prints "(no changes)" and CORS is already correct.
# EventBridge handles CORS updates when the Frontend URL SSM parameter changes.
API_STACK_NAME="${ACRONYM}-Api"
if grep -qF "${API_STACK_NAME}" "$CDK_OUTPUT" && ! grep -qF "${API_STACK_NAME} (no changes)" "$CDK_OUTPUT"; then
    print_status "🔄 API stack changed - updating CORS configuration..."
    if ./scripts/update-cors.sh; then
        print_success "CORS configuration updated"
    else
        print_warning "CORS update failed - you may need to run ./scripts/update-cors.sh manually"
    fi
else
    print_success "🔄 API stack unchanged - skipping CORS update (EventBridge handles URL changes)"
fi
rm -f "$CDK_OUTPUT"

# Get important outputs
print_status "📋 Retrieving deployment information..."

# Get product name from cdk.json and convert to PascalCase (remove spaces)
PRODUCT_NAME=$(node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')" 2>/dev/null || echo "MediaResourceManager")

# Get display name with spaces for frontend config
PRODUCT_DISPLAY_NAME=$(node -p "require('./cdk.json').context.productName" 2>/dev/null || echo "Media Resource Manager")

# Generate acronym from product name (e.g., "Media Resource Manager" -> "MRM")
ACRONYM=$(node -p "require('./cdk.json').context.productName.split(' ').map(word => word.charAt(0).toUpperCase()).join('')" 2>/dev/null || echo "MRM")

# Get CloudFront URL
CLOUDFRONT_URL=$(aws cloudformation describe-stacks --stack-name ${ACRONYM}-Frontend --query 'Stacks[0].Outputs[?OutputKey==`WebsiteUrl`].OutputValue' --output text 2>/dev/null || echo "Not available")

# Get API Gateway URL
API_URL=$(aws cloudformation describe-stacks --stack-name ${ACRONYM}-WorkstationMain --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text 2>/dev/null || echo "Not available")

# Generate config-dev.json for local development
print_status "📝 Generating development configuration..."

cat > frontend/public/config-dev.json << EOF
{
  "apiUrl": "$API_URL",
  "productName": "$PRODUCT_DISPLAY_NAME"
}
EOF

# Update .env.local for Vite development server
if [[ "$API_URL" != "Not available" ]]; then
    print_status "🔧 Updating Vite development configuration..."
    echo "VITE_API_URL=$API_URL" > frontend/.env.local
    print_success "Vite configuration updated with API URL: $API_URL"
fi

if [[ -f "frontend/public/config-dev.json" ]]; then
    print_success "Development configuration generated at frontend/public/config-dev.json"
else
    print_warning "Failed to generate development configuration"
fi

# Update vite.config.ts with current API URL for development proxy
if [[ "$API_URL" != "Not available" ]]; then
    API_URL_CLEAN=${API_URL%/}  # Remove trailing slash
    sed -i "s|target: 'https://[^']*'|target: '$API_URL_CLEAN'|g" frontend/vite.config.ts
    print_success "Updated vite.config.ts with API URL: $API_URL_CLEAN"
fi

echo ""
print_success "✅ Deployment complete!"

# Populate software library (free/open-source definitions only)
echo ""
echo "📦 Populating software library..."
TABLE_NAME=$(aws ssm get-parameter --name "/${PRODUCT_NAME}/SoftwareLibrary/TableName" --query 'Parameter.Value' --output text 2>/dev/null || echo "")
BUCKET_NAME=$(aws ssm get-parameter --name "/${PRODUCT_NAME}/SoftwareLibrary/UploadsBucket" --query 'Parameter.Value' --output text 2>/dev/null || echo "")
if [ -n "$TABLE_NAME" ] && [ "$TABLE_NAME" != "None" ]; then
    node scripts/populate-software-library.js \
        --table-name "$TABLE_NAME" \
        --bucket-name "$BUCKET_NAME" \
        || echo "Software library population completed with warnings (non-blocking)"
else
    echo "Software library table not found in SSM — skipping (first deploy?)"
fi
echo ""
echo "🌐 Application URL: $CLOUDFRONT_URL"
echo "🔗 API URL: $API_URL"
echo ""
print_warning "📋 Access Instructions:"
echo "👤 Username: ResourceAdmin"
echo "🔑 Get Password: aws secretsmanager get-secret-value --secret-id \"/${PRODUCT_NAME}/Identity/ResourceAdminActiveDirectoryLoginCredentials\" --query 'SecretString' --output text | grep -o '\"password\":\"[^\"]*\"' | cut -d'\"' -f4"
echo ""
print_warning "📋 Required post-deployment steps:"
echo "1. Run the command above to get the ResourceAdmin password"
echo "2. Login to the application URL using ResourceAdmin credentials"
echo "3. Update AMI IDs in frontend/src/pages/WorkstationManagement.tsx with your region-specific DCV AMIs"
echo "4. Test DCV connectivity and workstation creation"
echo "5. Run './scripts/update-dev-config.sh' to refresh development configuration if needed"
echo ""
print_success "🚀 Your Media Resource Manager system is ready!"
