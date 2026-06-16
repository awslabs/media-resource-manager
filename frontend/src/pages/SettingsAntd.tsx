// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import {
  Card,
  Input,
  Button,
  Switch,
  Tabs,
  Select,
  Alert,
  Spin,
  Space,
  Typography,
  Transfer,
  Breadcrumb,
} from 'antd';
import type { TransferProps } from 'antd';
import { HomeOutlined } from '@ant-design/icons';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';

const { Title, Text } = Typography;

// Fallback catalog used when dynamic catalog is not available
const FALLBACK_INSTANCE_TYPE_CATALOG: Record<string, { family: string; label: string; platforms: string[] }> = {
  // GPU - NVIDIA T4 (G4dn)
  'g4dn.xlarge': { family: 'GPU - NVIDIA T4', label: 'g4dn.xlarge (4 vCPU, 16 GB, T4)', platforms: ['windows', 'linux'] },
  'g4dn.2xlarge': { family: 'GPU - NVIDIA T4', label: 'g4dn.2xlarge (8 vCPU, 32 GB, T4)', platforms: ['windows', 'linux'] },
  'g4dn.4xlarge': { family: 'GPU - NVIDIA T4', label: 'g4dn.4xlarge (16 vCPU, 64 GB, T4)', platforms: ['windows', 'linux'] },
  // GPU - NVIDIA A10G (G5)
  'g5.xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.xlarge (4 vCPU, 16 GB, A10G)', platforms: ['windows', 'linux'] },
  'g5.2xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.2xlarge (8 vCPU, 32 GB, A10G)', platforms: ['windows', 'linux'] },
  'g5.4xlarge': { family: 'GPU - NVIDIA A10G', label: 'g5.4xlarge (16 vCPU, 64 GB, A10G)', platforms: ['windows', 'linux'] },
  // Apple Silicon
  'mac2.metal': { family: 'Apple Silicon', label: 'mac2.metal (M1, 8 CPU, 16 GB)', platforms: ['macos'] },
  'mac2-m2.metal': { family: 'Apple Silicon', label: 'mac2-m2.metal (M2, 8 CPU, 24 GB)', platforms: ['macos'] },
};

interface InstanceTypeMeta {
  family: string;
  label: string;
  platforms: string[];
}

interface InstanceTypeMeta {
  family: string;
  label: string;
  platforms: string[];
}

interface PlatformConfig {
  enabled: string[];
  default: string;
}

interface AllowedInstanceTypes {
  windows: PlatformConfig;
  linux: PlatformConfig;
  macos: PlatformConfig;
}

interface SettingsAntdProps {
  config?: any;
  user: any;
  isAdmin: boolean;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const SettingsAntd: React.FC<SettingsAntdProps> = ({
  config,
  user,
  isAdmin,
  onSignOut,
  onChangePassword,
}) => {
  const [disconnectedDuration, setDisconnectedDuration] = useState('');
  const [browserSessionsEnabled, setBrowserSessionsEnabled] = useState(true);
  const [keepAliveEnabled, setKeepAliveEnabled] = useState(false);
  const [keepAliveMaxHours, setKeepAliveMaxHours] = useState('24');
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartLeadTimeMinutes, setAutoStartLeadTimeMinutes] = useState('15');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // Dynamic instance type catalog from API
  const [instanceTypeCatalog, setInstanceTypeCatalog] = useState<Record<string, InstanceTypeMeta>>(FALLBACK_INSTANCE_TYPE_CATALOG);
  const [catalogLoading, setCatalogLoading] = useState(true);

  // Track original values to detect changes
  const [originalSettings, setOriginalSettings] = useState({
    disconnectedDuration: '',
    browserSessionsEnabled: true,
    keepAliveEnabled: false,
    keepAliveMaxHours: '24',
    autoStartEnabled: false,
    autoStartLeadTimeMinutes: '15',
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
    loadInstanceTypeCatalog();
    loadSettings();
    loadAllowedInstanceTypes();
  }, []);

