# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Install Script Agent - Python version for AgentCore Runtime

Full-featured agent that researches, generates, tests, and verifies silent 
installation scripts for software packages. Matches TypeScript version functionality.
"""

import json
import os
import time
import logging
import re
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional

import boto3
from botocore.exceptions import ClientError
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models import BedrockModel

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Bypass tool consent for automated execution
os.environ["BYPASS_TOOL_CONSENT"] = "true"

app = BedrockAgentCoreApp()

# Configuration from environment
AWS_REGION = os.getenv('AWS_REGION', os.getenv('AWS_DEFAULT_REGION', 'us-east-1'))
SOFTWARE_LIBRARY_TABLE = os.getenv('SOFTWARE_LIBRARY_TABLE_NAME', '')
AGENT_EXECUTION_STATE_TABLE = os.getenv('AGENT_EXECUTION_STATE_TABLE', '')
AGENT_USAGE_TABLE = os.getenv('AGENT_USAGE_TABLE', '')
AGENT_PROGRESS_TABLE = os.getenv('AGENT_PROGRESS_TABLE', '')
UPLOADS_BUCKET = os.getenv('UPLOADS_BUCKET', '')
AGENT_LOG_GROUP = os.getenv('AGENT_LOG_GROUP', '')
PASCAL_CASE_NAME = os.getenv('PASCAL_CASE_NAME', 'AMCCloudEditManager')

# SSM parameter cache for test infrastructure
_ssm_cache = {}

# Global task token for Step Functions heartbeats
_current_task_token = None

def set_task_token(task_token: str):
    """Set the current task token for heartbeat sending."""
    global _current_task_token
    _current_task_token = task_token

def send_heartbeat():
    """Send a heartbeat to Step Functions to keep the task alive."""
    global _current_task_token
    if not _current_task_token:
        return
    
    try:
        sfn = get_client('stepfunctions')
        sfn.send_task_heartbeat(taskToken=_current_task_token)
        logger.info("Sent heartbeat to Step Functions")
    except Exception as e:
        logger.warning(f"Failed to send heartbeat: {e}")

def get_ssm_parameter(param_name: str, default: str = '') -> str:
    """Get a parameter from SSM Parameter Store with caching."""
    if param_name in _ssm_cache:
        return _ssm_cache[param_name]
    
    try:
        ssm = get_client('ssm')
        response = ssm.get_parameter(Name=param_name, WithDecryption=True)
        value = response['Parameter']['Value']
        _ssm_cache[param_name] = value
        return value
    except Exception as e:
        logger.warning(f"Could not get SSM parameter {param_name}: {e}")
        return default

def get_test_subnet_id() -> str:
    """Get test subnet ID from SSM."""
    return get_ssm_parameter(f'/{PASCAL_CASE_NAME}/Agent/TestSubnetId')

def get_test_security_group_id() -> str:
    """Get test security group ID from SSM."""
    return get_ssm_parameter(f'/{PASCAL_CASE_NAME}/Agent/TestSecurityGroupId')

def get_test_instance_profile_arn() -> str:
    """Get test instance profile ARN from SSM."""
    return get_ssm_parameter(f'/{PASCAL_CASE_NAME}/Agent/TestInstanceProfileArn')

def get_windows_base_ami_id() -> str:
    """Get Windows base AMI ID from AWS SSM public parameter."""
    return get_ssm_parameter('/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base')

def get_linux_base_ami_id() -> str:
    """Get Linux base AMI ID from AWS SSM public parameter."""
    return get_ssm_parameter('/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id')

# Model ID for Bedrock
BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0'

# Default configuration
DEFAULT_INSTANCE_TYPE = 't3.medium'
DEFAULT_EXECUTION_TIMEOUT = 900  # 15 minutes

# AWS Clients (initialized lazily)
_clients = {}

def get_client(service_name: str):
    """Get or create an AWS client."""
    if service_name not in _clients:
        _clients[service_name] = boto3.client(service_name, region_name=AWS_REGION)
    return _clients[service_name]

def get_resource(service_name: str):
    """Get or create an AWS resource."""
    key = f"{service_name}_resource"
    if key not in _clients:
        _clients[key] = boto3.resource(service_name, region_name=AWS_REGION)
    return _clients[key]


# ============================================================================
# TOOL: Get Current Timestamp
# ============================================================================

@tool
def get_current_timestamp() -> str:
    """Get the current timestamp in ISO format."""
    return datetime.utcnow().isoformat() + "Z"


# ============================================================================
# TOOL: Update Progress
# ============================================================================

# Global variable to store execution ID for progress updates
_current_execution_id = None

def set_execution_id(execution_id: str):
    """Set the current execution ID for progress updates."""
    global _current_execution_id, _last_progress
    _current_execution_id = execution_id
    # Reset progress tracker for new execution
    _last_progress = {"phase": None, "message": None, "percent": None}

# Track last progress to avoid duplicate updates
_last_progress = {"phase": None, "message": None, "percent": None}

@tool
def update_progress(phase: str, message: str, percent: int) -> str:
    """
    Update the progress status in DynamoDB so the frontend can display it.
    Only updates if the status has actually changed to avoid duplicate messages.
    
    Args:
        phase: Current phase (research, generate, test, execute, verify, save)
        message: Human-readable progress message
        percent: Progress percentage (0-100)
    
    Returns:
        Status message
    """
    global _current_execution_id, _last_progress
    
    if not AGENT_EXECUTION_STATE_TABLE:
        return "Progress table not configured"
    
    if not _current_execution_id:
        return "No execution ID set"
    
    # Check if progress has actually changed
    if (_last_progress["phase"] == phase and 
        _last_progress["message"] == message and 
        _last_progress["percent"] == percent):
        return f"Progress unchanged: {phase} - {message} ({percent}%)"
    
    try:
        dynamodb = get_resource('dynamodb')
        table = dynamodb.Table(AGENT_EXECUTION_STATE_TABLE)
        
        table.update_item(
            Key={'executionId': _current_execution_id},
            UpdateExpression='SET currentPhase = :phase, progressPercent = :percent, progressMessage = :message, updatedAt = :time',
            ExpressionAttributeValues={
                ':phase': phase,
                ':percent': percent,
                ':message': message,
                ':time': datetime.utcnow().isoformat()
            }
        )
        
        # Update last progress tracker
        _last_progress = {"phase": phase, "message": message, "percent": percent}
        
        logger.info(f"Progress [{_current_execution_id}]: {phase} - {message} ({percent}%)")
        return f"Progress updated: {phase} - {message} ({percent}%)"
        
    except Exception as e:
        logger.warning(f"Failed to update progress: {e}")
        return f"Failed to update progress: {str(e)}"


# ============================================================================
# TOOL: Research Installation
# ============================================================================

# Known software database with download URLs and silent flags
SOFTWARE_DATABASE = {
    "7-zip": {
        "download_url": "https://www.7-zip.org/a/7z2301-x64.exe",
        "silent_flags": ["/S"],
        "verification": 'Test-Path "C:\\Program Files\\7-Zip\\7z.exe"',
        "installer_type": "exe"
    },
    "chrome": {
        "download_url": "https://dl.google.com/chrome/install/latest/chrome_installer.exe",
        "silent_flags": ["/silent", "/install"],
        "verification": 'Test-Path "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"',
        "installer_type": "exe"
    },
    "firefox": {
        "download_url": "https://download.mozilla.org/?product=firefox-latest&os=win64&lang=en-US",
        "silent_flags": ["-ms"],
        "verification": 'Test-Path "C:\\Program Files\\Mozilla Firefox\\firefox.exe"',
        "installer_type": "exe"
    },
    "vlc": {
        "download_url": "https://get.videolan.org/vlc/3.0.20/win64/vlc-3.0.20-win64.exe",
        "silent_flags": ["/S", "/L=1033"],
        "verification": 'Test-Path "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe"',
        "installer_type": "exe"
    },
    "notepad++": {
        "download_url": "https://github.com/notepad-plus-plus/notepad-plus-plus/releases/download/v8.6.2/npp.8.6.2.Installer.x64.exe",
        "silent_flags": ["/S"],
        "verification": 'Test-Path "C:\\Program Files\\Notepad++\\notepad++.exe"',
        "installer_type": "exe"
    },
    "python": {
        "download_url": "https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe",
        "silent_flags": ["/quiet", "InstallAllUsers=1", "PrependPath=1"],
        "verification": 'Test-Path "C:\\Program Files\\Python312\\python.exe"',
        "installer_type": "exe"
    },
    "nodejs": {
        "download_url": "https://nodejs.org/dist/v20.10.0/node-v20.10.0-x64.msi",
        "silent_flags": ["/qn"],
        "verification": 'Test-Path "C:\\Program Files\\nodejs\\node.exe"',
        "installer_type": "msi"
    },
    "git": {
        "download_url": "https://github.com/git-for-windows/git/releases/download/v2.43.0.windows.1/Git-2.43.0-64-bit.exe",
        "silent_flags": ["/VERYSILENT", "/NORESTART"],
        "verification": 'Test-Path "C:\\Program Files\\Git\\bin\\git.exe"',
        "installer_type": "exe"
    },
    "vscode": {
        "download_url": "https://update.code.visualstudio.com/latest/win32-x64/stable",
        "silent_flags": ["/VERYSILENT", "/NORESTART", "/MERGETASKS=!runcode"],
        "verification": 'Test-Path "C:\\Program Files\\Microsoft VS Code\\Code.exe"',
        "installer_type": "exe"
    }
}


@tool
def research_installation(
    software_name: str,
    version: str,
    platform: str,
    media_s3_uri: str = ""
) -> str:
    """
    Research silent installation methods for software.
    
    Args:
        software_name: Name of the software to research
        version: Version of the software (use 'latest' for most recent)
        platform: Target platform ('Windows' or 'Linux')
        media_s3_uri: Optional S3 URI of the installation media
    
    Returns:
        JSON string with research results including silent install flags, download URL, and verification commands
    """
    logger.info(f"Researching installation for {software_name} {version} on {platform}")
    
    # Normalize software name for lookup
    software_key = software_name.lower().replace(" ", "-").replace("_", "-")
    
    # Check known software database
    for key, info in SOFTWARE_DATABASE.items():
        if key in software_key or software_key in key:
            result = {
                "status": "success",
                "software_name": software_name,
                "version": version,
                "platform": platform,
                "download_url": info["download_url"] if not media_s3_uri else "",
                "media_s3_uri": media_s3_uri,
                "silent_flags": info["silent_flags"],
                "verification_commands": [info["verification"]],
                "installer_type": info["installer_type"],
                "prerequisites": [],
                "known_issues": [],
                "licensing_notes": "",
                "confidence": "high"
            }
            logger.info(f"Found known software: {key}")
            return json.dumps(result)
    
    # Default response for unknown software
    if platform == "Windows":
        default_flags = ["/S", "/silent", "/quiet", "/norestart"]
        default_verification = f'Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*" | Where-Object {{ $_.DisplayName -like "*{software_name}*" }}'
    else:
        default_flags = ["--silent", "-y", "--non-interactive"]
        default_verification = f'which {software_name.lower().replace(" ", "-")} || dpkg -l | grep -i "{software_name}"'
    
    result = {
        "status": "success",
        "software_name": software_name,
        "version": version,
        "platform": platform,
        "download_url": "",
        "media_s3_uri": media_s3_uri,
        "silent_flags": default_flags,
        "verification_commands": [default_verification],
        "installer_type": "exe" if platform == "Windows" else "sh",
        "prerequisites": [],
        "known_issues": [],
        "licensing_notes": "",
        "confidence": "low",
        "note": "Unknown software - using generic silent flags. You may need to research specific flags."
    }
    
    logger.info(f"Unknown software, returning defaults with low confidence")
    return json.dumps(result)


# ============================================================================
# TOOL: Generate Installation Script
# ============================================================================

WINDOWS_SCRIPT_TEMPLATE = '''# Auto-generated installation script for {software_name}
# Generated by AI Install Script Agent on {timestamp}
# Platform: Windows

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$LocalTempDir = "C:\\Temp\\{safe_name}"
$LogFile = "C:\\Temp\\{safe_name}_install.log"

# Create temp directory first (before any logging)
if (-not (Test-Path "C:\\Temp")) {{
    New-Item -ItemType Directory -Path "C:\\Temp" -Force | Out-Null
}}
if (-not (Test-Path $LocalTempDir)) {{
    New-Item -ItemType Directory -Path $LocalTempDir -Force | Out-Null
}}

function Write-Log {{
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logMessage = "[$ts] [$Level] $Message"
    Write-Host $logMessage
    Add-Content -Path $LogFile -Value $logMessage
}}

try {{
    Write-Log "Starting installation of {software_name}..."
    
{download_section}
    
    # Install
    Write-Log "Installing {software_name}..."
{install_section}
    
    # Verify installation
    Write-Log "Verifying installation..."
{verification_section}
    
    # Cleanup
    Write-Log "Cleaning up temporary files..."
    Remove-Item -Path $LocalTempDir -Recurse -Force -ErrorAction SilentlyContinue
    
    Write-Log "Installation completed successfully"
    exit 0
}} catch {{
    Write-Log "Installation failed: $_" -Level "ERROR"
    Write-Log $_.ScriptStackTrace -Level "ERROR"
    exit 1
}}'''

LINUX_SCRIPT_TEMPLATE = '''#!/bin/bash
# Auto-generated installation script for {software_name}
# Generated by AI Install Script Agent on {timestamp}
# Platform: Linux

set -e

LOCAL_TEMP_DIR="/tmp/{safe_name}"
LOG_FILE="/var/log/{safe_name}_install.log"

log() {{
    local level="${{2:-INFO}}"
    local ts=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$ts] [$level] $1" | tee -a "$LOG_FILE"
}}

cleanup() {{
    log "Cleaning up temporary files..."
    rm -rf "$LOCAL_TEMP_DIR" 2>/dev/null || true
}}

trap cleanup EXIT

log "Starting installation of {software_name}..."

mkdir -p "$LOCAL_TEMP_DIR"

{download_section}

# Install
log "Installing {software_name}..."
{install_section}

# Verify installation
log "Verifying installation..."
{verification_section}

log "Installation completed successfully"
exit 0'''


@tool
def generate_install_script(
    software_name: str,
    platform: str,
    download_url: str = "",
    media_s3_uri: str = "",
    silent_flags: str = "",
    verification_commands: str = "",
    installer_type: str = "exe"
) -> str:
    """
    Generate a platform-specific installation script.
    
    Args:
        software_name: Name of the software
        platform: Target platform ('Windows' or 'Linux')
        download_url: URL to download the installer (if no S3 media)
        media_s3_uri: S3 URI of the installation media (takes precedence over download_url)
        silent_flags: Comma-separated or JSON array of silent install flags
        verification_commands: Comma-separated or JSON array of verification commands
        installer_type: Type of installer (exe, msi, deb, rpm, sh)
    
    Returns:
        JSON with the generated script
    """
    logger.info(f"Generating {platform} script for {software_name}")
    
    timestamp = datetime.utcnow().isoformat()
    safe_name = re.sub(r'[^a-z0-9]', '-', software_name.lower())
    
    # Parse flags
    if silent_flags.startswith('['):
        flags_list = json.loads(silent_flags)
    else:
        flags_list = [f.strip() for f in silent_flags.split(',') if f.strip()]
    flags_str = ' '.join(flags_list)
    
    # Parse verification commands
    if verification_commands.startswith('['):
        verify_list = json.loads(verification_commands)
    else:
        verify_list = [v.strip() for v in verification_commands.split(',') if v.strip()]
    
    if platform == "Windows":
        script = _generate_windows_script(
            software_name, safe_name, timestamp, download_url, 
            media_s3_uri, flags_str, verify_list, installer_type
        )
    else:
        script = _generate_linux_script(
            software_name, safe_name, timestamp, download_url,
            media_s3_uri, flags_str, verify_list, installer_type
        )
    
    return json.dumps({
        "status": "success",
        "script": script,
        "platform": platform,
        "software_name": software_name
    })


def _generate_windows_script(
    software_name: str, safe_name: str, timestamp: str,
    download_url: str, media_s3_uri: str, flags_str: str,
    verify_list: List[str], installer_type: str
) -> str:
    """Generate Windows PowerShell installation script."""
    
    # Download section
    if media_s3_uri:
        download_section = f'''    # Download from S3
    $mediaPath = "$LocalTempDir\\installer.{installer_type}"
    Write-Log "Downloading from S3: {media_s3_uri}"
    aws s3 cp "{media_s3_uri}" $mediaPath
    Write-Log "Downloaded to: $mediaPath"'''
    elif download_url:
        download_section = f'''    # Download from URL
    $downloadUrl = "{download_url}"
    $mediaPath = "$LocalTempDir\\installer.{installer_type}"
    Write-Log "Downloading from: $downloadUrl"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $mediaPath -UseBasicParsing
    Write-Log "Downloaded to: $mediaPath"'''
    else:
        download_section = '''    # No download URL provided - expecting media to be pre-staged
    $mediaPath = $env:MEDIA_PATH
    if (-not $mediaPath) {
        throw "No download URL or MEDIA_PATH provided"
    }
    Write-Log "Using pre-staged media: $mediaPath"'''
    
    # Install section
    if installer_type == "msi":
        install_section = f'''    $process = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$mediaPath`" {flags_str} /norestart" -Wait -PassThru
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {{
        throw "MSI installation failed with exit code: $($process.ExitCode)"
    }}'''
    else:
        install_section = f'''    $process = Start-Process -FilePath $mediaPath -ArgumentList "{flags_str}" -Wait -PassThru
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {{
        throw "Installation failed with exit code: $($process.ExitCode)"
    }}'''
    
    # Verification section
    if verify_list:
        verify_cmds = '\n'.join([f'    $result = {cmd}\n    Write-Log "Verification: $result"' for cmd in verify_list])
        verification_section = verify_cmds
    else:
        verification_section = '    Write-Log "No verification commands provided - skipping"'
    
    return WINDOWS_SCRIPT_TEMPLATE.format(
        software_name=software_name,
        safe_name=safe_name,
        timestamp=timestamp,
        download_section=download_section,
        install_section=install_section,
        verification_section=verification_section
    )


def _generate_linux_script(
    software_name: str, safe_name: str, timestamp: str,
    download_url: str, media_s3_uri: str, flags_str: str,
    verify_list: List[str], installer_type: str
) -> str:
    """Generate Linux bash installation script."""
    
    # Download section
    if media_s3_uri:
        download_section = f'''# Download from S3
MEDIA_PATH="$LOCAL_TEMP_DIR/installer.{installer_type}"
log "Downloading from S3: {media_s3_uri}"
aws s3 cp "{media_s3_uri}" "$MEDIA_PATH"
log "Downloaded to: $MEDIA_PATH"'''
    elif download_url:
        download_section = f'''# Download from URL
DOWNLOAD_URL="{download_url}"
MEDIA_PATH="$LOCAL_TEMP_DIR/installer.{installer_type}"
log "Downloading from: $DOWNLOAD_URL"
curl -fsSL "$DOWNLOAD_URL" -o "$MEDIA_PATH"
log "Downloaded to: $MEDIA_PATH"'''
    else:
        download_section = '''# No download URL provided - expecting media to be pre-staged
if [ -z "$MEDIA_PATH" ]; then
    log "ERROR: No download URL or MEDIA_PATH provided" "ERROR"
    exit 1
fi
log "Using pre-staged media: $MEDIA_PATH"'''
    
    # Install section
    if installer_type == "deb":
        install_section = f'''sudo dpkg -i "$MEDIA_PATH" || sudo apt-get install -f -y
'''
    elif installer_type == "rpm":
        install_section = f'''sudo rpm -ivh "$MEDIA_PATH" {flags_str}
'''
    else:
        install_section = f'''chmod +x "$MEDIA_PATH"
sudo "$MEDIA_PATH" {flags_str}
'''
    
    # Verification section
    if verify_list:
        verify_cmds = '\n'.join([f'{cmd} && log "Verification passed" || log "Verification check returned non-zero" "WARN"' for cmd in verify_list])
        verification_section = verify_cmds
    else:
        verification_section = 'log "No verification commands provided - skipping"'
    
    return LINUX_SCRIPT_TEMPLATE.format(
        software_name=software_name,
        safe_name=safe_name,
        timestamp=timestamp,
        download_section=download_section,
        install_section=install_section,
        verification_section=verification_section
    )


# ============================================================================
# TOOL: Launch Test Instance
# ============================================================================

@tool
def launch_test_instance(platform: str, software_id: str) -> str:
    """
    Launch an EC2 test instance for script validation.
    
    Args:
        platform: Target platform ('Windows' or 'Linux')
        software_id: Unique identifier for the software being tested
    
    Returns:
        JSON with instance details including instance ID
    """
    logger.info(f"Launching {platform} test instance for {software_id}")
    
    # Register async task to keep session alive during long-running EC2 operations
    task_id = app.add_async_task("launch_test_instance", {"platform": platform, "software_id": software_id})
    logger.info(f"Registered async task {task_id} for launch_test_instance")
    
    try:
        # Get test infrastructure config from SSM
        test_subnet_id = get_test_subnet_id()
        test_security_group_id = get_test_security_group_id()
        test_instance_profile_arn = get_test_instance_profile_arn()
        
        # Check configuration
        if not all([test_subnet_id, test_security_group_id, test_instance_profile_arn]):
            app.complete_async_task(task_id)
            return json.dumps({
                "status": "error",
                "error": "Test infrastructure not configured. Missing SSM parameters for TestSubnetId, TestSecurityGroupId, or TestInstanceProfileArn."
            })
        
        ami_id = get_windows_base_ami_id() if platform == "Windows" else get_linux_base_ami_id()
        if not ami_id:
            app.complete_async_task(task_id)
            return json.dumps({
                "status": "error",
                "error": f"No base AMI configured for platform: {platform}. Set SSM parameter /{PASCAL_CASE_NAME}/Agent/WindowsBaseAmiId or LinuxBaseAmiId."
            })
        
        ec2 = get_client('ec2')
        instance_name = f"script-test-{software_id}-{int(time.time())}"
        
        # User data for Windows to ensure SSM agent is running
        user_data = ''
        if platform == "Windows":
            user_data = '<powershell>\nStart-Service AmazonSSMAgent -ErrorAction SilentlyContinue\n</powershell>'
        
        response = ec2.run_instances(
            ImageId=ami_id,
            InstanceType=DEFAULT_INSTANCE_TYPE,
            MinCount=1,
            MaxCount=1,
            SubnetId=test_subnet_id,
            SecurityGroupIds=[test_security_group_id],
            IamInstanceProfile={'Arn': test_instance_profile_arn},
            UserData=user_data,
            TagSpecifications=[{
                'ResourceType': 'instance',
                'Tags': [
                    {'Key': 'Name', 'Value': instance_name},
                    {'Key': 'Purpose', 'Value': 'InstallScriptTest'},
                    {'Key': 'AutoTerminate', 'Value': 'true'},
                    {'Key': 'SoftwareId', 'Value': software_id},
                    {'Key': 'Platform', 'Value': platform},
                ]
            }]
        )
        
        instance_id = response['Instances'][0]['InstanceId']
        logger.info(f"Launched instance: {instance_id}")
        
        # Send heartbeat before long waits
        send_heartbeat()
        
        # Wait for instance to be running
        logger.info("Waiting for instance to be running...")
        waiter = ec2.get_waiter('instance_running')
        waiter.wait(InstanceIds=[instance_id], WaiterConfig={'Delay': 15, 'MaxAttempts': 40})
        
        # Send heartbeat after instance running
        send_heartbeat()
        
        # Wait for status checks
        logger.info("Waiting for instance status checks...")
        waiter = ec2.get_waiter('instance_status_ok')
        waiter.wait(InstanceIds=[instance_id], WaiterConfig={'Delay': 15, 'MaxAttempts': 40})
        
        # Send heartbeat before SSM wait
        send_heartbeat()
        
        # Wait for SSM agent
        logger.info("Waiting for SSM agent...")
        _wait_for_ssm_agent(instance_id)
        
        # Get instance details
        desc = ec2.describe_instances(InstanceIds=[instance_id])
        instance = desc['Reservations'][0]['Instances'][0]
        
        # Complete async task
        app.complete_async_task(task_id)
        logger.info(f"Completed async task {task_id}")
        
        return json.dumps({
            "status": "success",
            "instance_id": instance_id,
            "platform": platform,
            "public_ip": instance.get('PublicIpAddress', ''),
            "private_ip": instance.get('PrivateIpAddress', ''),
            "state": instance['State']['Name']
        })
        
    except Exception as e:
        logger.error(f"Failed to launch instance: {e}")
        app.complete_async_task(task_id)
        return json.dumps({"status": "error", "error": str(e)})


def _wait_for_ssm_agent(instance_id: str, max_wait_seconds: int = 300):
    """Wait for SSM agent to be ready on the instance."""
    ssm = get_client('ssm')
    start_time = time.time()
    heartbeat_interval = 60  # Send heartbeat every 60 seconds
    last_heartbeat = time.time()
    
    while time.time() - start_time < max_wait_seconds:
        # Send heartbeat to keep Step Functions task alive
        if time.time() - last_heartbeat >= heartbeat_interval:
            send_heartbeat()
            last_heartbeat = time.time()
        
        try:
            response = ssm.describe_instance_information(
                Filters=[{'Key': 'InstanceIds', 'Values': [instance_id]}]
            )
            
            if response.get('InstanceInformationList'):
                info = response['InstanceInformationList'][0]
                if info.get('PingStatus') == 'Online':
                    logger.info(f"SSM agent ready on {instance_id}")
                    return
        except Exception:
            pass
        
        time.sleep(10)
    
    raise TimeoutError(f"SSM agent did not become ready within {max_wait_seconds} seconds")


# ============================================================================
# TOOL: Execute Script on Instance
# ============================================================================

@tool
def execute_script(
    instance_id: str,
    script: str,
    platform: str,
    timeout_seconds: int = 900
) -> str:
    """
    Execute an installation script on a test instance via AWS SSM.
    
    Args:
        instance_id: The EC2 instance ID to execute on
        script: The installation script to execute
        platform: Target platform ('Windows' or 'Linux')
        timeout_seconds: Timeout for script execution (default 900 = 15 minutes)
    
    Returns:
        JSON with execution results including exit code, stdout, and stderr
    """
    logger.info(f"Executing script on {instance_id} ({platform})")
    
    # Register async task to keep session alive during long-running SSM execution
    task_id = app.add_async_task("execute_script", {"instance_id": instance_id, "platform": platform})
    logger.info(f"Registered async task {task_id} for execute_script")
    
    ssm = get_client('ssm')
    document_name = 'AWS-RunPowerShellScript' if platform == 'Windows' else 'AWS-RunShellScript'
    
    try:
        start_time = time.time()
        
        response = ssm.send_command(
            InstanceIds=[instance_id],
            DocumentName=document_name,
            Parameters={
                'commands': [script],
                'executionTimeout': [str(timeout_seconds)]
            },
            TimeoutSeconds=timeout_seconds + 60,
            CloudWatchOutputConfig={
                'CloudWatchLogGroupName': AGENT_LOG_GROUP,
                'CloudWatchOutputEnabled': bool(AGENT_LOG_GROUP)
            }
        )
        
        command_id = response['Command']['CommandId']
        logger.info(f"SSM command sent: {command_id}")
        
        # Wait for command completion
        result = _wait_for_command_completion(command_id, instance_id, timeout_seconds)
        
        execution_time = time.time() - start_time
        
        # Complete async task
        app.complete_async_task(task_id)
        logger.info(f"Completed async task {task_id}")
        
        return json.dumps({
            "status": "success" if result['exit_code'] == 0 else "failed",
            "exit_code": result['exit_code'],
            "stdout": result['stdout'][:10000],  # Truncate large output
            "stderr": result['stderr'][:5000],
            "execution_time": round(execution_time, 2)
        })
        
    except Exception as e:
        logger.error(f"Script execution failed: {e}")
        app.complete_async_task(task_id)
        return json.dumps({"status": "error", "error": str(e)})


def _wait_for_command_completion(
    command_id: str,
    instance_id: str,
    timeout_seconds: int
) -> Dict[str, Any]:
    """Wait for SSM command to complete and return results."""
    ssm = get_client('ssm')
    start_time = time.time()
    max_wait = timeout_seconds + 120
    heartbeat_interval = 60  # Send heartbeat every 60 seconds
    last_heartbeat = time.time()
    
    while time.time() - start_time < max_wait:
        # Send heartbeat to keep Step Functions task alive
        if time.time() - last_heartbeat >= heartbeat_interval:
            send_heartbeat()
            last_heartbeat = time.time()
        
        try:
            response = ssm.get_command_invocation(
                CommandId=command_id,
                InstanceId=instance_id
            )
            
            status = response['Status']
            logger.info(f"Command status: {status}")
            
            if status == 'Success':
                return {
                    'exit_code': response.get('ResponseCode', 0),
                    'stdout': response.get('StandardOutputContent', ''),
                    'stderr': response.get('StandardErrorContent', '')
                }
            
            if status in ['Failed', 'Cancelled', 'TimedOut']:
                return {
                    'exit_code': response.get('ResponseCode', 1),
                    'stdout': response.get('StandardOutputContent', ''),
                    'stderr': response.get('StandardErrorContent', f'Command {status}')
                }
                
        except ssm.exceptions.InvocationDoesNotExist:
            pass
        except Exception as e:
            logger.warning(f"Error checking command status: {e}")
        
        time.sleep(5)
    
    return {'exit_code': 1, 'stdout': '', 'stderr': f'Command timed out after {timeout_seconds} seconds'}


# ============================================================================
# TOOL: Verify Installation
# ============================================================================

@tool
def verify_installation(
    instance_id: str,
    verification_commands: str,
    platform: str
) -> str:
    """
    Verify that software was installed correctly on the test instance.
    
    Args:
        instance_id: The EC2 instance ID
        verification_commands: JSON array or comma-separated list of verification commands
        platform: Target platform ('Windows' or 'Linux')
    
    Returns:
        JSON with verification results including pass/fail status for each check
    """
    logger.info(f"Verifying installation on {instance_id}")
    
    ssm = get_client('ssm')
    document_name = 'AWS-RunPowerShellScript' if platform == 'Windows' else 'AWS-RunShellScript'
    
    # Parse commands
    if verification_commands.startswith('['):
        commands = json.loads(verification_commands)
    else:
        commands = [c.strip() for c in verification_commands.split(',') if c.strip()]
    
    if not commands:
        return json.dumps({
            "status": "success",
            "passed": True,
            "message": "No verification commands provided - skipping verification",
            "checks": []
        })
    
    checks = []
    all_passed = True
    
    for i, command in enumerate(commands):
        try:
            # Wrap command for proper exit code handling
            if platform == 'Windows':
                wrapped = f'$ErrorActionPreference = "Stop"; try {{ {command}; exit 0 }} catch {{ Write-Error $_; exit 1 }}'
            else:
                wrapped = f'set -e; {command}'
            
            response = ssm.send_command(
                InstanceIds=[instance_id],
                DocumentName=document_name,
                Parameters={'commands': [wrapped], 'executionTimeout': ['60']}
            )
            
            command_id = response['Command']['CommandId']
            result = _wait_for_command_completion(command_id, instance_id, 60)
            
            passed = result['exit_code'] == 0
            checks.append({
                'name': f'Check {i + 1}',
                'command': command[:100],
                'passed': passed,
                'output': (result['stdout'] or result['stderr'])[:500]
            })
            
            if not passed:
                all_passed = False
                logger.warning(f"Verification check {i + 1} failed")
            else:
                logger.info(f"Verification check {i + 1} passed")
                
        except Exception as e:
            checks.append({
                'name': f'Check {i + 1}',
                'command': command[:100],
                'passed': False,
                'output': str(e)
            })
            all_passed = False
    
    return json.dumps({
        "status": "success",
        "passed": all_passed,
        "checks": checks
    })


# ============================================================================
# TOOL: Terminate Test Instance
# ============================================================================

@tool
def terminate_test_instance(instance_id: str) -> str:
    """
    Terminate a test EC2 instance.
    
    Args:
        instance_id: The EC2 instance ID to terminate
    
    Returns:
        JSON with termination status
    """
    logger.info(f"Terminating test instance: {instance_id}")
    
    ec2 = get_client('ec2')
    
    try:
        ec2.terminate_instances(InstanceIds=[instance_id])
        return json.dumps({
            "status": "success",
            "message": f"Instance {instance_id} termination initiated"
        })
    except Exception as e:
        logger.warning(f"Failed to terminate instance {instance_id}: {e}")
        return json.dumps({
            "status": "warning",
            "message": f"Could not terminate instance: {str(e)}"
        })


# ============================================================================
# TOOL: Save to Software Library
# ============================================================================

@tool
def save_to_library(
    software_id: str,
    software_name: str,
    script: str,
    platform: str,
    version: str = "latest"
) -> str:
    """
    Save a verified script to DynamoDB and create an Image Builder component.
    
    Args:
        software_id: Unique identifier for the software
        software_name: Name of the software
        script: The verified installation script
        platform: Target platform ('Windows' or 'Linux')
        version: Software version
    
    Returns:
        JSON with save results including component ARN
    """
    logger.info(f"Saving script for {software_name} ({software_id}) to library")
    
    if not SOFTWARE_LIBRARY_TABLE:
        return json.dumps({
            "status": "error",
            "error": "SOFTWARE_LIBRARY_TABLE_NAME not configured"
        })
    
    dynamodb = get_resource('dynamodb')
    imagebuilder = get_client('imagebuilder')
    
    try:
        table = dynamodb.Table(SOFTWARE_LIBRARY_TABLE)
        timestamp = datetime.utcnow().isoformat()
        
        # Get existing entry to determine component version
        try:
            response = table.get_item(Key={'softwareId': software_id})
            existing = response.get('Item', {})
            current_version = existing.get('componentVersion', '1.0.0')
            new_version = _increment_version(current_version)
        except Exception:
            existing = {}
            new_version = '1.0.1'
        
        # Create Image Builder component
        component_name = _build_component_name(software_name, platform)
        component_document = _build_component_document(script, platform)
        
        try:
            create_response = imagebuilder.create_component(
                name=component_name,
                semanticVersion=new_version,
                description=f"Auto-generated installation script for {software_name}",
                platform=platform,
                data=json.dumps(component_document)
            )
            component_arn = create_response['componentBuildVersionArn']
            logger.info(f"Created Image Builder component: {component_arn}")
        except imagebuilder.exceptions.ResourceAlreadyExistsException:
            # Component exists, construct ARN
            sts = get_client('sts')
            account_id = sts.get_caller_identity()['Account']
            component_arn = f"arn:aws:imagebuilder:{AWS_REGION}:{account_id}:component/{component_name}/{new_version}/1"
            logger.info(f"Component already exists: {component_arn}")
        except Exception as e:
            logger.warning(f"Could not create Image Builder component: {e}")
            component_arn = ""
        
        # Update DynamoDB
        table.update_item(
            Key={'softwareId': software_id},
            UpdateExpression='''
                SET #name = :name,
                    installScript = :script,
                    scriptStatus = :status,
                    scriptGeneratedAt = :generatedAt,
                    platform = :platform,
                    versionNumber = :version,
                    componentArn = :componentArn,
                    componentVersion = :componentVersion,
                    updatedAt = :updatedAt
            ''',
            ExpressionAttributeNames={'#name': 'name'},
            ExpressionAttributeValues={
                ':name': software_name,
                ':script': script,
                ':status': 'verified',
                ':generatedAt': timestamp,
                ':platform': platform,
                ':version': version,
                ':componentArn': component_arn,
                ':componentVersion': new_version,
                ':updatedAt': timestamp
            }
        )
        
        logger.info(f"Updated DynamoDB entry for {software_id}")
        
        return json.dumps({
            "status": "success",
            "software_id": software_id,
            "component_arn": component_arn,
            "component_version": new_version,
            "script_status": "verified"
        })
        
    except Exception as e:
        logger.error(f"Failed to save to library: {e}")
        return json.dumps({"status": "error", "error": str(e)})


def _increment_version(version: str) -> str:
    """Increment the patch version."""
    parts = version.split('.')
    if len(parts) != 3:
        return '1.0.1'
    try:
        parts[2] = str(int(parts[2]) + 1)
        return '.'.join(parts)
    except ValueError:
        return '1.0.1'


def _build_component_name(software_name: str, platform: str) -> str:
    """Build a valid Image Builder component name."""
    base_name = re.sub(r'[^a-z0-9]', '-', software_name.lower())
    base_name = re.sub(r'-+', '-', base_name).strip('-')
    platform_suffix = '-linux' if platform == 'Linux' else ''
    return f"{base_name}{platform_suffix}"


def _build_component_document(script: str, platform: str) -> Dict:
    """Build an Image Builder component document."""
    execute_action = 'ExecuteBash' if platform == 'Linux' else 'ExecutePowerShell'
    
    return {
        'schemaVersion': '1.0',
        'phases': [{
            'name': 'build',
            'steps': [{
                'name': 'InstallSoftware',
                'action': execute_action,
                'inputs': {'commands': [script]}
            }]
        }]
    }


# ============================================================================
# TOOL: Analyze Failure and Iterate
# ============================================================================

@tool
def analyze_failure(
    software_name: str,
    platform: str,
    previous_script: str,
    error_output: str,
    exit_code: int,
    attempt: int,
    max_attempts: int
) -> str:
    """
    Analyze a script failure and suggest fixes.
    
    Args:
        software_name: Name of the software
        platform: Target platform ('Windows' or 'Linux')
        previous_script: The script that failed
        error_output: Error output from the failed execution
        exit_code: Exit code from the failed execution
        attempt: Current attempt number
        max_attempts: Maximum number of attempts
    
    Returns:
        JSON with analysis and suggested fixes
    """
    logger.info(f"Analyzing failure for {software_name} (attempt {attempt}/{max_attempts})")
    
    error_lower = error_output.lower()
    root_cause = "Unknown error"
    solution = "Review the error output and adjust the script"
    suggested_changes = []
    
    if platform == "Windows":
        if 'access denied' in error_lower or 'permission' in error_lower:
            root_cause = "Permission denied - may need administrator privileges"
            solution = "Ensure the script runs with elevated privileges"
            suggested_changes.append("Add elevation check at script start")
        elif 'not found' in error_lower or 'cannot find' in error_lower:
            root_cause = "File or path not found"
            solution = "Verify download URL and file paths"
            suggested_changes.append("Add path validation before installation")
        elif 'timeout' in error_lower or 'timed out' in error_lower:
            root_cause = "Operation timed out"
            solution = "Increase timeout values or check network connectivity"
            suggested_changes.append("Increase execution timeout")
        elif 'reboot' in error_lower or 'restart' in error_lower or exit_code == 3010:
            root_cause = "Reboot required (exit code 3010 is normal)"
            solution = "Exit code 3010 indicates success with pending reboot"
            suggested_changes.append("Handle exit code 3010 as success")
        elif 'certificate' in error_lower or 'ssl' in error_lower:
            root_cause = "SSL/Certificate error"
            solution = "Add certificate bypass for download"
            suggested_changes.append("Add -SkipCertificateCheck to Invoke-WebRequest")
    else:
        if 'permission denied' in error_lower:
            root_cause = "Permission denied"
            solution = "Ensure commands run with sudo"
            suggested_changes.append("Add sudo to installation commands")
        elif 'not found' in error_lower or 'no such file' in error_lower:
            root_cause = "File or command not found"
            solution = "Verify download URL and package availability"
            suggested_changes.append("Add package manager update before install")
        elif 'dependency' in error_lower or 'unmet' in error_lower:
            root_cause = "Missing dependencies"
            solution = "Install dependencies first"
            suggested_changes.append("Run apt-get install -f -y to fix dependencies")
    
    return json.dumps({
        "status": "success",
        "analysis": f"Script failed with exit code {exit_code}",
        "root_cause": root_cause,
        "solution": solution,
        "suggested_changes": suggested_changes,
        "attempt": attempt,
        "max_attempts": max_attempts,
        "can_retry": attempt < max_attempts
    })


# Initialize Step Functions client for callbacks
stepfunctions = boto3.client('stepfunctions', region_name=AWS_REGION)


# ============================================================================
# TOOL: Send Step Functions Callback
# ============================================================================

@tool
def send_stepfunctions_callback(task_token: str, result_data: str) -> str:
    """
    Send success callback to Step Functions with processed data.
    
    Args:
        task_token: The Step Functions task token
        result_data: JSON string with the result data
    
    Returns:
        Status message
    """
    try:
        # Parse the result data to ensure it's valid JSON
        parsed_result = json.loads(result_data)
        
        # Send success callback
        stepfunctions.send_task_success(
            taskToken=task_token,
            output=json.dumps(parsed_result)
        )
        
        logger.info("Callback sent successfully to Step Functions")
        return "Callback sent successfully to Step Functions"
        
    except Exception as e:
        logger.error(f"Error sending callback: {str(e)}")
        
        # Send failure callback
        try:
            stepfunctions.send_task_failure(
                taskToken=task_token,
                error='CallbackError',
                cause=str(e)[:256]
            )
        except Exception as callback_error:
            logger.error(f"Failed to send failure callback: {str(callback_error)}")
        
        return f"Failed to send callback: {str(e)}"


# ============================================================================
# SYSTEM PROMPT
# ============================================================================

SYSTEM_PROMPT = """You are an AI Install Script Agent that helps generate, test, and verify silent installation scripts for software packages.

