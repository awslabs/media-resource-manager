# AWS CLI Installation Script - Latest Version
# Downloads and installs AWS CLI latest version silently
# Compatible with AWS EC2 Image Builder

$LocalTempDir = $env:TEMP
$AwsCliInstaller = "AWSCLIV2.msi"
$AwsCliUrl = "https://awscli.amazonaws.com/AWSCLIV2.msi"

try {
    Write-Host "Starting AWS CLI installation..."
    
    # Download AWS CLI installer
    Write-Host "Downloading AWS CLI installer..."
    Invoke-WebRequest -Uri $AwsCliUrl -OutFile "$LocalTempDir\$AwsCliInstaller" -UseBasicParsing
    Write-Host "Downloaded AWS CLI to $LocalTempDir\$AwsCliInstaller"
    
    # Verify download
    if (-not (Test-Path "$LocalTempDir\$AwsCliInstaller")) {
        throw "Failed to download AWS CLI installer"
    }
    
    $fileSize = (Get-Item "$LocalTempDir\$AwsCliInstaller").Length
    Write-Host "Downloaded file size: $($fileSize / 1MB) MB"
    
    # Install AWS CLI silently
    Write-Host "Installing AWS CLI silently..."
    $installArgs = @(
        "/i"
        "$LocalTempDir\$AwsCliInstaller"
        "/quiet"
        "/norestart"
    )
    
    $installProcess = Start-Process -FilePath "msiexec.exe" -ArgumentList $installArgs -Wait -PassThru
    
    if ($installProcess.ExitCode -ne 0) {
        throw "AWS CLI installation failed with exit code: $($installProcess.ExitCode)"
    }
    
    Write-Host "AWS CLI installation completed"
    
    # Verify installation
    Write-Host "Verifying AWS CLI installation..."
    
    # Refresh PATH for current session
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    
    try {
        $awsVersion = & aws --version 2>&1
        Write-Host "AWS CLI installed successfully: $awsVersion"
    } catch {
        Write-Host "AWS CLI installed but version check failed (PATH may need refresh)"
        Write-Host "AWS CLI should be available in new command prompt/PowerShell sessions"
    }
    
    # Cleanup
    Write-Host "Cleaning up temporary files..."
    Remove-Item "$LocalTempDir\$AwsCliInstaller" -ErrorAction SilentlyContinue
    
    Write-Host "AWS CLI installation completed successfully"
    Write-Host "AWS CLI is now available system-wide"
    Write-Host "Use 'aws configure' to set up credentials"
    
} catch {
    Write-Error "Failed to install AWS CLI: $_"
    
    # Cleanup on failure
    Remove-Item "$LocalTempDir\$AwsCliInstaller" -ErrorAction SilentlyContinue
    
    exit 1
}
