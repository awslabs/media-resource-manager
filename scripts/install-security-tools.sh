#!/bin/bash
# Security Scanning Tools Installation Script
# Installs: bandit, cfn_nag, checkov, gitleaks, semgrep, grype

set -e

echo "=== Installing Security Scanning Tools ==="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_command() {
    if command -v "$1" &> /dev/null; then
        echo -e "${GREEN}✓ $1 is installed${NC}"
        return 0
    else
        echo -e "${YELLOW}○ $1 not found, installing...${NC}"
        return 1
    fi
}

# 1. Bandit (Python security linter)
echo -e "\n${YELLOW}[1/6] Bandit (Python security scanner)${NC}"
if ! check_command bandit; then
    pip install --user bandit
    echo -e "${GREEN}✓ Bandit installed${NC}"
fi

# 2. cfn_nag (CloudFormation security linter)
echo -e "\n${YELLOW}[2/6] cfn_nag (CloudFormation security scanner)${NC}"
if ! check_command cfn_nag; then
    if command -v gem &> /dev/null; then
        gem install cfn-nag --user-install
        echo -e "${GREEN}✓ cfn_nag installed${NC}"
    else
        echo -e "${RED}✗ Ruby/gem not found. Install Ruby first or use: sudo apt install ruby${NC}"
    fi
fi

# 3. Checkov (IaC security scanner)
echo -e "\n${YELLOW}[3/6] Checkov (Infrastructure-as-Code scanner)${NC}"
if ! check_command checkov; then
    pip install --user checkov
    echo -e "${GREEN}✓ Checkov installed${NC}"
fi

# 4. Gitleaks (Secret detection)
echo -e "\n${YELLOW}[4/6] Gitleaks (Secret detection)${NC}"
if ! check_command gitleaks; then
    # Try to install via package manager or download binary
    if command -v brew &> /dev/null; then
        brew install gitleaks
    else
        # Download latest release for Linux
        GITLEAKS_VERSION=$(curl -s https://api.github.com/repos/gitleaks/gitleaks/releases/latest | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
        curl -sSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" | tar -xz -C ~/.local/bin gitleaks
        chmod +x ~/.local/bin/gitleaks
    fi
    echo -e "${GREEN}✓ Gitleaks installed${NC}"
fi

# 5. Semgrep (Static analysis)
echo -e "\n${YELLOW}[5/6] Semgrep (Static analysis)${NC}"
if ! check_command semgrep; then
    pip install --user semgrep
    echo -e "${GREEN}✓ Semgrep installed${NC}"
fi

# 6. Grype (Container vulnerability scanner)
echo -e "\n${YELLOW}[6/6] Grype (Vulnerability scanner)${NC}"
if ! check_command grype; then
    curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b ~/.local/bin
    echo -e "${GREEN}✓ Grype installed${NC}"
fi

echo -e "\n${GREEN}=== Installation Complete ===${NC}"
echo -e "Make sure ~/.local/bin is in your PATH:"
echo -e "  export PATH=\"\$HOME/.local/bin:\$PATH\""
echo -e "\nRun 'npm run security:all' to execute all security scans"