## Your Capabilities

You have access to these tools:

1. **update_progress** - Update progress status for the frontend
   - Call this at each major step to show progress to the user
   - Phases: research, generate, test, execute, verify, complete
   - Include a helpful message and percentage (0-100)

2. **research_installation** - Research silent installation methods for software
   - Finds download URLs, silent flags, and verification commands
   - Has a database of common software (7-Zip, Chrome, Firefox, VLC, etc.)

3. **generate_install_script** - Generate platform-specific installation scripts
   - Creates Windows PowerShell or Linux bash scripts
   - Includes error handling, logging, and cleanup

4. **launch_test_instance** - Launch an EC2 instance for testing
   - Creates a fresh Windows or Linux instance
   - Waits for SSM agent to be ready

5. **execute_script** - Execute scripts on test instances via SSM
   - Runs the installation script
   - Returns exit code, stdout, and stderr

6. **verify_installation** - Verify software was installed correctly
   - Runs verification commands
   - Reports pass/fail for each check

7. **analyze_failure** - Analyze script failures and suggest fixes
   - Identifies common error patterns
   - Suggests solutions

8. **terminate_test_instance** - Clean up test instances
   - Always terminate instances after testing

9. **get_current_timestamp** - Get current ISO timestamp

10. **send_stepfunctions_callback** - Send completion callback to Step Functions
    - REQUIRED when a taskToken is provided
    - Call this at the END of your workflow with the final result
    - Include the script, category, and description in the callback

