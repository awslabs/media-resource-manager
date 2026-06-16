#!/bin/bash
# Google Chrome Installation Script for macOS
# Downloads and installs the latest version of Chrome
# Compatible with AWS EC2 Image Builder

set -e

LOG_FILE="/tmp/chrome-install.log"
CHROME_DMG="/tmp/googlechrome.dmg"
CHROME_URL="https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg"

get_timestamp() {
    date "+[%m/%d/%y %H:%M:%S]"
}

log() {
    echo "$(get_timestamp) $1" | tee -a "$LOG_FILE"
}

cleanup() {
    log "Cleaning up..."
    # Unmount if still mounted
    if [ -d "/Volumes/Google Chrome" ]; then
        hdiutil detach "/Volumes/Google Chrome" -quiet 2>/dev/null || true
    fi
    # Remove downloaded DMG
    if [ -f "$CHROME_DMG" ]; then
        rm -f "$CHROME_DMG"
    fi
    log "Cleanup complete"
}

trap cleanup EXIT

log "Starting Google Chrome installation for macOS..."

# Step 1: Download Chrome DMG
log "=== Step 1: Downloading Google Chrome installer ==="
curl -L -o "$CHROME_DMG" "$CHROME_URL" 2>&1 | tee -a "$LOG_FILE"

if [ ! -f "$CHROME_DMG" ]; then
    log "ERROR: Failed to download Chrome installer"
    exit 1
fi

DMG_SIZE=$(stat -f%z "$CHROME_DMG" 2>/dev/null || stat -c%s "$CHROME_DMG")
DMG_SIZE_MB=$((DMG_SIZE / 1048576))
log "Chrome installer downloaded: ${DMG_SIZE_MB} MB"

# Step 2: Mount the DMG
log "=== Step 2: Mounting Chrome DMG ==="
hdiutil attach "$CHROME_DMG" -nobrowse -quiet

if [ ! -d "/Volumes/Google Chrome" ]; then
    log "ERROR: Failed to mount Chrome DMG"
    exit 1
fi

log "Chrome DMG mounted successfully"

# Step 3: Copy Chrome to Applications
log "=== Step 3: Installing Chrome to /Applications ==="

# Remove existing installation if present
if [ -d "/Applications/Google Chrome.app" ]; then
    log "Removing existing Chrome installation..."
    sudo rm -rf "/Applications/Google Chrome.app"
fi

# Copy the app
sudo cp -R "/Volumes/Google Chrome/Google Chrome.app" "/Applications/"

if [ ! -d "/Applications/Google Chrome.app" ]; then
    log "ERROR: Failed to copy Chrome to Applications"
    exit 1
fi

log "Chrome copied to /Applications successfully"

# Step 4: Unmount the DMG
log "=== Step 4: Unmounting Chrome DMG ==="
hdiutil detach "/Volumes/Google Chrome" -quiet

# Step 5: Verify installation
log "=== Step 5: Verifying Chrome installation ==="

if [ -d "/Applications/Google Chrome.app" ]; then
    VERSION=$(defaults read "/Applications/Google Chrome.app/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "unknown")
    log "SUCCESS: Google Chrome installed - Version: $VERSION"
    log ""
    log "=============================================="
    log "Google Chrome installation complete!"
    log "=============================================="
    exit 0
else
    log "ERROR: Chrome installation verification failed"
    exit 1
fi
