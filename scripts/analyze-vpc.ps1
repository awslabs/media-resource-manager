# VPC Analyzer Script (Windows PowerShell)
# Analyzes an imported VPC and helps select subnets when multiple exist per AZ

$ErrorActionPreference = "Continue"

# Helper functions
function Write-Status($msg) { Write-Host $msg -ForegroundColor Blue }
function Write-Ok($msg) { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "  $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor Cyan }

function Get-VpcId {
    if (-not (Test-Path "parameters.json")) { return "" }
    node -p "JSON.parse(require('fs').readFileSync('parameters.json')).find(p => p.ParameterKey === 'VpcId')?.ParameterValue || ''" 2>$null
}

function Get-CurrentRegion {
    $region = aws configure get region 2>$null
    if (-not $region) { $region = $env:AWS_REGION }
    if (-not $region) { $region = $env:AWS_DEFAULT_REGION }
    if (-not $region) { $region = "us-east-1" }
    return $region
}

function Analyze-Vpc {
    param([string]$VpcId)

    $region = Get-CurrentRegion
    Write-Status "Analyzing VPC: $VpcId in region: $region"
    Write-Host ""

    # Get all subnets in the VPC
    $subnetsJson = aws ec2 describe-subnets `
        --filters "Name=vpc-id,Values=$VpcId" `
        --query 'Subnets[*].{SubnetId:SubnetId,AZ:AvailabilityZone,CidrBlock:CidrBlock,MapPublicIpOnLaunch:MapPublicIpOnLaunch,Name:Tags[?Key==`Name`].Value|[0]}' `
        --output json --region $region 2>$null

    if (-not $subnetsJson -or $subnetsJson -eq "[]") {
        Write-Err "No subnets found in VPC $VpcId"
        return 1
    }

    # Use node to analyze and display subnet info
    $analysisScript = @"
const fs = require('fs');
const subnets = JSON.parse(process.argv[1]);

// Group subnets by AZ
const byAz = {};
subnets.forEach(s => {
    if (!byAz[s.AZ]) byAz[s.AZ] = { public: [], private: [] };
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

let hasMultiplePrivatePerAz = false;
let hasMultiplePublicPerAz = false;

Object.keys(byAz).sort().forEach(az => {
    console.log('');
    console.log('  Availability Zone: ' + az);
    console.log('-'.repeat(40));

    console.log('  Public Subnets (' + byAz[az].public.length + '):');
    byAz[az].public.forEach((s, i) => {
        console.log('    [' + (i + 1) + '] ' + s.SubnetId + ' - ' + s.CidrBlock + ' - ' + (s.Name || 'No Name'));
    });
    if (byAz[az].public.length > 1) hasMultiplePublicPerAz = true;

    console.log('  Private Subnets (' + byAz[az].private.length + '):');
    byAz[az].private.forEach((s, i) => {
        console.log('    [' + (i + 1) + '] ' + s.SubnetId + ' - ' + s.CidrBlock + ' - ' + (s.Name || 'No Name'));
    });
    if (byAz[az].private.length > 1) hasMultiplePrivatePerAz = true;
});

console.log('');
console.log('='.repeat(80));

const result = {
    hasMultiplePrivatePerAz,
    hasMultiplePublicPerAz,
    azCount: Object.keys(byAz).length,
    subnets: byAz
};

fs.writeFileSync('vpc-analysis.json', JSON.stringify(result, null, 2));

if (hasMultiplePrivatePerAz || hasMultiplePublicPerAz) {
    console.log('');
    console.log('WARNING: Multiple subnets detected per Availability Zone!');
    console.log('Load Balancers can only be attached to ONE subnet per AZ.');
    console.log('You need to select which subnets to use for deployment.');
    process.exit(2);
} else {
    console.log('');
    console.log('VPC has one subnet per AZ - no selection needed.');
    process.exit(0);
}
"@

    # Write the script to a temp file to avoid argument length issues
    $tempScript = [System.IO.Path]::GetTempFileName() + ".js"
    Set-Content -Path $tempScript -Value $analysisScript -Encoding UTF8

    node $tempScript $subnetsJson
    $nodeExit = $LASTEXITCODE
    Remove-Item $tempScript -ErrorAction SilentlyContinue

    if ($nodeExit -eq 2) {
        return 2
    }

    # For simple VPCs, auto-save subnet IDs
    if (Test-Path "vpc-analysis.json") {
        Check-NaclUdpRules -VpcId $VpcId
        Save-SimpleSubnets -VpcId $VpcId
    }

    return 0
}

function Check-NaclUdpRules {
    param([string]$VpcId)

    $region = Get-CurrentRegion
    Write-Status "Checking NACL rules for DCV UDP/QUIC support..."

    $naclsJson = aws ec2 describe-network-acls `
        --filters "Name=vpc-id,Values=$VpcId" `
        --query 'NetworkAcls[*].{AclId:NetworkAclId,Entries:Entries,Associations:Associations[*].SubnetId}' `
        --output json --region $region 2>$null

    if (-not $naclsJson) {
        Write-Warn "Could not retrieve NACLs for VPC $VpcId"
        return
    }

    $checkScript = @"
const nacls = JSON.parse(process.argv[1]);
let hasIssue = false;

for (const nacl of nacls) {
    const entries = nacl.Entries || [];
    const hasOutboundUdp = entries.some(e => {
        if (!e.Egress || e.RuleAction !== 'allow') return false;
        if (e.Protocol === '-1') return true;
        if (e.Protocol === '17' && e.PortRange) {
            return e.PortRange.From <= 1024 && e.PortRange.To >= 65535;
        }
        return false;
    });

    if (!hasOutboundUdp) {
        console.log('');
        console.log('WARNING: NACL ' + nacl.AclId + ' is missing outbound UDP 1024-65535 rules.');
        console.log('   Subnets: ' + (nacl.Associations || []).join(', '));
        console.log('   DCV native client (QUIC) connections will time out without this rule.');
        console.log('   The deployment will automatically add these rules via a custom resource.');
        hasIssue = true;
    }
}

if (!hasIssue) {
    console.log('All NACLs allow UDP traffic for DCV QUIC.');
}
"@

    $tempScript = [System.IO.Path]::GetTempFileName() + ".js"
    Set-Content -Path $tempScript -Value $checkScript -Encoding UTF8
    node $tempScript $naclsJson
    Remove-Item $tempScript -ErrorAction SilentlyContinue
}

function Save-SimpleSubnets {
    param([string]$VpcId)

    if (-not (Test-Path "vpc-analysis.json")) { return }

    $region = Get-CurrentRegion
    $vpcCidr = aws ec2 describe-vpcs --vpc-ids $VpcId --query 'Vpcs[0].CidrBlock' --output text --region $region 2>$null

    $saveScript = @"
const fs = require('fs');
const analysis = JSON.parse(fs.readFileSync('vpc-analysis.json'));
const subnets = analysis.subnets;
const azs = Object.keys(subnets).sort();

const privateIds = [];
const publicIds = [];

azs.forEach(az => {
    if (subnets[az].private.length === 1) privateIds.push(subnets[az].private[0].SubnetId);
    if (subnets[az].public.length === 1) publicIds.push(subnets[az].public[0].SubnetId);
});

const result = {
    privateSubnetIds: privateIds,
    publicSubnetIds: publicIds,
    availabilityZones: azs
};
fs.writeFileSync('selected-subnets.json', JSON.stringify(result, null, 2));
"@

    $tempScript = [System.IO.Path]::GetTempFileName() + ".js"
    Set-Content -Path $tempScript -Value $saveScript -Encoding UTF8
    node $tempScript
    Remove-Item $tempScript -ErrorAction SilentlyContinue

    # Now update parameters.json
    Update-Parameters -VpcId $VpcId -VpcCidr $vpcCidr
}

function Select-Subnets {
    param([string]$VpcId)

    Write-Status "Interactive Subnet Selection"
    Write-Host ""

    if (-not (Test-Path "vpc-analysis.json")) {
        Write-Err "No VPC analysis found"
        return
    }

    $selectScript = @"
const readline = require('readline');
const fs = require('fs');

const analysis = JSON.parse(fs.readFileSync('vpc-analysis.json', 'utf8'));
const subnets = analysis.subnets;
const azs = Object.keys(subnets).sort();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const selectedPrivate = [];
const selectedPublic = [];

function question(prompt) {
    return new Promise(resolve => rl.question(prompt, resolve));
}

async function selectSubnets() {
    console.log('');
    console.log('For each AZ, select which subnet to use (enter the number):');

    for (const az of azs) {
        const azSubnets = subnets[az];

        if (azSubnets.private.length > 1) {
            console.log('');
            console.log(az + ' - Private Subnets:');
            azSubnets.private.forEach((s, i) => {
                console.log('  [' + (i + 1) + '] ' + s.SubnetId + ' - ' + s.CidrBlock + ' - ' + (s.Name || 'No Name'));
            });
            let choice = 0;
            while (choice < 1 || choice > azSubnets.private.length) {
                const answer = await question('  Select private subnet for ' + az + ' (1-' + azSubnets.private.length + '): ');
                choice = parseInt(answer);
            }
            selectedPrivate.push(azSubnets.private[choice - 1].SubnetId);
        } else if (azSubnets.private.length === 1) {
            selectedPrivate.push(azSubnets.private[0].SubnetId);
            console.log(az + ' - Using only private subnet: ' + azSubnets.private[0].SubnetId);
        }

        if (azSubnets.public.length > 1) {
            console.log('');
            console.log(az + ' - Public Subnets:');
            azSubnets.public.forEach((s, i) => {
                console.log('  [' + (i + 1) + '] ' + s.SubnetId + ' - ' + s.CidrBlock + ' - ' + (s.Name || 'No Name'));
            });
            let choice = 0;
            while (choice < 1 || choice > azSubnets.public.length) {
                const answer = await question('  Select public subnet for ' + az + ' (1-' + azSubnets.public.length + '): ');
                choice = parseInt(answer);
            }
            selectedPublic.push(azSubnets.public[choice - 1].SubnetId);
        } else if (azSubnets.public.length === 1) {
            selectedPublic.push(azSubnets.public[0].SubnetId);
            console.log(az + ' - Using only public subnet: ' + azSubnets.public[0].SubnetId);
        }
    }

    rl.close();

    const result = {
        privateSubnetIds: selectedPrivate,
        publicSubnetIds: selectedPublic,
        availabilityZones: azs
    };

    console.log('');
    console.log('='.repeat(60));
    console.log('Selected Subnets:');
    console.log('  Private: ' + selectedPrivate.join(','));
    console.log('  Public: ' + selectedPublic.join(','));
    console.log('  AZs: ' + azs.join(','));
    console.log('='.repeat(60));

    fs.writeFileSync('selected-subnets.json', JSON.stringify(result, null, 2));
}

selectSubnets().catch(console.error);
"@

    $tempScript = [System.IO.Path]::GetTempFileName() + ".js"
    Set-Content -Path $tempScript -Value $selectScript -Encoding UTF8
    node $tempScript
    Remove-Item $tempScript -ErrorAction SilentlyContinue
}

# Check that each selected private subnet has outbound internet access, as
# check_private_egress in analyze-vpc.sh does. Its route table (the explicit
# association, else the VPC main table) needs an active 0.0.0.0/0 route to a
# NAT gateway, transit gateway, NAT instance or network interface. Workstations
# and the DCV Connection Gateway launched without one never become ready.
function Test-PrivateEgress {
    param([string]$VpcId, [string[]]$SubnetIds)

    $region = Get-CurrentRegion
    Write-Status "Checking outbound internet access of the private subnets..."

    $tablesJson = aws ec2 describe-route-tables `
        --filters "Name=vpc-id,Values=$VpcId" `
        --query 'RouteTables' --output json --region $region 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $tablesJson) {
        Write-Err "Could not read the route tables of VPC $VpcId"
        return $false
    }
    $subnetsJson = aws ec2 describe-subnets `
        --filters "Name=vpc-id,Values=$VpcId" `
        --query 'Subnets[*].{SubnetId:SubnetId,AZ:AvailabilityZone}' `
        --output json --region $region 2>$null

    # Passed through the environment: native arguments lose their quotes on Windows
    $env:MRM_ROUTE_TABLES = ($tablesJson -join "`n")
    $env:MRM_SUBNETS = ($subnetsJson -join "`n")
    $env:MRM_PRIVATE_IDS = ($SubnetIds -join ",")

    $checkScript = @"
const tables = JSON.parse(process.env.MRM_ROUTE_TABLES || '[]');
const azOf = new Map(JSON.parse(process.env.MRM_SUBNETS || '[]').map(s => [s.SubnetId, s.AZ]));
const mainTable = () => tables.find(t => (t.Associations || []).some(a => a.Main));
const tableFor = id => tables.find(t => (t.Associations || []).some(a => a.SubnetId === id)) || mainTable();
const defaultRouteOf = t => t && (t.Routes || []).find(r => r.DestinationCidrBlock === '0.0.0.0/0');
function describeRoute(r) {
    if (!r) return 'no default route';
    const state = r.State === 'blackhole' ? ' (blackhole)' : '';
    if (r.NatGatewayId) return 'NAT gateway ' + r.NatGatewayId + state;
    if (r.TransitGatewayId) return 'transit gateway ' + r.TransitGatewayId + state;
    if (r.InstanceId) return 'instance ' + r.InstanceId + state;
    if (r.NetworkInterfaceId) return 'network interface ' + r.NetworkInterfaceId + state;
    if (r.VpcPeeringConnectionId) return 'VPC peering ' + r.VpcPeeringConnectionId + state;
    if (r.GatewayId && r.GatewayId.startsWith('igw-')) return 'internet gateway ' + r.GatewayId + state;
    if (r.GatewayId) return 'gateway ' + r.GatewayId + state;
    return 'other' + state;
}
function egressOf(r) {
    if (!r || r.State === 'blackhole') return 'none';
    if (r.NatGatewayId || r.TransitGatewayId || r.InstanceId || r.NetworkInterfaceId) return 'ok';
    if (r.VpcPeeringConnectionId || (r.GatewayId && r.GatewayId.startsWith('igw-'))) return 'none';
    return 'unknown';
}
let failed = false;
for (const id of (process.env.MRM_PRIVATE_IDS || '').split(',').filter(Boolean)) {
    const t = tableFor(id);
    const r = defaultRouteOf(t);
    const where = id + ' (' + (azOf.get(id) || 'unknown AZ') + ')';
    const table = t ? 'route table ' + t.RouteTableId + ((t.Associations || []).some(a => a.SubnetId === id) ? '' : ' (VPC main route table)') : 'no route table';
    const egress = t ? egressOf(r) : 'none';
    if (egress === 'ok') console.log('  OK ' + where + ': ' + table + ' -> ' + describeRoute(r));
    else if (egress === 'unknown') console.log('  WARNING ' + where + ': ' + table + ' -> ' + describeRoute(r) + '. Check that this target gives outbound internet access.');
    else { console.log('  ERROR ' + where + ': ' + table + ' -> ' + describeRoute(r)); failed = true; }
}
process.exit(failed ? 1 : 0);
"@

    $tempScript = [System.IO.Path]::GetTempFileName() + ".js"
    Set-Content -Path $tempScript -Value $checkScript -Encoding UTF8
    node $tempScript | Out-Host
    $nodeExit = $LASTEXITCODE
    Remove-Item $tempScript -ErrorAction SilentlyContinue
    Remove-Item Env:MRM_ROUTE_TABLES, Env:MRM_SUBNETS, Env:MRM_PRIVATE_IDS -ErrorAction SilentlyContinue

    if ($nodeExit -ne 0) {
        Write-Err "A private subnet has no outbound internet access (see above)."
        Write-Err "Private subnets need a 0.0.0.0/0 route to a NAT gateway, NAT instance or transit gateway that is"
        Write-Err "not a blackhole. Workstations and the DCV Connection Gateway launched in such a subnet cannot"
        Write-Err "download their software and never become ready."
        Write-Err "Add that route to the route table shown, or set PrivateSubnetIds to a private subnet with one in"
        Write-Err "that AZ. On an install that is already deployed, add the route: changing PrivateSubnetIds"
        Write-Err "replaces the Managed AD directory."
        return $false
    }
    return $true
}