## Interactive Workflow

You operate in an INTERACTIVE conversational mode. Follow this workflow:

### Stage 1: Research & Generate
When user says "generate" or similar:
1. Call update_progress("research", "Researching installation methods...", 10)
2. Use research_installation to find download URL, silent flags, verification commands
3. Call update_progress("generate", "Generating installation script...", 30)
4. Use generate_install_script to create the script
5. Call update_progress("generate", "Script generated! Waiting for your decision...", 40)

Then STOP and present the results to the user in your response:
- Show the generated script in a code block
- Suggest an appropriate category (development, media, system, utilities)
- Suggest a description based on what you learned about the software
- Ask: "Would you like me to test this script on a real EC2 instance to verify it works? Reply 'test' to verify, or 'skip' to use the script as-is."

IMPORTANT: After generating the script, you MUST wait for the user to respond before proceeding. Do NOT automatically test or save.

### Stage 2a: If user says "test", "yes", or "verify"
1. Call update_progress("test", "Launching test instance...", 50)
2. Use launch_test_instance to create a fresh test environment
3. Call update_progress("execute", "Running installation script...", 70)
4. Use execute_script to run the installation
5. Call update_progress("verify", "Verifying installation...", 85)
6. Use verify_installation to confirm success
7. ALWAYS use terminate_test_instance to clean up
8. If failed and attempts remain, use analyze_failure, fix the script, and retry
9. Call update_progress("complete", "Script verified and ready!", 100)
10. Send callback with verified script, category, and description

