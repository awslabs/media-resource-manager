# GitHub Desktop Installation Script - Machine-Wide Deployment
# For AWS EC2 Image Builder
#
# GitHub Desktop uses a two-stage installation:
# 1. MSI installs the "GitHub Desktop Deployment Tool" to Program Files
# 2. The deployment tool installs the actual app per-user on first login
#
# This script:
# - Installs the MSI deployment tool machine-wide
# - Pre-stages the per-user installation to the Default User profile
#   so all new users get GitHub Desktop automatically
#

$LocalTempDir = $env:TEMP
$InstallerName = "GitHubDesktopSetup-x64.msi"
$DownloadUrl = "https://central.github.com/deployments/desktop/desktop/latest/win32?format=msi"

# Function to download with retry
function Download-WithRetry {
    param(
        [string]$Url,
        [string]$OutFile,
        [int]$MaxRetries = 3,
        [int]$RetryDelaySeconds = 10
    )
    
    for ($i = 1; $i -le $MaxRetries; $i++) {
        try {
            Write-Host "Download attempt $i of $MaxRetries..."
            
            # Use WebClient for more reliable large file downloads
            $webClient = New-Object System.Net.WebClient
            $webClient.DownloadFile($Url, $OutFile)
            $webClient.Dispose()
            
            if (Test-Path $OutFile) {
                $fileSize = (Get-Item $OutFile).Length
                if ($fileSize -gt 0) {
                    Write-Host "Download successful: $([math]::Round($fileSize / 1MB, 2)) MB"
                    return $true
                }
            }
            throw "Downloaded file is empty or missing"
        }
        catch {
            Write-Host "Download attempt $i failed: $_"
            if ($i -lt $MaxRetries) {
                Write-Host "Waiting $RetryDelaySeconds seconds before retry..."
                Start-Sleep -Seconds $RetryDelaySeconds
            }
        }
    }
    return $false
}