function Update-Parameters {
    param(
        [string]$VpcId,
        [string]$VpcCidr
    )

    if (-not (Test-Path "selected-subnets.json")) {
        Write-Err "No subnet selection found"
        return
    }

    $selected = Get-Content "selected-subnets.json" | ConvertFrom-Json

    # Check the private subnets before writing anything; stop the deploy if one is isolated
    if (-not (Test-PrivateEgress -VpcId $VpcId -SubnetIds $selected.privateSubnetIds)) {
        Remove-Item "selected-subnets.json", "vpc-analysis.json" -ErrorAction SilentlyContinue
        exit 1
    }
    $privateIds = $selected.privateSubnetIds -join ","
    $publicIds = $selected.publicSubnetIds -join ","
    $azs = $selected.availabilityZones -join ","

    # Look up route table IDs for private subnets
    $region = Get-CurrentRegion
    $routeTableIds = @()
    foreach ($subnetId in $selected.privateSubnetIds) {
        $rtId = aws ec2 describe-route-tables `
            --filters "Name=association.subnet-id,Values=$subnetId" `
            --query "RouteTables[0].RouteTableId" `
            --output text --region $region 2>$null
        if ($rtId -and $rtId -ne "None") {
            $routeTableIds += $rtId
        }
    }
    $privateRouteTables = $routeTableIds -join ","

    if (-not $VpcCidr) {
        $VpcCidr = aws ec2 describe-vpcs --vpc-ids $VpcId --query 'Vpcs[0].CidrBlock' --output text --region $region 2>$null
    }

    Write-Status "Updating parameters.json with selected subnets..."

    $updateScript = @"
const fs = require('fs');
const params = JSON.parse(fs.readFileSync('parameters.json', 'utf8'));

function setParam(key, value, description) {
    const existing = params.find(p => p.ParameterKey === key);
    if (existing) {
        existing.ParameterValue = value;
    } else {
        params.push({ ParameterKey: key, ParameterValue: value, Description: description || 'Auto-configured by VPC analyzer' });
    }
}

setParam('PrivateSubnetIds', '$privateIds', 'Private subnet IDs (one per AZ) for Load Balancers and workstations');
setParam('PublicSubnetIds', '$publicIds', 'Public subnet IDs (one per AZ) for internet-facing resources');
setParam('AvailabilityZones', '$azs', 'Availability zones in use');
setParam('VpcCidr', '$VpcCidr', 'VPC CIDR block');
setParam('PrivateRouteTableIds', '$privateRouteTables', 'Route table IDs for private subnets (for VPC endpoint association)');

fs.writeFileSync('parameters.json', JSON.stringify(params, null, 2));
console.log('parameters.json updated successfully');
"@

    $tempScript = [System.IO.Path]::GetTempFileName() + ".js"
    Set-Content -Path $tempScript -Value $updateScript -Encoding UTF8
    node $tempScript
    Remove-Item $tempScript -ErrorAction SilentlyContinue

    Write-Ok "Subnet configuration saved to parameters.json"
    Write-Host ""
    Write-Info "Private Subnets: $privateIds"
    Write-Info "Public Subnets: $publicIds"
    Write-Info "Availability Zones: $azs"
    Write-Info "VPC CIDR: $VpcCidr"

    # Clean up temp files
    Remove-Item "selected-subnets.json" -ErrorAction SilentlyContinue
    Remove-Item "vpc-analysis.json" -ErrorAction SilentlyContinue
}

# Main execution
$vpcId = Get-VpcId

if (-not $vpcId) {
    Write-Warn "No VPC ID found in parameters.json - will create new VPC"
    exit 0
}

$result = Analyze-Vpc -VpcId $vpcId

if ($result -eq 2) {
    Select-Subnets -VpcId $vpcId
    $region = Get-CurrentRegion
    $vpcCidr = aws ec2 describe-vpcs --vpc-ids $vpcId --query 'Vpcs[0].CidrBlock' --output text --region $region 2>$null
    Update-Parameters -VpcId $vpcId -VpcCidr $vpcCidr
}

# Clean up temp files
Remove-Item "vpc-analysis.json" -ErrorAction SilentlyContinue

# Explicit, so deploy.ps1 reads 0 here rather than the last native command's exit code
exit 0
