#!/bin/bash

# Script to systematically delete CloudFormation stacks in dependency order
# Dynamically discovers stacks with the product prefix and deletes them in reverse dependency order
# Usage: ./delete-stacks.sh [ACRONYM]
#   If ACRONYM is provided, it overrides the one derived from cdk.json

REGION="${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null)}"
if [ -z "$REGION" ]; then
    echo "Error: Could not determine AWS region. Set AWS_DEFAULT_REGION or configure 'aws configure'."
    exit 1
fi
echo "Using region: $REGION"

# Check if acronym was provided as argument
if [ -n "$1" ]; then
    ACRONYM="$1"
    echo "Using provided acronym: $ACRONYM"
else
    # Get product name from cdk.json and generate acronym
    PRODUCT_NAME=$(jq -r '.context.productName // "Media Resource Manager"' cdk.json)
    ACRONYM=$(echo "$PRODUCT_NAME" | sed 's/[^A-Za-z ]//g' | awk '{for(i=1;i<=NF;i++) printf toupper(substr($i,1,1))}')
    echo "Product Name: $PRODUCT_NAME"
    echo "Generated Acronym: $ACRONYM"
fi

# Define the deletion order (reverse of deployment order)
# Stacks are deleted in this order to respect dependencies
# Any stacks not in this list will be deleted after these (catches dynamic stacks like Storage-*)
DELETION_ORDER=(
    "Events"
    "EventBridge"
    "Frontend"
    "Waf"
    "Api"
    "Storage"
    "Regional-Hub"
    "DataSync"
    "WorkstationMain"
    "Workstation-Start"
    "WorkstationStart"
    "Image-MacOS"
    "Workstation-MacOS"
    "Workstation-Linux"
    "LinuxWorkstationCreation"
    "Workstation-Windows"
    "WorkstationCreation"
    "Dcv-StatusSync"
    "DcvStatusSync"
    "Dcv-Cleanup"
    "DcvCleanup"
    "Dcv-Infrastructure"
    "Dcv"
    "AgentCore"
    "Observability"
    "Infrastructure"
    "Infra"
)

# Discover all stacks with our prefix
echo "$(date): Discovering stacks with prefix '$ACRONYM-'..."
DISCOVERED_STACKS=$(aws cloudformation list-stacks --region "$REGION" \
    --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE ROLLBACK_COMPLETE \
    --query "StackSummaries[?starts_with(StackName, \`$ACRONYM-\`)].StackName" \
    --output text)

if [ -z "$DISCOVERED_STACKS" ]; then
    echo "$(date): No stacks found with prefix '$ACRONYM-'"
    exit 0
fi

echo "$(date): Found stacks:"
echo "$DISCOVERED_STACKS" | tr '\t' '\n' | sed 's/^/  - /'
echo ""

# Also discover WAF and CDK cross-region support stacks in us-east-1
# (WAF for CloudFront must be in us-east-1 regardless of deployment region)
US_EAST_STACKS=""
if [ "$REGION" != "us-east-1" ]; then
    echo "$(date): Checking us-east-1 for WAF and cross-region support stacks..."
    US_EAST_STACKS=$(aws cloudformation list-stacks --region "us-east-1" \
        --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE ROLLBACK_COMPLETE \
        --query "StackSummaries[?starts_with(StackName, \`$ACRONYM-\`)].StackName" \
        --output text 2>/dev/null || echo "")
    if [ -n "$US_EAST_STACKS" ]; then
        echo "$(date): Found cross-region stacks in us-east-1:"
        echo "$US_EAST_STACKS" | tr '\t' '\n' | sed 's/^/  - /'
    fi
fi

# Build ordered list of stacks to delete
STACKS_TO_DELETE=()

# First, add stacks in the defined deletion order
for suffix in "${DELETION_ORDER[@]}"; do
    stack_name="$ACRONYM-$suffix"
    if echo "$DISCOVERED_STACKS" | grep -qw "$stack_name"; then
        STACKS_TO_DELETE+=("$stack_name")
    fi
done

# Then, add any remaining discovered stacks not in the predefined order
for stack in $DISCOVERED_STACKS; do
    if [[ ! " ${STACKS_TO_DELETE[*]} " =~ " ${stack} " ]]; then
        STACKS_TO_DELETE+=("$stack")
    fi
