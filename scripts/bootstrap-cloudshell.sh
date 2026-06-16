#!/bin/bash
# =============================================================================
# Media Resource Manager - CloudShell Bootstrap Script
# =============================================================================
# Enables deployment from AWS CloudShell without a dev server.
# Uses /tmp for the build (plenty of space) and persists configuration
# to SSM Parameter Store so settings survive between sessions.
#
# Usage (run from the cloned repo directory):
#   First deploy:   ./scripts/bootstrap-cloudshell.sh
#   Re-deploy:      ./scripts/bootstrap-cloudshell.sh --redeploy
#   Save config:    ./scripts/bootstrap-cloudshell.sh --save-config
#   Restore config: ./scripts/bootstrap-cloudshell.sh --restore-config
#   Destroy:        ./scripts/bootstrap-cloudshell.sh --destroy
# =============================================================================

set -e

SSM_CONFIG_PARAM="/MRM/DeploymentConfig/parameters"
SSM_CDK_CONFIG_PARAM="/MRM/DeploymentConfig/cdk-json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

print_status()  { echo -e "${BLUE}$1${NC}"; }
print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_error()   { echo -e "${RED}❌ $1${NC}"; }
print_info()    { echo -e "${CYAN}$1${NC}"; }

# Find the project root (where package.json lives)
find_project_dir() {
    local dir="$PWD"
    while [[ "$dir" != "/" ]]; do
        if [[ -f "$dir/package.json" ]] && [[ -f "$dir/deploy.sh" ]]; then
            echo "$dir"
            return 0
        fi
        dir=$(dirname "$dir")
    done
    print_error "Could not find project root. Run this from the cloned repo directory."
    exit 1
}

PROJECT_DIR=$(find_project_dir)


# =============================================================================
# Prerequisite checks
# =============================================================================
check_prerequisites() {
    print_status "🔍 Checking prerequisites..."
    local missing=0

    if ! command -v aws &>/dev/null; then
        print_error "AWS CLI not found"; missing=1
    else
        print_success "AWS CLI: $(aws --version 2>&1 | head -1)"
    fi

    if ! aws sts get-caller-identity &>/dev/null; then
        print_error "AWS credentials not configured or expired"; missing=1
    else
        local account_id=$(aws sts get-caller-identity --query Account --output text)
        local region=$(aws configure get region 2>/dev/null || echo "")
        if [[ -z "$region" ]]; then
            # CloudShell sets AWS_REGION automatically
            region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
            if [[ -n "$region" ]]; then
                print_warning "No default region configured, using environment: $region"
                aws configure set region "$region"
            fi
        fi
        print_success "AWS Account: $account_id | Region: $region"
        if [[ -z "$region" ]]; then
            print_error "AWS region not configured. Run: aws configure set region <your-region>"
            missing=1
        fi
    fi

    if ! command -v node &>/dev/null; then
        print_error "Node.js not found"; missing=1
    else
        local node_major=$(node --version | sed 's/v//' | cut -d. -f1)
        if [[ "$node_major" -lt 18 ]]; then
            print_error "Node.js 18+ required (found $(node --version))"; missing=1
        else
            print_success "Node.js: $(node --version) | npm: $(npm --version)"
        fi
    fi

    if ! command -v git &>/dev/null; then
        print_error "Git not found"; missing=1
    fi

    if [[ $missing -ne 0 ]]; then
        print_error "Missing prerequisites."
        exit 1
    fi
    print_success "All prerequisites met"
    echo ""
}

# =============================================================================
# Save configuration to SSM Parameter Store
# =============================================================================
save_config_to_ssm() {
    if [[ ! -f "$PROJECT_DIR/parameters.json" ]]; then
        print_warning "No parameters.json found to save"
        return 1
    fi

    print_status "💾 Saving configuration to SSM Parameter Store..."

    aws ssm put-parameter \
        --name "$SSM_CONFIG_PARAM" \
        --type "String" \
        --value "$(cat "$PROJECT_DIR/parameters.json")" \
        --overwrite \
        --description "MRM deployment parameters.json - saved by bootstrap script" \
        --no-cli-pager >/dev/null
    print_success "parameters.json saved to SSM: $SSM_CONFIG_PARAM"

    if [[ -f "$PROJECT_DIR/cdk.json" ]]; then
        aws ssm put-parameter \
            --name "$SSM_CDK_CONFIG_PARAM" \
            --type "String" \
            --value "$(cat "$PROJECT_DIR/cdk.json")" \
            --overwrite \
            --description "MRM deployment cdk.json - saved by bootstrap script" \
            --no-cli-pager >/dev/null
        print_success "cdk.json saved to SSM: $SSM_CDK_CONFIG_PARAM"
    fi

    print_info "Configuration persisted — survives CloudShell session restarts."
}

