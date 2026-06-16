#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

#
# Cleanup stuck "deleting" storage records in Media Resource Manager.
#
# WHY: Before the fix in commit 98ea08c, the delete-storage Lambda only
# marked DataSync task DynamoDB records as "invalid" — it did not actually
# delete the DataSync task or location in AWS. That left DataSync ENIs
# attached to the FSx security group, which caused CloudFormation stack
# deletes to fail with DependencyViolation, which crashed the state machine,
# which left the storage record stuck at status "deleting" forever.
#
# This script cleans up those stuck records in the correct order:
#   1. DataSync tasks (AWS + DynamoDB) — releases ENIs
#   2. DataSync locations (AWS + DynamoDB) — completes ENI release
#   3. CloudFormation stack (retry delete if DELETE_FAILED)
#   4. mrm-storage DynamoDB row
#
# Once the fix in commit 98ea08c is deployed to an account, future storage
# deletes handle this automatically. This script is for cleaning up stuck
# records that were created before the fix.
#
# Usage:
#   ./scripts/cleanup-stuck-storage.sh [--region REGION] [--storage-id ID] [--execute]
#
# Flags:
#   --region REGION       AWS region (default: us-east-1)
#   --storage-id ID       Only process this specific storageId (default: all stuck)
#   --execute             Actually perform the deletes. Without this, runs dry-run.
#   --storage-table NAME  Override mrm-storage table name (default: mrm-storage)
#   --datasync-table NAME Override mrm-datasync table name (default: mrm-datasync)
#
# Examples:
#   # Dry-run: show what would be cleaned up across all stuck records
#   ./scripts/cleanup-stuck-storage.sh
#
#   # Actually run against one specific stuck record
#   ./scripts/cleanup-stuck-storage.sh --storage-id 01b2fcac-5db9-4225-acd8-fce86c268055 --execute
#
#   # Run against all stuck records in a different region
#   ./scripts/cleanup-stuck-storage.sh --region eu-west-1 --execute

set -euo pipefail

REGION="us-east-1"
TARGET_STORAGE_ID=""
EXECUTE=false
STORAGE_TABLE="mrm-storage"
DATASYNC_TABLE="mrm-datasync"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --storage-id) TARGET_STORAGE_ID="$2"; shift 2 ;;
    --execute) EXECUTE=true; shift ;;
    --storage-table) STORAGE_TABLE="$2"; shift 2 ;;
    --datasync-table) DATASYNC_TABLE="$2"; shift 2 ;;
    -h|--help) sed -n '/^# Usage/,/^set -euo pipefail/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

run_or_echo() {
  # Runs the command if --execute is set, otherwise just prints it
  if $EXECUTE; then
    "$@"
  else
    echo -e "${YELLOW}  [dry-run] $*${NC}"
  fi
}

banner() {
  echo ""
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE} $* ${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════════${NC}"
}

# Verify AWS credentials
ACCOUNT=$(aws sts get-caller-identity --query Account --output text --region "$REGION" 2>/dev/null || true)
if [[ -z "$ACCOUNT" ]]; then
  echo -e "${RED}Unable to get AWS account ID. Check your AWS credentials.${NC}" >&2
  exit 1
fi

banner "Media Resource Manager — Stuck Storage Cleanup"
echo "  Account:        $ACCOUNT"
echo "  Region:         $REGION"
echo "  Storage table:  $STORAGE_TABLE"
echo "  DataSync table: $DATASYNC_TABLE"
if $EXECUTE; then
  echo -e "  Mode:           ${RED}EXECUTE (will make changes)${NC}"
else
  echo -e "  Mode:           ${YELLOW}DRY-RUN (pass --execute to actually delete)${NC}"
fi

# ---------------------------------------------------------------------------
# Step 1: Identify stuck records
# ---------------------------------------------------------------------------
banner "Step 1: Find stuck storage records (status = 'deleting')"

if [[ -n "$TARGET_STORAGE_ID" ]]; then
  STUCK_JSON=$(aws dynamodb get-item \
    --table-name "$STORAGE_TABLE" --region "$REGION" \
    --key "{\"storageId\":{\"S\":\"$TARGET_STORAGE_ID\"}}" \
    --query 'Item' --output json 2>/dev/null || echo "null")
  if [[ "$STUCK_JSON" == "null" || -z "$STUCK_JSON" ]]; then
    echo -e "${RED}No record found for storageId $TARGET_STORAGE_ID${NC}" >&2
    exit 1
  fi
  STUCK_IDS=("$TARGET_STORAGE_ID")
else
  mapfile -t STUCK_IDS < <(aws dynamodb scan \
    --table-name "$STORAGE_TABLE" --region "$REGION" \
    --filter-expression "#s = :d" \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values '{":d":{"S":"deleting"}}' \
    --query 'Items[].storageId.S' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)
fi

