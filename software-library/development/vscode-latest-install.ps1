# Visual Studio Code Installation Script - Latest Version
# Downloads and installs VS Code latest version silently
# Compatible with AWS EC2 Image Builder

$LocalTempDir = $env:TEMP
$VSCodeInstaller = "VSCodeSetup.exe"
$VSCodeUrl = "https://code.visualstudio.com/sha/download?build=stable&os=win32-x64"
$InstallPath = "${env:ProgramFiles}\Microsoft VS Code"

try {
    Write-Host "Starting Visual Studio Code installation..."
    
    # Download VS Code installer
    Write-Host "Downloading VS Code installer..."
    Invoke-WebRequest -Uri $VSCodeUrl -OutFile "$LocalTempDir\$VSCodeInstaller" -UseBasicParsing
    Write-Host "Downloaded VS Code to $LocalTempDir\$VSCodeInstaller"
    
    # Verify download
    if (-not (Test-Path "$LocalTempDir\$VSCodeInstaller")) {
        throw "Failed to download VS Code installer"
    }
    
    $fileSize = (Get-Item "$LocalTempDir\$VSCodeInstaller").Length
    Write-Host "Downloaded file size: $($fileSize / 1MB) MB"
    
    # Install VS Code silently
    Write-Host "Installing VS Code silently..."
    $installArgs = @(
        "/VERYSILENT"
        "/NORESTART"
        "/MERGETASKS=!runcode"
        "/SUPPRESSMSGBOXES"
    )
    
    $installProcess = Start-Process -FilePath "$LocalTempDir\$VSCodeInstaller" -ArgumentList $installArgs -Wait -PassThru
    
    if ($installProcess.ExitCode -ne 0) {
        throw "VS Code installation failed with exit code: $($installProcess.ExitCode)"
    }
    
    Write-Host "VS Code installation completed"
    
    # Verify installation
    Write-Host "Verifying VS Code installation..."
    $codeExe = "$InstallPath\Code.exe"
    if (Test-Path $codeExe) {
        Write-Host "VS Code installed successfully at $codeExe"
    } else {
        Write-Host "Warning: Could not verify VS Code installation path"
    }
    
    # Cleanup
    Write-Host "Cleaning up temporary files..."
    Remove-Item "$LocalTempDir\$VSCodeInstaller" -ErrorAction SilentlyContinue
    
    Write-Host "VS Code installation completed successfully"
    Write-Host "VS Code can be launched from Start Menu or command line with 'code'"
    
} catch {
    Write-Error "Failed to install VS Code: $_"
    
    # Cleanup on failure
    Remove-Item "$LocalTempDir\$VSCodeInstaller" -ErrorAction SilentlyContinue
    
    exit 1
}
