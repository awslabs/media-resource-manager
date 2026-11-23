# Media Resource Manager CDK Deployment Script (Windows PowerShell)
# Usage: .\deploy.ps1 [-y] [-h]

param(
    [Alias("y")]
    [switch]$AutoApprove,
    [Alias("h")]
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# Show help
if ($Help) {
    Write-Host "Usage: .\deploy.ps1 [-y] [-h]"
    Write-Host "  -y    Auto-approve deployment (skip confirmation prompt)"
    Write-Host "  -h    Show this help message"
    exit 0
}

# Helper functions
function Write-Status($msg) { Write-Host $msg -ForegroundColor Blue }
function Write-Ok($msg) { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "  $msg" -ForegroundColor Red }

Write-Status "Starting Media Resource Manager deployment"

# Validate deployment readiness
if (-not (Test-Path "package.json")) {
    Write-Err "package.json not found. Are you in the correct directory?"
    exit 1
}

# Check CDK CLI version compatibility with aws-cdk-lib
$cdkLibVersion = (node -p "require('./package.json').dependencies['aws-cdk-lib'] || ''" 2>$null) -replace '[\^~]', ''
$cdkCliVersion = ((npx cdk --version 2>$null) -split ' ')[0]
if ($cdkLibVersion -and $cdkCliVersion) {
    $cdkLibMinor = [int]($cdkLibVersion -split '\.')[1]
    $cdkCliMinor = [int]($cdkCliVersion -split '\.')[1]
    if ($cdkCliMinor -lt $cdkLibMinor) {
        Write-Err "CDK CLI version ($cdkCliVersion) is older than aws-cdk-lib ($cdkLibVersion)."
        Write-Err "This can cause silent deployment failures (assets not uploaded, schema mismatch)."
        Write-Host ""
        Write-Host "  Fix: npm install -g aws-cdk@latest"
        Write-Host ""
        exit 1
    }
}

# Check for required config files and copy from examples if missing
if (-not (Test-Path "cdk.json")) {
    if (Test-Path "cdk.example.json") {
        Write-Warn "cdk.json not found. Copying from cdk.example.json..."
        Copy-Item "cdk.example.json" "cdk.json"
        Write-Ok "Created cdk.json from template"
        Write-Warn "Review cdk.json and update 'productName' if desired before continuing."
    } else {
        Write-Err "cdk.json not found and no cdk.example.json template available!"
        exit 1
    }
}

if (-not (Test-Path "parameters.json")) {
    if (Test-Path "parameters.example.json") {
        Write-Warn "parameters.json not found. Copying from parameters.example.json..."
        Copy-Item "parameters.example.json" "parameters.json"
        Write-Ok "Created parameters.json from template"
        Write-Warn "Review parameters.json and update values for your environment before continuing."
        Write-Host ""
        Read-Host "Press Enter to continue after reviewing config files, or Ctrl+C to abort"
    } else {
        Write-Err "parameters.json not found and no parameters.example.json template available!"
        exit 1
    }
}

# Analyze VPC if importing an existing one
$vpcId = node -p "JSON.parse(require('fs').readFileSync('parameters.json')).find(p => p.ParameterKey === 'VpcId')?.ParameterValue || ''" 2>$null
if ($vpcId) {
    Write-Status "Analyzing imported VPC for subnet configuration..."
    $privateSubnetIds = node -p "JSON.parse(require('fs').readFileSync('parameters.json')).find(p => p.ParameterKey === 'PrivateSubnetIds')?.ParameterValue || ''" 2>$null
    $privateRouteTableIds = node -p "JSON.parse(require('fs').readFileSync('parameters.json')).find(p => p.ParameterKey === 'PrivateRouteTableIds')?.ParameterValue || ''" 2>$null

    if (-not $privateSubnetIds -or ($privateSubnetIds -and -not $privateRouteTableIds)) {
        if (Test-Path "scripts/analyze-vpc.ps1") {
            & "scripts/analyze-vpc.ps1"
            $privateSubnetIds = node -p "JSON.parse(require('fs').readFileSync('parameters.json')).find(p => p.ParameterKey === 'PrivateSubnetIds')?.ParameterValue || ''" 2>$null
            if ($privateSubnetIds) {
                Write-Ok "VPC subnet configuration complete"
            } else {
                Write-Warn "VPC analyzer did not write subnet IDs - CDK will use VPC lookup"
            }
        }
    } else {
        Write-Ok "VPC subnet configuration already present in parameters.json"
    }
}

# Check Lambda concurrent executions quota
Write-Status "Checking Lambda concurrent executions quota..."
$desiredQuota = 2000
try {
    $currentQuota = [int](aws service-quotas get-service-quota --service-code lambda --quota-code "L-B99A9384" --query 'Quota.Value' --output text 2>$null)
    if ($currentQuota -ge $desiredQuota) {
        Write-Ok "Lambda concurrent executions quota is sufficient ($currentQuota >= $desiredQuota)"
    } else {
        Write-Warn "Lambda concurrent executions quota is $currentQuota (recommended: $desiredQuota)"
        Write-Warn "Consider requesting a quota increase via the AWS Console"
    }
} catch {
    Write-Warn "Could not check Lambda quota (non-blocking)"
}

# Install CDK dependencies
Write-Status "Installing CDK dependencies..."
npm install
if ($LASTEXITCODE -ne 0) { Write-Err "CDK dependency installation failed!"; exit 1 }
Write-Ok "CDK dependencies installed successfully"

# Install Lambda layer dependencies
Write-Status "Installing Lambda layer dependencies..."
if (Test-Path "layers/ldap/nodejs") {
    Push-Location "layers/ldap/nodejs"
    npm install
    Pop-Location
    Write-Ok "LDAP layer dependencies installed"
}

# Install Lambda function dependencies
Write-Status "Installing Lambda function dependencies..."
Get-ChildItem "lambda/*/package.json" -ErrorAction SilentlyContinue | ForEach-Object {
    $lambdaDir = $_.DirectoryName
    $lambdaName = Split-Path $lambdaDir -Leaf
    Write-Status "  Installing dependencies for $lambdaName..."
    Push-Location $lambdaDir
    npm install --omit=dev
    Pop-Location
    if ($LASTEXITCODE -eq 0) { Write-Ok "  $lambdaName dependencies installed" }
}

# Install frontend dependencies and build
Write-Status "Installing frontend dependencies..."
Push-Location "frontend"
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Warn "npm install failed, cleaning node_modules and retrying..."
    Remove-Item -Recurse -Force "node_modules", "package-lock.json" -ErrorAction SilentlyContinue
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Err "Frontend dependency installation failed!"; Pop-Location; exit 1 }
}
Write-Ok "Frontend dependencies installed successfully"