done

echo "$(date): Deletion order:"
for stack in "${STACKS_TO_DELETE[@]}"; do
    echo "  - $stack"
done
echo ""

# Confirm before proceeding
read -p "Proceed with deletion? (y/N): " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Deletion cancelled."
    exit 0
fi

delete_stack() {
    local stack_name=$1
    echo "$(date): Attempting to delete stack: $stack_name"
    
    # Check if stack exists
    if ! aws cloudformation describe-stacks --stack-name "$stack_name" --region "$REGION" >/dev/null 2>&1; then
        echo "$(date): Stack $stack_name does not exist or already deleted"
        return 0
    fi
    
    # Initiate deletion
    aws cloudformation delete-stack --stack-name "$stack_name" --region "$REGION"
    if [ $? -ne 0 ]; then
        echo "$(date): Failed to initiate deletion of $stack_name"
        return 1
    fi
    
    echo "$(date): Deletion initiated for $stack_name, waiting for completion..."
    
    # Wait for deletion to complete
    while true; do
        status=$(aws cloudformation describe-stacks --stack-name "$stack_name" --region "$REGION" --query 'Stacks[0].StackStatus' --output text 2>/dev/null)
        
        if [ $? -ne 0 ]; then
            echo "$(date): Stack $stack_name successfully deleted"
            return 0
        fi
        
        case "$status" in
            "DELETE_IN_PROGRESS")
                echo "$(date): $stack_name deletion in progress..."
                sleep 30
                ;;
            "DELETE_COMPLETE")
                echo "$(date): Stack $stack_name successfully deleted"
                return 0
                ;;
            "DELETE_FAILED")
                echo "$(date): Stack $stack_name deletion failed"
                return 1
                ;;
            *)
                echo "$(date): $stack_name status: $status, retrying deletion..."
                aws cloudformation delete-stack --stack-name "$stack_name" --region "$REGION"
                sleep 30
                ;;
        esac
    done
}

echo "$(date): Starting systematic stack deletion..."

for stack in "${STACKS_TO_DELETE[@]}"; do
    delete_stack "$stack"
    if [ $? -eq 0 ]; then
        echo "$(date): Successfully processed $stack"
    else
        echo "$(date): Failed to delete $stack, continuing with next stack..."
    fi
    echo "----------------------------------------"
done

echo "$(date): Stack deletion process completed"

# Delete cross-region stacks in us-east-1 (WAF, CDK support stacks)
if [ -n "$US_EAST_STACKS" ]; then
    echo ""
    echo "$(date): Deleting cross-region stacks in us-east-1..."
    for stack in $US_EAST_STACKS; do
        echo "$(date): Deleting us-east-1 stack: $stack"
        aws cloudformation delete-stack --stack-name "$stack" --region "us-east-1"
        aws cloudformation wait stack-delete-complete --stack-name "$stack" --region "us-east-1" 2>/dev/null || true
        echo "$(date): Deleted $stack"
    done
    echo "$(date): Cross-region cleanup completed"
fi

# Final check - list remaining stacks
echo "$(date): Remaining stacks:"
aws cloudformation list-stacks --region "$REGION" --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE --query 'StackSummaries[?!contains(StackName, `CDKToolkit`)].StackName' --output table

# ─── Cleanup orphaned resources ─────────────────────────────────────────────
# CloudFormation doesn't delete these automatically:
# - SSM parameters created at runtime by Lambda functions
# - CloudWatch log groups auto-created by Lambda on first invocation
# - S3 media bucket (RETAIN policy — contains user data)

# Derive PascalCase name for SSM parameter paths
PASCAL_CASE=$(echo "$PRODUCT_NAME" | sed 's/ //g; s/[^a-zA-Z0-9]//g')

echo ""
echo "$(date): Cleaning up orphaned resources..."

# Delete SSM parameters under the product namespace
echo "$(date): Deleting SSM parameters under /${PASCAL_CASE}/..."
SSM_PARAMS=$(aws ssm get-parameters-by-path --path "/${PASCAL_CASE}" --recursive \
    --query "Parameters[*].Name" --output text --region "$REGION" 2>/dev/null || echo "")
