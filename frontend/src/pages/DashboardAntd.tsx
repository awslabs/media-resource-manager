// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useMemo } from 'react';
import {
  Typography,
  Card,
  Button,
  Tag,
  Space,
  Input,
  Dropdown,
  Spin,
  Empty,
  Row,
  Col,
  Badge,
  Alert,
  Modal,
  Radio,
  Select,
} from 'antd';
import {
  PlayCircleOutlined,
  PoweroffOutlined,
  DesktopOutlined,
  GlobalOutlined,
  ReloadOutlined,
  SearchOutlined,
  MoreOutlined,
  LoadingOutlined,
  DownOutlined,
  PlusOutlined,
  ClockCircleOutlined,
  FilterOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useNavigate } from 'react-router-dom';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { apiCall } from '../utils/api';

const { Title, Text } = Typography;

interface Workstation {
  instanceId: string;
  workstationName: string;
  assignedUserId: string;
  assignedUserDisplay?: string;
  instanceStatus: string;
  dcvStatus: string;
  status: string;
  instanceType: string;
  createdAt: string;
  keepAliveUntil?: string;
  keepAliveRequestedBy?: string;
  platform?: string;
  region?: string;
}

interface RegionalHub {
  region: string;
  isPrimary: boolean;
  status: string;
}

