#!/bin/bash

# CDK Nag report: synthesizes the app with cdk-nag on (-c nag=true) and counts
# the AwsSolutions findings the CDK CLI prints, by severity, rule and stack.
# Extra arguments go to `cdk synth`, for example: --profile <your-profile>
#
# Review only: exits 0 once the synth has run, whatever it found. It exits
# non-zero only when the build fails, or the synth fails without reporting
# any cdk-nag finding (a real synth error).
set -uo pipefail

echo "🔍 Generating CDK Nag Security Report..."

OUT_DIR="cdk.out.nag"
mkdir -p reports
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
REPORT_FILE="reports/cdk-nag-report_${TIMESTAMP}.txt"

echo "Building CDK application..."
npm run build || exit 1

echo "Running CDK Nag checks (output in $REPORT_FILE)..."
npx cdk synth --quiet -c nag=true -o "$OUT_DIR" "$@" > "$REPORT_FILE" 2>&1
SYNTH_STATUS=$?

# The CLI prints each finding as "ERROR AwsSolutions-<rule>: <message>" or
# "WARNING AwsSolutions-<rule>: ...", followed by the construct path on the
# next line. grep -c prints 0 when nothing matches (and exits 1), so no
# fallback value is needed.
FINDING='^(ERROR|WARNING) AwsSolutions-'
ERRORS=$(grep -cE '^ERROR AwsSolutions-' "$REPORT_FILE" || true)
WARNINGS=$(grep -cE '^WARNING AwsSolutions-' "$REPORT_FILE" || true)
OTHER_ERRORS=$(grep -E '^ERROR ' "$REPORT_FILE" | grep -cv ' AwsSolutions-' || true)

echo ""
echo "📊 CDK Nag Report Summary"
echo "========================="
echo "Report saved to: $REPORT_FILE"
echo "Per-stack CSV reports: $OUT_DIR/AwsSolutions-*-NagReport.csv"
echo "Errors found: $ERRORS"
echo "Warnings found: $WARNINGS"

if [ "$((ERRORS + WARNINGS))" -gt 0 ]; then
    echo ""
    echo "Findings by rule:"
    grep -oE "${FINDING}[A-Za-z0-9]+" "$REPORT_FILE" | awk '{print $2}' | sort | uniq -c | sort -nr
    echo ""
    echo "Findings by stack:"
    awk -v re="$FINDING" '$0 ~ re { if ((getline path) > 0) { sub(/^ +/, "", path); split(path, p, "/"); print p[1] } }' "$REPORT_FILE" \
        | sort | uniq -c | sort -nr
fi

if [ "$OTHER_ERRORS" -gt 0 ]; then
    echo ""
    echo "⚠  $OTHER_ERRORS synth error(s) that are not cdk-nag findings (for example a context lookup without AWS credentials):"
    grep -E '^ERROR ' "$REPORT_FILE" | grep -v ' AwsSolutions-'
fi

if [ "$SYNTH_STATUS" -ne 0 ] && [ "$((ERRORS + WARNINGS))" -eq 0 ]; then
    echo ""
    echo "❌ cdk synth failed (exit $SYNTH_STATUS) without any cdk-nag finding. Last lines:"
    tail -n 20 "$REPORT_FILE"
    exit "$SYNTH_STATUS"
fi

echo ""
echo "🔍 For detailed findings, review: $REPORT_FILE"
