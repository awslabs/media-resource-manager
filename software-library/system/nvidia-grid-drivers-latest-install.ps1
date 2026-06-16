# NVIDIA GRID Driver Installation Script
# Downloads and installs latest NVIDIA GRID drivers for AWS GPU instances
# Compatible with AWS EC2 Image Builder
# Supports G4dn, G5, G6, G3 instances
#
# This script tries multiple download methods:
# 1. AWS PowerShell with S3 (requires IAM permissions)
# 2. Direct HTTPS download (no IAM required)

$LocalTempDir = $env:TEMP
$ErrorActionPreference = "Stop"

try {
    Write-Host "Starting NVIDIA GRID driver installation..."
    
    # Get instance metadata to determine GPU type
    Write-Host "Detecting GPU instance type..."
    try {
        # Try IMDSv2 first
        $token = Invoke-RestMethod -Uri "http://169.254.169.254/latest/api/token" -Method PUT -Headers @{"X-aws-ec2-metadata-token-ttl-seconds" = "21600"} -TimeoutSec 5
        $instanceType = Invoke-RestMethod -Uri "http://169.254.169.254/latest/meta-data/instance-type" -Headers @{"X-aws-ec2-metadata-token" = $token} -TimeoutSec 10
        Write-Host "Instance type: $instanceType"
    } catch {
        try {
            # Fallback to IMDSv1
            $instanceType = Invoke-RestMethod -Uri "http://169.254.169.254/latest/meta-data/instance-type" -TimeoutSec 10
            Write-Host "Instance type: $instanceType"
        } catch {
            Write-Host "Warning: Could not detect instance type, assuming G4dn"
            $instanceType = "g4dn.xlarge"
        }
    }
    
    Write-Host "Getting latest NVIDIA GRID driver..."
    
    $s3Bucket = "ec2-windows-nvidia-drivers"
    $s3Region = "us-east-1"
    $downloadPath = $null
    $downloadSuccess = $false
    
    # Method 1: Try AWS PowerShell with S3 (requires IAM role)
    $awsPowerShellAvailable = $null -ne (Get-Module -ListAvailable -Name AWS.Tools.S3)
    
    if (-not $awsPowerShellAvailable) {
        # Try to import if installed but not loaded
        try {
            Import-Module AWS.Tools.S3 -ErrorAction SilentlyContinue
            $awsPowerShellAvailable = $true
        } catch {
            $awsPowerShellAvailable = $false
        }
    }
    
    if ($awsPowerShellAvailable) {
        Write-Host "Attempting download via AWS PowerShell..."
        try {
            # List available drivers in the latest folder
            $s3Objects = Get-S3Object -BucketName $s3Bucket -KeyPrefix "latest/" -Region $s3Region 2>&1
            
            if ($s3Objects -and $s3Objects.GetType().Name -ne "ErrorRecord") {
                # Filter for .exe files
                $driverFiles = $s3Objects | Where-Object { $_.Key -like "*.exe" }
                
                if ($driverFiles) {
                    # Get the latest driver file (sort by LastModified descending)
                    $latestDriver = $driverFiles | Sort-Object -Property LastModified -Descending | Select-Object -First 1
                    $gridDriverInstaller = Split-Path $latestDriver.Key -Leaf
                    
                    Write-Host "Found driver: $gridDriverInstaller"
                    $downloadPath = "$LocalTempDir\$gridDriverInstaller"
                    
                    Write-Host "Downloading via S3..."
                    Read-S3Object -BucketName $s3Bucket -Key $latestDriver.Key -File $downloadPath -Region $s3Region
                    
                    if (Test-Path $downloadPath) {
                        $downloadSuccess = $true
                        Write-Host "S3 download successful"
                    }
                }
            } else {
                Write-Host "S3 access denied or no objects found - will try direct download"
            }
        } catch {
            Write-Host "AWS PowerShell method failed: $_"
        }
    } else {
        Write-Host "AWS PowerShell module not available - will try direct download"
    }
    
    # Method 2: Direct HTTPS download (no IAM required)
    if (-not $downloadSuccess) {
        Write-Host "Using direct HTTPS download..."
        
        # The ec2-windows-nvidia-drivers bucket allows anonymous HTTPS GET
        # Using the current driver version as of January 2026
        # Check https://docs.aws.amazon.com/AWSEC2/latest/WindowsGuide/install-nvidia-driver.html for updates
        
        $gridDriverInstaller = "582.16_grid_win10_win11_server2022_server2025_dch_64bit_international_aws_swl.exe"
        $downloadUrl = "https://$s3Bucket.s3.amazonaws.com/latest/$gridDriverInstaller"
        $downloadPath = "$LocalTempDir\$gridDriverInstaller"
        
        Write-Host "Downloading from: $downloadUrl"
        
        # Use TLS 1.2
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        
        # Download with WebClient (faster for large files)
        $webClient = New-Object System.Net.WebClient
        try {
            $webClient.DownloadFile($downloadUrl, $downloadPath)
            $downloadSuccess = $true
            Write-Host "Direct download successful"
        } catch {
            Write-Host "Direct download failed: $_"
            
            # Try alternative: Invoke-WebRequest
            Write-Host "Trying Invoke-WebRequest..."
            try {
                Invoke-WebRequest -Uri $downloadUrl -OutFile $downloadPath -UseBasicParsing
                $downloadSuccess = $true
            } catch {
                throw "All download methods failed. Last error: $_"
            }
        } finally {
            $webClient.Dispose()
        }
    }
    
    # Verify download
    if (-not (Test-Path $downloadPath)) {
        throw "Failed to download NVIDIA GRID driver - file not found"
    }
    
    $fileSize = (Get-Item $downloadPath).Length
    Write-Host "Downloaded file size: $([math]::Round($fileSize / 1MB, 2)) MB"
    
    if ($fileSize -lt 100MB) {
        throw "Downloaded file is too small ($([math]::Round($fileSize / 1MB, 2)) MB), download may have failed"
    }
    
    # Install GRID driver silently
    Write-Host "Installing NVIDIA GRID driver silently..."
    Write-Host "This may take 5-10 minutes..."
    
    $installArgs = @(
        "-s"           # Silent install
        "-noreboot"    # Don't reboot automatically
        "-clean"       # Clean install
    )
    
    $installProcess = Start-Process -FilePath $downloadPath -ArgumentList $installArgs -Wait -PassThru -NoNewWindow
    
    # Exit codes: 0 = success, 1 = reboot required
    if ($installProcess.ExitCode -ne 0 -and $installProcess.ExitCode -ne 1) {
        throw "NVIDIA GRID driver installation failed with exit code: $($installProcess.ExitCode)"
    }
    
    Write-Host "NVIDIA GRID driver installation completed (exit code: $($installProcess.ExitCode))"
    
    # Verify installation
    Write-Host "Verifying NVIDIA driver installation..."
    Start-Sleep -Seconds 5
    
    try {
        $nvidiaPath = "${env:ProgramFiles}\NVIDIA Corporation\NVSMI\nvidia-smi.exe"
        if (Test-Path $nvidiaPath) {
            Write-Host "Running nvidia-smi to verify installation..."
            & $nvidiaPath
        } else {
            Write-Host "nvidia-smi not found yet - this is normal before reboot"
        }
    } catch {
        Write-Host "Could not run nvidia-smi verification (normal before reboot)"
    }
    
    # Check if reboot is required
    $rebootRequired = ($installProcess.ExitCode -eq 1)
    
    if (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired" -ErrorAction SilentlyContinue) {
        $rebootRequired = $true
    }
    
    if ($rebootRequired) {
        Write-Host "IMPORTANT: System reboot is required to complete driver installation"
    } else {
        Write-Host "No immediate reboot required"
    }
    
    # Cleanup
    Write-Host "Cleaning up temporary files..."
    Remove-Item $downloadPath -ErrorAction SilentlyContinue
    
    Write-Host "NVIDIA GRID driver installation completed successfully!"
    Write-Host "GPU acceleration will be available after system reboot"
    
} catch {
    Write-Error "Failed to install NVIDIA GRID driver: $_"
    
    # Cleanup on failure
    if ($downloadPath -and (Test-Path $downloadPath)) {
        Remove-Item $downloadPath -ErrorAction SilentlyContinue
    }
    
    exit 1
}