interface DashboardProps {
  user: any;
  isAdmin?: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const DashboardAntd: React.FC<DashboardProps> = ({ 
  user, 
  isAdmin = false,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const navigate = useNavigate();
  const [workstations, setWorkstations] = useState<Workstation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchText, setSearchText] = useState('');
  const [connectingInstances, setConnectingInstances] = useState<Set<string>>(new Set());
  const [startingInstances, setStartingInstances] = useState<Set<string>>(new Set());
  const [stoppingInstances, setStoppingInstances] = useState<Set<string>>(new Set());
  const [browserSessionsEnabled, setBrowserSessionsEnabled] = useState(true);
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const [actionAlert, setActionAlert] = useState<{type: 'success' | 'error', message: string} | null>(null);

  // Filter state
  const [platformFilter, setPlatformFilter] = useState<string>('');
  const [instanceStatusFilter, setInstanceStatusFilter] = useState<string>('');
  const [regionFilter, setRegionFilter] = useState<string>('');
  const [regionalHubs, setRegionalHubs] = useState<RegionalHub[]>([]);
  const [sortBy, setSortBy] = useState<string>('user-asc');

  // Keep Alive state
  const [keepAliveEnabled, setKeepAliveEnabled] = useState(false);
  const [keepAliveMaxHours, setKeepAliveMaxHours] = useState(24);
  const [showKeepAliveModal, setShowKeepAliveModal] = useState(false);
  const [keepAliveWorkstation, setKeepAliveWorkstation] = useState<Workstation | null>(null);
  const [keepAliveDuration, setKeepAliveDuration] = useState<number>(4);
  const [settingKeepAlive, setSettingKeepAlive] = useState(false);

  useEffect(() => {
    fetchWorkstations();
    fetchSettings();
    fetchRegionalHubs();
  }, []);

  const fetchRegionalHubs = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall('regions', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const responseData = await response.json();
        const hubs = responseData.data || responseData;
        const availableHubs = (Array.isArray(hubs) ? hubs : []).filter(
          (hub: RegionalHub) => hub.status === 'available' || hub.isPrimary
        );
        setRegionalHubs(availableHubs);
      }
    } catch (error) {
      console.log('Could not fetch regional hubs:', error);
    }
  };

  // Auto-refresh for transitional states
  useEffect(() => {
    const hasTransitionalStates = workstations.some(ws => 
      ['pending', 'starting', 'stopping'].includes(ws.instanceStatus) || 
      ['launching', 'installing-dcv', 'configuring-dcv', 'joining-domain', 'configuring-system', 'finalizing',
       'starting-instance', 'instance-running', 'configuring-autologin', 'starting-dcv-agents', 'dcv-ready', 
       'testing-dcv', 'dcv-session-created', 'cleaning-up', 'Stopping'].includes(ws.status)
    );

    setIsAutoRefreshing(hasTransitionalStates);

    if (!hasTransitionalStates) return;

    const interval = setInterval(() => {
      if (!document.hidden) {
        fetchWorkstations();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [workstations]);

  const fetchSettings = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;
      
      const response = await apiCall('settings', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      
      if (response.ok) {
        const data = await response.json();
        setBrowserSessionsEnabled(data.browserSessionsEnabled !== false);
        setKeepAliveEnabled(data.keepAliveEnabled === true);
        setKeepAliveMaxHours(data.keepAliveMaxHours || 24);
      }
    } catch (error) {
      console.log('Could not fetch settings:', error);
    }
  };

  const fetchWorkstations = async () => {
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');
      
      const response = await apiCall('workstations', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      
      const data = await response.json();
      setWorkstations(data);
    } catch (error) {
      console.error('Error fetching workstations:', error);
      handleAuthError(error);
    } finally {
      setLoading(false);
    }
  };

  const handleStart = async (instanceId: string) => {
    setStartingInstances(prev => new Set(prev).add(instanceId));
    
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');
      
      await apiCall('workstations/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ instanceId }),
      });
      
      fetchWorkstations();
    } catch (error) {
      console.error('Error starting workstation:', error);
      setActionAlert({ type: 'error', message: 'Failed to start workstation' });
      setTimeout(() => setActionAlert(null), 5000);
      setStartingInstances(prev => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
    }
  };

  const handleStop = async (instanceId: string) => {
    setStoppingInstances(prev => new Set(prev).add(instanceId));
    
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');
      
      await apiCall('workstations/stop', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ instanceId }),
      });
      
      await fetchWorkstations();
    } catch (error) {
      console.error('Error stopping workstation:', error);
      setActionAlert({ type: 'error', message: 'Failed to stop workstation' });
      setTimeout(() => setActionAlert(null), 5000);
    } finally {
      setStoppingInstances(prev => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
    }
  };

  // Keep Alive helper functions
  const isKeepAliveActive = (workstation: Workstation): boolean => {
    if (!workstation.keepAliveUntil) return false;
    return new Date(workstation.keepAliveUntil) > new Date();
  };

  const getKeepAliveRemaining = (workstation: Workstation): string => {
    if (!workstation.keepAliveUntil) return '';
    const remaining = new Date(workstation.keepAliveUntil).getTime() - Date.now();
    if (remaining <= 0) return '';
    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const openKeepAliveModal = (workstation: Workstation) => {
    setKeepAliveWorkstation(workstation);
    setKeepAliveDuration(4);
    setShowKeepAliveModal(true);
  };

  const handleSetKeepAlive = async () => {
    if (!keepAliveWorkstation) return;

    setSettingKeepAlive(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('workstations/keep-alive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          instanceId: keepAliveWorkstation.instanceId,
          durationHours: keepAliveDuration,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      setShowKeepAliveModal(false);
      setKeepAliveWorkstation(null);
      await fetchWorkstations();
      setActionAlert({ type: 'success', message: `Keep Alive activated for ${keepAliveDuration} hours` });
      setTimeout(() => setActionAlert(null), 5000);
    } catch (error) {
      console.error('Error setting Keep Alive:', error);
      setActionAlert({ type: 'error', message: `Failed to set Keep Alive: ${(error as Error).message}` });
      setTimeout(() => setActionAlert(null), 5000);
    } finally {
      setSettingKeepAlive(false);
    }
  };

  const handleCancelKeepAlive = async (instanceId: string) => {
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall(`workstations/${instanceId}/keep-alive`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      await fetchWorkstations();
      setActionAlert({ type: 'success', message: 'Keep Alive cancelled' });
      setTimeout(() => setActionAlert(null), 5000);
    } catch (error) {
      console.error('Error cancelling Keep Alive:', error);
      setActionAlert({ type: 'error', message: `Failed to cancel Keep Alive: ${(error as Error).message}` });
      setTimeout(() => setActionAlert(null), 5000);
    }
  };

  const handleConnect = async (instanceId: string, connectionType: 'client' | 'browser') => {
    setConnectingInstances(prev => new Set(prev).add(instanceId));
    
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');
      
      const response = await apiCall('/dcv', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          action: 'create-session',
          serverId: instanceId,
          sessionName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email?.split('@')[0] || 'User',
          sessionType: 'console'
        })
      });

      if (response.ok) {
        const data = await response.json();
        
        if (connectionType === 'client') {
          const baseUrl = data.quicConnectionUrl || data.connectionUrl;
          window.location.href = baseUrl.replace('https://', 'dcv://');
        } else {
          window.open(data.connectionUrl, '_blank');
        }
      } else {
        throw new Error('Failed to create DCV session');
      }
    } catch (error) {
      console.error('Error connecting:', error);
      setActionAlert({ type: 'error', message: 'Failed to connect to workstation' });
      setTimeout(() => setActionAlert(null), 5000);
    } finally {
      setConnectingInstances(prev => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
    }
  };

  const filteredWorkstations = useMemo(() => {
    let filtered = [...workstations];

    // Apply text filter
    if (searchText) {
      const search = searchText.toLowerCase();
      filtered = filtered.filter(ws =>
        ws.workstationName?.toLowerCase().includes(search) ||
        ws.assignedUserDisplay?.toLowerCase().includes(search) ||
        ws.instanceId?.toLowerCase().includes(search)
      );
    }

    // Apply platform filter
    if (platformFilter) {
      filtered = filtered.filter(ws =>
        ws.platform?.toLowerCase() === platformFilter
      );
    }

    // Apply instance status filter
    if (instanceStatusFilter) {
      filtered = filtered.filter(ws =>
        ws.instanceStatus === instanceStatusFilter
      );
    }

    // Apply region filter
    if (regionFilter) {
      filtered = filtered.filter(ws =>
        ws.region === regionFilter
      );
    }

    // Apply sorting
    filtered.sort((a, b) => {
      let aValue: string | number;
      let bValue: string | number;
      let descending = false;

      switch (sortBy) {
        case 'user-asc':
        case 'user-desc':
          aValue = (a.assignedUserDisplay || a.assignedUserId || 'zzz').toLowerCase();
          bValue = (b.assignedUserDisplay || b.assignedUserId || 'zzz').toLowerCase();
          descending = sortBy === 'user-desc';
          break;
        case 'name-asc':
        case 'name-desc':
          aValue = (a.workstationName || a.instanceId || '').toLowerCase();
          bValue = (b.workstationName || b.instanceId || '').toLowerCase();
          descending = sortBy === 'name-desc';
          break;
        case 'status':
          // Running first, then starting/pending, then stopped
          const statusOrder: Record<string, number> = { running: 0, starting: 1, pending: 2, stopping: 3, stopped: 4 };
          aValue = statusOrder[a.instanceStatus] ?? 5;
          bValue = statusOrder[b.instanceStatus] ?? 5;
          break;
        case 'date-desc':
        case 'date-asc':
          aValue = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          bValue = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          descending = sortBy === 'date-desc';
          break;
        default:
          return 0;
      }

      if (aValue < bValue) return descending ? 1 : -1;
      if (aValue > bValue) return descending ? -1 : 1;
      return 0;
    });

    return filtered;
  }, [workstations, searchText, platformFilter, instanceStatusFilter, regionFilter, sortBy]);

  // Filter options
  const platformOptions = [
    { label: 'All Platforms', value: '' },
    { label: 'Windows', value: 'windows' },
    { label: 'Linux', value: 'linux' },
    { label: 'macOS', value: 'macos' },
  ];

  const instanceStatusOptions = [
    { label: 'All Statuses', value: '' },
    { label: 'Running', value: 'running' },
    { label: 'Stopped', value: 'stopped' },
    { label: 'Pending', value: 'pending' },
    { label: 'Starting', value: 'starting' },
    { label: 'Stopping', value: 'stopping' },
  ];

  const regionOptions = useMemo(() => {
    const options = [{ label: 'All Regions', value: '' }];
    regionalHubs.forEach(hub => {
      options.push({
        label: hub.isPrimary ? `${hub.region} (Primary)` : hub.region,
        value: hub.region,
      });
    });
    return options;
  }, [regionalHubs]);

  const sortOptions = [
    { label: 'User (A-Z)', value: 'user-asc' },
    { label: 'User (Z-A)', value: 'user-desc' },
    { label: 'Name (A-Z)', value: 'name-asc' },
    { label: 'Name (Z-A)', value: 'name-desc' },
    { label: 'Status', value: 'status' },
    { label: 'Newest First', value: 'date-desc' },
    { label: 'Oldest First', value: 'date-asc' },
  ];

  const getStatusTag = (ws: Workstation) => {
    const { instanceStatus, dcvStatus, status } = ws;
    
    if (instanceStatus === 'running' && dcvStatus === 'ready') {
      return <Tag color="success">Ready to Connect</Tag>;
    }
    if (instanceStatus === 'stopped') {
      return <Tag color="default">Stopped</Tag>;
    }
    if (instanceStatus === 'stopping') {
      return <Tag color="warning">Stopping...</Tag>;
    }
    
    // Show granular workflow status during transitions
    if (['pending', 'starting'].includes(instanceStatus) || instanceStatus === 'running') {
      return <Tag color="processing">{getWorkflowLabel(status, instanceStatus)}</Tag>;
    }
    
    return <Tag>{status || instanceStatus}</Tag>;
  };

  const getWorkflowLabel = (status: string, instanceStatus: string): string => {
    const labels: Record<string, string> = {
      'launching': 'Launching...',
      'setting-hostname': 'Setting Hostname...',
      'installing-dcv': 'Installing DCV...',
      'configuring-dcv': 'Configuring DCV...',
      'joining-domain': 'Joining Domain...',
      'configuring-system': 'Configuring System...',
      'finalizing': 'Finalizing...',
      'starting-instance': 'Starting Instance...',
      'instance-running': 'Instance Running...',
      'configuring-autologin': 'Configuring Auto-Login...',
      'starting-dcv-agents': 'Starting DCV...',
      'dcv-ready': 'DCV Ready...',
      'testing-dcv': 'Testing DCV...',
      'dcv-session-created': 'Creating Session...',
      'cleaning-up': 'Cleaning Up...',
      'starting-dcv': 'Starting DCV...',
    };
    
    if (labels[status]) return labels[status];
    if (instanceStatus === 'pending' || instanceStatus === 'starting') return 'Starting...';
    if (instanceStatus === 'running') return 'Starting Up...';
    return status || 'Processing...';
  };

  const isReady = (ws: Workstation) => ws.instanceStatus === 'running' && ws.dcvStatus === 'ready';
  const isStopped = (ws: Workstation) => ws.instanceStatus === 'stopped';
  const isTransitioning = (ws: Workstation) => 
    ['pending', 'starting', 'stopping'].includes(ws.instanceStatus) ||
    (ws.instanceStatus === 'running' && ws.dcvStatus !== 'ready');

  const renderWorkstationCard = (ws: Workstation) => {
    const ready = isReady(ws);
    const stopped = isStopped(ws);
    const transitioning = isTransitioning(ws);
    const isStarting = startingInstances.has(ws.instanceId);
    const isStopping = stoppingInstances.has(ws.instanceId);
    const isConnecting = connectingInstances.has(ws.instanceId);

    const hasActiveKeepAlive = isKeepAliveActive(ws);
    
    const moreMenuItems: MenuProps['items'] = [
      ...(ready ? [
        {
          key: 'client',
          icon: <DesktopOutlined />,
          label: 'Connect via DCV Client',
          onClick: () => handleConnect(ws.instanceId, 'client'),
        },
        ...(browserSessionsEnabled ? [{
          key: 'browser',
          icon: <GlobalOutlined />,
          label: 'Connect via Browser',
          onClick: () => handleConnect(ws.instanceId, 'browser'),
        }] : []),
        { type: 'divider' as const },
      ] : []),
      // Keep Alive options (available to all users if enabled and workstation is running)
      ...(keepAliveEnabled && ready ? [
        hasActiveKeepAlive ? {
          key: 'cancel-keep-alive',
          icon: <ClockCircleOutlined />,
          label: `Cancel Keep Alive (${getKeepAliveRemaining(ws)} left)`,
          onClick: () => handleCancelKeepAlive(ws.instanceId),
        } : {
          key: 'keep-alive',
          icon: <ClockCircleOutlined />,
          label: 'Keep Alive',
          onClick: () => openKeepAliveModal(ws),
        },
        { type: 'divider' as const },
      ] : []),
      ...(ready ? [{
        key: 'stop',
        icon: <PoweroffOutlined />,
        label: 'Stop Workstation',
        onClick: () => handleStop(ws.instanceId),
        danger: true,
      }] : []),
    ];

    return (
      <Col xs={24} sm={12} lg={8} xl={6} key={ws.instanceId}>
        <Card
          hoverable
          style={{ height: '100%' }}
          styles={{
            body: { 
              display: 'flex', 
              flexDirection: 'column', 
              height: '100%',
              padding: '20px',
            }
          }}
        >
          {/* Header */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <Text strong style={{ fontSize: '16px', display: 'block', marginBottom: '4px' }}>
                  {ws.assignedUserDisplay || ws.assignedUserId || 'Unassigned'}
                </Text>
                <Text type="secondary" style={{ fontSize: '13px', display: 'block' }}>
                  {ws.workstationName || ws.instanceId}
                </Text>
                <Text type="secondary" style={{ fontSize: '12px' }}>
                  {ws.instanceType}{regionalHubs.length > 1 && ws.region && ` · ${ws.region}`}
                </Text>
              </div>
              {moreMenuItems.length > 0 && (
                <Dropdown menu={{ items: moreMenuItems }} trigger={['click']}>
                  <Button type="text" icon={<MoreOutlined />} />
                </Dropdown>
              )}
            </div>
          </div>

          {/* Status */}
          <div style={{ marginBottom: '24px' }}>
            <Space>
              {getStatusTag(ws)}
              {hasActiveKeepAlive && (
                <Tag icon={<ClockCircleOutlined />} color="blue">
                  Keep Alive: {getKeepAliveRemaining(ws)}
                </Tag>
              )}
            </Space>
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Action Button */}
          <div>
            {ready && (
              browserSessionsEnabled ? (
                <Dropdown.Button
                  type="primary"
                  icon={<DownOutlined />}
                  loading={isConnecting}
                  onClick={() => handleConnect(ws.instanceId, 'client')}
                  size="large"
                  menu={{
                    items: [
                      {
                        key: 'client',
                        icon: <DesktopOutlined />,
                        label: 'Connect via DCV Client',
                        onClick: () => handleConnect(ws.instanceId, 'client'),
                      },
                      {
                        key: 'browser',
                        icon: <GlobalOutlined />,
                        label: 'Connect in Browser',
                        onClick: () => handleConnect(ws.instanceId, 'browser'),
                      },
                    ],
                  }}
                  buttonsRender={([leftButton, rightButton]) => [
                    React.cloneElement(leftButton as React.ReactElement, { style: { flex: 1 } }),
                    rightButton,
                  ]}
                  style={{ width: '100%', display: 'flex' }}
                >
                  <DesktopOutlined /> Connect
                </Dropdown.Button>
              ) : (
                <Button
                  type="primary"
                  icon={isConnecting ? <LoadingOutlined /> : <DesktopOutlined />}
                  onClick={() => handleConnect(ws.instanceId, 'client')}
                  loading={isConnecting}
                  block
                  size="large"
                >
                  Connect
                </Button>
              )
            )}
            {stopped && (
              <Button
                type="primary"
                icon={isStarting ? <LoadingOutlined /> : <PlayCircleOutlined />}
                onClick={() => handleStart(ws.instanceId)}
                loading={isStarting}
                block
                size="large"
                style={{ backgroundColor: '#10b981', borderColor: '#10b981' }}
              >
                Start
              </Button>
            )}
            {transitioning && !stopped && (
              <Button
                disabled
                icon={<LoadingOutlined spin />}
                block
                size="large"
              >
                {ws.instanceStatus === 'stopping' || isStopping ? 'Stopping...' : 'Starting...'}
              </Button>
            )}
          </div>
        </Card>
      </Col>
    );
  };

  return (
    <AppLayoutAntd
      isAdmin={isAdmin}
      user={user}
      config={config}
      onSignOut={onSignOut}
      onChangePassword={onChangePassword}
    >
      <div style={{ maxWidth: 1600, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <Title level={3} style={{ margin: 0 }}>Workstations</Title>
          <Space>
            <Button
              icon={isAutoRefreshing ? <LoadingOutlined spin /> : <ReloadOutlined />}
              onClick={fetchWorkstations}
              loading={loading}
            >
              {isAutoRefreshing ? 'Auto-refreshing' : 'Refresh'}
            </Button>
            {isAdmin && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => navigate('/workstations?create=true')}
            >
              Create Workstation
            </Button>
          )}
        </Space>
      </div>

      {actionAlert && (
        <Alert
          message={actionAlert.message}
          type={actionAlert.type}
          closable
          onClose={() => setActionAlert(null)}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Search and Filters */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space wrap size="middle">
          <Input
            placeholder="Search workstations..."
            prefix={<SearchOutlined />}
            allowClear
            style={{ width: 250 }}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <Select
            value={platformFilter || undefined}
            onChange={(val) => setPlatformFilter(val || '')}
            options={platformOptions.slice(1)}
            style={{ width: 140 }}
            placeholder="Platform"
            allowClear
          />
          <Select
            value={instanceStatusFilter || undefined}
            onChange={(val) => setInstanceStatusFilter(val || '')}
            options={instanceStatusOptions.slice(1)}
            style={{ width: 140 }}
            placeholder="Status"
            allowClear
          />
          {regionalHubs.length > 1 && (
            <Select
              value={regionFilter || undefined}
              onChange={(val) => setRegionFilter(val || '')}
              options={regionOptions.slice(1)}
              style={{ width: 180 }}
              placeholder="Region"
              allowClear
            />
          )}
        </Space>
        <Select
          value={sortBy}
          onChange={setSortBy}
          options={sortOptions}
          style={{ width: 140 }}
        />
      </div>

      {/* Workstation Cards */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px' }}>
          <Spin size="large" />
        </div>
      ) : filteredWorkstations.length === 0 ? (
        <Empty
          description={
            searchText || platformFilter || instanceStatusFilter || regionFilter
              ? "No workstations match your filters" 
              : "No workstations assigned to you"
          }
        />
      ) : (
        <Row gutter={[16, 16]}>
          {filteredWorkstations.map(renderWorkstationCard)}
        </Row>
      )}

      {/* Keep Alive Modal */}
      <Modal
        title="Keep Alive"
        open={showKeepAliveModal}
        onCancel={() => {
          setShowKeepAliveModal(false);
          setKeepAliveWorkstation(null);
        }}
        onOk={handleSetKeepAlive}
        confirmLoading={settingKeepAlive}
        okText="Activate"
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Text>
            Keep your workstation running to prevent auto-shutdown during long-running tasks like renders or builds.
          </Text>
          {keepAliveWorkstation && (
            <div>
              <Text type="secondary">Workstation: </Text>
              <Text strong>{keepAliveWorkstation.workstationName || keepAliveWorkstation.instanceId}</Text>
            </div>
          )}
          <div>
            <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
              How long do you need? (max {keepAliveMaxHours} hours)
            </Text>
            <Radio.Group
              value={keepAliveDuration}
              onChange={(e) => setKeepAliveDuration(e.target.value)}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value={2}>2 hours</Radio.Button>
              <Radio.Button value={4}>4 hours</Radio.Button>
              <Radio.Button value={8}>8 hours</Radio.Button>
              {keepAliveMaxHours >= 12 && <Radio.Button value={12}>12 hours</Radio.Button>}
              {keepAliveMaxHours >= 24 && <Radio.Button value={24}>24 hours</Radio.Button>}
            </Radio.Group>
          </div>
          <Alert
            type="info"
            message="Your workstation will be protected from auto-shutdown for the selected duration. You can cancel Keep Alive at any time from the menu."
            showIcon
          />
        </Space>
      </Modal>
      </div>
    </AppLayoutAntd>
  );
};

export default DashboardAntd;