# The Amazon DCV Web Client SDK for browser sessions is fetched and verified by
# a bash script (it needs curl, gpg and unzip), e.g. from Git Bash or WSL.
Write-Status "Fetching the Amazon DCV Web Client SDK (browser sessions)..."
if (-not (Get-Command bash -ErrorAction SilentlyContinue)) {
    Write-Err "bash is required to run scripts/fetch-dcv-web-sdk.sh (install Git for Windows or WSL, or deploy with the CodeBuild pipeline)"
    Pop-Location; exit 1
}
bash ../scripts/fetch-dcv-web-sdk.sh
if ($LASTEXITCODE -ne 0) { Write-Err "Could not fetch and verify the Amazon DCV Web Client SDK!"; Pop-Location; exit 1 }

Write-Status "Building frontend..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Err "Frontend build failed!"; Pop-Location; exit 1 }
Pop-Location
Write-Ok "Frontend built successfully"

# Show changes
Write-Status "Checking for changes..."
npx cdk diff --all 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Could not generate diff (normal on first deploy with imported VPC)"
}

# Confirm deployment
Write-Host ""
if (-not $AutoApprove) {
    $reply = Read-Host "Do you want to proceed with deployment? (y/N)"
    if ($reply -notmatch '^[Yy]$') {
        Write-Warn "Deployment cancelled by user"
        exit 0
    }
}

# Build CDK
Write-Status "Building CDK application..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Err "CDK build failed!"; exit 1 }
Write-Ok "CDK application built successfully"

# Check CDK bootstrap status
Write-Status "Checking CDK bootstrap status..."
$currentRegion = aws configure get region 2>$null
if (-not $currentRegion) { $currentRegion = if ($env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION } else { "us-east-1" } }

$bootstrapped = $false
try { aws ssm get-parameter --name "/cdk-bootstrap/hnb659fds/version" --region $currentRegion 2>$null | Out-Null; $bootstrapped = $true } catch {}
if (-not $bootstrapped) {
    try { aws cloudformation describe-stacks --stack-name CDKToolkit --region $currentRegion 2>$null | Out-Null; $bootstrapped = $true } catch {}
}

if ($bootstrapped) {
    Write-Ok "CDK environment already bootstrapped"
} else {
    Write-Warn "CDK environment not bootstrapped. Bootstrapping now..."
    npx cdk bootstrap
    if ($LASTEXITCODE -ne 0) { Write-Err "CDK bootstrap failed!"; exit 1 }
    Write-Ok "CDK bootstrap completed successfully"
}

