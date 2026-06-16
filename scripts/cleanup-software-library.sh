#!/bin/bash
# cleanup-software-library.sh
# Removes software items from the Software Library via API Gateway
#
# Usage: ./scripts/cleanup-software-library.sh [--dry-run] [--category <category>] [--all] [--name <name>]
#
# Prerequisites:
#   - AWS CLI configured with valid credentials
#   - jq installed (for JSON parsing)
#   - API Gateway endpoint from deployment outputs

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
DRY_RUN=false
CATEGORY_FILTER=""
NAME_FILTER=""
DELETE_ALL=false
VERBOSE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --category)
            CATEGORY_FILTER="$2"
            shift 2
            ;;
        --name)
            NAME_FILTER="$2"
            shift 2
            ;;
        --all)
            DELETE_ALL=true
            shift
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--dry-run] [--category <category>] [--name <name>] [--all] [--verbose]"
            echo ""
            echo "Options:"
            echo "  --dry-run           Show what would be deleted without making API calls"
            echo "  --category <name>   Only delete software in specified category"
            echo "  --name <name>       Only delete software matching name (partial match)"
            echo "  --all               Delete all software items (requires confirmation)"
            echo "  --verbose, -v       Show detailed output"
            echo "  --help, -h          Show this help message"
            echo ""
            echo "Categories: development, media, system, utilities"
            echo ""
            echo "Examples:"
            echo "  $0 --dry-run --all                    # Preview deleting everything"
            echo "  $0 --category media                   # Delete all media software"
            echo "  $0 --name 'Blender'                   # Delete software matching 'Blender'"
            echo "  $0 --category development --dry-run  # Preview deleting dev tools"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    if ! command -v jq &> /dev/null; then
        log_error "jq is required but not installed. Install with: sudo apt install jq"
        exit 1
    fi
    
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is required but not installed."
        exit 1
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS credentials not configured or expired."
        exit 1
    fi
}

# Get PascalCaseName from cdk.json
get_pascal_case_name() {
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local project_root="$(dirname "$script_dir")"
    local cdk_json="$project_root/cdk.json"
    
    if [ -f "$cdk_json" ]; then
        PASCAL_CASE_NAME=$(node -p "require('$cdk_json').context.productName.replace(/\\s+/g, '')" 2>/dev/null)
        if [ -z "$PASCAL_CASE_NAME" ] || [ "$PASCAL_CASE_NAME" = "undefined" ]; then
            PASCAL_CASE_NAME="MediaResourceManager"
            log_warning "Could not read productName from cdk.json, using default: $PASCAL_CASE_NAME"
        fi
    else
        PASCAL_CASE_NAME="MediaResourceManager"
        log_warning "cdk.json not found at $cdk_json, using default: $PASCAL_CASE_NAME"
    fi
    
    log_info "Using parameter prefix: /$PASCAL_CASE_NAME"
}

# Get API endpoint from SSM Parameter Store
get_api_endpoint() {
    local param_name="/${PASCAL_CASE_NAME}/Workstation/ApiUrl"
    
    log_info "Fetching API endpoint from SSM parameter: $param_name"
    
    API_ENDPOINT=$(aws ssm get-parameter --name "$param_name" --query 'Parameter.Value' --output text 2>/dev/null) || {
        log_error "Could not fetch API endpoint from SSM. Make sure the stack is deployed."
        log_info "You can also set API_ENDPOINT environment variable manually."
        exit 1
    }
    
    # Remove trailing slash if present
    API_ENDPOINT="${API_ENDPOINT%/}"
    
    log_info "API Endpoint: $API_ENDPOINT"
}

# Get auth token
get_auth_token() {
    if [ -n "$AUTH_TOKEN" ]; then
        log_info "Using provided AUTH_TOKEN"
        return
    fi
    
    log_warning "No AUTH_TOKEN environment variable set."
    echo ""
    log_info "To get a token:"
    log_info "  1. Log into the frontend application"
    log_info "  2. Open browser dev tools (F12)"
    log_info "  3. Go to Application > Local Storage or Network tab"
    log_info "  4. Copy the JWT/access token"
    echo ""
    
    if [ "$DRY_RUN" = false ]; then
        read -p "Paste your AUTH_TOKEN (or press Enter to skip): " AUTH_TOKEN
        echo ""
        
        if [ -n "$AUTH_TOKEN" ]; then
            log_success "AUTH_TOKEN set for this session"
        else
            log_warning "No token provided, continuing without authentication"
            read -p "Continue without authentication? (API may reject requests) [y/N]: " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                exit 1
            fi
        fi
    fi
}

# Fetch all software items from the API
fetch_software_list() {
    log_info "Fetching software list from API..." >&2
    log_info "URL: ${API_ENDPOINT}/images/software" >&2
    
    local response
    local http_code
    
    if [ -n "$AUTH_TOKEN" ]; then
        response=$(curl -s -w "\n%{http_code}" -X GET \
            "${API_ENDPOINT}/images/software" \
            -H "Authorization: Bearer $AUTH_TOKEN")
    else
        response=$(curl -s -w "\n%{http_code}" -X GET "${API_ENDPOINT}/images/software")
    fi
    
    http_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    if [ "$VERBOSE" = true ]; then
        log_info "HTTP Status: $http_code" >&2
        log_info "Response body:" >&2
        echo "$body" >&2
    fi
    
    # Check HTTP status
    if [ "$http_code" != "200" ]; then
        log_error "API request failed with HTTP $http_code" >&2
        log_error "Response: $body" >&2
        return 1
    fi
    
    # Validate JSON
    if ! echo "$body" | jq -e '.' &>/dev/null; then
        log_error "Invalid JSON response from API:" >&2
        echo "$body" >&2
        return 1
    fi
    
    # Check for error message in response
    if echo "$body" | jq -e '.message' &>/dev/null; then
        log_error "API error: $(echo "$body" | jq -r '.message')" >&2
        return 1
    fi
    
    echo "$body"
}