# =============================================================================
# Restore configuration from SSM Parameter Store
# =============================================================================
restore_config_from_ssm() {
    print_status "📥 Checking for saved configuration in SSM..."

    local saved_params
    saved_params=$(aws ssm get-parameter --name "$SSM_CONFIG_PARAM" \
        --query "Parameter.Value" --output text 2>/dev/null) || true

    if [[ -n "$saved_params" && "$saved_params" != "None" ]]; then
        echo "$saved_params" > "$PROJECT_DIR/parameters.json"
        print_success "Restored parameters.json from SSM"
        node -e "
            const params = JSON.parse(require('fs').readFileSync('$PROJECT_DIR/parameters.json'));
            const show = ['VpcId','VpcCidr','DomainName','UseCognitoAuth','AdminGroupName'];
            show.forEach(key => {
                const p = params.find(p => p.ParameterKey === key);
                if (p && p.ParameterValue) console.log('  ' + key + ': ' + p.ParameterValue);
            });
        " 2>/dev/null || true
        return 0
    else
        print_warning "No saved configuration found in SSM"
        return 1
    fi
}

restore_cdk_config_from_ssm() {
    local saved_cdk
    saved_cdk=$(aws ssm get-parameter --name "$SSM_CDK_CONFIG_PARAM" \
        --query "Parameter.Value" --output text 2>/dev/null) || true

    if [[ -n "$saved_cdk" && "$saved_cdk" != "None" ]]; then
        echo "$saved_cdk" > "$PROJECT_DIR/cdk.json"
        print_success "Restored cdk.json from SSM"
        return 0
    fi
    return 1
}


# =============================================================================
# Interactive configuration
# =============================================================================
configure_parameters() {
    print_status "⚙️  Interactive Configuration"
    print_info "Press Enter to accept defaults shown in brackets."
    echo ""

    cp "$PROJECT_DIR/parameters.example.json" "$PROJECT_DIR/parameters.json"

    local vpc_id vpc_cidr domain_name use_cognito admin_group hostname_prefix

    read -p "VPC ID (leave empty to create new VPC): " vpc_id
    if [[ -z "$vpc_id" ]]; then
        read -p "VPC CIDR block [10.1.0.0/16]: " vpc_cidr
        vpc_cidr="${vpc_cidr:-10.1.0.0/16}"
    fi

    read -p "Active Directory domain name [studio.mrm.internal]: " domain_name
    domain_name="${domain_name:-studio.mrm.internal}"

    read -p "Use Cognito authentication? (true/false) [true]: " use_cognito
    use_cognito="${use_cognito:-true}"

    read -p "Admin group name [MRM-Admins]: " admin_group
    admin_group="${admin_group:-MRM-Admins}"

    read -p "Hostname prefix [vdi-]: " hostname_prefix
    hostname_prefix="${hostname_prefix:-vdi-}"

    node -e "
        const fs = require('fs');
        const params = JSON.parse(fs.readFileSync('$PROJECT_DIR/parameters.json'));
        const updates = {
            VpcId: '$vpc_id', VpcCidr: '${vpc_cidr:-10.1.0.0/16}',
            DomainName: '$domain_name', UseCognitoAuth: '$use_cognito',
            AdminGroupName: '$admin_group', HostnamePrefix: '$hostname_prefix'
        };
        for (const [key, value] of Object.entries(updates)) {
            const p = params.find(p => p.ParameterKey === key);
            if (p) p.ParameterValue = value || '';
        }
        fs.writeFileSync('$PROJECT_DIR/parameters.json', JSON.stringify(params, null, 2));
    "

    print_success "Configuration saved"
    echo ""

    read -p "Save to SSM Parameter Store for future sessions? (Y/n): " save_ssm
    if [[ ! "$save_ssm" =~ ^[Nn]$ ]]; then
        save_config_to_ssm
    fi
}