# Ensure us-east-1 is also bootstrapped (required for WAF CloudFront stack)
if ($currentRegion -ne "us-east-1") {
    $usEast1Bootstrapped = $false
    try { aws ssm get-parameter --name "/cdk-bootstrap/hnb659fds/version" --region "us-east-1" 2>$null | Out-Null; $usEast1Bootstrapped = $true } catch {}
    if (-not $usEast1Bootstrapped) {
        try { aws cloudformation describe-stacks --stack-name CDKToolkit --region "us-east-1" 2>$null | Out-Null; $usEast1Bootstrapped = $true } catch {}
    }

    if ($usEast1Bootstrapped) {
        Write-Ok "CDK environment bootstrapped in us-east-1 (required for WAF)"
    } else {
        Write-Warn "Bootstrapping CDK in us-east-1 (required for WAF CloudFront stack)..."
        $accountId = aws sts get-caller-identity --query Account --output text
        npx cdk bootstrap "aws://$accountId/us-east-1"
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "CDK bootstrap in us-east-1 failed - WAF stack may not deploy"
        } else {
            Write-Ok "CDK bootstrap in us-east-1 completed"
        }
    }
}

# Deploy all stacks
Write-Status "Deploying all infrastructure stacks..."
npx cdk deploy --all --require-approval never
if ($LASTEXITCODE -ne 0) {
    Write-Err "Failed to deploy stacks"
    Write-Warn "Check the error messages above for details"
    exit 1
}

Write-Ok "All stacks deployed successfully!"

# Get important outputs
Write-Status "Retrieving deployment information..."

$productName = node -p "require('./cdk.json').context.productName.replace(/\s+/g, '')" 2>$null
if (-not $productName) { $productName = "MediaResourceManager" }

$productDisplayName = node -p "require('./cdk.json').context.productName" 2>$null
if (-not $productDisplayName) { $productDisplayName = "Media Resource Manager" }

$acronym = node -p "require('./cdk.json').context.productName.split(' ').map(word => word.charAt(0).toUpperCase()).join('')" 2>$null
if (-not $acronym) { $acronym = "MRM" }

$cloudfrontUrl = aws cloudformation describe-stacks --stack-name "$acronym-Frontend" --query 'Stacks[0].Outputs[?OutputKey==`WebsiteUrl`].OutputValue' --output text 2>$null
if (-not $cloudfrontUrl) { $cloudfrontUrl = "Not available" }

$apiUrl = aws cloudformation describe-stacks --stack-name "$acronym-WorkstationMain" --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text 2>$null
if (-not $apiUrl) { $apiUrl = "Not available" }

# Generate config-dev.json for local development
Write-Status "Generating development configuration..."
@"
{
  "apiUrl": "$apiUrl",
  "productName": "$productDisplayName"
}
"@ | Set-Content "frontend/public/config-dev.json" -Encoding UTF8

if (Test-Path "frontend/public/config-dev.json") {
    Write-Ok "Development configuration generated at frontend/public/config-dev.json"
}

# Populate software library
Write-Host ""
Write-Host "Populating software library..."
$tableName = aws ssm get-parameter --name "/$productName/SoftwareLibrary/TableName" --query 'Parameter.Value' --output text 2>$null
$bucketName = aws ssm get-parameter --name "/$productName/SoftwareLibrary/UploadsBucket" --query 'Parameter.Value' --output text 2>$null
if ($tableName -and $tableName -ne "None") {
    node scripts/populate-software-library.js --table-name $tableName --bucket-name $bucketName
} else {
    Write-Host "Software library table not found in SSM - skipping (first deploy?)"
}

Write-Host ""
Write-Host "Application URL: $cloudfrontUrl" -ForegroundColor Cyan
Write-Host "API URL: $apiUrl" -ForegroundColor Cyan
Write-Host ""
Write-Warn "Access Instructions:"
Write-Host "  Username: ResourceAdmin"
Write-Host "  Get Password: aws secretsmanager get-secret-value --secret-id `"/$productName/Identity/ResourceAdminActiveDirectoryLoginCredentials`" --query 'SecretString' --output text"
Write-Host ""
Write-Warn "Required post-deployment steps:"
Write-Host "  1. Run the command above to get the ResourceAdmin password"
Write-Host "  2. Login to the application URL using ResourceAdmin credentials"
Write-Host "  3. Update AMI IDs in frontend/src/pages/WorkstationManagement.tsx with your region-specific DCV AMIs"
Write-Host "  4. Test DCV connectivity and workstation creation"
Write-Host "  5. Run '.\scripts\update-dev-config.sh' (in WSL/Git Bash) to refresh development configuration if needed"
Write-Host ""
Write-Ok "Your Media Resource Manager system is ready!"