### Stage 2b: If user says "skip", "no", or "feeling lucky"
1. Call update_progress("complete", "Script ready (not tested)!", 100)
2. Send callback with unverified script, category, and description
3. Note in response that script was NOT tested on a real instance

### Callback Data Format
When calling send_stepfunctions_callback, the result_data MUST be a JSON string with this structure:
{
  "status": "success",
  "script": "the full PowerShell or bash script content",
  "verified": true or false,
  "suggestedCategory": "development" or "media" or "system" or "utilities",
  "suggestedDescription": "A brief description of what this software does and its main features",
  "softwareName": "the software name",
  "platform": "Windows" or "Linux"
}

## Category Guidelines
- **development**: IDEs, code editors, programming languages, SDKs, Git, databases, Notepad++, VS Code, Python, Node.js
- **media**: Video/audio editors, players, codecs, streaming software, creative tools, VLC, DaVinci Resolve, OBS
- **system**: Drivers, system utilities, monitoring tools, security software, antivirus
- **utilities**: General tools, file managers, compression (7-Zip), browsers (Chrome, Firefox), productivity apps

## Important Notes
- WAIT for user input after generating the script - do not auto-proceed
- Always terminate test instances after use
- Handle exit code 3010 (reboot required) as success on Windows
- For unknown software, research may return low confidence - inform the user
- Scripts should include proper error handling and logging
- Maximum 3 attempts by default for failed installations
- DO NOT call save_to_library - the frontend wizard handles saving
- ALWAYS call send_stepfunctions_callback at the end with the script data

