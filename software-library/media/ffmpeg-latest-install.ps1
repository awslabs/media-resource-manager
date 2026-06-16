# FFmpeg Installation Script - Latest Version
# Downloads and installs FFmpeg latest static build silently
# Compatible with AWS EC2 Image Builder
# Uses BtbN GitHub builds (reliable community builds)

$ErrorActionPreference = "Stop"
$LocalTempDir = $env:TEMP
$FFmpegZip = "ffmpeg-master-latest-win64-gpl-shared.zip"
$FFmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip"
$InstallPath = "C:\ffmpeg"
$MaxRetries = 3
$RetryDelaySeconds = 10

function Download-WithRetry {
    param(
        [string]$Url,
        [string]$OutFile,
        [int]$MaxAttempts = 3,
        [int]$DelaySeconds = 10
    )
    
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            Write-Host "Download attempt $attempt of $MaxAttempts..."
            
            # Use TLS 1.2
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            
            # Try WebClient first (faster for large files)
            $webClient = New-Object System.Net.WebClient
            $webClient.DownloadFile($Url, $OutFile)
            $webClient.Dispose()
            
            if (Test-Path $OutFile) {
                $fileSize = (Get-Item $OutFile).Length
                if ($fileSize -gt 10MB) {
                    Write-Host "Download successful: $([math]::Round($fileSize / 1MB, 2)) MB"
                    return $true
                } else {
                    Write-Host "Downloaded file too small ($([math]::Round($fileSize / 1MB, 2)) MB), retrying..."
                    Remove-Item $OutFile -ErrorAction SilentlyContinue
                }
            }
        } catch {
            Write-Host "Attempt $attempt failed: $_"
            
            # Try Invoke-WebRequest as fallback
            if ($attempt -lt $MaxAttempts) {
                try {
                    Write-Host "Trying Invoke-WebRequest as fallback..."
                    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 300
                    
                    if (Test-Path $OutFile) {
                        $fileSize = (Get-Item $OutFile).Length
                        if ($fileSize -gt 10MB) {
                            Write-Host "Fallback download successful: $([math]::Round($fileSize / 1MB, 2)) MB"
                            return $true
                        }
                    }
                } catch {
                    Write-Host "Fallback also failed: $_"
                }
            }
        }
        
        if ($attempt -lt $MaxAttempts) {
            Write-Host "Waiting $DelaySeconds seconds before retry..."
            Start-Sleep -Seconds $DelaySeconds
        }
    }
    
    return $false
}

try {
    Write-Host "Starting FFmpeg installation..."
    
    # Download FFmpeg static build with retry
    Write-Host "Downloading FFmpeg latest build from $FFmpegUrl..."
    $downloadPath = "$LocalTempDir\$FFmpegZip"
    
    $downloadSuccess = Download-WithRetry -Url $FFmpegUrl -OutFile $downloadPath -MaxAttempts $MaxRetries -DelaySeconds $RetryDelaySeconds
    
    if (-not $downloadSuccess) {
        throw "Failed to download FFmpeg after $MaxRetries attempts"
    }
    
    Write-Host "Downloaded FFmpeg to $downloadPath"
    
    # Create installation directory
    Write-Host "Creating installation directory at $InstallPath..."
    if (Test-Path $InstallPath) {
        Remove-Item $InstallPath -Recurse -Force
    }
    New-Item -Path $InstallPath -ItemType Directory -Force | Out-Null
    
    # Extract FFmpeg
    Write-Host "Extracting FFmpeg..."
    Expand-Archive -Path $downloadPath -DestinationPath $LocalTempDir -Force
    
    # Find extracted folder
    $extractedFolder = Get-ChildItem $LocalTempDir -Directory | Where-Object { $_.Name -like "ffmpeg-*" } | Select-Object -First 1
    if (-not $extractedFolder) {
        throw "Could not find extracted FFmpeg folder"
    }
    
    Write-Host "Found extracted folder: $($extractedFolder.Name)"
    
    # Copy files to installation directory
    Write-Host "Installing FFmpeg to $InstallPath..."
    Copy-Item "$($extractedFolder.FullName)\*" -Destination $InstallPath -Recurse -Force
    
    # Add to system PATH
    Write-Host "Adding FFmpeg to system PATH..."
    $currentPath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
    $ffmpegBinPath = "$InstallPath\bin"
    
    if ($currentPath -notlike "*$ffmpegBinPath*") {
        $newPath = "$currentPath;$ffmpegBinPath"
        [Environment]::SetEnvironmentVariable("PATH", $newPath, "Machine")
        Write-Host "Added $ffmpegBinPath to system PATH"
    } else {
        Write-Host "FFmpeg bin path already in system PATH"
    }
    
    # Verify installation
    Write-Host "Verifying FFmpeg installation..."
    $ffmpegExe = "$ffmpegBinPath\ffmpeg.exe"
    if (Test-Path $ffmpegExe) {
        Write-Host "FFmpeg installed successfully at $ffmpegExe"
        
        # Test FFmpeg version
        try {
            $env:Path = [Environment]::GetEnvironmentVariable("PATH", "Machine")
            $versionOutput = & $ffmpegExe -version 2>&1 | Select-Object -First 1
            Write-Host "FFmpeg version: $versionOutput"
        } catch {
            Write-Host "FFmpeg installed but version check failed (normal in some environments)"
        }
    } else {
        throw "FFmpeg executable not found after installation"
    }
    
    # Cleanup
    Write-Host "Cleaning up temporary files..."
    Remove-Item $downloadPath -ErrorAction SilentlyContinue
    Remove-Item $extractedFolder.FullName -Recurse -Force -ErrorAction SilentlyContinue
    
    Write-Host "FFmpeg installation completed successfully!"
    
} catch {
    Write-Error "Failed to install FFmpeg: $_"
    
    # Cleanup on failure
    if ($downloadPath) { Remove-Item $downloadPath -ErrorAction SilentlyContinue }
    if ($extractedFolder) { Remove-Item $extractedFolder.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    
    exit 1
}
