#!/bin/bash
#
# Mac Dedicated Host Allocator
# Continuously attempts to allocate Mac dedicated hosts until target is reached
# Tries mac-m4pro.metal first, falls back to mac-m4.metal
#
# USAGE:
#   Run in tmux to keep it running if your SSH session disconnects:
#
#     tmux new -s mac-hosts
#     ~/media-resource-manager/scripts/allocate-mac-hosts.sh
#
#   Press Ctrl+B then D to detach (script keeps running)
#   Later reconnect with: tmux attach -t mac-hosts
#
#   Or use nohup for background execution:
#     nohup ~/media-resource-manager/scripts/allocate-mac-hosts.sh &
#     tail -f ~/media-resource-manager/mac-host-allocation.log  # to monitor
#

# Configuration
TARGET_HOSTS=5
RETRY_INTERVAL_SECONDS=30          # 30 seconds between attempts
MAX_RETRY_INTERVAL_SECONDS=300     # Max backoff: 5 minutes
THROTTLE_BACKOFF_SECONDS=120       # Wait 2 min if throttled
LOG_FILE="mac-host-allocation.log"
CONSECUTIVE_FAILURES=0
MAX_CONSECUTIVE_FAILURES=10        # Back off after this many failures in a row

# Instance types to try in order of preference
declare -A INSTANCE_TYPES
INSTANCE_TYPES["mac-m4pro.metal"]="us-east-1b us-east-1d"  # use1-az6 (IAD7), use1-az2 (IAD12)
INSTANCE_TYPES["mac-m4.metal"]="us-east-1b us-east-1d"     # use1-az6 (IAD7), use1-az2 (IAD12)

# Order of preference
PREFERRED_ORDER=("mac-m4pro.metal" "mac-m4.metal")

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "${timestamp} - $1" | tee -a "$LOG_FILE"
}

get_total_host_count() {
    local count=0
    for instance_type in "${PREFERRED_ORDER[@]}"; do
        local azs=(${INSTANCE_TYPES[$instance_type]})
        for az in "${azs[@]}"; do
            local az_count=$(aws ec2 describe-hosts \
                --filter "Name=instance-type,Values=${instance_type}" \
                         "Name=availability-zone,Values=${az}" \
                         "Name=state,Values=available,pending,under-assessment" \
                --query 'length(Hosts)' \
                --output text 2>/dev/null || echo "0")
            count=$((count + az_count))
        done
    done
    echo "$count"
}

get_hosts_summary() {
    echo ""
    log "${BLUE}Current host distribution:${NC}"
    for instance_type in "${PREFERRED_ORDER[@]}"; do
        local azs=(${INSTANCE_TYPES[$instance_type]})
        local type_total=0
        log "  ${CYAN}${instance_type}:${NC}"
        for az in "${azs[@]}"; do
            local hosts=$(aws ec2 describe-hosts \
                --filter "Name=instance-type,Values=${instance_type}" \
                         "Name=availability-zone,Values=${az}" \
                --query 'Hosts[*].{HostId:HostId,State:State}' \
                --output json 2>/dev/null)
            
            local available=$(echo "$hosts" | jq '[.[] | select(.State=="available")] | length')
            local pending=$(echo "$hosts" | jq '[.[] | select(.State=="pending")] | length')
            local total=$(echo "$hosts" | jq 'length')
            type_total=$((type_total + total))
            
            if [ "$total" -gt 0 ]; then
                log "    ${az}: ${total} total (${GREEN}${available} available${NC}, ${YELLOW}${pending} pending${NC})"
            fi
        done
        if [ "$type_total" -eq 0 ]; then
            log "    (none allocated)"
        fi
    done
    echo ""
}

allocate_host() {
    local instance_type=$1
    local az=$2
    log "${BLUE}Attempting to allocate ${instance_type} in ${az}...${NC}"
    
    local result=$(aws ec2 allocate-hosts \
        --instance-type "${instance_type}" \
        --availability-zone "${az}" \
        --auto-placement on \
        --quantity 1 \
        --output json 2>&1)
    
    local exit_code=$?
    
    if [ $exit_code -eq 0 ]; then
        local host_id=$(echo "$result" | jq -r '.HostIds[0]' 2>/dev/null)
        if [ "$host_id" != "null" ] && [ -n "$host_id" ]; then
            log "${GREEN}SUCCESS: Allocated ${instance_type} host ${host_id} in ${az}${NC}"
            return 0
        fi
    fi
    
    # Check for specific error messages
    if echo "$result" | grep -q "InsufficientCapacity\|InsufficientHostCapacity"; then
        log "${YELLOW}No capacity for ${instance_type} in ${az}${NC}"
        return 1
    elif echo "$result" | grep -q "UnsupportedHostConfiguration"; then
        log "${YELLOW}${instance_type} not supported in ${az}${NC}"
        return 1
    elif echo "$result" | grep -q "HostLimitExceeded"; then
        log "${RED}Host limit exceeded - check your service quotas${NC}"
        return 2
    elif echo "$result" | grep -q "Throttling\|RequestLimitExceeded"; then
        log "${YELLOW}API throttled - backing off${NC}"
        return 3
    else
        log "${RED}Failed to allocate ${instance_type} in ${az}: ${result}${NC}"
    fi
    
    return 1
}