## Common Software Knowledge
- 7-Zip: /S flag, installs to C:\\Program Files\\7-Zip (utilities)
- Chrome: /silent /install flags (utilities)
- Firefox: -ms flag (utilities)
- VLC: /S /L=1033 flags (media)
- Notepad++: /S flag (development)
- Python: /quiet InstallAllUsers=1 PrependPath=1 (development)
- Node.js: MSI with /qn flag (development)
- Git: /VERYSILENT /NORESTART (development)
- VS Code: /VERYSILENT /NORESTART /MERGETASKS=!runcode (development)
- DaVinci Resolve: media editing software (media)
- OBS Studio: streaming/recording software (media)
"""


# ============================================================================
# CREATE AGENT AT MODULE LEVEL (Best Practice)
# ============================================================================

# Create Bedrock model - initialized once at module load
bedrock_model = BedrockModel(
    model_id=BEDROCK_MODEL_ID,
    temperature=0.1,
    streaming=False
)

# Create agent at module level - this is the recommended pattern for AgentCore
# The agent is reused across invocations for better performance
agent = Agent(
    model=bedrock_model,
    tools=[
        get_current_timestamp,
        update_progress,
        research_installation,
        generate_install_script,
        launch_test_instance,
        execute_script,
        verify_installation,
        analyze_failure,
        save_to_library,
        terminate_test_instance,
        send_stepfunctions_callback,
    ],
    system_prompt=SYSTEM_PROMPT,
    name="InstallScriptAgent"
)

logger.info("Agent initialized at module level")


# ============================================================================
# ENTRYPOINT
# ============================================================================

@app.entrypoint
def invoke(payload, context=None):
    """Main entrypoint for the Install Script Agent.
    
    Uses synchronous invocation with the Strands agent.
    For long-running operations, tools use app.add_async_task() to keep
    the session alive and prevent the 15-minute idle timeout.
    """
    task_token = None
    
    try:
        logger.info(f"Install Script Agent invoked with payload keys: {list(payload.keys()) if payload else []}")
        
        # Extract task token if provided (for Step Functions callback)
        task_token = payload.get('taskToken') if payload else None
        
        # Set task token for heartbeat sending during long operations
        if task_token:
            set_task_token(task_token)
        
        # Set execution ID for progress updates
        execution_id = payload.get('executionId', '') if payload else ''
        if execution_id:
            set_execution_id(execution_id)
        
        if payload is None:
            payload = {}
        
        # Check if this is a direct action request
        action = payload.get('action')
        
        if action == 'generate':
            software_name = payload.get('softwareName', 'Unknown')
            version = payload.get('version', 'latest')
            platform = payload.get('platform', 'Windows')
            software_id = payload.get('softwareId', 'unknown')
            media_s3_uri = payload.get('mediaS3Uri', '')
            test_automatically = payload.get('testAutomatically', False)
            max_attempts = payload.get('maxAttempts', 3)
            is_draft_mode = payload.get('isDraftMode', False)
            execution_id = payload.get('executionId', '')
            user_requirements = payload.get('userRequirements', '')
            
            # Build prompt for the agent
            callback_instruction = ""
            if task_token:
                callback_instruction = f"""
