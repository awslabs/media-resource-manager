# Install AWS CLI v2 on Windows
# Run as Administrator

Write-Host "Installing AWS CLI v2..."

$awsCliUrl = "https://awscli.amazonaws.com/AWSCLIV2.msi"
$installer = "$env:TEMP\AWSCLIV2.msi"

# Download AWS CLI installer
Invoke-WebRequest -Uri $awsCliUrl -OutFile $installer -UseBasicParsing
Write-Host "Downloaded AWS CLI installer"

# Install silently
Start-Process msiexec.exe -ArgumentList "/i", $installer, "/quiet" -Wait
Write-Host "AWS CLI installation completed"

# Add to PATH for current session
$env:PATH = "C:\Program Files\Amazon\AWSCLIV2;$env:PATH"

# Test installation
aws --version

# Clean up
Remove-Item $installer -Force
Write-Host "AWS CLI ready to use"