# Delete a single software item
delete_software() {
    local software_id="$1"
    local name="$2"
    local platform="$3"
    
    if [ "$DRY_RUN" = true ]; then
        log_info "  [DRY RUN] Would delete: $name ($platform) - ID: $software_id"
        return 0
    fi
    
    local response
    local http_code
    
    if [ -n "$AUTH_TOKEN" ]; then
        response=$(curl -s -w "\n%{http_code}" -X DELETE \
            "${API_ENDPOINT}/images/software/${software_id}" \
            -H "Authorization: Bearer $AUTH_TOKEN")
    else
        response=$(curl -s -w "\n%{http_code}" -X DELETE \
            "${API_ENDPOINT}/images/software/${software_id}")
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" = "200" ] || [ "$http_code" = "204" ]; then
        log_success "  Deleted: $name ($platform)"
        return 0
    else
        local error_msg=$(echo "$body" | jq -r '.message // .error // "Unknown error"' 2>/dev/null)
        log_error "  Failed to delete $name (HTTP $http_code): $error_msg"
        if [ "$VERBOSE" = true ]; then
            echo "$body" | jq '.' 2>/dev/null || echo "$body"
        fi
        return 1
    fi
}

# Main execution
main() {
    echo ""
    echo "=========================================="
    echo "  Software Library Cleanup Script"
    echo "=========================================="
    echo ""
    
    # Validate arguments
    if [ "$DELETE_ALL" = false ] && [ -z "$CATEGORY_FILTER" ] && [ -z "$NAME_FILTER" ]; then
        log_error "You must specify --all, --category, or --name to delete items."
        log_info "Use --help for usage information."
        exit 1
    fi
    
    check_prerequisites
    get_pascal_case_name
    
    if [ "$DRY_RUN" = true ]; then
        log_warning "Running in DRY RUN mode - no changes will be made"
        echo ""
    fi
    
    # Get API endpoint
    if [ -z "$API_ENDPOINT" ]; then
        get_api_endpoint
    fi
    
    # Get auth token
    if [ "$DRY_RUN" = false ]; then
        get_auth_token
    fi
    
    # Fetch software list
    local software_list
    software_list=$(fetch_software_list)
    if [ $? -ne 0 ]; then
        exit 1
    fi
    
    local items=$(echo "$software_list" | jq -r '.items // []')
    local total_items=$(echo "$items" | jq 'length')
    
    log_info "Found $total_items software items in library"
    
    # Filter items based on criteria
    local filtered_items="$items"
    
    if [ -n "$CATEGORY_FILTER" ]; then
        filtered_items=$(echo "$filtered_items" | jq --arg cat "$CATEGORY_FILTER" '[.[] | select(.category == $cat)]')
        log_info "Filtered by category '$CATEGORY_FILTER': $(echo "$filtered_items" | jq 'length') items"
    fi
    
    if [ -n "$NAME_FILTER" ]; then
        filtered_items=$(echo "$filtered_items" | jq --arg name "$NAME_FILTER" '[.[] | select(.name | test($name; "i"))]')
        log_info "Filtered by name '$NAME_FILTER': $(echo "$filtered_items" | jq 'length') items"
    fi
    
    local delete_count=$(echo "$filtered_items" | jq 'length')
    
    if [ "$delete_count" = "0" ]; then
        log_warning "No items match the specified criteria."
        exit 0
    fi
    
    # Show items to be deleted
    echo ""
    log_info "Items to be deleted:"
    echo "$filtered_items" | jq -r '.[] | "  - \(.name) (\(.platform)) [\(.category)]"'
    echo ""
    
    # Confirmation for non-dry-run
    if [ "$DRY_RUN" = false ]; then
        log_warning "This will delete $delete_count software item(s)."
        read -p "Are you sure you want to continue? [y/N]: " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Aborted."
            exit 0
        fi
        echo ""
    fi
    
    # Delete items
    local total_deleted=0
    local total_failed=0
    
    while IFS= read -r item; do
        local software_id=$(echo "$item" | jq -r '.softwareId')
        local name=$(echo "$item" | jq -r '.name')
        local platform=$(echo "$item" | jq -r '.platform')
        
        if delete_software "$software_id" "$name" "$platform"; then
            total_deleted=$((total_deleted + 1))
        else
            total_failed=$((total_failed + 1))
        fi
    done < <(echo "$filtered_items" | jq -c '.[]')
    
    # Summary
    echo ""
    echo "=========================================="
    echo "  Summary"
    echo "=========================================="
    echo "  Total matched: $delete_count"
    if [ "$DRY_RUN" = true ]; then
        echo "  Would delete: $total_deleted"
    else
        echo "  Deleted: $total_deleted"
        echo "  Failed: $total_failed"
    fi
    echo "=========================================="
    
    if [ $total_failed -gt 0 ]; then
        exit 1
    fi
}

main "$@"
