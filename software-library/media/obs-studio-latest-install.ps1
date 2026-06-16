# OBS Studio Installation Script - Latest Version
# Downloads and installs OBS Studio latest version silently
# Compatible with AWS EC2 Image Builder

$LocalTempDir = $env:TEMP
$OBSInstaller = "OBS-Studio-Installer.exe"
$InstallPath = "C:\Program Files\obs-studio"

try {
    Write-Host "Starting OBS Studio installation..."
    
    # Get latest release URL from GitHub API
    Write-Host "Getting latest OBS Studio release..."
    $apiUrl = "https://api.github.com/repos/obsproject/obs-studio/releases/latest"
    $release = Invoke-RestMethod -Uri $apiUrl -UseBasicParsing
    $downloadUrl = ($release.assets | Where-Object { $_.name -like "*Windows-x64-Installer.exe" }).browser_download_url
    
    if (-not $downloadUrl) {
        throw "Could not find Windows installer in latest release"
    }
    
    Write-Host "Found latest installer: $downloadUrl"
    
    # Download OBS Studio installer
    Write-Host "Downloading OBS Studio installer..."
    Invoke-WebRequest -Uri $downloadUrl -OutFile "$LocalTempDir\$OBSInstaller" -UseBasicParsing
    Write-Host "Downloaded OBS Studio to $LocalTempDir\$OBSInstaller"
    
    # Verify download
    if (-not (Test-Path "$LocalTempDir\$OBSInstaller")) {
        throw "Failed to download OBS Studio installer"
    }
    
    $fileSize = (Get-Item "$LocalTempDir\$OBSInstaller").Length
    Write-Host "Downloaded file size: $($fileSize / 1MB) MB"
    
    # Install OBS Studio silently
    Write-Host "Installing OBS Studio silently..."
    $installProcess = Start-Process -FilePath "$LocalTempDir\$OBSInstaller" -ArgumentList "/S" -Wait -PassThru
    
    if ($installProcess.ExitCode -ne 0) {
        throw "OBS Studio installation failed with exit code: $($installProcess.ExitCode)"
    }
    
    Write-Host "OBS Studio installation completed"
    
    # Verify installation
    Write-Host "Verifying OBS Studio installation..."
    $obsExe = "$InstallPath\bin\64bit\obs64.exe"
    if (Test-Path $obsExe) {
        Write-Host "OBS Studio installed successfully at $obsExe"
    } else {
        # Try alternative path
        $obsExe = "${env:ProgramFiles}\obs-studio\bin\64bit\obs64.exe"
        if (Test-Path $obsExe) {
            Write-Host "OBS Studio installed successfully at $obsExe"
        } else {
            Write-Host "Warning: Could not verify OBS Studio installation path"
        }
    }
    
    # Cleanup
    Write-Host "Cleaning up temporary files..."
    Remove-Item "$LocalTempDir\$OBSInstaller" -ErrorAction SilentlyContinue
    
    Write-Host "OBS Studio installation completed successfully"
    Write-Host "OBS Studio can be launched from Start Menu or desktop shortcut"
    
} catch {
    Write-Error "Failed to install OBS Studio: $_"
    
    # Cleanup on failure
    Remove-Item "$LocalTempDir\$OBSInstaller" -ErrorAction SilentlyContinue
    
    exit 1
}