if [[ ${#STUCK_IDS[@]} -eq 0 ]]; then
  echo -e "${GREEN}No stuck storage records found — nothing to do.${NC}"
  exit 0
fi

echo "Found ${#STUCK_IDS[@]} stuck storage record(s):"
for SID in "${STUCK_IDS[@]}"; do
  NAME=$(aws dynamodb get-item --table-name "$STORAGE_TABLE" --region "$REGION" \
    --key "{\"storageId\":{\"S\":\"$SID\"}}" \
    --query 'Item.name.S' --output text 2>/dev/null || echo "?")
  TYPE=$(aws dynamodb get-item --table-name "$STORAGE_TABLE" --region "$REGION" \
    --key "{\"storageId\":{\"S\":\"$SID\"}}" \
    --query 'Item.type.S' --output text 2>/dev/null || echo "?")
  echo "  • $SID ($NAME, type=$TYPE)"
done

# ---------------------------------------------------------------------------
# Process each stuck record
# ---------------------------------------------------------------------------
for SID in "${STUCK_IDS[@]}"; do
  banner "Processing storageId: $SID"

  STACK_NAME=$(aws dynamodb get-item --table-name "$STORAGE_TABLE" --region "$REGION" \
    --key "{\"storageId\":{\"S\":\"$SID\"}}" \
    --query 'Item.cloudFormationStackName.S' --output text 2>/dev/null || echo "None")
  echo "  CloudFormation stack: $STACK_NAME"

  # -------------------------------------------------------------------------
  # Step 2: DataSync locations referencing this storage (mrm-datasync)
  # -------------------------------------------------------------------------
  echo ""
  echo -e "${BLUE}── Step 2: Find DataSync locations referencing $SID ──${NC}"
  LOCATIONS_JSON=$(aws dynamodb scan --table-name "$DATASYNC_TABLE" --region "$REGION" \
    --filter-expression "storageId = :sid AND #t = :l" \
    --expression-attribute-names '{"#t":"type"}' \
    --expression-attribute-values "{\":sid\":{\"S\":\"$SID\"},\":l\":{\"S\":\"LOCATION\"}}" \
    --query 'Items' --output json 2>/dev/null || echo "[]")

  LOC_COUNT=$(echo "$LOCATIONS_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
  echo "  Found $LOC_COUNT location(s) in $DATASYNC_TABLE"

  # Extract location IDs and ARNs
  mapfile -t LOCATION_IDS < <(echo "$LOCATIONS_JSON" | python3 -c 'import json,sys
for x in json.load(sys.stdin):
    lid = x.get("locationId",{}).get("S","")
    if lid: print(lid)')
  mapfile -t LOCATION_ARNS < <(echo "$LOCATIONS_JSON" | python3 -c 'import json,sys
for x in json.load(sys.stdin):
    arn = x.get("locationArn",{}).get("S","")
    if arn: print(arn)')

  # -------------------------------------------------------------------------
  # Step 3: Find and delete DataSync TASKS referencing those locations
  # -------------------------------------------------------------------------
  echo ""
  echo -e "${BLUE}── Step 3: Delete DataSync tasks pointing at those locations ──${NC}"
  if [[ ${#LOCATION_IDS[@]} -gt 0 ]]; then
    TASKS_JSON=$(aws dynamodb scan --table-name "$DATASYNC_TABLE" --region "$REGION" \
      --filter-expression "#t = :t" \
      --expression-attribute-names '{"#t":"type"}' \
      --expression-attribute-values '{":t":{"S":"TASK"}}' \
      --query 'Items' --output json 2>/dev/null || echo "[]")

    LOC_IDS_JSON=$(printf '%s\n' "${LOCATION_IDS[@]}" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')

    AFFECTED_TASKS=$(echo "$TASKS_JSON" | python3 -c "
import json, sys
locs = set($LOC_IDS_JSON)
for x in json.load(sys.stdin):
    src = x.get('sourceLocationId',{}).get('S','')
    dst = x.get('destinationLocationId',{}).get('S','')
    if src in locs or dst in locs:
        tid = x.get('taskId',{}).get('S','')
        tarn = x.get('taskArn',{}).get('S','')
        tname = x.get('name',{}).get('S','')
        print(f'{tid}\t{tarn}\t{tname}')
")

    if [[ -z "$AFFECTED_TASKS" ]]; then
      echo "  No tasks reference these locations."
    else
      echo "$AFFECTED_TASKS" | while IFS=$'\t' read -r TID TARN TNAME; do
        [[ -z "$TID" ]] && continue
        echo "  Task $TID ($TNAME)"
        if [[ -n "$TARN" ]]; then
          run_or_echo aws datasync delete-task --task-arn "$TARN" --region "$REGION"
        fi

        # Delete EXECUTION# rows first
        EXECS=$(aws dynamodb query --table-name "$DATASYNC_TABLE" --region "$REGION" \
          --key-condition-expression "pk = :pk AND begins_with(sk, :skp)" \
          --expression-attribute-values "{\":pk\":{\"S\":\"TASK#$TID\"},\":skp\":{\"S\":\"EXECUTION#\"}}" \
          --query 'Items[].sk.S' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)
        if [[ -n "$EXECS" ]]; then
          EXEC_COUNT=$(echo "$EXECS" | wc -l)
          echo "    Deleting $EXEC_COUNT execution record(s)"
          echo "$EXECS" | while read -r SK; do
            run_or_echo aws dynamodb delete-item --table-name "$DATASYNC_TABLE" --region "$REGION" \
              --key "{\"pk\":{\"S\":\"TASK#$TID\"},\"sk\":{\"S\":\"$SK\"}}"
          done
        fi

        # Delete the TASK metadata row
        run_or_echo aws dynamodb delete-item --table-name "$DATASYNC_TABLE" --region "$REGION" \
          --key "{\"pk\":{\"S\":\"TASK#$TID\"},\"sk\":{\"S\":\"METADATA\"}}"
      done
    fi
  else
    echo "  No locations to check tasks against."
  fi

  # -------------------------------------------------------------------------
  # Step 4: Delete DataSync LOCATIONS
  # -------------------------------------------------------------------------
  echo ""
  echo -e "${BLUE}── Step 4: Delete DataSync locations ──${NC}"
  if [[ ${#LOCATION_IDS[@]} -eq 0 ]]; then
    echo "  No locations to delete."
  else
    for i in "${!LOCATION_IDS[@]}"; do
      LID="${LOCATION_IDS[$i]}"
      LARN="${LOCATION_ARNS[$i]:-}"
      echo "  Location $LID"
      if [[ -n "$LARN" ]]; then
        run_or_echo aws datasync delete-location --location-arn "$LARN" --region "$REGION"
      fi
      run_or_echo aws dynamodb delete-item --table-name "$DATASYNC_TABLE" --region "$REGION" \
        --key "{\"pk\":{\"S\":\"LOCATION#$LID\"},\"sk\":{\"S\":\"METADATA\"}}"
    done
  fi

  # -------------------------------------------------------------------------
  # Step 5: Retry CloudFormation stack delete (if applicable)
  # -------------------------------------------------------------------------
  echo ""
  echo -e "${BLUE}── Step 5: CloudFormation stack delete ──${NC}"
  if [[ "$STACK_NAME" == "None" || -z "$STACK_NAME" ]]; then
    echo "  No stack associated (e.g. Mountpoint S3 type) — skipping."
  else
    STACK_STATUS=$(aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" --region "$REGION" \
      --query 'Stacks[0].StackStatus' --output text 2>&1 || echo "DOES_NOT_EXIST")
    if [[ "$STACK_STATUS" == *"does not exist"* || "$STACK_STATUS" == "DOES_NOT_EXIST" ]]; then
      echo "  Stack $STACK_NAME already deleted."
    else
      echo "  Stack $STACK_NAME is in state: $STACK_STATUS"
      if $EXECUTE; then
        # Give DataSync a moment to actually release ENIs before retrying SG delete
        echo "  Waiting 20s for DataSync ENIs to release..."
        sleep 20
      fi
      run_or_echo aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"

      if $EXECUTE; then
        echo -n "  Waiting for stack to delete (up to 5 min)"
        for i in $(seq 1 20); do
          sleep 15
          NEW_STATUS=$(aws cloudformation describe-stacks \
            --stack-name "$STACK_NAME" --region "$REGION" \
            --query 'Stacks[0].StackStatus' --output text 2>&1 || echo "DOES_NOT_EXIST")
          if [[ "$NEW_STATUS" == *"does not exist"* || "$NEW_STATUS" == "DOES_NOT_EXIST" ]]; then
            echo ""
            echo -e "  ${GREEN}Stack deleted.${NC}"
            break
          fi
          if [[ "$NEW_STATUS" == *"FAILED"* ]]; then
            echo ""
            echo -e "  ${RED}Stack delete failed again: $NEW_STATUS${NC}"
            echo "  Inspect with: aws cloudformation describe-stack-events --stack-name $STACK_NAME --region $REGION"
            echo "  Skipping DynamoDB row deletion for this storage — investigate manually."
            continue 2
          fi
          echo -n "."
        done
      fi
    fi
  fi

  # -------------------------------------------------------------------------
  # Step 6: Delete the mrm-storage row
  # -------------------------------------------------------------------------
  echo ""
  echo -e "${BLUE}── Step 6: Delete mrm-storage row ──${NC}"
  run_or_echo aws dynamodb delete-item --table-name "$STORAGE_TABLE" --region "$REGION" \
    --key "{\"storageId\":{\"S\":\"$SID\"}}"

  echo ""
  echo -e "${GREEN}✓ Finished processing $SID${NC}"
done

banner "Summary"
if $EXECUTE; then
  echo -e "${GREEN}Cleanup complete.${NC}"
  echo ""
  echo "Verify:"
  echo "  aws dynamodb scan --table-name $STORAGE_TABLE --region $REGION --filter-expression '#s = :d' --expression-attribute-names '{\"#s\":\"status\"}' --expression-attribute-values '{\":d\":{\"S\":\"deleting\"}}' --query 'Items[].{id:storageId.S,name:name.S}'"
else
  echo -e "${YELLOW}This was a dry-run. Re-run with --execute to actually perform the cleanup.${NC}"
fi
