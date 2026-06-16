#!/bin/bash
# Comprehensive Security Scanning Script
# Runs all security tools and generates reports

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REPORT_DIR="$PROJECT_DIR/security-reports"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Create reports directory
mkdir -p "$REPORT_DIR"

echo -e "${BLUE}=== Security Scanning Suite ===${NC}"
echo -e "Project: $PROJECT_DIR"
echo -e "Reports: $REPORT_DIR"
echo -e "Timestamp: $TIMESTAMP\n"

# Track overall status
FAILED_SCANS=()

run_scan() {
    local name="$1"
    local cmd="$2"
    local report_file="$3"
    
    echo -e "${YELLOW}[$name]${NC} Running..."
    
    if eval "$cmd" > "$report_file" 2>&1; then
        echo -e "${GREEN}✓ $name passed${NC}"
        return 0
    else
        echo -e "${RED}✗ $name found issues (see $report_file)${NC}"
        FAILED_SCANS+=("$name")
        return 1
    fi
}

# 1. Bandit - Python Security
echo -e "\n${BLUE}[1/6] Bandit - Python Security Scanner${NC}"
if command -v bandit &> /dev/null; then
    run_scan "Bandit" \
        "bandit -r '$PROJECT_DIR/lambda' -f json --exclude '*/__pycache__/*' -ll" \
        "$REPORT_DIR/bandit-report.json" || true
else
    echo -e "${YELLOW}⚠ Bandit not installed, skipping${NC}"
fi

# 2. cfn_nag - CloudFormation Security
echo -e "\n${BLUE}[2/6] cfn_nag - CloudFormation Security Scanner${NC}"
if command -v cfn_nag &> /dev/null; then
    # First synthesize CDK to get CloudFormation templates
    echo "Synthesizing CDK templates..."
    cd "$PROJECT_DIR"
    npm run build --silent 2>/dev/null || true
    cdk synth --quiet 2>/dev/null || true
    
    if [ -d "$PROJECT_DIR/cdk.out" ]; then
        run_scan "cfn_nag" \
            "cfn_nag_scan --input-path '$PROJECT_DIR/cdk.out' --output-format json" \
            "$REPORT_DIR/cfn-nag-report.json" || true
    else
        echo -e "${YELLOW}⚠ No cdk.out directory found, skipping cfn_nag${NC}"
    fi
else
    echo -e "${YELLOW}⚠ cfn_nag not installed, skipping${NC}"
fi

# 3. Checkov - IaC Security
echo -e "\n${BLUE}[3/6] Checkov - Infrastructure-as-Code Scanner${NC}"
if command -v checkov &> /dev/null; then
    if checkov -d "$PROJECT_DIR" --config-file "$PROJECT_DIR/.checkov.yaml" --compact --quiet > "$REPORT_DIR/checkov-report.txt" 2>&1; then
        echo -e "${GREEN}✓ Checkov passed${NC}"
    else
        # Check if there are actual failures or just warnings
        if grep -q "Failed checks: 0" "$REPORT_DIR/checkov-report.txt"; then
            echo -e "${GREEN}✓ Checkov passed${NC}"
        else
            echo -e "${RED}✗ Checkov found issues (see $REPORT_DIR/checkov-report.txt)${NC}"
            FAILED_SCANS+=("Checkov")
        fi
    fi
else
    echo -e "${YELLOW}⚠ Checkov not installed, skipping${NC}"
fi

# 4. Gitleaks - Secret Detection
echo -e "\n${BLUE}[4/6] Gitleaks - Secret Detection${NC}"
if command -v gitleaks &> /dev/null; then
    run_scan "Gitleaks" \
        "gitleaks detect --source '$PROJECT_DIR' --report-format json --report-path '$REPORT_DIR/gitleaks-report.json' --no-git" \
        "$REPORT_DIR/gitleaks-stdout.txt" || true
else
    echo -e "${YELLOW}⚠ Gitleaks not installed, skipping${NC}"
fi

# 5. Semgrep - Static Analysis
echo -e "\n${BLUE}[5/6] Semgrep - Static Analysis${NC}"
if command -v semgrep &> /dev/null; then
    run_scan "Semgrep" \
        "semgrep scan --config auto --json '$PROJECT_DIR/lambda' '$PROJECT_DIR/lib' '$PROJECT_DIR/frontend/src' 2>/dev/null" \
        "$REPORT_DIR/semgrep-report.json" || true
else
    echo -e "${YELLOW}⚠ Semgrep not installed, skipping${NC}"
fi

# 6. Grype - Dependency Vulnerabilities
echo -e "\n${BLUE}[6/6] Grype - Dependency Vulnerability Scanner${NC}"
if command -v grype &> /dev/null; then
    run_scan "Grype" \
        "grype dir:'$PROJECT_DIR' --output json" \
        "$REPORT_DIR/grype-report.json" || true
else
    echo -e "${YELLOW}⚠ Grype not installed, skipping${NC}"
fi

# Summary
echo -e "\n${BLUE}=== Scan Summary ===${NC}"
echo -e "Reports saved to: $REPORT_DIR"

if [ ${#FAILED_SCANS[@]} -eq 0 ]; then
    echo -e "${GREEN}✓ All scans passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Issues found in: ${FAILED_SCANS[*]}${NC}"
    echo -e "Review the reports in $REPORT_DIR for details"
    exit 1
fi
