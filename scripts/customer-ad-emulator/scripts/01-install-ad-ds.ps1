# Install and promote to Active Directory domain controller.
#
# Run via SSM SendCommand from emulator.py after the instance has booted and
# joined SSM.
#
# This script:
#   1. Installs the AD-Domain-Services Windows Feature and its management
#      tools, plus the DNS Server Windows Feature (DCs are also DNS servers)
#   2. Promotes the instance to the first domain controller in a new forest
#      using Install-ADDSForest
#
# After Install-ADDSForest completes, the instance reboots automatically.
# The next SSM command (02-create-users.ps1) must wait for the reboot and
# for AD services to come up before it can run.
#
# Parameters:
#   -DomainName          e.g. customer.internal
#   -NetbiosName         e.g. CUSTOMER (short domain name, max 15 chars,
#                        uppercase, no dots)
#   -SafeModePassword    plaintext password for Directory Services Restore
#                        Mode. Different from the domain admin password.
#                        Retrieved from Secrets Manager by the caller and
#                        passed in via SSM parameter overrides.

param(
    [Parameter(Mandatory=$true)][string]$DomainName,
    [Parameter(Mandatory=$true)][string]$NetbiosName,
    [Parameter(Mandatory=$true)][string]$SafeModePassword
)

$ErrorActionPreference = 'Stop'

Write-Host "=== 01-install-ad-ds.ps1 starting ==="
Write-Host "Domain name : $DomainName"
Write-Host "NetBIOS name: $NetbiosName"

# Skip if this DC has already been promoted (idempotency for retries).
try {
    $existingRole = Get-WmiObject Win32_ComputerSystem
    if ($existingRole.DomainRole -eq 4 -or $existingRole.DomainRole -eq 5) {
        Write-Host "This machine is already a domain controller (DomainRole=$($existingRole.DomainRole)). Nothing to do."
        exit 0
    }
} catch {
    Write-Host "Could not read Win32_ComputerSystem; proceeding with install."
}

Write-Host "=== Installing AD-Domain-Services and DNS ==="
Install-WindowsFeature -Name AD-Domain-Services, DNS -IncludeManagementTools

Write-Host "=== Converting SafeMode password to SecureString ==="
$secure = ConvertTo-SecureString $SafeModePassword -AsPlainText -Force

Write-Host "=== Promoting to first DC in new forest: $DomainName ==="
# Install-ADDSForest triggers an automatic reboot on completion.
# -Force skips the "are you sure" prompt.
Install-ADDSForest `
    -DomainName $DomainName `
    -DomainNetbiosName $NetbiosName `
    -SafeModeAdministratorPassword $secure `
    -InstallDns `
    -CreateDnsDelegation:$false `
    -DatabasePath 'C:\Windows\NTDS' `
    -LogPath 'C:\Windows\NTDS' `
    -SysvolPath 'C:\Windows\SYSVOL' `
    -DomainMode 'WinThreshold' `
    -ForestMode 'WinThreshold' `
    -Force

# If Install-ADDSForest completes without triggering a reboot, force one so
# the caller can detect it and wait.
Write-Host "=== Install-ADDSForest completed. Forcing reboot. ==="
Restart-Computer -Force
