#!/bin/bash

# VPC Analyzer Script
# Analyzes an imported VPC and helps select subnets when multiple exist per AZ

# Don't use set -e as we need to handle exit codes manually
set +e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_status() { echo -e "${BLUE}$1${NC}"; }
print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_error() { echo -e "${RED}❌ $1${NC}"; }
print_info() { echo -e "${CYAN}$1${NC}"; }

# Get VPC ID from parameters.json
get_vpc_id() {
    if [[ ! -f "parameters.json" ]]; then
        echo ""
        return
    fi
    node -p "JSON.parse(require('fs').readFileSync('parameters.json')).find(p => p.ParameterKey === 'VpcId')?.ParameterValue || ''" 2>/dev/null
}

# Get current region
get_region() {
    aws configure get region 2>/dev/null || echo "${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
}

# Analyze VPC subnets and detect multiple subnets per AZ
analyze_vpc() {
    local vpc_id=$1
    local region=$(get_region)
    
    print_status "🔍 Analyzing VPC: $vpc_id in region: $region"
    echo ""
    
    # Get all subnets in the VPC
    local subnets=$(aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=$vpc_id" \
        --query 'Subnets[*].{SubnetId:SubnetId,AZ:AvailabilityZone,CidrBlock:CidrBlock,MapPublicIpOnLaunch:MapPublicIpOnLaunch,Name:Tags[?Key==`Name`].Value|[0]}' \
        --output json 2>/dev/null)
    
    if [[ -z "$subnets" ]] || [[ "$subnets" == "[]" ]]; then
        print_error "No subnets found in VPC $vpc_id"
        return 1
    fi
    
    # Parse subnets and group by AZ - use || true to prevent set -e from exiting
    echo "$subnets" | node -e "
const subnets = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));

// Group subnets by AZ
const byAz = {};
subnets.forEach(s => {
    if (!byAz[s.AZ]) byAz[s.AZ] = { public: [], private: [] };
    // Determine if public or private based on MapPublicIpOnLaunch or name
    const isPublic = s.MapPublicIpOnLaunch || (s.Name && s.Name.toLowerCase().includes('public'));
    if (isPublic) {
        byAz[s.AZ].public.push(s);
    } else {
        byAz[s.AZ].private.push(s);
    }
});

// Output analysis
console.log('='.repeat(80));
console.log('VPC SUBNET ANALYSIS');
console.log('='.repeat(80));
console.log('');

let hasMultiplePrivatePerAz = false;
let hasMultiplePublicPerAz = false;