# =============================================================================
# Setup project (restore config or run interactive setup)
# =============================================================================
setup_project() {
    print_status "📦 Setting up project in $PROJECT_DIR..."

    # Restore or create cdk.json (gitignored)
    if [[ ! -f "$PROJECT_DIR/cdk.json" ]]; then
        if ! restore_cdk_config_from_ssm; then
            if [[ -f "$PROJECT_DIR/cdk.example.json" ]]; then
                cp "$PROJECT_DIR/cdk.example.json" "$PROJECT_DIR/cdk.json"
                print_success "Created cdk.json from template"
            fi
        fi
    else
        print_success "cdk.json already exists"
    fi

    # Restore config from SSM or run interactive setup
    if [[ -f "$PROJECT_DIR/parameters.json" ]]; then
        print_success "parameters.json already exists"
        read -p "Use existing parameters.json? (Y/n): " use_existing
        if [[ "$use_existing" =~ ^[Nn]$ ]]; then
            if ! restore_config_from_ssm; then
                configure_parameters
            fi
        fi
    elif ! restore_config_from_ssm; then
        print_warning "No saved configuration found."
        read -p "Run interactive configuration? (Y/n): " do_config
        if [[ ! "$do_config" =~ ^[Nn]$ ]]; then
            configure_parameters
        else
            cp "$PROJECT_DIR/parameters.example.json" "$PROJECT_DIR/parameters.json"
            print_warning "Using defaults. Edit parameters.json before deploying."
        fi
    fi
}

# =============================================================================
# Deploy
# =============================================================================
run_deploy() {
    cd "$PROJECT_DIR"

    echo ""
    print_info "Deployment takes approximately 30-45 minutes."
    print_info "Keep this CloudShell tab active to prevent session timeout."
    echo ""

    chmod +x deploy.sh
    ./deploy.sh -y

    # Save config after deploy (captures VPC analyzer changes)
    save_config_to_ssm
}

# =============================================================================
# Destroy
# =============================================================================
run_destroy() {
    cd "$PROJECT_DIR"

    print_warning "This will DELETE all MRM stacks and resources."
    read -p "Type 'yes' to confirm: " confirm
    if [[ "$confirm" != "yes" ]]; then
        print_warning "Cancelled."
        exit 0
    fi

    chmod +x delete-stacks.sh
    ./delete-stacks.sh

    read -p "Also remove saved configuration from SSM? (y/N): " clean_ssm
    if [[ "$clean_ssm" =~ ^[Yy]$ ]]; then
        aws ssm delete-parameter --name "$SSM_CONFIG_PARAM" 2>/dev/null || true
        aws ssm delete-parameter --name "$SSM_CDK_CONFIG_PARAM" 2>/dev/null || true
        print_success "SSM configuration removed"
    fi
}

# =============================================================================
# Main
# =============================================================================
echo ""
echo "============================================================"
echo "  Media Resource Manager - CloudShell Bootstrap"
echo "============================================================"
echo ""

# Wrap long-running operations in tmux so they survive CloudShell disconnects.
# If tmux is available and we're not already in a tmux session, re-launch inside one.
# Skip tmux for quick operations (save/restore config, help).
NEEDS_TMUX=false
case "${1:-}" in
    --save-config|--restore-config|--help|-h) NEEDS_TMUX=false ;;
    *) NEEDS_TMUX=true ;;
esac

if [[ "$NEEDS_TMUX" == "true" ]] && command -v tmux &>/dev/null && [[ -z "${TMUX:-}" ]]; then
    print_info "Starting tmux session 'mrm-deploy' to survive disconnects..."
    print_info "If disconnected, reconnect with: tmux attach -t mrm-deploy"
    echo ""
    # Kill any stale session, then launch a new one running this script with the same args
    tmux kill-session -t mrm-deploy 2>/dev/null || true
    exec tmux new-session -s mrm-deploy "$0 $*"
fi

case "${1:-}" in
    --redeploy)
        check_prerequisites
        setup_project
        run_deploy
        ;;
    --save-config)
        save_config_to_ssm
        ;;
    --restore-config)
        restore_config_from_ssm
        ;;
    --destroy)
        check_prerequisites
        run_destroy
        ;;
    --help|-h)
        echo "Usage: $0 [option]"
        echo ""
        echo "Options:"
        echo "  (none)           First-time setup and deploy"
        echo "  --redeploy       Restore config from SSM and deploy"
        echo "  --save-config    Save current parameters.json to SSM"
        echo "  --restore-config Restore parameters.json from SSM"
        echo "  --destroy        Destroy all stacks"
        echo "  --help           Show this help"
        echo ""
        echo "The script automatically runs inside tmux to survive CloudShell"
        echo "disconnects. If disconnected, reconnect with: tmux attach -t mrm-deploy"
        ;;
    *)
        check_prerequisites
        setup_project
        run_deploy
        ;;
esac
