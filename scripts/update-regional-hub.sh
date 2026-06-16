#!/bin/bash
# Update a regional hub's CloudFormation stack
# This regenerates the template with latest Lambda code and updates the stack
#
# Usage: ./scripts/update-regional-hub.sh <region> [--wait]
# Example: ./scripts/update-regional-hub.sh us-west-2
# Example: ./scripts/update-regional-hub.sh us-west-2 --wait

set -e

REGION=$1
WAIT_FLAG=$2

if [ -z "$REGION" ]; then
    echo "Usage: $0 <region> [--wait]"
    echo "Example: $0 us-west-2"
    echo "Example: $0 us-west-2 --wait"
    exit 1
fi

# Get the script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Get product name from cdk.json and generate acronym
PRODUCT_NAME=$(jq -r '.context.productName // empty' "$PROJECT_ROOT/cdk.json")
if [ -z "$PRODUCT_NAME" ]; then
    echo "Error: Could not find productName in cdk.json"
    exit 1
fi

# Generate acronym from product name (first letter of each word, uppercase)
# e.g., "AMC Cloud Edit Manager" -> "ACEM"
ACRONYM=$(echo "$PRODUCT_NAME" | awk '{for(i=1;i<=NF;i++) printf toupper(substr($i,1,1))}')
ACRONYM_LOWER=$(echo "$ACRONYM" | tr '[:upper:]' '[:lower:]')

echo "Product: $PRODUCT_NAME"
echo "Acronym: $ACRONYM ($ACRONYM_LOWER)"

# Convert region to stack name format (e.g., ap-southeast-2 -> apsoutheast2)
STACK_REGION=$(echo "$REGION" | tr -d '-')
STACK_NAME="${ACRONYM}-Regional-Hub-${STACK_REGION}"

echo "Updating regional hub in $REGION..."
echo "Stack name: $STACK_NAME"

# Invoke the update regional hub Lambda
RESULT=$(aws lambda invoke \
    --function-name "${ACRONYM_LOWER}-update-regional-hub" \
    --payload "{\"body\": \"{\\\"region\\\": \\\"$REGION\\\"}\"}" \
    --cli-binary-format raw-in-base64-out \
    /tmp/update-regional-hub-result.json 2>&1)

# Check for Lambda invocation errors
if [ $? -ne 0 ]; then
    echo "Error invoking Lambda: $RESULT"
    exit 1
fi

# Display the result
echo "Response:"
cat /tmp/update-regional-hub-result.json | jq .

# Parse the response to check status
STATUS_CODE=$(cat /tmp/update-regional-hub-result.json | jq -r '.statusCode // empty')
BODY=$(cat /tmp/update-regional-hub-result.json | jq -r '.body // empty')

if [ -n "$STATUS_CODE" ]; then
    if [ "$STATUS_CODE" -eq 200 ]; then
        # Already up to date (no changes)
        echo ""
        echo "✓ Regional hub is already up to date"
        exit 0
    elif [ "$STATUS_CODE" -eq 202 ]; then
        echo ""
        echo "✓ Regional hub update initiated successfully"
        
        if [ "$WAIT_FLAG" == "--wait" ]; then
            echo ""
            echo "Waiting for CloudFormation stack update to complete..."
            
            # Poll for stack completion
            while true; do
                STACK_STATUS=$(aws cloudformation describe-stacks \
                    --stack-name "$STACK_NAME" \
                    --region "$REGION" \
                    --query "Stacks[0].StackStatus" \
                    --output text 2>/dev/null)
                
                echo "  Stack status: $STACK_STATUS"
                
                case "$STACK_STATUS" in
                    UPDATE_COMPLETE)
                        echo ""
                        echo "✓ Stack update completed successfully"
                        
                        # Update DynamoDB status to 'available'
                        echo "Updating regional hub status to 'available'..."
                        aws dynamodb update-item \
                            --table-name "${ACRONYM_LOWER}-regional-hubs" \
                            --key "{\"region\": {\"S\": \"$REGION\"}}" \
                            --update-expression "SET #status = :status, updatedAt = :updatedAt" \
                            --expression-attribute-names '{"#status": "status"}' \
                            --expression-attribute-values "{\":status\": {\"S\": \"available\"}, \":updatedAt\": {\"S\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}" \
                            > /dev/null
                        
                        echo "✓ Regional hub status set to 'available'"
                        exit 0
                        ;;
                    UPDATE_ROLLBACK_COMPLETE|UPDATE_FAILED|ROLLBACK_COMPLETE)
                        echo ""
                        echo "✗ Stack update failed with status: $STACK_STATUS"
                        
                        # Update DynamoDB status to 'update_failed'
                        aws dynamodb update-item \
                            --table-name "${ACRONYM_LOWER}-regional-hubs" \
                            --key "{\"region\": {\"S\": \"$REGION\"}}" \
                            --update-expression "SET #status = :status, updatedAt = :updatedAt" \
                            --expression-attribute-names '{"#status": "status"}' \
                            --expression-attribute-values "{\":status\": {\"S\": \"update_failed\"}, \":updatedAt\": {\"S\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}" \
                            > /dev/null
                        
                        exit 1
                        ;;
                    UPDATE_IN_PROGRESS|UPDATE_COMPLETE_CLEANUP_IN_PROGRESS)
                        # Still in progress, wait and check again
                        sleep 15
                        ;;
                    *)
                        echo "Unexpected stack status: $STACK_STATUS"
                        sleep 15
                        ;;
                esac
            done
        else
            echo "  Run with --wait flag to wait for completion and update status"
            echo "  Or run: aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query \"Stacks[0].StackStatus\""
        fi
    else
        echo ""
        echo "✗ Regional hub update failed"
        echo "$BODY" | jq .
        exit 1
    fi
fi