Object.keys(byAz).sort().forEach(az => {
    console.log(\`\n📍 Availability Zone: \${az}\`);
    console.log('-'.repeat(40));
    
    console.log(\`  Public Subnets (\${byAz[az].public.length}):\`);
    byAz[az].public.forEach((s, i) => {
        console.log(\`    [\${i + 1}] \${s.SubnetId} - \${s.CidrBlock} - \${s.Name || 'No Name'}\`);
    });
    if (byAz[az].public.length > 1) hasMultiplePublicPerAz = true;
    
    console.log(\`  Private Subnets (\${byAz[az].private.length}):\`);
    byAz[az].private.forEach((s, i) => {
        console.log(\`    [\${i + 1}] \${s.SubnetId} - \${s.CidrBlock} - \${s.Name || 'No Name'}\`);
    });
    if (byAz[az].private.length > 1) hasMultiplePrivatePerAz = true;
});

console.log('');
console.log('='.repeat(80));

// Output JSON for script consumption
const result = {
    hasMultiplePrivatePerAz,
    hasMultiplePublicPerAz,
    azCount: Object.keys(byAz).length,
    subnets: byAz
};

// Write to temp file for bash to read
require('fs').writeFileSync('/tmp/vpc-analysis.json', JSON.stringify(result, null, 2));

if (hasMultiplePrivatePerAz || hasMultiplePublicPerAz) {
    console.log('');
    console.log('⚠️  WARNING: Multiple subnets detected per Availability Zone!');
    console.log('');
    console.log('Load Balancers can only be attached to ONE subnet per AZ.');
    console.log('You need to select which subnets to use for deployment.');
    console.log('');
    process.exit(2);  // Special exit code to indicate selection needed
} else {
    console.log('');
    console.log('✅ VPC has one subnet per AZ - no selection needed.');
    console.log('');
    process.exit(0);
}
"
    # Capture the exit code before || true modifies it
    local node_exit=$?
    
    # Read the result from the temp file
    if [[ -f "/tmp/vpc-analysis.json" ]]; then
        local needs_selection=$(node -p "JSON.parse(require('fs').readFileSync('/tmp/vpc-analysis.json')).hasMultiplePrivatePerAz || JSON.parse(require('fs').readFileSync('/tmp/vpc-analysis.json')).hasMultiplePublicPerAz")
        if [[ "$needs_selection" == "true" ]]; then
            return 2
        fi
    fi
    
    # Check NACLs for UDP rules needed by DCV
    check_nacl_udp_rules "$vpc_id"
    
    # For simple VPCs (one subnet per AZ), auto-write subnet IDs to parameters.json
    # This avoids Vpc.fromLookup() which requires cdk.context.json cache
    auto_save_simple_subnets "$vpc_id"
    
    return 0
}

# For simple VPCs (one subnet per AZ), auto-save subnet IDs to parameters.json
# This ensures fromVpcAttributes is used instead of fromLookup, avoiding
# CDK context cache issues in fresh environments (CodeBuild, CloudShell)
auto_save_simple_subnets() {
    local vpc_id=$1
    local region=$(get_region)
    
    if [[ ! -f "/tmp/vpc-analysis.json" ]]; then
        return
    fi
    
    local vpc_cidr=$(aws ec2 describe-vpcs --vpc-ids "$vpc_id" --query 'Vpcs[0].CidrBlock' --output text --region "$region" 2>/dev/null)
    
    node -e "
const fs = require('fs');
const analysis = JSON.parse(fs.readFileSync('/tmp/vpc-analysis.json'));
const subnets = analysis.subnets;
const azs = Object.keys(subnets).sort();

const privateIds = [];
const publicIds = [];

azs.forEach(az => {
    if (subnets[az].private.length === 1) privateIds.push(subnets[az].private[0].SubnetId);
    if (subnets[az].public.length === 1) publicIds.push(subnets[az].public[0].SubnetId);
});

// Write selected-subnets.json for update_parameters to consume
const result = {
    privateSubnetIds: privateIds,
    publicSubnetIds: publicIds,
    availabilityZones: azs
};
fs.writeFileSync('/tmp/selected-subnets.json', JSON.stringify(result, null, 2));
"
    
    # Reuse the existing update_parameters function
    update_parameters
}

# Check if NACLs on the VPC subnets allow UDP traffic for DCV QUIC (ports 8443-8444)
check_nacl_udp_rules() {
    local vpc_id=$1
    local region=$(get_region)
    
    print_status "🔍 Checking NACL rules for DCV UDP/QUIC support..."
    
    local nacls=$(aws ec2 describe-network-acls \
        --filters "Name=vpc-id,Values=$vpc_id" \
        --query 'NetworkAcls[*].{AclId:NetworkAclId,Entries:Entries,Associations:Associations[*].SubnetId}' \
        --output json --region "$region" 2>/dev/null)
    
    if [[ -z "$nacls" ]]; then
        print_warning "Could not retrieve NACLs for VPC $vpc_id"
        return
    fi
    
    node -e "
const nacls = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
let hasIssue = false;

for (const nacl of nacls) {
    const entries = nacl.Entries || [];
    
    // Check if outbound UDP 1024-65535 is allowed (ephemeral ports for QUIC responses)
    const hasOutboundUdp = entries.some(e => {
        if (!e.Egress || e.RuleAction !== 'allow') return false;
        if (e.Protocol === '-1') return true;
        if (e.Protocol === '17' && e.PortRange) {
            return e.PortRange.From <= 1024 && e.PortRange.To >= 65535;
        }
        return false;
    });
    
    if (!hasOutboundUdp) {
        console.log(\"\");
        console.log('⚠️  WARNING: NACL ' + nacl.AclId + ' is missing outbound UDP 1024-65535 rules.');
        console.log('   Subnets: ' + (nacl.Associations || []).join(', '));
        console.log('   DCV native client (QUIC) connections will time out without this rule.');
        console.log('   The deployment will automatically add these rules via a custom resource.');
        hasIssue = true;
    }
}

if (!hasIssue) {
    console.log('✅ All NACLs allow UDP 8443-8444 traffic for DCV QUIC.');
}
" <<< "$nacls"
}

# Interactive subnet selection
select_subnets() {
    local vpc_id=$1
    
    print_status "🎯 Interactive Subnet Selection"
    echo ""
    
    # Read the analysis
    local analysis=$(cat /tmp/vpc-analysis.json)
    
    # Use node to handle the interactive selection
    node -e "
const readline = require('readline');
const fs = require('fs');

const analysis = JSON.parse(fs.readFileSync('/tmp/vpc-analysis.json', 'utf8'));
const subnets = analysis.subnets;
const azs = Object.keys(subnets).sort();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const selectedPrivate = [];
const selectedPublic = [];

async function question(prompt) {
    return new Promise(resolve => rl.question(prompt, resolve));
}

async function selectSubnets() {
    console.log('');
    console.log('For each AZ, select which subnet to use (enter the number):');
    console.log('');
    
    for (const az of azs) {
        const azSubnets = subnets[az];
        
        // Select private subnet
        if (azSubnets.private.length > 1) {
            console.log(\`\n📍 \${az} - Private Subnets:\`);
            azSubnets.private.forEach((s, i) => {
                console.log(\`  [\${i + 1}] \${s.SubnetId} - \${s.CidrBlock} - \${s.Name || 'No Name'}\`);
            });
            
            let choice = 0;
            while (choice < 1 || choice > azSubnets.private.length) {
                const answer = await question(\`  Select private subnet for \${az} (1-\${azSubnets.private.length}): \`);
                choice = parseInt(answer);
            }
            selectedPrivate.push(azSubnets.private[choice - 1].SubnetId);
        } else if (azSubnets.private.length === 1) {
            selectedPrivate.push(azSubnets.private[0].SubnetId);
            console.log(\`\n📍 \${az} - Using only private subnet: \${azSubnets.private[0].SubnetId}\`);
        }
        
        // Select public subnet
        if (azSubnets.public.length > 1) {
            console.log(\`\n📍 \${az} - Public Subnets:\`);
            azSubnets.public.forEach((s, i) => {
                console.log(\`  [\${i + 1}] \${s.SubnetId} - \${s.CidrBlock} - \${s.Name || 'No Name'}\`);
            });
            
            let choice = 0;
            while (choice < 1 || choice > azSubnets.public.length) {
                const answer = await question(\`  Select public subnet for \${az} (1-\${azSubnets.public.length}): \`);
                choice = parseInt(answer);
            }
            selectedPublic.push(azSubnets.public[choice - 1].SubnetId);
        } else if (azSubnets.public.length === 1) {
            selectedPublic.push(azSubnets.public[0].SubnetId);
            console.log(\`\n📍 \${az} - Using only public subnet: \${azSubnets.public[0].SubnetId}\`);
        }
    }
    
    rl.close();
    
    // Output selected subnets
    const result = {
        privateSubnetIds: selectedPrivate,
        publicSubnetIds: selectedPublic,
        availabilityZones: azs
    };
    
    console.log('');
    console.log('='.repeat(60));
    console.log('Selected Subnets:');
    console.log('  Private:', selectedPrivate.join(','));
    console.log('  Public:', selectedPublic.join(','));
    console.log('  AZs:', azs.join(','));
    console.log('='.repeat(60));
    
    fs.writeFileSync('/tmp/selected-subnets.json', JSON.stringify(result, null, 2));
}

selectSubnets().catch(console.error);
"
}

# Update parameters.json with selected subnets
update_parameters() {
    if [[ ! -f "/tmp/selected-subnets.json" ]]; then
        print_error "No subnet selection found"
        return 1
    fi
    
    local selected=$(cat /tmp/selected-subnets.json)
    local private_ids=$(echo "$selected" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin')).privateSubnetIds.join(',')")
    local public_ids=$(echo "$selected" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin')).publicSubnetIds.join(',')")
    local azs=$(echo "$selected" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin')).availabilityZones.join(',')")
    
    # Get VPC CIDR block
    local vpc_id=$(get_vpc_id)
    local vpc_cidr=$(aws ec2 describe-vpcs --vpc-ids "$vpc_id" --query 'Vpcs[0].CidrBlock' --output text 2>/dev/null)
    
    # Look up route table IDs for private subnets (needed for VPC endpoint association)
    local private_route_tables=""
    for subnet_id in $(echo "$private_ids" | tr ',' ' '); do
        local rt_id=$(aws ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$subnet_id" --query "RouteTables[0].RouteTableId" --output text 2>/dev/null)
        if [ -n "$rt_id" ] && [ "$rt_id" != "None" ]; then
            if [ -n "$private_route_tables" ]; then
                private_route_tables="$private_route_tables,$rt_id"
            else
                private_route_tables="$rt_id"
            fi
        fi
    done
    
    print_status "📝 Updating parameters.json with selected subnets..."
    
    # Update parameters.json using node
    node -e "
const fs = require('fs');
const params = JSON.parse(fs.readFileSync('parameters.json', 'utf8'));

// Helper to update or add parameter
function setParam(key, value, description) {
    const existing = params.find(p => p.ParameterKey === key);
    if (existing) {
        existing.ParameterValue = value;
    } else {
        params.push({
            ParameterKey: key,
            ParameterValue: value,
            Description: description || 'Auto-configured by VPC analyzer'
        });
    }
}

setParam('PrivateSubnetIds', '$private_ids', 'Private subnet IDs (one per AZ) for Load Balancers and workstations');
setParam('PublicSubnetIds', '$public_ids', 'Public subnet IDs (one per AZ) for internet-facing resources');
setParam('AvailabilityZones', '$azs', 'Availability zones in use');
setParam('VpcCidr', '$vpc_cidr', 'VPC CIDR block');
setParam('PrivateRouteTableIds', '$private_route_tables', 'Route table IDs for private subnets (for VPC endpoint association)');

fs.writeFileSync('parameters.json', JSON.stringify(params, null, 2));
console.log('✅ parameters.json updated successfully');
"
    
    print_success "Subnet configuration saved to parameters.json"
    echo ""
    print_info "Private Subnets: $private_ids"
    print_info "Public Subnets: $public_ids"
    print_info "Availability Zones: $azs"
    print_info "VPC CIDR: $vpc_cidr"
}

# Main execution
main() {
    local vpc_id=$(get_vpc_id)
    
    if [[ -z "$vpc_id" ]]; then
        print_warning "No VPC ID found in parameters.json - will create new VPC"
        exit 0
    fi
    
    # Analyze the VPC
    analyze_vpc "$vpc_id"
    local result=$?
    
    if [[ $result -eq 2 ]]; then
        # Multiple subnets per AZ detected - proceed with selection
        select_subnets "$vpc_id"
        update_parameters
        exit 0
    fi
}

main "$@"
