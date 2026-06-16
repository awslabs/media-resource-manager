// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import {
  AppLayout,
  ContentLayout,
  BreadcrumbGroup,
  Grid,
  Header,
  FormField,
  Input,
  Button,
  SpaceBetween,
  Alert,
  Box,
  Toggle,
  Spinner,
  Container,
  Tabs,
  Multiselect,
  Select,
} from '@cloudscape-design/components';
import Navigation from '../components/Navigation';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';

// Master catalog of all instance types with metadata
const INSTANCE_TYPE_CATALOG: Record<string, { family: string; label: string; platforms: string[] }> = {
  // Burstable - T3 (Intel)
  't3.medium': { family: 'Burstable - T3', label: 't3.medium (2 vCPU, 4 GB)', platforms: ['windows', 'linux'] },
  't3.large': { family: 'Burstable - T3', label: 't3.large (2 vCPU, 8 GB)', platforms: ['windows', 'linux'] },
  't3.xlarge': { family: 'Burstable - T3', label: 't3.xlarge (4 vCPU, 16 GB)', platforms: ['windows', 'linux'] },
  't3.2xlarge': { family: 'Burstable - T3', label: 't3.2xlarge (8 vCPU, 32 GB)', platforms: ['windows', 'linux'] },
  // General Purpose - M7i (Intel 4th Gen Xeon)
  'm7i.large': { family: 'General Purpose - M7i', label: 'm7i.large (2 vCPU, 8 GB)', platforms: ['windows', 'linux'] },
  'm7i.xlarge': { family: 'General Purpose - M7i', label: 'm7i.xlarge (4 vCPU, 16 GB)', platforms: ['windows', 'linux'] },
  'm7i.2xlarge': { family: 'General Purpose - M7i', label: 'm7i.2xlarge (8 vCPU, 32 GB)', platforms: ['windows', 'linux'] },
  'm7i.4xlarge': { family: 'General Purpose - M7i', label: 'm7i.4xlarge (16 vCPU, 64 GB)', platforms: ['windows', 'linux'] },
  'm7i.8xlarge': { family: 'General Purpose - M7i', label: 'm7i.8xlarge (32 vCPU, 128 GB)', platforms: ['windows', 'linux'] },
  'm7i.12xlarge': { family: 'General Purpose - M7i', label: 'm7i.12xlarge (48 vCPU, 192 GB)', platforms: ['windows', 'linux'] },
  'm7i.16xlarge': { family: 'General Purpose - M7i', label: 'm7i.16xlarge (64 vCPU, 256 GB)', platforms: ['windows', 'linux'] },
  // GPU - NVIDIA T4 (G4dn)
  'g4dn.xlarge': { family: 'GPU - NVIDIA T4', label: 'g4dn.xlarge (4 vCPU, 16 GB, T4)', platforms: ['windows', 'linux'] },
  'g4dn.2xlarge': { family: 'GPU - NVIDIA T4', label: 'g4dn.2xlarge (8 vCPU, 32 GB, T4)', platforms: ['windows', 'linux'] },
  'g4dn.4xlarge': { family: 'GPU - NVIDIA T4', label: 'g4dn.4xlarge (16 vCPU, 64 GB, T4)', platforms: ['windows', 'linux'] },
  'g4dn.8xlarge': { family: 'GPU - NVIDIA T4', label: 'g4dn.8xlarge (32 vCPU, 128 GB, T4)', platforms: ['windows', 'linux'] },
  'g4dn.12xlarge': { family: 'GPU - NVIDIA T4', label: 'g4dn.12xlarge (48 vCPU, 192 GB, 4x T4)', platforms: ['windows', 'linux'] },
  'g4dn.16xlarge': { family: 'GPU - NVIDIA T4', label: 'g4dn.16xlarge (64 vCPU, 256 GB, T4)', platforms: ['windows', 'linux'] },
  // GPU - NVIDIA A10G (G5)
  'g5.xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.xlarge (4 vCPU, 16 GB, A10G)', platforms: ['windows', 'linux'] },
  'g5.2xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.2xlarge (8 vCPU, 32 GB, A10G)', platforms: ['windows', 'linux'] },
  'g5.4xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.4xlarge (16 vCPU, 64 GB, A10G)', platforms: ['windows', 'linux'] },
  'g5.8xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.8xlarge (32 vCPU, 128 GB, A10G)', platforms: ['windows', 'linux'] },
  'g5.12xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.12xlarge (48 vCPU, 192 GB, 4x A10G)', platforms: ['windows', 'linux'] },
  'g5.16xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.16xlarge (64 vCPU, 256 GB, A10G)', platforms: ['windows', 'linux'] },
  'g5.24xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.24xlarge (96 vCPU, 384 GB, 4x A10G)', platforms: ['windows', 'linux'] },
  'g5.48xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.48xlarge (192 vCPU, 768 GB, 8x A10G)', platforms: ['windows', 'linux'] },
  // GPU - NVIDIA L4 (G6)
  'g6.xlarge': { family: 'GPU - NVIDIA L4', label: 'g6.xlarge (4 vCPU, 16 GB, L4)', platforms: ['windows', 'linux'] },
  'g6.2xlarge': { family: 'GPU - NVIDIA L4', label: 'g6.2xlarge (8 vCPU, 32 GB, L4)', platforms: ['windows', 'linux'] },
  'g6.4xlarge': { family: 'GPU - NVIDIA L4', label: 'g6.4xlarge (16 vCPU, 64 GB, L4)', platforms: ['windows', 'linux'] },
  'g6.8xlarge': { family: 'GPU - NVIDIA L4', label: 'g6.8xlarge (32 vCPU, 128 GB, L4)', platforms: ['windows', 'linux'] },
  'g6.12xlarge': { family: 'GPU - NVIDIA L4', label: 'g6.12xlarge (48 vCPU, 192 GB, 4x L4)', platforms: ['windows', 'linux'] },
  'g6.16xlarge': { family: 'GPU - NVIDIA L4', label: 'g6.16xlarge (64 vCPU, 256 GB, L4)', platforms: ['windows', 'linux'] },
  // Apple Silicon - M1
  'mac2.metal': { family: 'Apple Silicon - M1', label: 'mac2.metal (M1, 8 CPU, 8 GPU, 16 GB)', platforms: ['macos'] },
  'mac2-m1ultra.metal': { family: 'Apple Silicon - M1', label: 'mac2-m1ultra.metal (M1 Ultra, 20 CPU, 64 GPU, 128 GB)', platforms: ['macos'] },
  // Apple Silicon - M2
  'mac2-m2.metal': { family: 'Apple Silicon - M2', label: 'mac2-m2.metal (M2, 8 CPU, 10 GPU, 24 GB)', platforms: ['macos'] },
  'mac2-m2pro.metal': { family: 'Apple Silicon - M2', label: 'mac2-m2pro.metal (M2 Pro, 12 CPU, 19 GPU, 32 GB)', platforms: ['macos'] },
  // Apple Silicon - M4
  'mac-m4.metal': { family: 'Apple Silicon - M4', label: 'mac-m4.metal (M4, 10 CPU, 10 GPU, 24 GB)', platforms: ['macos'] },
  'mac-m4pro.metal': { family: 'Apple Silicon - M4', label: 'mac-m4pro.metal (M4 Pro, 14 CPU, 20 GPU, 48 GB)', platforms: ['macos'] },
};

