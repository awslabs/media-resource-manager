# Attack Surface Analyzer Installation Script
# Run this in PowerShell ISE as Administrator

Write-Host "=== Attack Surface Analyzer Installation Script ===" -ForegroundColor Green

# Create temp directory
$tempDir = "C:\temp"
if (-not (Test-Path $tempDir)) {
    New-Item -Path $tempDir -ItemType Directory -Force
    Write-Host "Created temp directory: $tempDir"
}

# Step 1: Install .NET SDK
Write-Host "`n1. Installing .NET SDK..." -ForegroundColor Yellow
$dotnetUrl = "https://dotnetcli.azureedge.net/dotnet/Sdk/8.0.404/dotnet-sdk-8.0.404-win-x64.exe"
$dotnetInstaller = "$tempDir\dotnet-sdk-installer.exe"

try {
    Write-Host "Downloading .NET SDK from: $dotnetUrl"
    Invoke-WebRequest -Uri $dotnetUrl -OutFile $dotnetInstaller -UseBasicParsing
    $fileSize = (Get-Item $dotnetInstaller).Length / 1MB
    Write-Host "Downloaded .NET SDK installer. Size: $([math]::Round($fileSize, 2)) MB"
    
    Write-Host "Installing .NET SDK silently..."
    $process = Start-Process -FilePath $dotnetInstaller -ArgumentList "/quiet" -PassThru -Wait
    Write-Host ".NET SDK installation completed with exit code: $($process.ExitCode)"
    
    # Clean up installer
    Remove-Item $dotnetInstaller -ErrorAction SilentlyContinue
    
} catch {
    Write-Host "Error installing .NET SDK: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Step 2: Update PATH and test .NET
Write-Host "`n2. Configuring .NET environment..." -ForegroundColor Yellow
$dotnetPath = "C:\Program Files\dotnet"
if (Test-Path $dotnetPath) {
    $env:PATH = "$dotnetPath;$env:PATH"
    Write-Host "Added .NET to PATH: $dotnetPath"
} else {
    Write-Host ".NET installation directory not found at expected location" -ForegroundColor Red
}

# Refresh environment variables
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")

Write-Host "Testing .NET installation..."
try {
    $dotnetVersion = & dotnet --version 2>&1
    Write-Host ".NET SDK Version: $dotnetVersion" -ForegroundColor Green
} catch {
    Write-Host "Error: .NET is not available in PATH" -ForegroundColor Red
    Write-Host "Current PATH: $env:PATH"
    exit 1
}

# Step 3: Install Attack Surface Analyzer
Write-Host "`n3. Installing Attack Surface Analyzer..." -ForegroundColor Yellow
try {
    Write-Host "Installing ASA via dotnet tool..."
    & dotnet tool install -g Microsoft.CST.AttackSurfaceAnalyzer.CLI
    Write-Host "ASA installation completed" -ForegroundColor Green
} catch {
    Write-Host "Error installing ASA: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Step 4: Test ASA installation
Write-Host "`n4. Testing Attack Surface Analyzer..." -ForegroundColor Yellow
try {
    # Update PATH for global tools
    $globalToolsPath = "$env:USERPROFILE\.dotnet\tools"
    $env:PATH = "$globalToolsPath;$env:PATH"
    
    Write-Host "Testing ASA command..."
    & asa --version
    Write-Host "ASA is working!" -ForegroundColor Green
    
    Write-Host "`nASA Help:" -ForegroundColor Cyan
    & asa --help
    
} catch {
    Write-Host "Error testing ASA: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Checking if ASA was installed..."
    
    # Check if ASA exists in global tools
    if (Test-Path "$env:USERPROFILE\.dotnet\tools\asa.exe") {
        Write-Host "ASA executable found at: $env:USERPROFILE\.dotnet\tools\asa.exe"
    } else {
        Write-Host "ASA executable not found"
    }
}

Write-Host "`n=== Installation Complete ===" -ForegroundColor Green
Write-Host "If successful, you can now use ASA with these commands:"
Write-Host "  asa collect -a          # Collect baseline"
Write-Host "  asa collect -a          # Collect after changes"
Write-Host "  asa export-collect      # Compare collections"
Write-Host "  asa gui                 # Start web interface"