try {
    Write-Host "Starting GitHub Desktop machine-wide installation..."
    Write-Host "Running as: $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
    
    # Step 1: Download and install the MSI (deployment tool)
    Write-Host "`n=== Step 1: Installing GitHub Desktop Deployment Tool ==="
    Write-Host "Downloading GitHub Desktop MSI installer..."
    
    $msiPath = "$LocalTempDir\$InstallerName"
    $downloadSuccess = Download-WithRetry -Url $DownloadUrl -OutFile $msiPath
    
    if (-not $downloadSuccess) {
        throw "Failed to download GitHub Desktop MSI installer after multiple attempts"
    }
    
    # Install MSI with ALLUSERS=1 for machine-wide registration
    Write-Host "Installing MSI with ALLUSERS=1..."
    $msiArgs = "/i `"$msiPath`" /qn /norestart ALLUSERS=1 /l*v `"$LocalTempDir\GitHubDesktop_MSI.log`""
    $process = Start-Process -FilePath "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru
    
    if ($process.ExitCode -ne 0) {
        Write-Host "MSI installation returned exit code: $($process.ExitCode)"
        if (Test-Path "$LocalTempDir\GitHubDesktop_MSI.log") {
            Write-Host "Last 30 lines of MSI log:"
            Get-Content "$LocalTempDir\GitHubDesktop_MSI.log" -Tail 30
        }
        throw "MSI installation failed with exit code $($process.ExitCode)"
    }
    
    Write-Host "MSI deployment tool installed successfully"
    
    # Find the deployment tool executable
    $deploymentToolPaths = @(
        "${env:ProgramFiles(x86)}\GitHub Desktop Installer\GitHubDesktop.exe",
        "${env:ProgramFiles}\GitHub Desktop Installer\GitHubDesktop.exe",
        "C:\Program Files (x86)\GitHub Desktop Installer\GitHubDesktop.exe",
        "C:\Program Files\GitHub Desktop Installer\GitHubDesktop.exe"
    )
    
    $deploymentTool = $null
    foreach ($path in $deploymentToolPaths) {
        if (Test-Path $path) {
            $deploymentTool = $path
            Write-Host "Found deployment tool at: $deploymentTool"
            break
        }
    }
    
    if (-not $deploymentTool) {
        Write-Host "Warning: Deployment tool not found at expected paths"
        Write-Host "Searching for GitHubDesktop.exe..."
        $found = Get-ChildItem -Path "C:\Program Files*" -Recurse -Filter "GitHubDesktop.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
            $deploymentTool = $found.FullName
            Write-Host "Found deployment tool at: $deploymentTool"
        }
    }
    
    # Step 2: Pre-install for Default User profile
    Write-Host "`n=== Step 2: Pre-staging GitHub Desktop for Default User ==="
    
    if ($deploymentTool) {
        $defaultUserProfile = "C:\Users\Default"
        $defaultLocalAppData = "$defaultUserProfile\AppData\Local"
        
        # Create the target directory structure
        if (-not (Test-Path $defaultLocalAppData)) {
            New-Item -Path $defaultLocalAppData -ItemType Directory -Force | Out-Null
        }
        
        # Download the standalone EXE installer
        Write-Host "Downloading standalone EXE installer for extraction..."
        $exeUrl = "https://central.github.com/deployments/desktop/desktop/latest/win32"
        $exeInstaller = "$LocalTempDir\GitHubDesktopSetup.exe"
        
        $exeDownloadSuccess = Download-WithRetry -Url $exeUrl -OutFile $exeInstaller
        
        if ($exeDownloadSuccess -and (Test-Path $exeInstaller)) {
            Write-Host "Extracting GitHub Desktop to Default User profile..."
            
            # Set environment variable to redirect installation
            $env:LOCALAPPDATA = $defaultLocalAppData
            
            # Run the installer silently
            $installProcess = Start-Process -FilePath $exeInstaller -ArgumentList "--silent" -Wait -PassThru -NoNewWindow
            
            # Reset environment variable
            $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
            
            Write-Host "Installer exit code: $($installProcess.ExitCode)"
            
            # Check if installation succeeded
            $ghDesktopPath = "$defaultLocalAppData\GitHubDesktop"
            if (Test-Path $ghDesktopPath) {
                Write-Host "GitHub Desktop installed to Default User profile at: $ghDesktopPath"
                $installedFiles = Get-ChildItem -Path $ghDesktopPath -Recurse -File | Measure-Object
                Write-Host "Installed files count: $($installedFiles.Count)"
                
                $mainExe = Get-ChildItem -Path $ghDesktopPath -Recurse -Filter "GitHubDesktop.exe" | Select-Object -First 1
                if ($mainExe) {
                    Write-Host "Main executable found at: $($mainExe.FullName)"
                }
            } else {
                Write-Host "Warning: GitHub Desktop directory not found in Default User profile"
                Write-Host "Checking what was created..."
                Get-ChildItem -Path $defaultLocalAppData -ErrorAction SilentlyContinue | ForEach-Object {
                    Write-Host "  - $($_.Name)"
                }
            }
        } else {
            Write-Host "Warning: Could not download EXE installer for Default User pre-staging"
        }
    }
    
    # Step 3: Create Start Menu shortcut for all users
    Write-Host "`n=== Step 3: Creating Start Menu shortcut ==="
    
    $startMenuPath = "C:\ProgramData\Microsoft\Windows\Start Menu\Programs"
    $shortcutPath = "$startMenuPath\GitHub Desktop.lnk"
    
    $targetExe = $null
    
    # Check Default User profile first
    $defaultGhDesktop = Get-ChildItem -Path "C:\Users\Default\AppData\Local\GitHubDesktop" -Recurse -Filter "GitHubDesktop.exe" -ErrorAction SilentlyContinue | 
        Where-Object { $_.Directory.Name -like "app-*" } | 
        Select-Object -First 1
    
    if ($defaultGhDesktop) {
        $targetExe = "%LOCALAPPDATA%\GitHubDesktop\GitHubDesktop.exe"
        Write-Host "Will create shortcut pointing to: $targetExe"
    } elseif ($deploymentTool) {
        $targetExe = $deploymentTool
        Write-Host "Will create shortcut pointing to deployment tool: $targetExe"
    }
    
    if ($targetExe) {
        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut($shortcutPath)
        $Shortcut.TargetPath = $targetExe
        $Shortcut.Description = "GitHub Desktop"
        $Shortcut.Save()
        Write-Host "Created Start Menu shortcut at: $shortcutPath"
    }
    
    # Cleanup
    Write-Host "`n=== Cleanup ==="
    Remove-Item "$LocalTempDir\$InstallerName" -Force -ErrorAction SilentlyContinue
    Remove-Item "$LocalTempDir\GitHubDesktopSetup.exe" -Force -ErrorAction SilentlyContinue
    
    Write-Host "`n=== Installation Summary ==="
    Write-Host "GitHub Desktop deployment tool: Installed"
    if (Test-Path "C:\Users\Default\AppData\Local\GitHubDesktop") {
        Write-Host "Default User pre-staging: Success"
        Write-Host "New users will have GitHub Desktop available on first login"
    } else {
        Write-Host "Default User pre-staging: Partial"
        Write-Host "Users can run GitHub Desktop from Start Menu (deployment tool will install on first run)"
    }
    
    Write-Host "`nGitHub Desktop installation completed"
    
} catch {
    Write-Error "Failed to install GitHub Desktop: $_"
    Remove-Item "$LocalTempDir\$InstallerName" -Force -ErrorAction SilentlyContinue
    Remove-Item "$LocalTempDir\GitHubDesktopSetup.exe" -Force -ErrorAction SilentlyContinue
    exit 1
}