if [ -n "$SSM_PARAMS" ]; then
    PARAM_COUNT=$(echo "$SSM_PARAMS" | wc -w)
    echo "$(date): Found $PARAM_COUNT SSM parameters to delete"
    for param in $SSM_PARAMS; do
        aws ssm delete-parameter --name "$param" --region "$REGION" 2>/dev/null || true
    done
    echo "$(date): SSM parameters deleted"
else
    echo "$(date): No SSM parameters found"
fi

# Delete CloudWatch log groups for Lambda functions
# Catch both naming patterns: /aws/lambda/mrm-* (new) and /aws/lambda/MRM-* (old stack-based names)
# Also catch Image Builder log groups created at pipeline runtime (prefixed with acronym)
echo "$(date): Deleting CloudWatch log groups for /aws/lambda/${ACRONYM,,}-*, /aws/lambda/${ACRONYM}-*, and /aws/imagebuilder/${ACRONYM,,}-*..."
LOG_GROUPS=""
for prefix in "/aws/lambda/${ACRONYM,,}-" "/aws/lambda/${ACRONYM}-" "${ACRONYM}-" "/aws/imagebuilder/${ACRONYM,,}-" "/aws/imagebuilder/pipeline/${ACRONYM,,}-" "/aws/imagebuilder/${PASCAL_CASE}-" "/aws/imagebuilder/pipeline/${PASCAL_CASE,,}-"; do
    FOUND=$(aws logs describe-log-groups \
        --log-group-name-prefix "$prefix" \
        --query "logGroups[*].logGroupName" --output text --region "$REGION" 2>/dev/null || echo "")
    if [ -n "$FOUND" ]; then
        LOG_GROUPS="$LOG_GROUPS $FOUND"
    fi
done
if [ -n "$(echo "$LOG_GROUPS" | tr -d ' ')" ]; then
    LOG_COUNT=$(echo "$LOG_GROUPS" | wc -w)
    echo "$(date): Found $LOG_COUNT log groups to delete"
    for lg in $LOG_GROUPS; do
        aws logs delete-log-group --log-group-name "$lg" --region "$REGION" 2>/dev/null || true
    done
    echo "$(date): Log groups deleted"
else
    echo "$(date): No log groups found"
fi

# Delete DCV Session Manager DynamoDB tables (created by DCV software, not CloudFormation)
echo "$(date): Checking for DCV Session Manager DynamoDB tables..."
DCV_TABLES=$(aws dynamodb list-tables --query "TableNames[?starts_with(@, 'dcv-session-manager-')]" --output text --region "$REGION" 2>/dev/null || echo "")
if [ -n "$DCV_TABLES" ]; then
    DCV_COUNT=$(echo "$DCV_TABLES" | wc -w)
    echo "$(date): Found $DCV_COUNT DCV Session Manager tables to delete"
    for table in $DCV_TABLES; do
        aws dynamodb delete-table --table-name "$table" --region "$REGION" > /dev/null 2>&1 || true
    done
    echo "$(date): DCV Session Manager tables deleted"
else
    echo "$(date): No DCV Session Manager tables found"
fi

# Delete AgentCore and DCV log groups (created at runtime, not by CloudFormation)
# Only target our specific agent (install_script_agent) and our acronym-prefixed DCV logs
echo "$(date): Deleting AgentCore and DCV Session Manager log groups..."
for prefix in "/aws/bedrock-agentcore/runtimes/install_script_agent" "/aws/codebuild/bedrock-agentcore-install_script_agent" "/aws/vendedlogs/bedrock-agentcore/runtime/" "/aws/ec2/${ACRONYM,,}-dcv-"; do
    FOUND=$(aws logs describe-log-groups \
        --log-group-name-prefix "$prefix" \
        --query "logGroups[*].logGroupName" --output text --region "$REGION" 2>/dev/null || echo "")
    if [ -n "$FOUND" ]; then
        for lg in $FOUND; do
            aws logs delete-log-group --log-group-name "$lg" --region "$REGION" 2>/dev/null || true
        done
    fi
done
echo "$(date): AgentCore/DCV log groups deleted"