try_all_options() {
    # Try each instance type in order of preference
    for instance_type in "${PREFERRED_ORDER[@]}"; do
        local azs=(${INSTANCE_TYPES[$instance_type]})
        for az in "${azs[@]}"; do
            allocate_host "$instance_type" "$az"
            local result=$?
            
            if [ $result -eq 0 ]; then
                return 0  # Success
            elif [ $result -eq 2 ]; then
                return 2  # Host limit exceeded
            elif [ $result -eq 3 ]; then
                return 3  # Throttled
            fi
            # Continue to next option on capacity failure
        done
    done
    
    return 1  # All options exhausted
}

main() {
    log "=========================================="
    log "${GREEN}Mac Dedicated Host Allocator Started${NC}"
    log "=========================================="
    log "Target: ${TARGET_HOSTS} hosts"
    log "Instance Types (in order of preference):"
    for instance_type in "${PREFERRED_ORDER[@]}"; do
        log "  - ${instance_type}: ${INSTANCE_TYPES[$instance_type]}"
    done
    log ""
    log "AZ Mapping:"
    log "  us-east-1b = use1-az6 (IAD7)"
    log "  us-east-1d = use1-az2 (IAD12)"
    log "Retry Interval: ${RETRY_INTERVAL_SECONDS} seconds"
    log "=========================================="
    
    local attempt=0
    
    while true; do
        attempt=$((attempt + 1))
        
        # Get current count
        local current_count=$(get_total_host_count)
        log "Attempt #${attempt}: Current hosts: ${current_count}/${TARGET_HOSTS}"
        
        # Check if we've reached target
        if [ "$current_count" -ge "$TARGET_HOSTS" ]; then
            log "${GREEN}=========================================="
            log "TARGET REACHED! ${current_count} hosts allocated"
            log "==========================================${NC}"
            get_hosts_summary
            exit 0
        fi
        
        # Show current distribution every 10 attempts
        if [ $((attempt % 10)) -eq 1 ]; then
            get_hosts_summary
        fi
        
        # Try to allocate (cycles through all instance types and AZs)
        try_all_options
        local alloc_result=$?
        
        # If host limit exceeded, exit
        if [ $alloc_result -eq 2 ]; then
            log "${RED}Exiting due to host limit exceeded${NC}"
            exit 1
        fi
        
        # Handle throttling with longer backoff
        if [ $alloc_result -eq 3 ]; then
            log "${YELLOW}Throttled - waiting ${THROTTLE_BACKOFF_SECONDS} seconds${NC}"
            sleep "$THROTTLE_BACKOFF_SECONDS"
            continue
        fi
        
        # Track consecutive failures for adaptive backoff
        if [ $alloc_result -eq 0 ]; then
            CONSECUTIVE_FAILURES=0
            current_interval=$RETRY_INTERVAL_SECONDS
        else
            CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
            # Increase interval after repeated failures
            if [ $CONSECUTIVE_FAILURES -ge $MAX_CONSECUTIVE_FAILURES ]; then
                current_interval=$((RETRY_INTERVAL_SECONDS * 2))
                if [ $current_interval -gt $MAX_RETRY_INTERVAL_SECONDS ]; then
                    current_interval=$MAX_RETRY_INTERVAL_SECONDS
                fi
                log "${YELLOW}${CONSECUTIVE_FAILURES} consecutive failures - increased interval to ${current_interval}s${NC}"
            else
                current_interval=$RETRY_INTERVAL_SECONDS
            fi
        fi
        
        # Wait before next attempt (use loop for interruptible sleep)
        log "Waiting ${current_interval} seconds before next attempt..."
        for ((i=0; i<current_interval; i++)); do
            sleep 1
        done
    done
}

# Handle Ctrl+C gracefully
cleanup() {
    echo ""
    log "${YELLOW}Script interrupted by user${NC}"
    exit 130
}
trap cleanup INT TERM

# Run main function
main
