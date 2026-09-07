# Create the service account, admin group, and test user on the promoted DC.
#
# Run via SSM SendCommand from emulator.py AFTER the AD promotion reboot has
# completed and AD DS services are up. Idempotent — creating an object that
# already exists is a no-op with a warning.
#
# Parameters:
#   -DomainName             e.g. customer.internal
#   -ServiceAccountName     e.g. MRMServiceAccount
#   -ServiceAccountPassword plaintext, retrieved from Secrets Manager by caller
#   -AdminGroupName         e.g. Studio-Admins-Test
#   -TestUserName           e.g. teststudio
#   -TestUserPassword       plaintext, retrieved from Secrets Manager by caller

param(
    [Parameter(Mandatory=$true)][string]$DomainName,
    [Parameter(Mandatory=$true)][string]$ServiceAccountName,
    [Parameter(Mandatory=$true)][string]$ServiceAccountPassword,
    [Parameter(Mandatory=$true)][string]$AdminGroupName,
    [Parameter(Mandatory=$true)][string]$TestUserName,
    [Parameter(Mandatory=$true)][string]$TestUserPassword
)

$ErrorActionPreference = 'Stop'

Write-Host "=== 02-create-users.ps1 starting ==="
Write-Host "Domain: $DomainName"

# Wait for the ActiveDirectory module to be available (AD services take a
# few extra seconds to come up after reboot even after the OS is running).
$maxWait = 300  # 5 minutes
$elapsed = 0
while ($elapsed -lt $maxWait) {
    try {
        Import-Module ActiveDirectory -ErrorAction Stop
        # Also try a real query to confirm the service is responsive.
        Get-ADDomain -Identity $DomainName -ErrorAction Stop | Out-Null
        Write-Host "AD DS is up and responsive after ${elapsed}s"
        break
    } catch {
        Write-Host "  AD DS not ready yet (${elapsed}s): $($_.Exception.Message)"
        Start-Sleep -Seconds 15
        $elapsed += 15
    }
}
if ($elapsed -ge $maxWait) {
    Write-Error "AD DS did not become responsive within ${maxWait}s"
    exit 1
}

$domainParts = $DomainName.Split('.')
$domainDN = ($domainParts | ForEach-Object { "DC=$_" }) -join ','
Write-Host "Domain DN: $domainDN"

# ─── Service account ────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Creating service account: $ServiceAccountName ==="
$existing = Get-ADUser -Filter "SamAccountName -eq '$ServiceAccountName'" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  Service account already exists — resetting password to match Secrets Manager value"
    $securePw = ConvertTo-SecureString $ServiceAccountPassword -AsPlainText -Force
    Set-ADAccountPassword -Identity $ServiceAccountName -Reset -NewPassword $securePw
} else {
    $securePw = ConvertTo-SecureString $ServiceAccountPassword -AsPlainText -Force
    New-ADUser `
        -Name $ServiceAccountName `
        -SamAccountName $ServiceAccountName `
        -UserPrincipalName "$ServiceAccountName@$DomainName" `
        -AccountPassword $securePw `
        -Enabled $true `
        -PasswordNeverExpires $true `
        -Description "Service account used by MRM to bind to this AD (test emulator)"
    Write-Host "  Created service account"
}

# The service account needs read access to the domain so AD Connector's
# LDAP bind + queries succeed. Add to "Domain Users" (default) and grant
# "Read all inetOrgPerson information" via delegation would be more precise,
# but for a test fixture the simpler pattern is fine.
Write-Host "  Service account is a member of Domain Users by default"

# ─── Admin group ────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Creating admin group: $AdminGroupName ==="
$existing = Get-ADGroup -Filter "SamAccountName -eq '$AdminGroupName'" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  Admin group already exists — no change"
} else {
    New-ADGroup `
        -Name $AdminGroupName `
        -SamAccountName $AdminGroupName `
        -GroupCategory Security `
        -GroupScope Global `
        -Description "Test admin group for MRM AD emulator"
    Write-Host "  Created admin group"
}

# ─── Test user ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Creating test user: $TestUserName ==="
$existing = Get-ADUser -Filter "SamAccountName -eq '$TestUserName'" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  Test user already exists — resetting password to match Secrets Manager value"
    $securePw = ConvertTo-SecureString $TestUserPassword -AsPlainText -Force
    Set-ADAccountPassword -Identity $TestUserName -Reset -NewPassword $securePw
} else {
    $securePw = ConvertTo-SecureString $TestUserPassword -AsPlainText -Force
    New-ADUser `
        -Name $TestUserName `
        -SamAccountName $TestUserName `
        -UserPrincipalName "$TestUserName@$DomainName" `
        -GivenName "Test" `
        -Surname "Studio" `
        -DisplayName "Test Studio" `
        -EmailAddress "$TestUserName@$DomainName" `
        -AccountPassword $securePw `
        -Enabled $true `
        -PasswordNeverExpires $true `
        -Description "Test user for MRM AD emulator"
    Write-Host "  Created test user"
}

# Add test user to admin group so MRM sees them as admin.
Write-Host ""
Write-Host "=== Adding test user to admin group ==="
$memberOf = Get-ADPrincipalGroupMembership -Identity $TestUserName | Where-Object { $_.SamAccountName -eq $AdminGroupName }
if ($memberOf) {
    Write-Host "  Test user is already a member of $AdminGroupName"
} else {
    Add-ADGroupMember -Identity $AdminGroupName -Members $TestUserName
    Write-Host "  Added test user to $AdminGroupName"
}

Write-Host ""
Write-Host "=== 02-create-users.ps1 completed successfully ==="