# Delete EC2 Image Builder resources (created at runtime by image-manager Lambda)
# Deletion order matters: pipelines → images → recipes → infra configs → dist configs → components
# Uses pagination loops since list APIs return max 25 items per page
echo "$(date): Cleaning up EC2 Image Builder resources..."

# Helper: paginate through Image Builder list APIs
imagebuilder_list_all() {
    local cmd="$1"
    local query="$2"
    local all_arns=""
    local next_token=""
    
    while true; do
        if [ -n "$next_token" ]; then
            result=$(aws imagebuilder $cmd --query "$query" --next-token "$next_token" --output text --region "$REGION" 2>/dev/null)
            next_token=$(aws imagebuilder $cmd --next-token "$next_token" --query "nextToken" --output text --region "$REGION" 2>/dev/null)
        else
            result=$(aws imagebuilder $cmd --query "$query" --output text --region "$REGION" 2>/dev/null)
            next_token=$(aws imagebuilder $cmd --query "nextToken" --output text --region "$REGION" 2>/dev/null)
        fi
        if [ -n "$result" ] && [ "$result" != "None" ]; then
            all_arns="$all_arns $result"
        fi
        if [ -z "$next_token" ] || [ "$next_token" = "None" ]; then
            break
        fi
    done
    echo "$all_arns"
}

# Delete pipelines (filter by acronym prefix in name)
PIPELINES=$(imagebuilder_list_all "list-image-pipelines" "imagePipelineList[?starts_with(name, '${ACRONYM,,}-') || starts_with(name, '${PASCAL_CASE}-')].arn")
if [ -n "$(echo "$PIPELINES" | tr -d ' ')" ]; then
    PIPE_COUNT=$(echo "$PIPELINES" | wc -w)
    echo "$(date): Deleting $PIPE_COUNT Image Builder pipelines..."
    for arn in $PIPELINES; do
        aws imagebuilder delete-image-pipeline --image-pipeline-arn "$arn" --region "$REGION" 2>/dev/null || true
    done
fi

# Delete images (all self-owned — images don't have our name prefix but are tagged)
IMAGES=$(imagebuilder_list_all "list-images --owner Self" "imageVersionList[*].arn")
if [ -n "$(echo "$IMAGES" | tr -d ' ')" ]; then
    IMG_COUNT=$(echo "$IMAGES" | wc -w)
    echo "$(date): Deleting $IMG_COUNT Image Builder image versions..."
    for arn in $IMAGES; do
        BUILDS=$(aws imagebuilder list-image-build-versions --image-version-arn "$arn" --query "imageSummaryList[*].arn" --output text --region "$REGION" 2>/dev/null || echo "")
        for build_arn in $BUILDS; do
            aws imagebuilder delete-image --image-build-version-arn "$build_arn" --region "$REGION" 2>/dev/null || true
        done
    done
fi

# Delete recipes (filter by acronym prefix in name)
RECIPES=$(imagebuilder_list_all "list-image-recipes --owner Self" "imageRecipeSummaryList[?starts_with(name, '${ACRONYM,,}-') || starts_with(name, '${PASCAL_CASE}-')].arn")
if [ -n "$(echo "$RECIPES" | tr -d ' ')" ]; then
    REC_COUNT=$(echo "$RECIPES" | wc -w)
    echo "$(date): Deleting $REC_COUNT Image Builder recipes..."
    for arn in $RECIPES; do
        aws imagebuilder delete-image-recipe --image-recipe-arn "$arn" --region "$REGION" 2>/dev/null || true
    done
fi

# Delete infrastructure configurations (filter by acronym prefix in name)
INFRA_CONFIGS=$(imagebuilder_list_all "list-infrastructure-configurations" "infrastructureConfigurationSummaryList[?starts_with(name, '${ACRONYM,,}-') || starts_with(name, '${PASCAL_CASE}-')].arn")
if [ -n "$(echo "$INFRA_CONFIGS" | tr -d ' ')" ]; then
    INFRA_COUNT=$(echo "$INFRA_CONFIGS" | wc -w)
    echo "$(date): Deleting $INFRA_COUNT Image Builder infrastructure configs..."
    for arn in $INFRA_CONFIGS; do
        aws imagebuilder delete-infrastructure-configuration --infrastructure-configuration-arn "$arn" --region "$REGION" 2>/dev/null || true
    done
