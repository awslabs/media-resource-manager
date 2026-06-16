// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// SSM Document: Windows Disable CTRL+ALT+DEL
// Disables the CTRL+ALT+DEL requirement for easier DCV login
// Used by workstation-creation-stack-windows.ts for satellite region workstations

module.exports = {
  schemaVersion: '2.2',
  description: 'Disable CTRL+ALT+DEL requirement for DCV login on Windows workstations',
  parameters: {},
  mainSteps: [
    {
      action: 'aws:runPowerShellScript',
      name: 'DisableCtrlAltDel',
      inputs: {
        runCommand: [
          '# Disable CTRL+ALT+DEL requirement for DCV login',
          'Write-Host "Disabling CTRL+ALT+DEL requirement for easier DCV access"',
          'try {',
          '    # Set registry value to disable CTRL+ALT+DEL requirement',
          '    $regPath = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System"',
          '    Set-ItemProperty -Path $regPath -Name "DisableCAD" -Value 1 -Type DWord -Force',
          '    Write-Host "Successfully disabled CTRL+ALT+DEL requirement"',
          '    # Verify the setting',
          '    $value = Get-ItemProperty -Path $regPath -Name "DisableCAD" -ErrorAction SilentlyContinue',
          '    if ($value.DisableCAD -eq 1) {',
          '        Write-Host "Verification: DisableCAD registry value is set to 1"',
          '    } else {',
          '        Write-Host "Warning: DisableCAD registry value verification failed"',
          '    }',
          '} catch {',
          '    Write-Host "Error setting registry value: $($_.Exception.Message)"',
          '    exit 1',
          '}'
        ],
        timeoutSeconds: '120'
      }
    }
  ]
};
