#!/bin/bash

# VPC Analyzer Script
# Analyzes an imported VPC and helps select subnets when multiple exist per AZ
#
# Modes:
#   - PrivateSubnetIds set in parameters.json: validate the given subnets
#     (no prompt) and write PrivateRouteTableIds.
#   - One subnet of each type per AZ: save those subnets.
#   - Several per AZ, with a terminal: prompt for the subnets to use.
#   - Several per AZ, no terminal (CodeBuild): exit 3 on a fresh install with
#     the candidate subnets; on an existing install, warn and keep the VPC
#     lookup it was deployed with.
#   - Every mode that saves subnets first checks that each private subnet has
#     outbound internet access, and exits 1 if one does not.
#   - --check-egress: only that check, on the saved PrivateSubnetIds, as a
#     warning (always exit 0). deploy.sh runs it when the subnets are saved.
#
# Exit codes: 0 = done, 1 = error, 3 = subnet selection needed but no terminal.

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

# Get a parameter value from parameters.json (empty if unset)
get_param() {
    [[ -f "parameters.json" ]] || return 0
    PARAM_KEY="$1" node -p "(JSON.parse(require('fs').readFileSync('parameters.json')).find(p => p.ParameterKey === process.env.PARAM_KEY)?.ParameterValue || '').replace(/\s+/g, '')" 2>/dev/null
}

# Product naming, as in bin/media-resource-manager.ts. The pipeline exports
# ACRONYM and PASCAL_CASE; local runs derive them from cdk.json.
get_product_name() {
    node -p "(require('./cdk.json').context || {}).productName || 'Media Resource Manager'" 2>/dev/null || echo "Media Resource Manager"
}
get_acronym() {
    if [[ -n "$ACRONYM" ]]; then echo "$ACRONYM"; return; fi
    PRODUCT_NAME="$(get_product_name)" node -p "process.env.PRODUCT_NAME.trim().replace(/\s+/g, ' ').split(' ').map(w => w.charAt(0).toUpperCase()).join('')"
}
get_pascal_case() {
    if [[ -n "$PASCAL_CASE" ]]; then echo "$PASCAL_CASE"; return; fi
    PRODUCT_NAME="$(get_product_name)" node -p "process.env.PRODUCT_NAME.trim().replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '')"
}

# All subnets in the VPC (same shape for every caller)
describe_vpc_subnets() {
    aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=$1" \
        --query 'Subnets[*].{SubnetId:SubnetId,AZ:AvailabilityZone,CidrBlock:CidrBlock,MapPublicIpOnLaunch:MapPublicIpOnLaunch,Name:Tags[?Key==`Name`].Value|[0]}' \
        --output json 2>/dev/null
}

