// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Static checks on the Windows auto-login SSM document: the Administrator
 * password is read from Secrets Manager on the instance and set in-process,
 * never passed to a child process as an argument, and never sent in the Run
 * Command parameters.
 */

const doc = require('../ssm-documents/windows-autologin-configure.js');
const runCommand: string[] = doc.mainSteps[0].inputs.runCommand;
const script = runCommand.join('\n');
// Code lines only (comments dropped), trimmed.
const codeLines = runCommand.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

const indexOf = (re: RegExp) => codeLines.findIndex((l) => re.test(l));

describe('windows-autologin-configure document', () => {
  test('takes no password parameter', () => {
    expect(Object.keys(doc.parameters).sort()).toEqual(['PascalCaseName', 'PrimaryRegion']);
  });

  test('reads the password from Secrets Manager on the instance', () => {
    expect(script).toMatch(/\$password = \(Get-SECSecretValue -SecretId \$secretArn -Region \$PrimaryRegion\)\.SecretString/);
  });

  test('passes the password to no external command', () => {
    // Any line that mentions $password must be a PowerShell assignment or
    // cmdlet call, not net.exe or another program taking it in argv.
    const withPassword = codeLines.filter((l) => /\$password\b/.test(l));
    expect(withPassword.length).toBeGreaterThan(0);
    for (const line of withPassword) {
      expect(line).not.toMatch(/^(\$\w+\s*=\s*)?(&\s*)?(net|net\.exe|cmd|cmd\.exe|powershell|powershell\.exe)\b/i);
    }
    expect(script).not.toMatch(/net(\.exe)?\s+user\s+\S+\s+\$password/i);
  });

  test('sets the Administrator password with Set-LocalUser and a SecureString', () => {
    expect(script).toMatch(/\$securePassword = ConvertTo-SecureString -String \$password -AsPlainText -Force/);
    expect(script).toMatch(/Set-LocalUser -Name "Administrator" -Password \$securePassword -ErrorAction Stop/);
  });

  test('sets the account password before writing DefaultPassword', () => {
    const setUser = indexOf(/^Set-LocalUser /);
    const defaultPassword = indexOf(/-Name "DefaultPassword"/);
    expect(setUser).toBeGreaterThanOrEqual(0);
    expect(defaultPassword).toBeGreaterThan(setUser);
  });

  test('drops the password variables after use', () => {
    const defaultPassword = indexOf(/-Name "DefaultPassword"/);
    const remove = indexOf(/^Remove-Variable -Name password, securePassword\b/);
    expect(remove).toBeGreaterThan(defaultPassword);
    // Nothing after that reads $password again.
    expect(codeLines.slice(remove + 1).some((l) => /\$password\b/.test(l))).toBe(false);
  });

  test('never prints the password', () => {
    for (const line of codeLines.filter((l) => /^(Write-\w+|echo)\b/i.test(l))) {
      expect(line).not.toMatch(/\$password\b|\$securePassword\b/);
    }
  });
});

describe('autologin-configure Lambda', () => {
  test('sends only the prefix and Region as Run Command parameters', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'autologin-configure', 'index.js'), 'utf8');
    const params = src.match(/Parameters:\s*\{([^}]*)\}/);
    expect(params).not.toBeNull();
    const keys = Array.from(params![1].matchAll(/(\w+):/g)).map((m) => m[1]).sort();
    expect(keys).toEqual(['PascalCaseName', 'PrimaryRegion']);
  });
});