6. IMPORTANT: At the very end, you MUST call send_stepfunctions_callback with:
   - task_token: "{task_token}"
   - result_data: A JSON string containing {{"status": "success" or "failed", "script": "the generated script", "softwareId": "{software_id}", "softwareName": "{software_name}", "platform": "{platform}"}}
   
This callback is REQUIRED to complete the workflow."""
            
            test_instruction = ""
            if test_automatically:
                test_instruction = "After generating the script, proceed to test it on an EC2 instance."
            else:
                test_instruction = "Skip testing - just generate the script and return it."
            
            # Include user requirements if provided
            requirements_section = ""
            if user_requirements:
                requirements_section = f"""
## User Requirements (IMPORTANT - incorporate these into the script):
- {user_requirements}

Make sure the generated script addresses ALL of the user's requirements listed above.
"""
            
            prompt = f"""Please generate a silent installation script for:
- Software: {software_name}
- Version: {version}
- Platform: {platform}
- Software ID: {software_id}
- Execution ID: {execution_id}
- Media S3 URI: {media_s3_uri or 'Not provided - find official download URL'}
{requirements_section}
{test_instruction}

Follow this workflow:
1. Research the installation method using research_installation
2. Generate the installation script using generate_install_script{' - incorporating all user requirements' if user_requirements else ''}
{"3. Launch EC2 test instance, execute the script, and verify installation" if test_automatically else "3. Skip testing (user chose not to test)"}
4. Send the callback with the script, suggested category, and suggested description