# JavaScript for the node snippets that read route tables (`tables`, the
# RouteTables of the VPC): the table a subnet uses (its explicit association,
# else the VPC main table), the target of its default route, and whether that
# route gives a private subnet outbound internet access.
ROUTE_JS='
const mainTable = () => tables.find(t => (t.Associations || []).some(a => a.Main));
const tableFor = id => tables.find(t => (t.Associations || []).some(a => a.SubnetId === id)) || mainTable();
const defaultRouteOf = t => t && (t.Routes || []).find(r => r.DestinationCidrBlock === "0.0.0.0/0");
function describeRoute(r) {
    if (!r) return "no default route";
    const state = r.State === "blackhole" ? " (blackhole)" : "";
    if (r.NatGatewayId) return "NAT gateway " + r.NatGatewayId + state;
    if (r.TransitGatewayId) return "transit gateway " + r.TransitGatewayId + state;
    if (r.InstanceId) return "instance " + r.InstanceId + state;
    if (r.NetworkInterfaceId) return "network interface " + r.NetworkInterfaceId + state;
    if (r.CoreNetworkArn) return "Cloud WAN core network " + r.CoreNetworkArn + state;
    if (r.VpcPeeringConnectionId) return "VPC peering " + r.VpcPeeringConnectionId + state;
    if (r.GatewayId && r.GatewayId.startsWith("igw-")) return "internet gateway " + r.GatewayId + state;
    if (r.GatewayId && r.GatewayId.startsWith("vpce-")) return "VPC endpoint " + r.GatewayId + state;
    if (r.GatewayId) return "gateway " + r.GatewayId + state;
    return "other" + state;
}
// "ok": an active route to a NAT gateway, transit gateway, NAT instance,
// network interface, VPC endpoint (Gateway Load Balancer or AWS Network
// Firewall; describe-route-tables reports it as a vpce- GatewayId) or Cloud
// WAN core network. "unknown": another target that may reach the internet
// (such as a virtual private gateway). "none": no route, a blackhole, an
// internet gateway (private subnets have no public IPs) or VPC peering
// (peering does not carry internet traffic).
function egressOf(r) {
    if (!r || r.State === "blackhole") return "none";
    if (r.NatGatewayId || r.TransitGatewayId || r.InstanceId || r.NetworkInterfaceId || r.CoreNetworkArn) return "ok";
    if (r.GatewayId && r.GatewayId.startsWith("vpce-")) return "ok";
    if (r.VpcPeeringConnectionId || (r.GatewayId && r.GatewayId.startsWith("igw-"))) return "none";
    return "unknown";
}
'

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
    local subnets=$(describe_vpc_subnets "$vpc_id")
    
    if [[ -z "$subnets" ]] || [[ "$subnets" == "[]" ]]; then
        print_error "No subnets found in VPC $vpc_id"
        return 1
    fi
    
    # Route tables, to count subnets whose default route is an internet gateway as public
    local route_tables=$(aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$vpc_id" --query 'RouteTables' --output json 2>/dev/null)
    [[ -n "$route_tables" ]] || route_tables='[]'

    # Parse subnets and group by AZ - use || true to prevent set -e from exiting
    echo "$subnets" | MRM_CLASSIFY_ROUTE_TABLES="$route_tables" node -e "
const subnets = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
const tables = JSON.parse(process.env.MRM_CLASSIFY_ROUTE_TABLES || '[]');
${ROUTE_JS}
function routesToIgw(id) {
    const r = defaultRouteOf(tableFor(id));
    return !!(r && r.GatewayId && r.GatewayId.startsWith('igw-'));
}

// Group subnets by AZ
const byAz = {};
subnets.forEach(s => {
    if (!byAz[s.AZ]) byAz[s.AZ] = { public: [], private: [] };
    // Public: default route to an internet gateway, public IPs on launch, or 'public' in the name
    const isPublic = routesToIgw(s.SubnetId) || s.MapPublicIpOnLaunch || (s.Name && s.Name.toLowerCase().includes('public'));
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
require('fs').writeFileSync(process.env.ANALYSIS_FILE, JSON.stringify(result, null, 2));

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
    if [[ $node_exit -ne 0 && $node_exit -ne 2 ]] || [[ ! -s "$ANALYSIS_FILE" ]]; then
        print_error "Could not analyze the subnets of VPC $vpc_id"
        return 1
    fi
    
    # Read the result from the temp file
    local needs_selection=$(node -p "const a = JSON.parse(require('fs').readFileSync(process.env.ANALYSIS_FILE)); a.hasMultiplePrivatePerAz || a.hasMultiplePublicPerAz")
    if [[ "$needs_selection" == "true" ]]; then
        return 2
    fi
    
    # Check NACLs for UDP rules needed by DCV
    check_nacl_udp_rules "$vpc_id"
    
    # For simple VPCs (one subnet per AZ), auto-write subnet IDs to parameters.json
    # This avoids Vpc.fromLookup() which requires cdk.context.json cache
    auto_save_simple_subnets "$vpc_id" || return 1
    
    return 0
}

# For simple VPCs (one subnet per AZ), auto-save subnet IDs to parameters.json
# This ensures fromVpcAttributes is used instead of fromLookup, avoiding
# CDK context cache issues in fresh environments (CodeBuild, CloudShell)
auto_save_simple_subnets() {
    local vpc_id=$1
    local region=$(get_region)
    
    if [[ ! -s "$ANALYSIS_FILE" ]]; then
        return 1
    fi
    
    local vpc_cidr=$(aws ec2 describe-vpcs --vpc-ids "$vpc_id" --query 'Vpcs[0].CidrBlock' --output text --region "$region" 2>/dev/null)
    
    node -e "
const fs = require('fs');
const analysis = JSON.parse(fs.readFileSync(process.env.ANALYSIS_FILE));
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
fs.writeFileSync(process.env.SELECTION_FILE, JSON.stringify(result, null, 2));
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
    
    # Use node to handle the interactive selection
    node -e "
const readline = require('readline');
const fs = require('fs');

const analysis = JSON.parse(fs.readFileSync(process.env.ANALYSIS_FILE, 'utf8'));
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
    
    fs.writeFileSync(process.env.SELECTION_FILE, JSON.stringify(result, null, 2));
}

selectSubnets().catch(console.error);
"
}

# Check that each private subnet has outbound internet access.
# Workstations and the DCV Connection Gateway download software at boot; one
# launched in a subnet without a NAT route never becomes ready. The ASGs span
# every private subnet, so one isolated subnet is enough to break them.
#   $1 VPC ID, $2 comma-separated private subnet IDs,
#   $3 "fail" (default: an isolated subnet returns 1) or "warn" (print a
#      warning and return 0, for subnets an install is already deployed on).
# Read-only: describe-route-tables and describe-subnets.
check_private_egress() {
    local vpc_id=$1 private_ids=$2 mode=${3:-fail}
    local tables subnets
    print_status "🔍 Checking outbound internet access of the private subnets..."
    tables=$(aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$vpc_id" --query 'RouteTables' --output json 2>&1)
    if [[ $? -ne 0 ]]; then
        if [[ "$mode" == warn ]]; then
            print_warning "Could not read the route tables of VPC $vpc_id to check the private subnets: $tables"
            return 0
        fi
        print_error "Could not read the route tables of VPC $vpc_id: $tables"
        return 1
    fi
    subnets=$(describe_vpc_subnets "$vpc_id")

    echo "$tables" | SUBNETS="$subnets" PRIVATE_IDS="$private_ids" EGRESS_MODE="$mode" node -e "
const fs = require('fs');
const tables = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8') || '[]');
${ROUTE_JS}
const azOf = new Map(JSON.parse(process.env.SUBNETS || '[]').map(s => [s.SubnetId, s.AZ]));
const warnOnly = process.env.EGRESS_MODE === 'warn';
let failed = false;
for (const id of process.env.PRIVATE_IDS.split(',').map(s => s.trim()).filter(Boolean)) {
    const t = tableFor(id);
    const r = defaultRouteOf(t);
    const where = id + ' (' + (azOf.get(id) || 'unknown AZ') + ')';
    const table = t ? 'route table ' + t.RouteTableId + ((t.Associations || []).some(a => a.SubnetId === id) ? '' : ' (VPC main route table)') : 'no route table';
    const egress = t ? egressOf(r) : 'none';
    if (egress === 'ok') {
        console.log('  ✅ ' + where + ': ' + table + ' -> ' + describeRoute(r));
    } else if (egress === 'unknown') {
        console.log('  ⚠️  ' + where + ': ' + table + ' -> ' + describeRoute(r) + '. Check that this target gives outbound internet access.');
    } else if (warnOnly) {
        console.log('  ⚠️  WARNING: ' + where + ': ' + table + ' -> ' + describeRoute(r));
        failed = true;
    } else {
        console.error('  ❌ ' + where + ': ' + table + ' -> ' + describeRoute(r));
        failed = true;
    }
}
process.exit(failed ? 1 : 0);
"
    [[ $? -eq 0 ]] && return 0

    if [[ "$mode" == warn ]]; then
        print_warning "WARNING: a private subnet this install is deployed on has no outbound internet access (see above)."
        echo "  Workstations and the DCV Connection Gateway launched in it cannot download their software and"
        echo "  never become ready. Add a 0.0.0.0/0 route to a NAT gateway, NAT instance, transit gateway,"
        echo "  firewall endpoint or Cloud WAN core network (not a blackhole) to the route table shown."
        echo "  Don't change PrivateSubnetIds instead: that replaces the Managed AD directory."
        echo "  The deployment continues."
        return 0
    fi
    print_error "A private subnet has no outbound internet access (see above)."
    echo "  Private subnets need a 0.0.0.0/0 route to a NAT gateway, NAT instance, transit gateway, firewall"
    echo "  endpoint or Cloud WAN core network that is not a blackhole. Workstations and the DCV Connection"
    echo "  Gateway launched in such a subnet cannot download their software and never become ready."
    echo "  Add that route to the route table shown, or set PrivateSubnetIds to a private subnet with one in"
    echo "  that AZ. On an install that is already deployed, add the route: changing PrivateSubnetIds"
    echo "  replaces the Managed AD directory."
    return 1
}

# Update parameters.json with selected subnets
update_parameters() {
    if [[ ! -s "$SELECTION_FILE" ]]; then
        print_error "No subnet selection found"
        return 1
    fi
    
    local vpc_id=$(get_vpc_id)

    # Every path (explicit, one per AZ, prompted) saves its subnets here, so
    # check their outbound access before writing anything.
    local private_ids=$(node -p "JSON.parse(require('fs').readFileSync(process.env.SELECTION_FILE)).privateSubnetIds.join(',')")
    check_private_egress "$vpc_id" "$private_ids" || return 1

    local public_ids=$(node -p "JSON.parse(require('fs').readFileSync(process.env.SELECTION_FILE)).publicSubnetIds.join(',')")
    local azs=$(node -p "JSON.parse(require('fs').readFileSync(process.env.SELECTION_FILE)).availabilityZones.join(',')")
    
    # Get VPC CIDR block
    local vpc_cidr=$(aws ec2 describe-vpcs --vpc-ids "$vpc_id" --query 'Vpcs[0].CidrBlock' --output text 2>/dev/null)
    
    # Look up route table IDs for private subnets (needed for VPC endpoint association)
    local private_route_tables=""
    for subnet_id in $(echo "$private_ids" | tr ',' ' '); do
        local rt_id=$(aws ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$subnet_id" --query "RouteTables[0].RouteTableId" --output text 2>/dev/null)
        # Private subnets often share a route table; list each one once.
        if [ -n "$rt_id" ] && [ "$rt_id" != "None" ] && [[ ",$private_route_tables," != *",$rt_id,"* ]]; then
            if [ -n "$private_route_tables" ]; then
                private_route_tables="$private_route_tables,$rt_id"
            else
                private_route_tables="$rt_id"
            fi
        fi
    done
    
    print_status "📝 Updating parameters.json with selected subnets..."
    
    # Update parameters.json using node (values passed through the environment, not the script text)
    SEL_PRIVATE="$private_ids" SEL_PUBLIC="$public_ids" SEL_AZS="$azs" SEL_CIDR="$vpc_cidr" SEL_RTS="$private_route_tables" node -e "
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

setParam('PrivateSubnetIds', process.env.SEL_PRIVATE, 'Private subnet IDs (one per AZ) for Load Balancers and workstations');
setParam('PublicSubnetIds', process.env.SEL_PUBLIC, 'Public subnet IDs (one per AZ) for internet-facing resources');
setParam('AvailabilityZones', process.env.SEL_AZS, 'Availability zones in use');
setParam('VpcCidr', process.env.SEL_CIDR, 'VPC CIDR block');
setParam('PrivateRouteTableIds', process.env.SEL_RTS, 'Route table IDs for private subnets (for VPC endpoint association)');

fs.writeFileSync('parameters.json', JSON.stringify(params, null, 2));
console.log('✅ parameters.json updated successfully');
" || return 1
    
    print_success "Subnet configuration saved to parameters.json"
    echo ""
    print_info "Private Subnets: $private_ids"
    print_info "Public Subnets: $public_ids"
    print_info "Availability Zones: $azs"
    print_info "VPC CIDR: $vpc_cidr"
}

# Validate PrivateSubnetIds / PublicSubnetIds from parameters.json without
# prompting, then write the selection for update_parameters. Never reorders:
# CDK places subnet i in AvailabilityZones[i].
validate_explicit_subnets() {
    local vpc_id=$1
    local private_ids=$(get_param PrivateSubnetIds)
    local public_ids=$(get_param PublicSubnetIds)
    local azs=$(get_param AvailabilityZones)

    print_status "🔍 Checking the configured subnets against VPC $vpc_id..."

    local subnets=$(describe_vpc_subnets "$vpc_id")
    if [[ -z "$subnets" ]] || [[ "$subnets" == "[]" ]]; then
        print_error "No subnets found in VPC $vpc_id"
        return 1
    fi

    echo "$subnets" | SEL_PRIVATE="$private_ids" SEL_PUBLIC="$public_ids" SEL_AZS="$azs" VPC_ID="$vpc_id" node -e "
const fs = require('fs');
const inVpc = new Map(JSON.parse(fs.readFileSync('/dev/stdin', 'utf8')).map(s => [s.SubnetId, s]));
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const priv = list(process.env.SEL_PRIVATE);
const pub = list(process.env.SEL_PUBLIC);
let azs = list(process.env.SEL_AZS);
const errors = [];

for (const id of [...priv, ...pub]) {
    if (!/^subnet-[0-9a-f]+\$/.test(id)) errors.push(id + ' is not a subnet ID');
    else if (!inVpc.has(id)) errors.push(id + ' is not in VPC ' + process.env.VPC_ID);
}
const all = [...priv, ...pub];
const dups = all.filter((id, i) => all.indexOf(id) !== i);
if (dups.length) errors.push('listed more than once: ' + [...new Set(dups)].join(','));

if (!errors.length) {
    const az = id => inVpc.get(id).AZ;
    if (priv.length < 2) errors.push('PrivateSubnetIds needs one subnet per AZ in at least 2 AZs (got ' + priv.length + ')');
    const privAzs = priv.map(az);
    if (new Set(privAzs).size !== privAzs.length) errors.push('PrivateSubnetIds has more than one subnet in an AZ (' + priv.map(id => id + '=' + az(id)).join(', ') + ')');
    if (!azs.length) azs = privAzs;
    if (azs.length !== priv.length) errors.push('AvailabilityZones lists ' + azs.length + ' AZ(s) (' + azs.join(',') + ') but PrivateSubnetIds has ' + priv.length + ' subnet(s)');
    priv.forEach((id, i) => { if (azs[i] && az(id) !== azs[i]) errors.push('PrivateSubnetIds[' + i + '] ' + id + ' is in ' + az(id) + ', expected ' + azs[i] + ' (same order as AvailabilityZones)'); });
    if (pub.length) {
        if (pub.length !== priv.length) errors.push('PublicSubnetIds has ' + pub.length + ' subnet(s); give one per AZ, like PrivateSubnetIds (' + priv.length + ')');
        pub.forEach((id, i) => { if (azs[i] && az(id) !== azs[i]) errors.push('PublicSubnetIds[' + i + '] ' + id + ' is in ' + az(id) + ', expected ' + azs[i] + ' (same order as AvailabilityZones)'); });
    }
}

if (errors.length) {
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
}
fs.writeFileSync(process.env.SELECTION_FILE, JSON.stringify({ privateSubnetIds: priv, publicSubnetIds: pub, availabilityZones: azs }, null, 2));
console.log('✅ Subnets OK: one private' + (pub.length ? ' and one public' : '') + ' subnet in each of ' + azs.join(', '));
"
    if [[ $? -ne 0 ]]; then
        print_error "PrivateSubnetIds / PublicSubnetIds are not valid for this VPC (see above)"
        return 1
    fi

    # Changing or reordering the subnets of an existing install replaces AWS Managed
    # Microsoft AD (and with it every domain join), the DNS resolver endpoint and the
    # load balancers, so stop if they differ from the ones it is deployed on.
    check_deployed_subnets PrivateSubnetIds "$private_ids" || return 1
    check_deployed_subnets PublicSubnetIds "$public_ids" || return 1
    return 0
}

# Compare a configured subnet list with the one the install is deployed on
# (the /<PascalName>/Network/<key> parameter that NetworkConstruct writes).
# Order matters: CDK uses the list by position.
check_deployed_subnets() {
    local key=$1 configured=$2
    local name="/$(get_pascal_case)/Network/${key}"
    local out deployed
    out=$(aws ssm get-parameter --name "$name" --query 'Parameter.Value' --output text 2>&1)
    if [[ $? -ne 0 ]]; then
        [[ "$out" == *ParameterNotFound* ]] && return 0
        print_error "Could not read $name to compare with the deployed subnets: $out"
        return 1
    fi
    deployed=$(echo "$out" | tr -d '[:space:]')
    if [[ -n "$deployed" && "$deployed" != "$configured" ]]; then
        print_error "$key differs from the subnets this install is deployed on (or is in a different order)."
        echo "  Deployed:   $deployed"
        echo "  Configured: ${configured:-<empty>}"
        if [[ "$key" == PrivateSubnetIds ]]; then
            echo "  Changing them replaces the Managed AD directory (users and domain joins are lost),"
            echo "  the DNS resolver endpoint and the internal load balancers."
        else
            echo "  Changing them moves the internet-facing DCV load balancer and connection gateway."
        fi
        echo "  Set $key to the deployed value, in the same order, to continue."
        return 1
    fi
    return 0
}

# Explain how to choose subnets when there is no terminal, listing each
# candidate with the target of its default route.
print_selection_help() {
    local vpc_id=$1
    local route_tables=$(aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$vpc_id" --query 'RouteTables' --output json 2>/dev/null)
    [[ -n "$route_tables" ]] || route_tables='[]'

    print_error "VPC $vpc_id has more than one subnet of a type in an Availability Zone, and there is no terminal to choose them."
    echo ""
    echo "Set PrivateSubnetIds and PublicSubnetIds to one subnet per AZ (comma-separated, same AZ order), then deploy again:"
    echo "  - Deploy pipeline: update the pipeline stack and set its PrivateSubnetIds and PublicSubnetIds parameters, or"
    echo "    pass them for one build in MRM_PARAM_OVERRIDES, e.g."
    echo "    {\"PrivateSubnetIds\":\"subnet-aaa,subnet-bbb\",\"PublicSubnetIds\":\"subnet-ccc,subnet-ddd\"}"
    echo "  - Local deploy: add PrivateSubnetIds and PublicSubnetIds to parameters.json, or run ./deploy.sh in a terminal to choose."
    echo ""
    echo "Private subnets need outbound internet access (a NAT gateway, NAT instance or transit gateway)."
    echo ""
    echo "$route_tables" | node -e "
const fs = require('fs');
const analysis = JSON.parse(fs.readFileSync(process.env.ANALYSIS_FILE, 'utf8'));
const tables = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8') || '[]');
${ROUTE_JS}
const defaultRoute = id => describeRoute(defaultRouteOf(tableFor(id)));
console.log('Candidate subnets (default route):');
for (const az of Object.keys(analysis.subnets).sort()) {
    console.log('  ' + az);
    for (const type of ['private', 'public']) {
        for (const s of analysis.subnets[az][type]) {
            console.log('    ' + type.padEnd(8) + s.SubnetId + '  ' + s.CidrBlock + '  ' + (s.Name || 'No Name') + '  -> ' + defaultRoute(s.SubnetId));
        }
    }
}
"
}

# Main execution
main() {
    local vpc_id=$(get_vpc_id)
    
    if [[ -z "$vpc_id" ]]; then
        print_warning "No VPC ID found in parameters.json - will create new VPC"
        exit 0
    fi

    # --check-egress: deploy.sh skips the analyzer when the subnets are already
    # saved, and runs only this. Warn, never fail: the install is deployed on them.
    if [[ "$1" == "--check-egress" ]]; then
        local saved=$(get_param PrivateSubnetIds)
        [[ -n "$saved" ]] && check_private_egress "$vpc_id" "$saved" warn
        exit 0
    fi

    # Private working files (no fixed /tmp names, so a stale selection from an
    # earlier run is never picked up)
    WORK_DIR=$(mktemp -d) || exit 1
    trap 'rm -rf "$WORK_DIR"' EXIT
    export ANALYSIS_FILE="$WORK_DIR/vpc-analysis.json"
    export SELECTION_FILE="$WORK_DIR/selected-subnets.json"

    # Subnets given explicitly: validate them, no prompt
    if [[ -n "$(get_param PrivateSubnetIds)" ]]; then
        validate_explicit_subnets "$vpc_id" || exit 1
        check_nacl_udp_rules "$vpc_id"
        update_parameters || exit 1
        exit 0
    fi
    
    # Analyze the VPC
    analyze_vpc "$vpc_id"
    local result=$?
    [[ $result -eq 0 ]] && exit 0
    [[ $result -eq 2 ]] || exit 1

    # Multiple subnets per AZ detected - prompt when there is a terminal
    if [[ -t 0 ]]; then
        select_subnets "$vpc_id"
        update_parameters || exit 1
        exit 0
    fi

    # No terminal (CodeBuild). An existing install keeps the VPC lookup it was
    # deployed with: pinning subnets now could move its resources.
    local infra_stack="$(get_acronym)-Infrastructure"
    local status rc
    status=$(aws cloudformation describe-stacks --stack-name "$infra_stack" --query 'Stacks[0].StackStatus' --output text 2>&1)
    rc=$?
    if [[ $rc -eq 0 && "$status" != "ROLLBACK_COMPLETE" && "$status" != "REVIEW_IN_PROGRESS" ]]; then
        print_warning "$infra_stack exists ($status): keeping the VPC lookup this install was deployed with."
        print_warning "To pin subnets, set PrivateSubnetIds and PublicSubnetIds to the subnets it already uses."
        exit 0
    fi
    if [[ $rc -ne 0 && "$status" != *"does not exist"* ]]; then
        print_error "Could not check whether $infra_stack exists: $status"
        exit 1
    fi

    print_selection_help "$vpc_id"
    exit 3
}

main "$@"