// Export for use in other components
export { INSTANCE_TYPE_CATALOG };

interface PlatformConfig {
  enabled: string[];
  default: string;
}

interface AllowedInstanceTypes {
  windows: PlatformConfig;
  linux: PlatformConfig;
  macos: PlatformConfig;
}

const Settings: React.FC<{ config?: any }> = ({ config }) => {
  const [disconnectedDuration, setDisconnectedDuration] = useState('');
  const [browserSessionsEnabled, setBrowserSessionsEnabled] = useState(true);
  const [keepAliveEnabled, setKeepAliveEnabled] = useState(false);
  const [keepAliveMaxHours, setKeepAliveMaxHours] = useState('24');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  
  // Track original values to detect changes
  const [originalSettings, setOriginalSettings] = useState({
    disconnectedDuration: '',
    browserSessionsEnabled: true,
    keepAliveEnabled: false,
    keepAliveMaxHours: '24'
  });
  const [originalInstanceTypes, setOriginalInstanceTypes] = useState<AllowedInstanceTypes>({
    windows: { enabled: [], default: '' },
    linux: { enabled: [], default: '' },
    macos: { enabled: [], default: '' }
  });
  
  // Instance type allowlist state
  const [allowedInstanceTypes, setAllowedInstanceTypes] = useState<AllowedInstanceTypes>({
    windows: { enabled: [], default: '' },
    linux: { enabled: [], default: '' },
    macos: { enabled: [], default: '' }
  });

  useEffect(() => {
    loadSettings();
    loadAllowedInstanceTypes();
  }, []);

  const loadSettings = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall('/settings', {
        method: 'GET',
        headers: { 
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const settings = await response.json();
        const duration = settings.disconnectedDuration || '';
        const browserEnabled = settings.browserSessionsEnabled !== false;
        const keepAlive = settings.keepAliveEnabled === true;
        const keepAliveMax = settings.keepAliveMaxHours?.toString() || '24';
        setDisconnectedDuration(duration);
        setBrowserSessionsEnabled(browserEnabled);
        setKeepAliveEnabled(keepAlive);
        setKeepAliveMaxHours(keepAliveMax);
        setOriginalSettings({ 
          disconnectedDuration: duration, 
          browserSessionsEnabled: browserEnabled,
          keepAliveEnabled: keepAlive,
          keepAliveMaxHours: keepAliveMax
        });
      }
    } catch (error) {
      console.error('Error loading settings:', error);
      setError('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const loadAllowedInstanceTypes = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall('/settings/instance-types', {
        method: 'GET',
        headers: { 
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setAllowedInstanceTypes(data);
        setOriginalInstanceTypes(JSON.parse(JSON.stringify(data)));
      }
    } catch (error) {
      console.error('Error loading allowed instance types:', error);
    }
  };

  // Check if there are unsaved changes
  const hasUnsavedChanges = () => {
    const settingsChanged = 
      disconnectedDuration !== originalSettings.disconnectedDuration ||
      browserSessionsEnabled !== originalSettings.browserSessionsEnabled ||
      keepAliveEnabled !== originalSettings.keepAliveEnabled ||
      keepAliveMaxHours !== originalSettings.keepAliveMaxHours;
    
    const instanceTypesChanged = 
      JSON.stringify(allowedInstanceTypes) !== JSON.stringify(originalInstanceTypes);
    
    return settingsChanged || instanceTypesChanged;
  };

  // Cancel all changes
  const handleCancel = () => {
    setDisconnectedDuration(originalSettings.disconnectedDuration);
    setBrowserSessionsEnabled(originalSettings.browserSessionsEnabled);
    setKeepAliveEnabled(originalSettings.keepAliveEnabled);
    setKeepAliveMaxHours(originalSettings.keepAliveMaxHours);
    setAllowedInstanceTypes(JSON.parse(JSON.stringify(originalInstanceTypes)));
    setMessage('');
    setError('');
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    setError('');

    // Validate instance types first
    for (const [platform, config] of Object.entries(allowedInstanceTypes)) {
      if (config.enabled.length === 0) {
        setError(`${platform.charAt(0).toUpperCase() + platform.slice(1)} must have at least one enabled instance type.`);
        setSaving(false);
        return;
      }
      if (!config.default || !config.enabled.includes(config.default)) {
        setError(`${platform.charAt(0).toUpperCase() + platform.slice(1)} default must be one of the enabled instance types.`);
        setSaving(false);
        return;
      }
    }

    try {
      const token = getAuthToken();
      if (!token) return;

      // Save system settings
      const settingsResponse = await apiCall('/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          disconnectedDuration: parseInt(disconnectedDuration) || 0,
          browserSessionsEnabled,
          keepAliveEnabled,
          keepAliveMaxHours: parseInt(keepAliveMaxHours) || 24
        })
      });

      if (!settingsResponse.ok) {
        const errorData = await settingsResponse.json();
        setError(errorData.error || 'Failed to save system settings');
        setSaving(false);
        return;
      }

      // Save instance type settings
      const instanceTypesResponse = await apiCall('/settings/instance-types', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(allowedInstanceTypes)
      });

      if (!instanceTypesResponse.ok) {
        const errorData = await instanceTypesResponse.json();
        setError(errorData.error || 'Failed to save instance type settings');
        setSaving(false);
        return;
      }

      // Update original values to reflect saved state
      setOriginalSettings({ 
        disconnectedDuration, 
        browserSessionsEnabled,
        keepAliveEnabled,
        keepAliveMaxHours
      });
      setOriginalInstanceTypes(JSON.parse(JSON.stringify(allowedInstanceTypes)));
      setMessage('All settings saved successfully');
    } catch (error) {
      console.error('Error saving settings:', error);
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  // Get instance types available for a platform, grouped by family
  const getInstanceTypeOptionsForPlatform = (platform: string) => {
    const types = Object.entries(INSTANCE_TYPE_CATALOG)
      .filter(([_, meta]) => meta.platforms.includes(platform))
      .map(([type, meta]) => ({
        value: type,
        label: meta.label,
        group: meta.family
      }));

    // Group by family
    const groups: Record<string, { label: string; value: string }[]> = {};
    types.forEach(type => {
      if (!groups[type.group]) {
        groups[type.group] = [];
      }
      groups[type.group].push({ label: type.label, value: type.value });
    });

    return Object.entries(groups).map(([groupLabel, options]) => ({
      label: groupLabel,
      options
    }));
  };

  // Get selected options for multiselect
  const getSelectedOptions = (platform: string) => {
    const enabled = allowedInstanceTypes[platform as keyof AllowedInstanceTypes]?.enabled || [];
    return enabled.map(type => ({
      value: type,
      label: INSTANCE_TYPE_CATALOG[type]?.label || type
    }));
  };

  // Handle multiselect change
  const handleInstanceTypeChange = (platform: string, selectedOptions: readonly { value?: string }[]) => {
    const enabled = selectedOptions.map(opt => opt.value!).filter(Boolean);
    const currentDefault = allowedInstanceTypes[platform as keyof AllowedInstanceTypes]?.default;
    
    // If current default is no longer in enabled list, set first enabled as default
    const newDefault = enabled.includes(currentDefault) ? currentDefault : (enabled[0] || '');
    
    setAllowedInstanceTypes(prev => ({
      ...prev,
      [platform]: {
        enabled,
        default: newDefault
      }
    }));
  };

  // Handle default change
  const handleDefaultChange = (platform: string, value: string) => {
    setAllowedInstanceTypes(prev => ({
      ...prev,
      [platform]: {
        ...prev[platform as keyof AllowedInstanceTypes],
        default: value
      }
    }));
  };

  // Get default options (only from enabled types)
  const getDefaultOptions = (platform: string) => {
    const enabled = allowedInstanceTypes[platform as keyof AllowedInstanceTypes]?.enabled || [];
    return enabled.map(type => ({
      value: type,
      label: INSTANCE_TYPE_CATALOG[type]?.label || type
    }));
  };

  const renderPlatformConfig = (platform: string, platformLabel: string) => {
    const config = allowedInstanceTypes[platform as keyof AllowedInstanceTypes];
    
    return (
      <SpaceBetween direction="vertical" size="l">
        <FormField
          label="Allowed Instance Types"
          description={`Select which instance types are available for ${platformLabel} workstations`}
        >
          <Multiselect
            selectedOptions={getSelectedOptions(platform)}
            onChange={({ detail }) => handleInstanceTypeChange(platform, detail.selectedOptions)}
            options={getInstanceTypeOptionsForPlatform(platform)}
            placeholder="Select instance types"
            filteringType="auto"
            tokenLimit={5}
          />
        </FormField>
        
        <FormField
          label="Default Instance Type"
          description="The instance type selected by default when creating a new workstation"
        >
          <Select
            selectedOption={config?.default ? { value: config.default, label: INSTANCE_TYPE_CATALOG[config.default]?.label || config.default } : null}
            onChange={({ detail }) => handleDefaultChange(platform, detail.selectedOption?.value || '')}
            options={getDefaultOptions(platform)}
            placeholder="Select default instance type"
            disabled={!config?.enabled?.length}
          />
        </FormField>
      </SpaceBetween>
    );
  };

  if (loading) {
    return (
      <AppLayout
        navigation={<Navigation isAdmin={true} productName={config?.productName} acronym={config?.acronym} />}
        disableContentPaddings={true}
        toolsHide={true}
        content={
          <ContentLayout
            defaultPadding
            headerVariant="high-contrast"
            maxContentWidth={1800}
            breadcrumbs={
              <BreadcrumbGroup
                items={[
                  { text: 'Dashboard', href: '/dashboard' },
                  { text: 'Settings', href: '/settings' }
                ]}
                ariaLabel="Breadcrumbs"
              />
            }
            header={
              <Box padding={{ vertical: "l" }}>
                <Grid
                  gridDefinition={[
                    { colspan: { default: 12, xs: 8, s: 9 } },
                    { colspan: { default: 12, xs: 4, s: 3 } }
                  ]}
                >
                  <div>
                    <Box variant="h1" fontSize="display-l">
                      Settings
                    </Box>
                    <Box
                      variant="p"
                      color="text-body-secondary"
                      margin={{ top: "xxs", bottom: "s" }}
                    >
                      Configure system-wide settings for workstation management, power policies, and session controls.
                    </Box>
                  </div>
                </Grid>
              </Box>
            }
          >
            <Box textAlign="center" padding="xxl">
              <SpaceBetween direction="vertical" size="m">
                <Spinner size="large" />
                <Box variant="p" color="text-body-secondary">
                  Loading settings...
                </Box>
              </SpaceBetween>
            </Box>
          </ContentLayout>
        }
      />
    );
  }

  return (
    <AppLayout
      navigation={<Navigation isAdmin={true} productName={config?.productName} acronym={config?.acronym} />}
      disableContentPaddings={true}
      toolsHide={true}
      content={
        <ContentLayout
          defaultPadding
          headerVariant="high-contrast"
          maxContentWidth={1800}
          breadcrumbs={
            <BreadcrumbGroup
              items={[
                { text: 'Dashboard', href: '/dashboard' },
                { text: 'Settings', href: '/settings' }
              ]}
              ariaLabel="Breadcrumbs"
            />
          }
          header={
            <Box padding={{ vertical: "l" }}>
              <Grid
                gridDefinition={[
                  { colspan: { default: 12, xs: 8, s: 9 } },
                  { colspan: { default: 12, xs: 4, s: 3 } }
                ]}
              >
                <div>
                  <Box variant="h1" fontSize="display-l">
                    Settings
                  </Box>
                  <Box
                    variant="p"
                    color="text-body-secondary"
                    margin={{ top: "xxs", bottom: "s" }}
                  >
                    Configure system-wide settings for workstation management, power policies, and session controls.
                  </Box>
                </div>
              </Grid>
            </Box>
          }
        >
    <Container
      header={
        <Header
          variant="h2"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button 
                variant="link" 
                onClick={handleCancel}
                disabled={!hasUnsavedChanges()}
              >
                Cancel
              </Button>
              <Button 
                variant="primary" 
                loading={saving}
                onClick={handleSave}
                disabled={!hasUnsavedChanges()}
              >
                Save changes
              </Button>
            </SpaceBetween>
          }
        >
          System Settings
        </Header>
      }
    >
      <SpaceBetween direction="vertical" size="l">
        {message && (
          <Alert type="success" dismissible onDismiss={() => setMessage('')}>
            {message}
          </Alert>
        )}
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError('')}>
            {error}
          </Alert>
        )}

        <Box variant="h3">Power Management</Box>
        <FormField
          label="Auto-shutdown timeout"
          description="Time in minutes before idle workstations are automatically stopped"
        >
          <Input
            value={disconnectedDuration}
            onChange={({ detail }) => setDisconnectedDuration(detail.value)}
            placeholder="Enter timeout in minutes"
            type="number"
          />
        </FormField>
        
        <hr style={{ border: 'none', borderTop: '1px solid #e9ebed', margin: '8px 0' }} />
        
        <Box variant="h3">Session Management</Box>
        <FormField
          label="Browser sessions"
          description="Allow users to connect to workstations via web browser in addition to DCV client"
        >
          <Toggle
            checked={browserSessionsEnabled}
            onChange={({ detail }) => setBrowserSessionsEnabled(detail.checked)}
          >
            Enable browser sessions
          </Toggle>
        </FormField>

        <hr style={{ border: 'none', borderTop: '1px solid #e9ebed', margin: '8px 0' }} />

        <Box variant="h3">Keep Alive</Box>
        <Box variant="p" color="text-body-secondary" margin={{ bottom: 's' }}>
          Allow users to temporarily prevent auto-shutdown for long-running tasks like renders or builds
        </Box>
        <SpaceBetween direction="vertical" size="m">
          <FormField
            label="Enable Keep Alive"
            description="When enabled, users can request to keep their workstation running beyond the auto-shutdown timeout"
          >
            <Toggle
              checked={keepAliveEnabled}
              onChange={({ detail }) => setKeepAliveEnabled(detail.checked)}
            >
              Allow users to request Keep Alive
            </Toggle>
          </FormField>
          
          {keepAliveEnabled && (
            <FormField
              label="Maximum duration (hours)"
              description="Maximum time users can request to keep their workstation alive"
            >
              <Input
                value={keepAliveMaxHours}
                onChange={({ detail }) => setKeepAliveMaxHours(detail.value)}
                placeholder="24"
                type="number"
              />
            </FormField>
          )}
        </SpaceBetween>

        <hr style={{ border: 'none', borderTop: '1px solid #e9ebed', margin: '8px 0' }} />

        <Box variant="h3">Instance Type Allowlist</Box>
        <Box variant="p" color="text-body-secondary" margin={{ bottom: 's' }}>
          Configure which EC2 instance types are available when creating workstations
        </Box>
        
        <Tabs
          tabs={[
            {
              id: 'windows',
              label: 'Windows',
              content: renderPlatformConfig('windows', 'Windows')
            },
            {
              id: 'linux',
              label: 'Linux',
              content: renderPlatformConfig('linux', 'Linux')
            },
            {
              id: 'macos',
              label: 'macOS',
              content: renderPlatformConfig('macos', 'macOS')
            }
          ]}
        />
      </SpaceBetween>
    </Container>
        </ContentLayout>
      }
    />
  );
};

export default Settings;