fi

# Delete distribution configurations (filter by acronym prefix in name)
DIST_CONFIGS=$(imagebuilder_list_all "list-distribution-configurations" "distributionConfigurationSummaryList[?starts_with(name, '${ACRONYM,,}-') || starts_with(name, '${PASCAL_CASE}-')].arn")
if [ -n "$(echo "$DIST_CONFIGS" | tr -d ' ')" ]; then
    DIST_COUNT=$(echo "$DIST_CONFIGS" | wc -w)
    echo "$(date): Deleting $DIST_COUNT Image Builder distribution configs..."
    for arn in $DIST_CONFIGS; do
        aws imagebuilder delete-distribution-configuration --distribution-configuration-arn "$arn" --region "$REGION" 2>/dev/null || true
    done
fi

# Delete components (self-owned, all versions — components use various naming)
COMPONENTS=$(imagebuilder_list_all "list-components --owner Self" "componentVersionList[*].arn")
if [ -n "$(echo "$COMPONENTS" | tr -d ' ')" ]; then
    COMP_COUNT=$(echo "$COMPONENTS" | wc -w)
    echo "$(date): Deleting $COMP_COUNT Image Builder components..."
    for arn in $COMPONENTS; do
        VERSIONS=$(aws imagebuilder list-component-build-versions --component-version-arn "$arn" --query "componentSummaryList[*].arn" --output text --region "$REGION" 2>/dev/null || echo "")
        for ver_arn in $VERSIONS; do
            aws imagebuilder delete-component --component-build-version-arn "$ver_arn" --region "$REGION" 2>/dev/null || true
        done
    done
fi

echo "$(date): Image Builder cleanup complete"

# Handle S3 media bucket (RETAIN policy — requires explicit confirmation)
MEDIA_BUCKET="${ACRONYM,,}-media-$(aws sts get-caller-identity --query Account --output text)-${REGION}"
if aws s3api head-bucket --bucket "$MEDIA_BUCKET" 2>/dev/null; then
    echo ""
    echo "$(date): S3 media bucket still exists: $MEDIA_BUCKET"
    echo "  This bucket has RemovalPolicy.RETAIN because it may contain user data."
    read -p "  Delete media bucket and all its contents? This is IRREVERSIBLE. (y/N): " confirm_media
    if [[ "$confirm_media" =~ ^[Yy]$ ]]; then
        echo "$(date): Emptying and deleting $MEDIA_BUCKET..."
        # Delete all current objects
        aws s3 rm "s3://$MEDIA_BUCKET" --recursive --region "$REGION" 2>/dev/null || true
        # Delete all object versions (required for versioned buckets)
        aws s3api list-object-versions --bucket "$MEDIA_BUCKET" \
            --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' \
            --output json > /tmp/mrm-versions.json 2>/dev/null
        if python3 -c "import json,sys; d=json.load(open('/tmp/mrm-versions.json')); sys.exit(0 if d.get('Objects') else 1)" 2>/dev/null; then
            aws s3api delete-objects --bucket "$MEDIA_BUCKET" --delete "file:///tmp/mrm-versions.json" 2>/dev/null || true
        fi
        # Delete all delete markers
        aws s3api list-object-versions --bucket "$MEDIA_BUCKET" \
            --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' \
            --output json > /tmp/mrm-markers.json 2>/dev/null
        if python3 -c "import json,sys; d=json.load(open('/tmp/mrm-markers.json')); sys.exit(0 if d.get('Objects') else 1)" 2>/dev/null; then
            aws s3api delete-objects --bucket "$MEDIA_BUCKET" --delete "file:///tmp/mrm-markers.json" 2>/dev/null || true
        fi
        aws s3 rb "s3://$MEDIA_BUCKET" --region "$REGION" 2>/dev/null || true
        rm -f /tmp/mrm-versions.json /tmp/mrm-markers.json
        echo "$(date): Media bucket deleted"
    else
        echo "$(date): Media bucket preserved: $MEDIA_BUCKET"
    fi
fi

echo ""
echo "$(date): Cleanup complete!"
