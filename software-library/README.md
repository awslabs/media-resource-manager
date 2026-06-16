# Software Library

This directory contains installation script definitions that seed the application's Software Library — a catalog of software that can be installed on workstations via EC2 Image Builder pipelines.

## How It Works

Software definitions consist of two files per entry:
- A **JSON metadata file** describing the software (name, version, platform, etc.)
- An **installation script** (`.ps1` for Windows, `.sh` for Linux/macOS)

When deployed, the `populate-software-library.js` script reads these definitions, creates EC2 Image Builder components, and writes entries to DynamoDB. Users can then select software when building workstation AMIs through the web UI.

## Two Ways to Add Software

### 1. Via the Web UI (recommended for commercial/licensed software)

Use the **Software** section in the Image Builder UI to add software interactively:
1. Click **Add Software**
2. Enter the name, description, and platform
3. Upload the installer file (for software that requires a media file)
4. Paste or write the installation script
5. Save — the software is immediately available for use in pipelines

This is the recommended approach for commercial software (DaVinci Resolve, Adobe, etc.) where you must obtain the installer yourself.

### 2. Via Code (recommended for free/open-source software)

Add a JSON definition and install script to this directory, then redeploy. The populate script runs automatically during `./deploy.sh` and CodeBuild deployments.

This approach is ideal for:
- Free/open-source software that can be downloaded from official public URLs
- Software that should be version-controlled alongside the codebase
- Standardized software that should be available in every deployment

## Directory Structure

```
software-library/
├── development/           # Development tools (VS Code, GitHub Desktop, etc.)
├── media/                 # Media production software (FFmpeg, OBS, etc.)
├── system/                # System tools and drivers (NVIDIA GRID, etc.)
├── utilities/             # General utilities (Chrome, AWS CLI, etc.)
└── README.md
```

## Running the Populate Script

The script runs automatically after `./deploy.sh`. To run it manually:

```bash
# Populate all categories
node scripts/populate-software-library.js

# Dry run — see what would be created without making changes
node scripts/populate-software-library.js --dry-run

# Only process a specific category
node scripts/populate-software-library.js --category media

# Override table/bucket names (skips SSM lookup)
node scripts/populate-software-library.js --table-name mrm-software-library --bucket-name mrm-uploads-123456789-us-east-1
```

The script is **idempotent** — it checks DynamoDB before creating anything and skips entries that already exist. Safe to run multiple times.

## Adding New Software Definitions

### Step 1: Create the JSON metadata file

```json
{
  "name": "My Software",
  "versionNumber": "1.0.0",
  "description": "Description shown in the UI",
  "platform": "Windows",
  "scriptFile": "my-software-install.ps1",
  "estimatedInstallTime": "5 minutes",
  "diskSpaceRequired": "500 MB",
  "gpuRequired": false
}
```

For software that downloads its own installer at build time, no additional fields are needed — just download in the install script.

For software that requires a pre-uploaded installer file, add:
```json
{
  "mediaFileName": "MyInstaller.exe",
  "mediaSourceUrl": "https://official-vendor-cdn.com/MyInstaller.exe"
}
```

> **Note:** Only include `mediaSourceUrl` for software with permissive distribution terms. For commercial/licensed software, leave it empty and upload via the web UI instead.

### Step 2: Create the installation script

**Windows (PowerShell):**
```powershell
$ErrorActionPreference = "Stop"

try {
    Write-Host "Starting installation..."

    # If using a media file uploaded via UI or mediaSourceUrl:
    # $InstallerPath = $env:MEDIA_PATH

    # Or download directly from vendor:
    $DownloadUrl = "https://example.com/installer.exe"
    $InstallerPath = "$env:TEMP\installer.exe"
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $InstallerPath

    # Install silently
    Start-Process -FilePath $InstallerPath -ArgumentList "/S" -Wait

    # Cleanup
    Remove-Item $InstallerPath -ErrorAction SilentlyContinue

    Write-Host "Installation completed successfully"
} catch {
    Write-Error "Installation failed: $_"
    exit 1
}
```

**Linux (Bash):**
```bash
#!/bin/bash
set -e

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

log "Starting installation..."

# If using a media file uploaded via UI or mediaSourceUrl:
# INSTALLER_PATH="$MEDIA_PATH"

# Or download directly from vendor:
curl -fsSL https://example.com/installer.sh -o /tmp/installer.sh
chmod +x /tmp/installer.sh
/tmp/installer.sh --silent

log "Installation completed successfully"
```

### Step 3: Deploy

```bash
./deploy.sh
```

Or run the populate script directly:
```bash
node scripts/populate-software-library.js --category utilities
```

## JSON Schema Reference

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | ✅ | string | Display name in the UI |
| `platform` | ✅ | string | `Windows`, `Linux`, or `macOS` |
| `scriptFile` | ✅ | string | Install script filename (relative to JSON file) |
| `versionNumber` | | string | Version or `"Latest"` (default: `"Latest"`) |
| `description` | | string | Description shown in UI |
| `mediaFileName` | | string | Installer filename (required if using media upload) |
| `mediaSourceUrl` | | string | URL to auto-download installer (free software only) |
| `mediaS3Uri` | | string | S3 URI (auto-populated — do not set manually) |
| `estimatedInstallTime` | | string | e.g., `"5-10 minutes"` |
| `diskSpaceRequired` | | string | e.g., `"1.5 GB"` |
| `gpuRequired` | | boolean | Whether GPU is required (default: `false`) |
| `parameters` | | array | Custom parameters users can set at pipeline creation time |