IMPORTANT: 
- Suggest an appropriate category (development, media, system, or utilities)
- Suggest a brief description of what this software does
- Include verified={"true" if test_automatically else "false"} in the callback
{callback_instruction}"""
            
            logger.info(f"Processing generate request for {software_name}")
            result = agent(prompt)
            
            # Extract response text
            text = _extract_response_text(result)
            
            response_data = {
                'status': 'success',
                'response': text,
                'software_id': software_id,
                'software_name': software_name,
                'platform': platform,
                'agent': 'install-script-agent'
            }
            
            # If we have a task token and the agent didn't call the callback, do it now
            if task_token:
                try:
                    # Try to extract script from response
                    script = _extract_script_from_response(text, platform)
                    callback_result = {
                        'status': 'success',
                        'script': script,
                        'verified': test_automatically,
                        'suggestedCategory': 'utilities',  # Default fallback
                        'suggestedDescription': f'Installation script for {software_name}',
                        'softwareId': software_id,
                        'softwareName': software_name,
                        'platform': platform,
                        'executionId': execution_id
                    }
                    stepfunctions.send_task_success(
                        taskToken=task_token,
                        output=json.dumps(callback_result)
                    )
                    logger.info("Sent task success callback")
                except Exception as callback_err:
                    logger.warning(f"Callback may have already been sent by agent: {callback_err}")
            
            return response_data
        
        else:
            # Natural language prompt
            prompt = payload.get('prompt', 'Hello! What can you help me with?')
            
            logger.info(f"Processing prompt: {prompt[:100]}...")
            result = agent(prompt)
            
            text = _extract_response_text(result)
            
            return {
                'status': 'success',
                'response': text,
                'agent': 'install-script-agent'
            }
        
    except Exception as e:
        import traceback
        logger.error(f"Error in Install Script Agent: {str(e)}")
        logger.error(traceback.format_exc())
        
        # Send failure callback if we have a task token
        if task_token:
            try:
                stepfunctions.send_task_failure(
                    taskToken=task_token,
                    error='AgentError',
                    cause=str(e)[:256]
                )
                logger.info("Sent task failure callback")
            except Exception as callback_err:
                logger.error(f"Failed to send failure callback: {callback_err}")
        
        return {
            'status': 'error',
            'error': str(e),
            'agent': 'install-script-agent'
        }


def _extract_response_text(response) -> str:
    """Extract text from agent response."""
    if hasattr(response, 'message') and response.message:
        content = response.message.get('content', [])
        if content and isinstance(content, list):
            return content[0].get('text', str(response))
    return str(response)


def _extract_script_from_response(response_text: str, platform: str) -> str:
    """Try to extract the generated script from the response text."""
    # Look for code blocks
    import re
    
    # Try to find PowerShell or bash code blocks
    if platform == 'Windows':
        patterns = [
            r'```powershell\n(.*?)```',
            r'```ps1\n(.*?)```',
            r'```\n(#.*?Auto-generated.*?exit 0\n})```',
        ]
    else:
        patterns = [
            r'```bash\n(.*?)```',
            r'```sh\n(.*?)```',
            r'```\n(#!/bin/bash.*?exit 0)```',
        ]
    
    for pattern in patterns:
        match = re.search(pattern, response_text, re.DOTALL)
        if match:
            return match.group(1).strip()
    
    # If no code block found, look for script markers
    if platform == 'Windows':
        if '# Auto-generated installation script' in response_text:
            start = response_text.find('# Auto-generated installation script')
            end = response_text.find('exit 0', start)
            if end > start:
                return response_text[start:end + 6].strip()
    else:
        if '#!/bin/bash' in response_text:
            start = response_text.find('#!/bin/bash')
            end = response_text.find('exit 0', start)
            if end > start:
                return response_text[start:end + 6].strip()
    
    # Return empty if no script found
    return ""


@app.ping
def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "agent": "install-script-agent"}


if __name__ == "__main__":
    app.run()
