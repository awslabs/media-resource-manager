// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { SSMClient, SendCommandCommand } = require('@aws-sdk/client-ssm');

// Helper to create SSM client for specific region
function getSSMClient(region) {
  if (region && region !== process.env.AWS_REGION) {
    return new SSMClient({ region });
  }
  return new SSMClient();
}

exports.handler = async (event) => {
  console.log('Configuring Linux auto-login:', JSON.stringify(event, null, 2));
  
  const { instanceId, platform, region } = event;
  const ssm = getSSMClient(region);
  
  // Shell script to configure Linux autologin
  // Detects distro (Ubuntu vs Rocky/RHEL) and configures GDM autologin
  const commands = [
    '#!/bin/bash',
    'set -e',
    'echo "=== Configuring Linux autologin on workstation start ==="',
    '',
    '# Detect distro',
    'if [ -f /etc/os-release ]; then . /etc/os-release; DISTRO=$ID; else DISTRO="unknown"; fi',
    '',
    '# Set distro-specific variables',
    'if [ "$DISTRO" = "ubuntu" ]; then',
    '  DEFAULT_USER="ubuntu"; GDM_SERVICE="gdm3"; GDM_CONF="/etc/gdm3/custom.conf"',
    'else',
    '  DEFAULT_USER="rocky"; GDM_SERVICE="gdm"; GDM_CONF="/etc/gdm/custom.conf"',
    'fi',
    'echo "Distro: $DISTRO, User: $DEFAULT_USER, GDM: $GDM_SERVICE"',
    '',
    '# Ensure GDM autologin config exists',
    'sudo mkdir -p $(dirname $GDM_CONF)',
    'echo "[daemon]" | sudo tee $GDM_CONF',
    'echo "WaylandEnable=false" | sudo tee -a $GDM_CONF',
    'echo "AutomaticLoginEnable=true" | sudo tee -a $GDM_CONF',
    'echo "AutomaticLogin=$DEFAULT_USER" | sudo tee -a $GDM_CONF',
    'echo "[security]" | sudo tee -a $GDM_CONF',
    'echo "[xdmcp]" | sudo tee -a $GDM_CONF',
    'echo "[chooser]" | sudo tee -a $GDM_CONF',
    'echo "[debug]" | sudo tee -a $GDM_CONF',
    '',
    '# Remove old ensure-xorg.service if it exists (replaced by ensure-autologin)',
    'if [ -f /etc/systemd/system/ensure-xorg.service ]; then',
    '  echo "Removing old ensure-xorg.service..."',
    '  sudo systemctl disable ensure-xorg.service 2>/dev/null || true',
    '  sudo rm -f /etc/systemd/system/ensure-xorg.service',
    'fi',
    '',
    '# Create/update ensure-autologin systemd service if not exists or outdated',
    'NEED_SERVICE_UPDATE=false',
    'if [ ! -f /etc/systemd/system/ensure-autologin.service ]; then',
    '  NEED_SERVICE_UPDATE=true',
    'elif ! grep -q "sleep 20" /etc/systemd/system/ensure-autologin.service; then',
    '  NEED_SERVICE_UPDATE=true',
    'fi',
    '',
    'if [ "$NEED_SERVICE_UPDATE" = "true" ]; then',
    '  echo "Creating/updating ensure-autologin.service..."',
    '  cat << SERVICEEOF | sudo tee /etc/systemd/system/ensure-autologin.service',
    '[Unit]',
    'Description=Ensure GDM autologin on boot',
    'After=graphical.target ${GDM_SERVICE}.service',
    'Wants=graphical.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    'ExecStartPre=/bin/sleep 20',
    'ExecStart=/bin/bash -c "systemctl restart ${GDM_SERVICE}; sleep 15; pgrep -x Xorg || systemctl restart ${GDM_SERVICE}"',
    '',
    '[Install]',
    'WantedBy=graphical.target',
    'SERVICEEOF',
    '  # Replace ${GDM_SERVICE} with actual value',
    '  sudo sed -i "s/\\${GDM_SERVICE}/$GDM_SERVICE/g" /etc/systemd/system/ensure-autologin.service',
    '  sudo systemctl daemon-reload',
    '  sudo systemctl enable ensure-autologin.service',
    'fi',
    '',
    '# Check if user is already logged in (service may have run on boot)',
    'if loginctl list-sessions | grep -q "$DEFAULT_USER"; then',
    '  echo "SUCCESS: $DEFAULT_USER is already logged in"',
    '  loginctl list-sessions',
    '  pgrep -x Xorg && echo "Xorg: RUNNING" || echo "Xorg: NOT RUNNING"',
    '  exit 0',
    'fi',
    '',
    '# User not logged in - manually trigger autologin by restarting GDM',
    'echo "User not logged in, triggering autologin by restarting GDM..."',
    'sudo systemctl restart $GDM_SERVICE',
    '',
    '# Wait for autologin to complete (GDM restart + session creation)',
    'echo "Waiting for autologin to complete..."',
    'for i in {1..12}; do',
    '  sleep 5',
    '  if loginctl list-sessions | grep -q "$DEFAULT_USER"; then',
    '    echo "SUCCESS: $DEFAULT_USER is logged in after GDM restart"',
    '    break',
    '  fi',
    '  echo "Waiting for $DEFAULT_USER session... ($i/12)"',
    'done',
    '',
    '# Final verification',
    'loginctl list-sessions',
    'pgrep -x Xorg && echo "Xorg: RUNNING" || echo "Xorg: NOT RUNNING"',
    '',
    'if loginctl list-sessions | grep -q "$DEFAULT_USER"; then',
    '  echo "Linux autologin configuration complete!"',
    'else',
    '  echo "WARNING: User session not detected, but continuing..."',
    'fi'
  ];
  
  try {
    const commandResult = await ssm.send(new SendCommandCommand({
      DocumentName: 'AWS-RunShellScript',
      InstanceIds: [instanceId],
      Parameters: { commands },
      TimeoutSeconds: 180,
      Comment: 'Configure Linux auto-login for workstation start'
    }));
    
    const commandId = commandResult.Command.CommandId;
    console.log('Linux auto-login configuration command sent, CommandId:', commandId);
    
    return {
      ...event,
      autoLoginCommandId: commandId
    };
  } catch (error) {
    console.error('Error sending Linux auto-login configuration command:', error);
    throw error;
  }
};
