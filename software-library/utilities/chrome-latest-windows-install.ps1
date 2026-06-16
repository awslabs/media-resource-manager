# Google Chrome Installation Script
# Downloads and installs Chrome silently
# Compatible with AWS EC2 Image Builder

$LocalTempDir = $env:TEMP
$ChromeInstaller = "ChromeInstaller.exe"
$ChromeUrl = "http://dl.google.com/chrome/install/375.126/chrome_installer.exe"

try {
    Write-Host "Starting Chrome installation..."
    
    # Download Chrome installer
    (new-object System.Net.WebClient).DownloadFile($ChromeUrl, "$LocalTempDir\$ChromeInstaller")
    Write-Host "Downloaded Chrome installer to $LocalTempDir\$ChromeInstaller"
    
    # Install Chrome silently
    & "$LocalTempDir\$ChromeInstaller" /silent /install
    Write-Host "Chrome installation started"
    
    # Wait for installation to complete
    $Process2Monitor = "ChromeInstaller"
    Do {
        $ProcessesFound = Get-Process | ?{$Process2Monitor -contains $_.Name} | Select-Object -ExpandProperty Name
        If ($ProcessesFound) {
            "Still running: $($ProcessesFound -join ', ')" | Write-Host
            Start-Sleep -Seconds 2
        } else {
            rm "$LocalTempDir\$ChromeInstaller" -ErrorAction SilentlyContinue -Verbose
        }
    } Until (!$ProcessesFound)
    
    Write-Host "Chrome installation completed successfully"
    
} catch {
    Write-Error "Failed to install Chrome: $_"
    exit 1
}