  const loadInstanceTypeCatalog = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall('/instance-types/catalog', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.instanceTypes && Object.keys(data.instanceTypes).length > 0) {
          setInstanceTypeCatalog(data.instanceTypes);
          console.log(`Loaded ${data.count} instance types from dynamic catalog`);
        } else {
          console.log('Dynamic catalog empty, using fallback');
        }
      }
    } catch (error) {
      console.error('Error loading instance type catalog:', error);
      // Keep using fallback catalog
    } finally {
      setCatalogLoading(false);
    }
  };

  const loadSettings = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall('/settings', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.ok) {
        const settings = await response.json();
        const duration = settings.disconnectedDuration?.toString() || '';
        const browserEnabled = settings.browserSessionsEnabled !== false;
        const keepAlive = settings.keepAliveEnabled === true;
        const keepAliveMax = settings.keepAliveMaxHours?.toString() || '24';
        const autoStart = settings.autoStartEnabled === true;
        const autoStartLead = settings.autoStartLeadTimeMinutes?.toString() || '15';
        setDisconnectedDuration(duration);
        setBrowserSessionsEnabled(browserEnabled);
        setKeepAliveEnabled(keepAlive);
        setKeepAliveMaxHours(keepAliveMax);
        setAutoStartEnabled(autoStart);
        setAutoStartLeadTimeMinutes(autoStartLead);
        setOriginalSettings({ 
          disconnectedDuration: duration, 
          browserSessionsEnabled: browserEnabled,
          keepAliveEnabled: keepAlive,
          keepAliveMaxHours: keepAliveMax,
          autoStartEnabled: autoStart,
          autoStartLeadTimeMinutes: autoStartLead,
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
        headers: { 'Authorization': `Bearer ${token}` }
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

  const hasUnsavedChanges = () => {
    const settingsChanged =
      disconnectedDuration !== originalSettings.disconnectedDuration ||
      browserSessionsEnabled !== originalSettings.browserSessionsEnabled ||
      keepAliveEnabled !== originalSettings.keepAliveEnabled ||
      keepAliveMaxHours !== originalSettings.keepAliveMaxHours ||
      autoStartEnabled !== originalSettings.autoStartEnabled ||
      autoStartLeadTimeMinutes !== originalSettings.autoStartLeadTimeMinutes;

    const instanceTypesChanged =
      JSON.stringify(allowedInstanceTypes) !== JSON.stringify(originalInstanceTypes);

    return settingsChanged || instanceTypesChanged;
  };

  const handleCancel = () => {
    setDisconnectedDuration(originalSettings.disconnectedDuration);
    setBrowserSessionsEnabled(originalSettings.browserSessionsEnabled);
    setKeepAliveEnabled(originalSettings.keepAliveEnabled);
    setKeepAliveMaxHours(originalSettings.keepAliveMaxHours);
    setAutoStartEnabled(originalSettings.autoStartEnabled);
    setAutoStartLeadTimeMinutes(originalSettings.autoStartLeadTimeMinutes);
    setAllowedInstanceTypes(JSON.parse(JSON.stringify(originalInstanceTypes)));
    setMessage('');
    setError('');
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    setError('');

    // Validate instance types
    for (const [platform, cfg] of Object.entries(allowedInstanceTypes)) {
      if (cfg.enabled.length === 0) {
        setError(`${platform.charAt(0).toUpperCase() + platform.slice(1)} must have at least one enabled instance type.`);
        setSaving(false);
        return;
      }
      if (!cfg.default || !cfg.enabled.includes(cfg.default)) {
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
          keepAliveMaxHours: parseInt(keepAliveMaxHours) || 24,
          autoStartEnabled,
          autoStartLeadTimeMinutes: parseInt(autoStartLeadTimeMinutes) || 15
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

      setOriginalSettings({ 
        disconnectedDuration, 
        browserSessionsEnabled,
        keepAliveEnabled,
        keepAliveMaxHours,
        autoStartEnabled,
        autoStartLeadTimeMinutes,
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

  // Get instance types for Transfer component - grouped by family
  const getTransferDataSource = (platform: string) => {
    const items = Object.entries(instanceTypeCatalog)
      .filter(([_, meta]) => meta.platforms.includes(platform))
      .map(([type, meta]) => ({
        key: type,
        title: meta.label,
        description: meta.family,
        family: meta.family,
      }));
    
    // Sort by family, then by instance type within family
    const sizeOrder = ['nano', 'micro', 'small', 'medium', 'large', 'xlarge', '2xlarge', '4xlarge', '8xlarge', '12xlarge', '16xlarge', '24xlarge', '48xlarge', 'metal'];
    items.sort((a, b) => {
      const familyCompare = a.family.localeCompare(b.family);
      if (familyCompare !== 0) return familyCompare;
      const aSize = sizeOrder.findIndex(s => a.key.includes(s));
      const bSize = sizeOrder.findIndex(s => b.key.includes(s));
      return (aSize === -1 ? 999 : aSize) - (bSize === -1 ? 999 : bSize);
    });
    
    return items;
  };

  const handleTransferChange = (platform: string, targetKeys: string[]) => {
    const currentDefault = allowedInstanceTypes[platform as keyof AllowedInstanceTypes]?.default;
    const newDefault = targetKeys.includes(currentDefault) ? currentDefault : (targetKeys[0] || '');

    setAllowedInstanceTypes(prev => ({
      ...prev,
      [platform]: {
        enabled: targetKeys,
        default: newDefault
      }
    }));
  };

  const handleDefaultChange = (platform: string, value: string) => {
    setAllowedInstanceTypes(prev => ({
      ...prev,
      [platform]: {
        ...prev[platform as keyof AllowedInstanceTypes],
        default: value
      }
    }));
  };

  const getDefaultOptions = (platform: string) => {
    const enabled = allowedInstanceTypes[platform as keyof AllowedInstanceTypes]?.enabled || [];
    return enabled.map(type => ({
      value: type,
      label: instanceTypeCatalog[type]?.label || type
    }));
  };

  const filterOption: TransferProps['filterOption'] = (inputValue, option) =>
    option.title.toLowerCase().includes(inputValue.toLowerCase()) ||
    option.description.toLowerCase().includes(inputValue.toLowerCase());

  const renderPlatformConfig = (platform: string) => {
    const cfg = allowedInstanceTypes[platform as keyof AllowedInstanceTypes];
    const dataSource = getTransferDataSource(platform);

    // Custom render with family grouping visual
    const renderItem = (item: any) => {
      const dataIndex = dataSource.findIndex(d => d.key === item.key);
      const prevItem = dataIndex > 0 ? dataSource[dataIndex - 1] : null;
      const showFamilyHeader = !prevItem || prevItem.family !== item.family;
      
      return (
        <span>
          {showFamilyHeader && (
            <div style={{ 
              fontSize: 11, 
              color: '#8c8c8c', 
              fontWeight: 600, 
              marginTop: dataIndex > 0 ? 8 : 0,
              marginBottom: 2,
              borderBottom: '1px solid #f0f0f0',
              paddingBottom: 2
            }}>
              {item.family}
            </div>
          )}
          <span style={{ paddingLeft: 8 }}>{item.title}</span>
        </span>
      );
    };

    return (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Transfer
          dataSource={dataSource}
          titles={['Available', 'Enabled']}
          targetKeys={cfg?.enabled || []}
          onChange={(targetKeys) => handleTransferChange(platform, targetKeys as string[])}
          render={renderItem}
          showSearch
          filterOption={filterOption}
          listStyle={{ width: 380, height: 400 }}
        />

        <div style={{ maxWidth: 400 }}>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>Default Instance Type</Text>
          <Select
            value={cfg?.default || undefined}
            onChange={(value) => handleDefaultChange(platform, value)}
            options={getDefaultOptions(platform)}
            placeholder="Select default"
            disabled={!cfg?.enabled?.length}
            style={{ width: '100%' }}
          />
          <Text type="secondary" style={{ fontSize: 13, marginTop: 6, display: 'block' }}>
            Selected by default when creating new workstations
          </Text>
        </div>
      </Space>
    );
  };

  const tabItems = [
    { key: 'windows', label: 'Windows', children: renderPlatformConfig('windows') },
    { key: 'linux', label: 'Linux', children: renderPlatformConfig('linux') },
    { key: 'macos', label: 'macOS', children: renderPlatformConfig('macos') },
  ];

  if (loading || catalogLoading) {
    return (
      <AppLayoutAntd
        isAdmin={isAdmin}
        user={user}
        config={config}
        onSignOut={onSignOut}
        onChangePassword={onChangePassword}
      >
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
          <Spin size="large" tip="Loading settings..." />
        </div>
      </AppLayoutAntd>
    );
  }

  return (
    <AppLayoutAntd
      isAdmin={isAdmin}
      user={user}
      config={config}
      onSignOut={onSignOut}
      onChangePassword={onChangePassword}
    >
      <div style={{ maxWidth: 900 }}>
        {/* Breadcrumb */}
        <Breadcrumb
          style={{ marginBottom: 16 }}
          items={[
            { href: '/dashboard', title: <><HomeOutlined /> Dashboard</> },
            { title: 'Settings' },
          ]}
        />

        {/* Header with title and actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <Title level={3} style={{ margin: 0 }}>Settings</Title>
          <Space>
            <Button onClick={handleCancel} disabled={!hasUnsavedChanges()}>
              Cancel
            </Button>
            <Button
              type="primary"
              loading={saving}
              onClick={handleSave}
              disabled={!hasUnsavedChanges()}
            >
              Save changes
            </Button>
          </Space>
        </div>

        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {message && (
            <Alert
              type="success"
              message={message}
              closable
              onClose={() => setMessage('')}
            />
          )}
          {error && (
            <Alert
              type="error"
              message={error}
              closable
              onClose={() => setError('')}
            />
          )}

          {/* Power Management Section */}
          <Card 
            size="small" 
            title="Power Management"
            
          >
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>Auto-shutdown timeout</Text>
              <style>{`
                .timeout-input input { 
                  text-align: right; 
                }
                .timeout-input input::-webkit-outer-spin-button,
                .timeout-input input::-webkit-inner-spin-button {
                  -webkit-appearance: none;
                  margin: 0;
                }
                .timeout-input input[type=number] {
                  -moz-appearance: textfield;
                }
              `}</style>
              <Input
                value={disconnectedDuration}
                onChange={(e) => setDisconnectedDuration(e.target.value)}
                placeholder="0"
                type="number"
                suffix="minutes"
                style={{ maxWidth: 160 }}
                className="timeout-input"
              />
              <Text type="secondary" style={{ fontSize: 13, marginTop: 6, display: 'block' }}>
                Time before idle workstations are automatically stopped
              </Text>
            </div>
          </Card>

          {/* Session Management Section */}
          <Card 
            size="small" 
            title="Session Management"
            
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <Switch
                checked={browserSessionsEnabled}
                onChange={(checked) => setBrowserSessionsEnabled(checked)}
                style={{ marginTop: 2 }}
              />
              <div>
                <Text strong>Enable browser sessions</Text>
                <Text type="secondary" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
                  Allow users to connect via web browser in addition to DCV client
                </Text>
              </div>
            </div>
          </Card>

          {/* Keep Alive Section */}
          <Card 
            size="small" 
            title="Keep Alive"
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Text type="secondary">
                Allow users to temporarily prevent auto-shutdown for long-running tasks like renders or builds
              </Text>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <Switch
                  checked={keepAliveEnabled}
                  onChange={(checked) => setKeepAliveEnabled(checked)}
                  style={{ marginTop: 2 }}
                />
                <div>
                  <Text strong>Allow users to request Keep Alive</Text>
                  <Text type="secondary" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
                    When enabled, users can request to keep their workstation running beyond the auto-shutdown timeout
                  </Text>
                </div>
              </div>
              {keepAliveEnabled && (
                <div>
                  <Text strong style={{ display: 'block', marginBottom: 8 }}>Maximum duration</Text>
                  <Input
                    value={keepAliveMaxHours}
                    onChange={(e) => setKeepAliveMaxHours(e.target.value)}
                    placeholder="24"
                    type="number"
                    suffix="hours"
                    style={{ maxWidth: 160 }}
                    className="timeout-input"
                  />
                  <Text type="secondary" style={{ fontSize: 13, marginTop: 6, display: 'block' }}>
                    Maximum time users can request to keep their workstation alive
                  </Text>
                </div>
              )}
            </Space>
          </Card>

          {/* Auto-Start Scheduling Section */}
          <Card 
            size="small" 
            title="Auto-Start Scheduling"
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Text type="secondary">
                Automatically start workstations based on user schedules configured in User Management
              </Text>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <Switch
                  checked={autoStartEnabled}
                  onChange={(checked) => setAutoStartEnabled(checked)}
                  style={{ marginTop: 2 }}
                />
                <div>
                  <Text strong>Enable auto-start scheduling</Text>
                  <Text type="secondary" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
                    When enabled, workstations will automatically start based on user-configured schedules
                  </Text>
                </div>
              </div>
              {autoStartEnabled && (
                <div>
                  <Text strong style={{ display: 'block', marginBottom: 8 }}>Lead time</Text>
                  <Input
                    value={autoStartLeadTimeMinutes}
                    onChange={(e) => setAutoStartLeadTimeMinutes(e.target.value)}
                    placeholder="15"
                    type="number"
                    suffix="minutes"
                    style={{ maxWidth: 160 }}
                    className="timeout-input"
                  />
                  <Text type="secondary" style={{ fontSize: 13, marginTop: 6, display: 'block' }}>
                    How early to start workstations before the user's scheduled start time
                  </Text>
                </div>
              )}
            </Space>
          </Card>

          {/* Instance Type Allowlist Section */}
          <Card 
            size="small" 
            title="Instance Type Allowlist"
            
          >
            <Tabs items={tabItems} />
          </Card>
        </Space>
      </div>
    </AppLayoutAntd>
  );
};

export default SettingsAntd;
