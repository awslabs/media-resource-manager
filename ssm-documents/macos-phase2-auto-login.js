// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// SSM Document: macOS Phase 2 - Auto Login
// Source: lib/workstation-creation-stack-macos.ts lines 194-267
// Copy the content object from the CfnDocument definition

module.exports = {
  schemaVersion: '2.2',
  description: 'Phase 2: Configure auto-login for macOS workstation',
  parameters: {
    Username: { type: 'String', default: 'ec2-user', description: 'Username for auto-login' },
    AdminPasswordSecretArn: { type: 'String', description: 'Secrets Manager ARN for the SIP admin password' }
  },
  mainSteps: [{
    action: 'aws:runShellScript',
    name: 'ConfigureAutoLogin',
    inputs: {
      runCommand: [
        '#!/bin/bash',
        'set -e',
        'USERNAME="{{Username}}"',
        'SECRET_ARN="{{AdminPasswordSecretArn}}"',
        '',
        'echo "=== Phase 2: Configure Auto-Login on macOS ==="',
        '',
        '# Retrieve password from Secrets Manager',
        'REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)',
        'PASSWORD=$(/usr/local/bin/aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --region "$REGION" --query SecretString --output text 2>/dev/null)',
        'if [ -z "$PASSWORD" ]; then',
        '  echo "ERROR: Failed to retrieve password from Secrets Manager"',
        '  exit 1',
        'fi',
        '',
        'echo "Verifying user $USERNAME exists..."',
        'if ! dscl . -read /Users/$USERNAME > /dev/null 2>&1; then',
        '  echo "ERROR: User $USERNAME does not exist"',
        '  exit 1',
        'fi',
        'echo "User $USERNAME verified"',
        '',
        '# Generate kcpassword file (XOR encoded) for auto-login',
        '# This file stores the password in an obfuscated format that macOS uses for auto-login',
        'echo "Generating kcpassword file for auto-login..."',
        'sudo python3 - "$PASSWORD" << \'PYEOF\' | sudo tee /etc/kcpassword > /dev/null',
        'import sys',
        'KEY = [0x7D, 0x89, 0x52, 0x23, 0xD2, 0xBC, 0xDD, 0xEA, 0xA3, 0xB9, 0x1F]',
        'password = sys.argv[1].encode("utf-8")',
        'padding = 12 - (len(password) % 12)',
        'if padding == 12: padding = 0',
        'padded = password + (b"\\x00" * padding)',
        'encoded = bytearray(b ^ KEY[i % len(KEY)] for i, b in enumerate(padded))',
        'sys.stdout.buffer.write(bytes(encoded))',
        'PYEOF',
        '',
        'sudo chmod 600 /etc/kcpassword',
        'sudo chown root:wheel /etc/kcpassword',
        '',
        '# Verify kcpassword was created',
        'if [ ! -f /etc/kcpassword ]; then',
        '  echo "ERROR: Failed to create kcpassword file"',
        '  exit 1',
        'fi',
        'echo "kcpassword file created successfully"',
        '',
        '# Set auto-login user in loginwindow preferences',
        'echo "Setting auto-login user to $USERNAME..."',
        'sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser "$USERNAME"',
        '',
        '# Verify configuration',
        'echo "Verifying auto-login configuration..."',
        'CONFIGURED_USER=$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo "NOT SET")',
        'echo "Auto-login user: $CONFIGURED_USER"',
        '',
        'if [ "$CONFIGURED_USER" = "$USERNAME" ]; then',
        '  echo "Auto-login configured successfully!"',
        'else',
        '  echo "WARNING: Auto-login may not be configured correctly"',
        'fi',
        '',
        'echo "Phase 2 complete!"'
      ],
      timeoutSeconds: '300'
    }
  }]
};
