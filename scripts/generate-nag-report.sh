#!/bin/bash

# CDK Nag Report Generation Script
set -e

echo "🔍 Generating CDK Nag Security Report..."

# Create reports directory
mkdir -p reports

# Generate timestamp
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
REPORT_FILE="reports/cdk-nag-report_${TIMESTAMP}.txt"

# Build and run CDK Nag
echo "Building CDK application..."
npm run build

echo "Running CDK Nag checks..."
cdk synth --quiet 2>&1 | tee "$REPORT_FILE"

# Count issues
ERRORS=$(grep -c "\[Error" "$REPORT_FILE" || echo "0")
WARNINGS=$(grep -c "\[Warning" "$REPORT_FILE" || echo "0")

echo ""
echo "📊 CDK Nag Report Summary"
echo "========================="
echo "Report saved to: $REPORT_FILE"
echo "Errors found: $ERRORS"
echo "Warnings found: $WARNINGS"
echo ""

if [ "$ERRORS" -gt 0 ]; then
    echo "❌ CDK Nag found $ERRORS error(s) that should be addressed"
    echo ""
    echo "Top Error Categories:"
    grep "\[Error" "$REPORT_FILE" | cut -d']' -f1 | cut -d'[' -f2 | sort | uniq -c | sort -nr | head -5
    exit 1
else
    echo "✅ No CDK Nag errors found!"
fi

if [ "$WARNINGS" -gt 0 ]; then
    echo ""
    echo "⚠️  CDK Nag found $WARNINGS warning(s) for consideration"
    echo ""
    echo "Top Warning Categories:"
    grep "\[Warning" "$REPORT_FILE" | cut -d']' -f1 | cut -d'[' -f2 | sort | uniq -c | sort -nr | head -5
fi

echo ""
echo "🔍 For detailed findings, review: $REPORT_FILE"
