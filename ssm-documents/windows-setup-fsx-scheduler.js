// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// SSM Document: Windows Setup FSx Task Scheduler
// Creates a scheduled task to mount FSx storage at user login
// Used by workstation-creation-stack-windows.ts for satellite region workstations

module.exports = {
  schemaVersion: '2.2',
  description: 'Setup FSx mount task scheduler for Windows workstations',
  parameters: {},
  mainSteps: [
    {
      action: 'aws:runPowerShellScript',
      name: 'SetupFsxTaskScheduler',
      inputs: {
        runCommand: [
          'Write-Host "Setting up FSx mount task scheduler for login"',
          'try {',
          '    # Create script directory if it doesn\'t exist',
          '    $scriptDir = "C:\\Windows\\System32\\GroupPolicy\\User\\Scripts\\Logon"',
          '    if (-not (Test-Path $scriptDir)) {',
          '        New-Item -Path $scriptDir -ItemType Directory -Force | Out-Null',
          '        Write-Host "Created directory: $scriptDir"',
          '    }',
          '    ',
          '    # Create placeholder script if it doesn\'t exist',
          '    $scriptPath = "$scriptDir\\MountFsxStorage.ps1"',
          '    if (-not (Test-Path $scriptPath)) {',
          '        $scriptContent = "# Placeholder FSx mount script`nWrite-Host `"FSx mount script placeholder - replace with actual mount logic`""',
          '        $scriptContent | Out-File -FilePath $scriptPath -Encoding UTF8',
          '        Write-Host "Created placeholder script: $scriptPath"',
          '    }',
          '    ',
          '    # Create scheduled task using schtasks command (more reliable)',
          '    Write-Host "Creating scheduled task using schtasks command"',
          '    ',
          '    # Remove existing task if it exists',
          '    schtasks /delete /tn FSxMountScript /f 2>$null',
          '    ',
          '    # Create task using schtasks command with simpler syntax',
          '    schtasks /create /tn FSxMountScript /tr "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -NonInteractive -File \'$scriptPath\'" /sc onlogon /ru Users /f',
          '    ',
          '    # Verify task creation',
          '    if ($LASTEXITCODE -eq 0) {',
          '        Write-Host "Successfully created FSx mount task scheduler"',
          '    } else {',
          '        Write-Host "Failed to create scheduled task with exit code: $LASTEXITCODE"',
          '        exit 1',
          '    }',
          '    ',
          '} catch {',
          '    Write-Host "Error: $($_.Exception.Message)"',
          '    exit 1',
          '}'
        ],
        timeoutSeconds: '120'
      }
    }
  ]
};
