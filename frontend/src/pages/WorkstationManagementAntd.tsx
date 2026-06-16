// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Card,
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Alert,
  Tag,
  Space,
  Typography,
  Breadcrumb,
  Tooltip,
  Dropdown,
  Spin,
  InputNumber,
  Switch,
  Popover,
  Radio,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ReloadOutlined,
  HomeOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  PoweroffOutlined,
  DesktopOutlined,
  UserOutlined,
  CloudServerOutlined,
  MoreOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ExclamationCircleOutlined,
  DatabaseOutlined,
  ClockCircleOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { MenuProps } from 'antd';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { apiCall } from '../utils/api';
import { useInstanceTypeCatalog } from '../hooks/useInstanceTypeCatalog';

const { Title, Text, Link } = Typography;

interface WorkstationManagementAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
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

interface Workstation {
  instanceId: string;
  workstationName?: string;
  assignedUserId?: string;
  assignedUserDisplay?: string;
  region?: string;
  instanceType: string;
  platform?: string;
  status: string;
  instanceStatus: string;
  dcvStatus?: string;
  errorMessage?: string;
  createdAt: string;
  failureReason?: string;
  groups?: string[];
  storageConfig?: any;
  keepAliveUntil?: string;
  keepAliveRequestedBy?: string;
}

const instanceStatusOptions = [
  { label: 'All Statuses', value: '' },
  { label: 'Running', value: 'running' },
  { label: 'Stopped', value: 'stopped' },
  { label: 'Pending', value: 'pending' },
  { label: 'Starting', value: 'starting' },
  { label: 'Stopping', value: 'stopping' },
  { label: 'Terminated', value: 'terminated' },
];

const dcvStatusOptions = [
  { label: 'All DCV Statuses', value: '' },
  { label: 'Ready', value: 'ready' },
  { label: 'Not Ready', value: 'not-ready' },
  { label: 'Stopped', value: 'stopped' },
];

const platformOptions = [
  { label: 'All Platforms', value: '' },
  { label: 'Windows', value: 'windows' },
  { label: 'Linux', value: 'linux' },
  { label: 'macOS', value: 'macos' },
];

const WorkstationManagementAntd: React.FC<WorkstationManagementAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const [workstations, setWorkstations] = useState<Workstation[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [browserSessionsEnabled, setBrowserSessionsEnabled] = useState(true);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [connectingInstances, setConnectingInstances] = useState<Set<string>>(new Set());
  const [creatingWorkstation, setCreatingWorkstation] = useState(false);
  const [deletingInstances, setDeletingInstances] = useState<Set<string>>(new Set());
  const [startingInstances, setStartingInstances] = useState<Set<string>>(new Set());
  const [stoppingInstances, setStoppingInstances] = useState<Set<string>>(new Set());
  const [rebootingInstances, setRebootingInstances] = useState<Set<string>>(new Set());
  const [assigningUser, setAssigningUser] = useState(false);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info' | 'warning'; message: string } | null>(null);
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const [workstationToDelete, setWorkstationToDelete] = useState<Workstation | null>(null);

  // Storage state
  const [showAddStorageModal, setShowAddStorageModal] = useState(false);
  const [showChangeInstanceTypeModal, setShowChangeInstanceTypeModal] = useState(false);
  const [workstationToChangeType, setWorkstationToChangeType] = useState<Workstation | null>(null);
  const [newInstanceType, setNewInstanceType] = useState<string>('');
  const [changingInstanceType, setChangingInstanceType] = useState(false);
  const [availableStorage, setAvailableStorage] = useState<any[]>([]);
  const [storageAssignments, setStorageAssignments] = useState<any[]>([]);
  const [loadingStorage, setLoadingStorage] = useState(false);
  const [savingStorage, setSavingStorage] = useState(false);
  const [driveLetterError, setDriveLetterError] = useState('');

  // Keep Alive state
  const [showKeepAliveModal, setShowKeepAliveModal] = useState(false);
  const [keepAliveWorkstation, setKeepAliveWorkstation] = useState<Workstation | null>(null);
  const [keepAliveDuration, setKeepAliveDuration] = useState<number>(4);
  const [settingKeepAlive, setSettingKeepAlive] = useState(false);
  const [cancellingKeepAlive, setCancellingKeepAlive] = useState<Set<string>>(new Set());
  const [keepAliveEnabled, setKeepAliveEnabled] = useState(false);
  const [keepAliveMaxHours, setKeepAliveMaxHours] = useState(24);

  // Filters
  const [filterText, setFilterText] = useState('');
  const [instanceStatusFilter, setInstanceStatusFilter] = useState('');
  const [dcvStatusFilter, setDcvStatusFilter] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState('');

  // Table preferences with localStorage persistence
  const [sortedInfo, setSortedInfo] = useState<{ columnKey: string; order: 'ascend' | 'descend' } | null>(() => {
    try {
      const saved = localStorage.getItem('workstations-table-sort');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { columnKey: 'createdAt', order: 'descend' };
  });

  const [pageSize, setPageSize] = useState(() => {
    try {
      const saved = localStorage.getItem('workstations-table-pageSize');
      if (saved) return parseInt(saved, 10);
    } catch (e) {}
    return 10;
  });

  // AMI and instance type data
  const [amiOptions, setAmiOptions] = useState<any[]>([]);
  const [amiData, setAmiData] = useState<Map<string, any>>(new Map());
  const [pipelineRegionMap, setPipelineRegionMap] = useState<Map<string, Array<{ region: string; amiId: string }>>>(new Map());
  const [loadingAmiOptions, setLoadingAmiOptions] = useState(true);
  const [allowedInstanceTypes, setAllowedInstanceTypes] = useState<AllowedInstanceTypes | null>(null);
  const [regionalHubs, setRegionalHubs] = useState<any[]>([]);

  // Instance type catalog from API
  const { catalog: instanceTypeCatalog } = useInstanceTypeCatalog();

  // Create workstation form
  const [createForm] = Form.useForm();
  const [assignForm] = Form.useForm();
  
  // Watch the amiId field to reactively update instance type options
  const selectedAmiId = Form.useWatch('amiId', createForm);
  // Watch the region field to filter AMI options
  const selectedRegion = Form.useWatch('region', createForm);
  // Watch the instanceCount field for dynamic modal title
  const watchedInstanceCount = Form.useWatch('instanceCount', createForm) || 1;

  // Assign modal state
  const [assignUserData, setAssignUserData] = useState({
    instanceId: '',
    currentUserId: '',
    newUserId: '',
  });

  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    fetchData();
    fetchSettings();
    fetchAllowedInstanceTypes();
    fetchRegionalHubs();
  }, []);

  // Check for create parameter in URL
  useEffect(() => {
    if (searchParams.get('create') === 'true') {
      const preselectedImageId = searchParams.get('imageId');
      const preselectedPipelineId = searchParams.get('pipelineId');
      
      createForm.setFieldsValue({
        amiId: preselectedImageId || '',
        pipelineId: preselectedPipelineId || '',
        instanceType: '',
        assignmentType: '',
        assignedUserId: '',
        rootVolumeSize: 100,
        joinDomain: !config?.useCognitoAuth,
        region: '',
        instanceCount: 1,
      });
      setShowCreateModal(true);
      searchParams.delete('create');
      searchParams.delete('imageId');
      searchParams.delete('pipelineId');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Auto-refresh when there are workstations in transitional states
  useEffect(() => {
    const hasTransitionalStates = workstations.some(ws =>
      ['pending', 'starting', 'stopping'].includes(ws.instanceStatus) ||
      ['launching', 'installing-dcv', 'configuring-dcv', 'joining-domain', 'configuring-system', 'finalizing',
       'starting-instance', 'instance-running', 'configuring-autologin', 'starting-dcv-agents', 'dcv-ready', 'testing-dcv', 'dcv-session-created', 'cleaning-up'].includes(ws.status) ||
      ws.dcvStatus === null || ws.dcvStatus === 'installing'
    );

    setIsAutoRefreshing(hasTransitionalStates);

    if (!hasTransitionalStates) return;

    const interval = setInterval(() => {
      if (!document.hidden) {
        fetchData();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [workstations]);

  const fetchSettings = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;
      const response = await apiCall('settings', {
        headers: { Authorization: `Bearer ${token}` },
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

  const fetchAllowedInstanceTypes = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;
      const response = await apiCall('settings/instance-types', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setAllowedInstanceTypes(data);
      }
    } catch (error) {
      console.log('Could not fetch allowed instance types:', error);
    }
  };

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
          (hub: any) => hub.status === 'available' || hub.isPrimary
        );
        setRegionalHubs(availableHubs);
      }
    } catch (error) {
      console.log('Could not fetch regional hubs:', error);
    }
  };

  const fetchAmiOptions = async () => {
    if (amiData.size === 0) {
      setLoadingAmiOptions(true);
    }
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('images', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();

      const dataMap = new Map();
      data.forEach((ami: any) => {
        dataMap.set(ami.amiId, ami);
      });

      // Build pipeline+name to regions mapping
      const pipelineMap = new Map<string, Array<{ region: string; amiId: string }>>();
      data.forEach((ami: any) => {
        if (ami.pipelineId) {
          const groupKey = `${ami.pipelineId}::${ami.name}`;
          const existing = pipelineMap.get(groupKey) || [];
          existing.push({ region: ami.region || 'us-east-1', amiId: ami.amiId });
          pipelineMap.set(groupKey, existing);
        }
      });
      setPipelineRegionMap(pipelineMap);

      // Filter out AMIs that require pipeline processing
      const filteredData = data.filter((ami: any) => !ami.requiresPipeline);

      // Group images by pipelineId + name
      const buildGroups = new Map<string, any>();
      const standaloneImages: any[] = [];

      filteredData.forEach((ami: any) => {
        if (ami.pipelineId) {
          const groupKey = `${ami.pipelineId}::${ami.name}`;
          if (!buildGroups.has(groupKey)) {
            buildGroups.set(groupKey, {
              ...ami,
              groupKey,
              regions: [{ region: ami.region || 'us-east-1', amiId: ami.amiId }],
            });
          } else {
            const existing = buildGroups.get(groupKey);
            existing.regions.push({ region: ami.region || 'us-east-1', amiId: ami.amiId });
          }
        } else {
          standaloneImages.push(ami);
        }
      });

      const allImages = [...buildGroups.values(), ...standaloneImages];

      // Add grouped images to dataMap by groupKey so getInstanceTypeOptions can find them
      buildGroups.forEach((groupedAmi, groupKey) => {
        dataMap.set(groupKey, groupedAmi);
      });
      setAmiData(dataMap);

      // Group by platform for Select options
      const options: any[] = [];
      const platforms = ['windows', 'linux', 'macos'];
      platforms.forEach((platform) => {
        const platformImages = allImages
          .filter((ami: any) => ami.platform?.toLowerCase() === platform)
          .sort((a: any, b: any) => a.name.localeCompare(b.name))
          .map((ami: any) => ({
            label: ami.regions?.length > 1 ? `${ami.name} (${ami.regions.length} regions)` : ami.name,
            value: ami.groupKey || ami.amiId,
          }));

        if (platformImages.length > 0) {
          options.push({
            label: platform.charAt(0).toUpperCase() + platform.slice(1),
            options: platformImages,
          });
        }
      });

      setAmiOptions(options);
    } catch (error) {
      console.error('Error fetching AMI options:', error);
    } finally {
      setLoadingAmiOptions(false);
    }
  };

  const fetchData = async () => {
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const promises: Promise<Response>[] = [
        apiCall('workstations', { headers: { Authorization: `Bearer ${token}` } }),
      ];

      // Fetch AMI options
      fetchAmiOptions();

      if (isAdmin) {
        promises.push(
          apiCall('users', { headers: { Authorization: `Bearer ${token}` } }),
          apiCall('groups', { headers: { Authorization: `Bearer ${token}` } })
        );
      }

      const responses = await Promise.all(promises);
      const workstationsData = await responses[0].json();
      setWorkstations(workstationsData);

      if (isAdmin && responses[1]) {
        const usersData = await responses[1].json();
        setUsers(usersData);
        if (responses[2]) {
          const groupsData = await responses[2].json();
          setGroups(groupsData);
        }
      }
    } catch (error) {
      console.error('Error fetching data:', error);
      handleAuthError(error);
    } finally {
      setLoading(false);
    }
  };

  const selectedWorkstations = useMemo(() => {
    return workstations.filter((ws) => selectedRowKeys.includes(ws.instanceId));
  }, [workstations, selectedRowKeys]);

  // Filter workstations
  const filteredWorkstations = useMemo(() => {
    let filtered = [...workstations];

    if (filterText) {
      const searchText = filterText.toLowerCase();
      filtered = filtered.filter(
        (ws) =>
          ws.workstationName?.toLowerCase().includes(searchText) ||
          ws.instanceId?.toLowerCase().includes(searchText) ||
          (ws.assignedUserDisplay || ws.assignedUserId || '').toLowerCase().includes(searchText) ||
          ws.instanceType?.toLowerCase().includes(searchText)
      );
    }

    if (instanceStatusFilter) {
      filtered = filtered.filter((ws) => ws.instanceStatus === instanceStatusFilter);
    }

    if (dcvStatusFilter) {
      if (dcvStatusFilter === 'ready') {
        filtered = filtered.filter((ws) => ws.dcvStatus === 'ready');
      } else if (dcvStatusFilter === 'not-ready') {
        filtered = filtered.filter((ws) => ws.dcvStatus !== 'ready' && ws.dcvStatus !== 'stopped');
      } else if (dcvStatusFilter === 'stopped') {
        filtered = filtered.filter((ws) => ws.dcvStatus === 'stopped' || ws.instanceStatus === 'stopped');
      }
    }

    if (platformFilter) {
      filtered = filtered.filter((ws) => ws.platform?.toLowerCase() === platformFilter);
    }

    if (regionFilter) {
      filtered = filtered.filter((ws) => ws.region === regionFilter);
    }

    return filtered;
  }, [workstations, filterText, instanceStatusFilter, dcvStatusFilter, platformFilter, regionFilter]);

  const regionOptions = useMemo(() => {
    const options = [{ label: 'All Regions', value: '' }];
    regionalHubs.forEach((hub) => {
      options.push({
        label: hub.isPrimary ? `${hub.region} (Primary)` : hub.region,
        value: hub.region,
      });
    });
    return options;
  }, [regionalHubs]);

  // Filter AMI options based on selected region
  const filteredAmiOptions = useMemo(() => {
    // If no region selected or only one region, show all AMIs
    if (!selectedRegion || regionalHubs.length <= 1) {
      return amiOptions;
    }

    // Filter AMIs to only show those available in the selected region
    return amiOptions.map((group) => {
      if (!group.options) return group;
      
      const filteredOptions = group.options.filter((option: any) => {
        const ami = amiData.get(option.value);
        if (!ami) return false;
        
        // For grouped AMIs (multi-region), check if the selected region is in the regions array
        if (ami.regions && ami.regions.length > 0) {
          return ami.regions.some((r: { region: string }) => r.region === selectedRegion);
        }
        
        // For standalone AMIs, check the region field
        // Auto-generated AMIs (from SSM) are available in all regions
        if (ami.isAutoGenerated) return true;
        
        return ami.region === selectedRegion || !ami.region;
      });

      if (filteredOptions.length === 0) return null;
      
      return {
        ...group,
        options: filteredOptions,
      };
    }).filter(Boolean);
  }, [amiOptions, amiData, selectedRegion, regionalHubs]);

  const handleTableChange = (pagination: any, filters: any, sorter: any) => {
    const newSort = sorter.order 
      ? { columnKey: sorter.columnKey || sorter.field, order: sorter.order }
      : null;
    setSortedInfo(newSort);
    try {
      if (newSort) {
        localStorage.setItem('workstations-table-sort', JSON.stringify(newSort));
      } else {
        localStorage.removeItem('workstations-table-sort');
      }
    } catch (e) {}
  };

  const handlePageSizeChange = (current: number, size: number) => {
    setPageSize(size);
    try {
      localStorage.setItem('workstations-table-pageSize', String(size));
    } catch (e) {}
  };

  // Action handlers
  const handleConnect = async (instanceId: string, connectionType: 'client' | 'browser') => {
    setConnectingInstances((prev) => new Set(prev).add(instanceId));
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('/dcv', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'create-session',
          serverId: instanceId,
          sessionName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email?.split('@')[0] || 'User',
          sessionType: 'console',
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const sessionData = await response.json();
      if (sessionData.error) throw new Error(sessionData.error);

      if (sessionData.connectionUrl) {
        if (connectionType === 'client') {
          const baseUrl = sessionData.quicConnectionUrl || sessionData.connectionUrl;
          const dcvUrl = baseUrl.replace('https://', 'dcv://');
          window.location.href = dcvUrl;
        } else {
          window.open(sessionData.connectionUrl, '_blank');
        }
      }
    } catch (error) {
      console.error('Error connecting to workstation:', error);
      setAlert({ type: 'error', message: `Failed to connect: ${(error as Error).message}` });
    } finally {
      setConnectingInstances((prev) => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
    }
  };

  const handleStartWorkstation = async (instanceId: string) => {
    setStartingInstances((prev) => new Set(prev).add(instanceId));
    
    // Optimistic update: clear the failed state so user sees "Starting"
    setWorkstations((prev) =>
      prev.map((ws) =>
        ws.instanceId === instanceId ? { ...ws, dcvStatus: 'starting', errorMessage: undefined } : ws
      )
    );
    
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      await apiCall('workstations/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instanceId }),
      });

      // Poll for status changes every 5 seconds until terminal state
      let pollCount = 0;
      const maxPolls = 60; // 5 minutes max
      const pollInterval = setInterval(async () => {
        pollCount++;
        if (pollCount >= maxPolls) {
          clearInterval(pollInterval);
          setStartingInstances((prev) => {
            const newSet = new Set(prev);
            newSet.delete(instanceId);
            return newSet;
          });
          return;
        }
        
        try {
          const pollToken = getAuthToken();
          if (!pollToken) return;
          const response = await apiCall('workstations', {
            headers: { Authorization: `Bearer ${pollToken}` },
          });
          const data = await response.json();
          const allWorkstations = data.workstations || data || [];
          const ws = allWorkstations.find((w: any) => w.instanceId === instanceId);
          
          if (ws && (ws.instanceStatus === 'running' || ws.dcvStatus === 'ready' || ws.dcvStatus === 'failed')) {
            clearInterval(pollInterval);
            setStartingInstances((prev) => {
              const newSet = new Set(prev);
              newSet.delete(instanceId);
              return newSet;
            });
            // Update the workstation in state with latest data
            setWorkstations((prev) =>
              prev.map((w) => w.instanceId === instanceId ? { ...w, ...ws } : w)
            );
            if (ws.dcvStatus === 'failed') {
              setAlert({ type: 'error', message: ws.errorMessage || 'Workstation start failed' });
            }
          } else if (ws) {
            // Update with latest status while still in progress
            setWorkstations((prev) =>
              prev.map((w) => w.instanceId === instanceId ? { ...w, ...ws, dcvStatus: ws.dcvStatus || 'starting' } : w)
            );
          }
        } catch (e) {
          // Polling error — continue trying
        }
      }, 5000);
    } catch (error) {
      console.error('Error starting workstation:', error);
      setAlert({ type: 'error', message: 'Failed to start workstation' });
      setStartingInstances((prev) => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
      // Revert optimistic update
      setWorkstations((prev) =>
        prev.map((ws) =>
          ws.instanceId === instanceId ? { ...ws, dcvStatus: 'failed', errorMessage: 'Failed to start workstation' } : ws
        )
      );
    }
  };

  const handleStopWorkstation = async (instanceId: string) => {
    setStoppingInstances((prev) => new Set(prev).add(instanceId));
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      await apiCall('workstations/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instanceId }),
      });

      // Refresh data after a short delay to pick up the new instance state
      setTimeout(() => fetchData(), 3000);
      // Safety net: clear loading state after 30s
      setTimeout(() => {
        setStoppingInstances((prev) => {
          const newSet = new Set(prev);
          newSet.delete(instanceId);
          return newSet;
        });
      }, 30000);
    } catch (error) {
      console.error('Error stopping workstation:', error);
      setAlert({ type: 'error', message: 'Failed to stop workstation' });
      setStoppingInstances((prev) => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
    }
  };

  const handleRebootWorkstation = async (instanceId: string) => {
    setRebootingInstances((prev) => new Set(prev).add(instanceId));
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      await apiCall('workstations/reboot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instanceId }),
      });

      setAlert({ type: 'success', message: 'Workstation reboot initiated' });
      setTimeout(() => fetchData(), 3000);
    } catch (error) {
      console.error('Error rebooting workstation:', error);
      setAlert({ type: 'error', message: 'Failed to reboot workstation' });
    } finally {
      setRebootingInstances((prev) => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
    }
  };

  const handleChangeInstanceType = async () => {
    if (!workstationToChangeType || !newInstanceType) return;
    setChangingInstanceType(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      await apiCall('workstations/change-instance-type', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instanceId: workstationToChangeType.instanceId, instanceType: newInstanceType }),
      });

      setShowChangeInstanceTypeModal(false);
      setWorkstationToChangeType(null);
      setNewInstanceType('');
      await fetchData();
      setAlert({ type: 'success', message: `Instance type changed to ${newInstanceType}` });
    } catch (error) {
      console.error('Error changing instance type:', error);
      setAlert({ type: 'error', message: 'Failed to change instance type' });
    } finally {
      setChangingInstanceType(false);
    }
  };

  const handleDeleteWorkstation = async () => {
    if (!workstationToDelete) return;

    setDeletingInstances((prev) => new Set(prev).add(workstationToDelete.instanceId));
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      await apiCall(`workstations/${workstationToDelete.instanceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      setShowDeleteModal(false);
      setWorkstationToDelete(null);
      setSelectedRowKeys([]);
      await fetchData();
      setAlert({ type: 'success', message: 'Workstation terminated successfully' });
    } catch (error) {
      console.error('Error deleting workstation:', error);
      setAlert({ type: 'error', message: 'Failed to terminate workstation' });
    } finally {
      setDeletingInstances((prev) => {
        const newSet = new Set(prev);
        newSet.delete(workstationToDelete?.instanceId || '');
        return newSet;
      });
    }
  };

  const handleAssignUser = async () => {
    setAssigningUser(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall(`/workstations/${assignUserData.instanceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ assignedUserId: assignUserData.newUserId }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      await fetchData();
      setShowAssignModal(false);
      setAssignUserData({ instanceId: '', currentUserId: '', newUserId: '' });
      setAlert({ type: 'success', message: 'User assigned successfully' });
    } catch (error) {
      console.error('Error assigning user:', error);
      setAlert({ type: 'error', message: 'Failed to assign user' });
    } finally {
      setAssigningUser(false);
    }
  };

  const handleRenameWorkstation = async (instanceId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) {
      setEditingNameId(null);
      return;
    }
    setSavingName(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall(`/workstations/${instanceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workstationName: trimmed }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await fetchData();
      setAlert({ type: 'success', message: 'Workstation renamed' });
    } catch (error) {
      console.error('Error renaming workstation:', error);
      setAlert({ type: 'error', message: 'Failed to rename workstation' });
    } finally {
      setSavingName(false);
      setEditingNameId(null);
    }
  };

  const handleUnassign = async (instanceId: string) => {
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall(`/workstations/${instanceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ assignedUserId: '' }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await fetchData();
      setAlert({ type: 'success', message: 'Workstation unassigned' });
    } catch (error) {
      console.error('Error unassigning workstation:', error);
      setAlert({ type: 'error', message: 'Failed to unassign workstation' });
    }
  };

  const openKeepAliveModal = (workstation: Workstation) => {
    setKeepAliveWorkstation(workstation);
    setKeepAliveDuration(4); // Default to 4 hours
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
      await fetchData();
      setAlert({ type: 'success', message: `Keep Alive activated for ${keepAliveDuration} hours` });
    } catch (error) {
      console.error('Error setting Keep Alive:', error);
      setAlert({ type: 'error', message: `Failed to set Keep Alive: ${(error as Error).message}` });
    } finally {
      setSettingKeepAlive(false);
    }
  };

  const handleCancelKeepAlive = async (instanceId: string) => {
    setCancellingKeepAlive((prev) => new Set(prev).add(instanceId));
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

      await fetchData();
      setAlert({ type: 'success', message: 'Keep Alive cancelled' });
    } catch (error) {
      console.error('Error cancelling Keep Alive:', error);
      setAlert({ type: 'error', message: `Failed to cancel Keep Alive: ${(error as Error).message}` });
    } finally {
      setCancellingKeepAlive((prev) => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
    }
  };

  // Helper to check if Keep Alive is active for a workstation
  const isKeepAliveActive = (workstation: Workstation): boolean => {
    if (!workstation.keepAliveUntil) return false;
    return new Date(workstation.keepAliveUntil) > new Date();
  };

  // Helper to get remaining Keep Alive time
  const getKeepAliveRemaining = (workstation: Workstation): string => {
    if (!workstation.keepAliveUntil) return '';
    const remaining = new Date(workstation.keepAliveUntil).getTime() - Date.now();
    if (remaining <= 0) return '';
    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const openAssignModal = (workstation: Workstation) => {
    setAssignUserData({
      instanceId: workstation.instanceId,
      currentUserId: workstation.assignedUserDisplay || workstation.assignedUserId || 'Unassigned',
      newUserId: workstation.assignedUserId || '',
    });
    setShowAssignModal(true);
  };

  // Storage functions
  const fetchAvailableStorage = async () => {
    setLoadingStorage(true);
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall('storage', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const data = await response.json();
        const availableStorageList = data.filter((storage: any) => storage.status === 'available');

        // Get unique platforms and regions from selected workstations
        const selectedPlatforms = new Set(selectedWorkstations.map((w) => w.platform?.toLowerCase()));
        const selectedRegions = new Set(selectedWorkstations.map((w) => w.region || 'us-east-1'));

        // Filter storage based on platform compatibility AND region
        const compatibleStorage = availableStorageList.filter((storage: any) => {
          let platformCompatible = true;
          if (storage.type === 'mountpoint-s3') {
            platformCompatible = selectedPlatforms.has('linux');
          } else if (storage.type === 'fsx-windows') {
            platformCompatible = selectedPlatforms.has('windows');
          } else if (storage.type === 'fsx-ontap') {
            platformCompatible = true; // Works on all platforms
          }

          if (!platformCompatible) return false;

          // Check region compatibility for FSx storage types
          if (storage.type === 'fsx-windows' || storage.type === 'fsx-ontap') {
            const storageRegion = storage.region || 'us-east-1';
            if (!selectedRegions.has(storageRegion)) return false;
          }

          return true;
        });

        setAvailableStorage(compatibleStorage);
      }
    } catch (error) {
      console.error('Error fetching storage:', error);
    } finally {
      setLoadingStorage(false);
    }
  };

  const loadExistingStorageConfig = () => {
    if (selectedWorkstations.length === 0) return;

    const workstation = selectedWorkstations[0];
    const existingConfig = workstation.storageConfig || {};
    const platform = workstation.platform?.toLowerCase() || 'windows';

    const assignments = Object.entries(existingConfig).map(([storageId, config]: [string, any]) => {
      if (config.type === 'mountpoint-s3') {
        return {
          storageId,
          autoMount: config.autoMount || false,
          mountPath: config.mountPath || '/mnt/s3',
        };
      } else if (config.type === 'fsx-ontap') {
        if (platform === 'windows') {
          return {
            storageId,
            autoMount: config.autoMount || false,
            driveLetter: (config.driveLetter || 'Z').replace(':', ''),
            junctionPath: config.junctionPath || '/vol1',
          };
        } else {
          const defaultMountPath =
            platform === 'macos'
              ? `/Volumes/fsxn-${storageId.substring(0, 8)}`
              : `/mnt/fsxn-${storageId.substring(0, 8)}`;
          return {
            storageId,
            autoMount: config.autoMount || false,
            mountPath: config.mountPath || defaultMountPath,
            junctionPath: config.junctionPath || '/vol1',
          };
        }
      } else {
        return {
          storageId,
          autoMount: config.autoMount || false,
          driveLetter: (config.driveLetter || 'Z').replace(':', ''),
        };
      }
    });

    setStorageAssignments(assignments);
  };

  // Fetch available storage when modal opens
  useEffect(() => {
    if (showAddStorageModal) {
      fetchAvailableStorage();
      loadExistingStorageConfig();
    }
  }, [showAddStorageModal]);

  const handleAddStorage = async () => {
    setSavingStorage(true);
    try {
      const token = getAuthToken();
      if (!token) return;

      // Validate drive letter conflicts (only for Windows storage)
      const enabledWindowsAssignments = storageAssignments.filter((a: any) => {
        const storage = availableStorage.find((s: any) => s.storageId === a.storageId);
        const platform = selectedWorkstations[0]?.platform?.toLowerCase() || 'windows';
        return (
          a.autoMount &&
          storage?.type !== 'mountpoint-s3' &&
          (storage?.type === 'fsx-windows' || (storage?.type === 'fsx-ontap' && platform === 'windows'))
        );
      });
      const driveLetters = enabledWindowsAssignments.map((a: any) => a.driveLetter);
      const duplicates = driveLetters.filter((letter: string, index: number) => driveLetters.indexOf(letter) !== index);

      if (duplicates.length > 0) {
        setDriveLetterError(
          `Drive letter conflict: ${duplicates[0]}: is assigned to multiple storage resources. Please select different drive letters.`
        );
        setSavingStorage(false);
        return;
      }

      setDriveLetterError('');

      if (storageAssignments.length === 0) {
        setShowAddStorageModal(false);
        setStorageAssignments([]);
        setSavingStorage(false);
        return;
      }

      // Update each selected workstation
      for (const workstation of selectedWorkstations) {
        const existingConfig = workstation.storageConfig || {};
        const platform = workstation.platform?.toLowerCase() || 'windows';

        const storageConfig = storageAssignments.reduce((acc: any, assignment: any) => {
          const storageDetails = availableStorage.find((s: any) => s.storageId === assignment.storageId);

          if (storageDetails?.type === 'mountpoint-s3') {
            acc[assignment.storageId] = {
              autoMount: assignment.autoMount,
              mountPath: storageDetails.mountPath || '/mnt/s3',
              type: 'mountpoint-s3',
              bucketName: storageDetails.bucketName,
              prefix: storageDetails.prefix || '',
            };
          } else if (storageDetails?.type === 'fsx-ontap') {
            if (platform === 'windows') {
              acc[assignment.storageId] = {
                autoMount: assignment.autoMount,
                driveLetter: assignment.driveLetter || 'Z',
                type: 'fsx-ontap',
                junctionPath: assignment.junctionPath || storageDetails?.junctionPath || '/vol1',
              };
            } else {
              const defaultMountPath =
                platform === 'macos'
                  ? `/Volumes/fsxn-${assignment.storageId?.substring(0, 8) || 'vol'}`
                  : `/mnt/fsxn-${assignment.storageId?.substring(0, 8) || 'vol'}`;
              acc[assignment.storageId] = {
                autoMount: assignment.autoMount,
                mountPath: assignment.mountPath || defaultMountPath,
                type: 'fsx-ontap',
                junctionPath: assignment.junctionPath || storageDetails?.junctionPath || '/vol1',
              };
            }
          } else {
            acc[assignment.storageId] = {
              autoMount: assignment.autoMount,
              driveLetter: assignment.driveLetter,
              type: storageDetails?.type || 'fsx-windows',
              shareName: storageDetails?.name || 'share',
            };
          }
          return acc;
        }, {});

        // Save the storage config to the workstation
        await apiCall(`workstations/${workstation.instanceId}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ storageConfig }),
        });

        // Handle mount/unmount for running workstations
        if (workstation.instanceStatus === 'running') {
          for (const assignment of storageAssignments) {
            const storageDetails = availableStorage.find((s: any) => s.storageId === assignment.storageId);
            const wasEnabled = existingConfig[assignment.storageId]?.autoMount || false;
            const isEnabled = assignment.autoMount;

            // Handle S3 mounts (Linux only)
            if (storageDetails?.type === 'mountpoint-s3' && platform === 'linux') {
              if (isEnabled && !wasEnabled) {
                try {
                  await apiCall('storage/mount', {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${token}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      action: 'mount',
                      instanceId: workstation.instanceId,
                      storageId: assignment.storageId,
                    }),
                  });
                } catch (mountError) {
                  console.error(`Failed to mount S3 storage ${assignment.storageId}:`, mountError);
                }
              } else if (!isEnabled && wasEnabled) {
                try {
                  await apiCall('storage/mount', {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${token}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      action: 'unmount',
                      instanceId: workstation.instanceId,
                      storageId: assignment.storageId,
                    }),
                  });
                } catch (unmountError) {
                  console.error(`Failed to unmount S3 storage ${assignment.storageId}:`, unmountError);
                }
              }
            }
          }
        }
      }

      setShowAddStorageModal(false);
      setStorageAssignments([]);
      await fetchData();
      setAlert({
        type: 'success',
        message: `Storage configuration updated for ${selectedWorkstations.length} workstation(s).`,
      });
    } catch (error) {
      console.error('Error saving storage config:', error);
      setAlert({ type: 'error', message: 'Failed to save storage configuration' });
    } finally {
      setSavingStorage(false);
    }
  };

  const handleCreateWorkstation = async () => {
    try {
      const values = await createForm.validateFields();
      
      if (!values.amiId) {
        setAlert({ type: 'error', message: 'Please select an AMI.' });
        return;
      }

      setCreatingWorkstation(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      // Get platform from AMI data
      const selectedAmi = amiData.get(values.amiId);
      if (!selectedAmi?.platform) {
        setAlert({ type: 'error', message: 'Cannot create workstation: Platform information is missing for the selected AMI.' });
        setCreatingWorkstation(false);
        return;
      }

      // Resolve groupKey to actual amiId for grouped AMIs
      let resolvedAmiId = values.amiId;
      if (selectedAmi.groupKey && selectedAmi.regions?.length > 0) {
        // This is a grouped AMI - resolve to actual amiId based on selected region
        const targetRegion = values.region || selectedAmi.regions[0].region;
        const regionEntry = selectedAmi.regions.find((r: { region: string; amiId: string }) => r.region === targetRegion);
        if (regionEntry) {
          resolvedAmiId = regionEntry.amiId;
        } else {
          // Fallback to first available region's AMI
          resolvedAmiId = selectedAmi.regions[0].amiId;
        }
      }

      const basePayload = {
        amiId: resolvedAmiId,
        instanceType: values.instanceType,
        rootVolumeSize: values.rootVolumeSize || 100,
        pipelineId: values.pipelineId,
        // When using Cognito auth, never join domain; otherwise use form value
        joinDomain: config?.useCognitoAuth ? false : (values.joinDomain ?? true),
        acronym: config?.acronym || 'MRM',
        platform: selectedAmi.platform,
        ...(values.region && { region: values.region }),
      };

      const workstationsToCreate: any[] = [];
      const instanceCount = values.instanceCount || 1;

      if (values.assignmentType === 'group') {
        for (let i = 0; i < instanceCount; i++) {
          workstationsToCreate.push({
            ...basePayload,
            assignedUserId: values.assignedUserId,
            assignmentType: 'group',
          });
        }
      } else if (values.assignmentType === 'user') {
        // Check if this is bulk creation with multiple users
        if (instanceCount > 1 && values.assignedUserIds?.length > 0) {
          // Bulk creation with individual user assignments
          for (let i = 0; i < instanceCount; i++) {
            const userId = values.assignedUserIds[i] || ''; // Empty if no user selected for this slot
            workstationsToCreate.push({
              ...basePayload,
              assignedUserId: userId,
              assignmentType: userId ? 'user' : 'unassigned',
            });
          }
        } else {
          // Single user assignment
          workstationsToCreate.push({
            ...basePayload,
            assignedUserId: values.assignedUserId,
            assignmentType: 'user',
          });
        }
      } else {
        for (let i = 0; i < instanceCount; i++) {
          workstationsToCreate.push({
            ...basePayload,
            assignedUserId: '',
            assignmentType: 'unassigned',
          });
        }
      }

      const response = await apiCall('workstations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workstations: workstationsToCreate }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || errorData.error || response.statusText);
      }

      setShowCreateModal(false);
      createForm.resetFields();
      await fetchData();
      setTimeout(() => fetchData(), 5000);
      setAlert({ type: 'success', message: `${instanceCount} workstation(s) creation started` });
    } catch (error) {
      console.error('Error creating workstation:', error);
      setAlert({ type: 'error', message: `Failed to create workstation: ${(error as Error).message}` });
    } finally {
      setCreatingWorkstation(false);
    }
  };

  // Status renderers
  const getInstanceStatusTag = (status: string) => {
    switch (status) {
      case 'running':
        return <Tag color="success" icon={<CheckCircleOutlined />}>Running</Tag>;
      case 'stopped':
        return <Tag color="default" icon={<PoweroffOutlined />}>Stopped</Tag>;
      case 'pending':
      case 'starting':
        return <Tag color="processing" icon={<SyncOutlined spin />}>Starting</Tag>;
      case 'stopping':
        return <Tag color="processing" icon={<SyncOutlined spin />}>Stopping</Tag>;
      case 'terminated':
        return <Tag color="error" icon={<CloseCircleOutlined />}>Terminated</Tag>;
      case 'shutting-down':
        return <Tag color="processing" icon={<SyncOutlined spin />}>Shutting Down</Tag>;
      default:
        return <Tag>{status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown'}</Tag>;
    }
  };

  const getWorkflowStatusTag = (status: string, failureReason?: string) => {
    const statusMap: Record<string, { color: string; text: string }> = {
      launching: { color: 'processing', text: 'Launching' },
      'setting-hostname': { color: 'processing', text: 'Setting Hostname' },
      'installing-dcv': { color: 'processing', text: 'Installing DCV' },
      'installing-base': { color: 'processing', text: 'Installing Base' },
      'installing-gpu': { color: 'processing', text: 'Installing GPU' },
      rebooting: { color: 'processing', text: 'Rebooting' },
      Rebooting: { color: 'processing', text: 'Rebooting' },
      'starting-services': { color: 'processing', text: 'Starting Services' },
      'configuring-dcv': { color: 'processing', text: 'Configuring DCV' },
      'joining-domain': { color: 'processing', text: 'Joining Domain' },
      'configuring-system': { color: 'processing', text: 'Configuring System' },
      finalizing: { color: 'processing', text: 'Finalizing' },
      ready: { color: 'success', text: 'Ready' },
      Complete: { color: 'success', text: 'Complete' },
      complete: { color: 'success', text: 'Complete' },
      Stopped: { color: 'default', text: 'Stopped' },
      Stopping: { color: 'processing', text: 'Stopping' },
      Terminated: { color: 'error', text: 'Terminated' },
      Configuring: { color: 'processing', text: 'Configuring' },
      failed: { color: 'error', text: 'Failed' },
      'starting-instance': { color: 'processing', text: 'Starting Instance' },
      'instance-running': { color: 'processing', text: 'Instance Running' },
      'configuring-autologin': { color: 'processing', text: 'Configuring Auto-Login' },
      'starting-dcv-agents': { color: 'processing', text: 'Starting DCV Agents' },
      'dcv-ready': { color: 'processing', text: 'DCV Ready' },
      'testing-dcv': { color: 'processing', text: 'Testing DCV' },
      'dcv-session-created': { color: 'processing', text: 'DCV Session Created' },
      'cleaning-up': { color: 'processing', text: 'Cleaning Up' },
      'starting-dcv': { color: 'processing', text: 'Starting DCV' },
      Starting: { color: 'processing', text: 'Starting' },
      'Starting DCV': { color: 'processing', text: 'Starting DCV' },
      Running: { color: 'success', text: 'Running' },
      'DCV Ready': { color: 'processing', text: 'DCV Ready' },
    };

    const config = statusMap[status] || { color: 'default', text: status || 'Unknown' };

    if (status === 'failed' && failureReason) {
      return (
        <Popover content={failureReason} title="Failure Reason">
          <Tag color={config.color} icon={<ExclamationCircleOutlined />}>{config.text}</Tag>
        </Popover>
      );
    }

    return (
      <Tag
        color={config.color}
        icon={config.color === 'processing' ? <SyncOutlined spin /> : undefined}
      >
        {config.text}
      </Tag>
    );
  };

  const getDcvStatusTag = (dcvStatus: string | undefined, workflowStatus: string, instanceStatus: string, errorMessage?: string) => {
    if (dcvStatus === 'failed') {
      return <Tooltip title={errorMessage || 'Start failed'}><Tag color="error" icon={<ExclamationCircleOutlined />}>Failed</Tag></Tooltip>;
    }
    if (dcvStatus === 'starting') {
      return <Tag color="processing" icon={<SyncOutlined spin />}>Starting</Tag>;
    }
    if (dcvStatus === 'ready') {
      return <Tag color="success" icon={<CheckCircleOutlined />}>Ready</Tag>;
    }
    if (instanceStatus === 'stopped') {
      return <Tag color="default" icon={<PoweroffOutlined />}>Stopped</Tag>;
    }
    if (['pending', 'starting'].includes(instanceStatus)) {
      return <Tag color="processing" icon={<SyncOutlined spin />}>Starting</Tag>;
    }
    if (['launching', 'installing-dcv', 'configuring-dcv'].includes(workflowStatus)) {
      return <Tag color="processing" icon={<SyncOutlined spin />}>Setting Up</Tag>;
    }
    return <Tag color="warning" icon={<ExclamationCircleOutlined />}>Not Ready</Tag>;
  };

  // Bulk action handlers
  const handleBulkStart = async () => {
    const stoppedWorkstations = selectedWorkstations.filter((ws) => ws.instanceStatus === 'stopped');
    for (const ws of stoppedWorkstations) {
      await handleStartWorkstation(ws.instanceId);
    }
  };

  const handleBulkStop = async () => {
    const runningWorkstations = selectedWorkstations.filter((ws) => ws.instanceStatus === 'running');
    for (const ws of runningWorkstations) {
      await handleStopWorkstation(ws.instanceId);
    }
  };

  // Get action menu items for a workstation (simplified - only items not available elsewhere)
  const getActionMenuItems = (record: Workstation): MenuProps['items'] => {
    const isRunning = record.instanceStatus === 'running';
    const hasActiveKeepAlive = isKeepAliveActive(record);

    const items: MenuProps['items'] = [];

    // Keep Alive option (available to all users if enabled)
    if (keepAliveEnabled && isRunning) {
      if (hasActiveKeepAlive) {
        items.push({
          key: 'cancel-keep-alive',
          label: `Cancel Keep Alive (${getKeepAliveRemaining(record)} left)`,
          icon: <ClockCircleOutlined />,
          onClick: () => handleCancelKeepAlive(record.instanceId),
        });
      } else {
        items.push({
          key: 'keep-alive',
          label: 'Keep Alive',
          icon: <ClockCircleOutlined />,
          onClick: () => openKeepAliveModal(record),
        });
      }
      items.push({ type: 'divider' });
    }

    if (isAdmin) {
      items.push({
        key: 'assign',
        label: 'Assign User',
        icon: <UserOutlined />,
        onClick: () => openAssignModal(record),
      });
      if (record.assignedUserId) {
        items.push({
          key: 'unassign',
          label: 'Unassign',
          onClick: () => handleUnassign(record.instanceId),
        });
      }
      items.push({
        key: 'attach-storage',
        label: 'Attach Storage',
        icon: <DatabaseOutlined />,
        onClick: () => setShowAddStorageModal(true),
      });
      items.push({
        key: 'change-instance-type',
        label: 'Change Instance Type',
        icon: <DesktopOutlined />,
        disabled: record.instanceStatus !== 'stopped' || record.platform === 'macos',
        title: record.platform === 'macos'
          ? 'Instance type cannot be changed for macOS workstations'
          : record.instanceStatus !== 'stopped'
          ? 'Instance must be stopped to change instance type'
          : undefined,
        onClick: () => {
          setWorkstationToChangeType(record);
          setNewInstanceType(record.instanceType || '');
          setShowChangeInstanceTypeModal(true);
        },
      });
      items.push({ type: 'divider' });
    }

    items.push({
      key: 'reboot',
      label: 'Reboot',
      icon: <SyncOutlined />,
      disabled: !isRunning,
      onClick: () => handleRebootWorkstation(record.instanceId),
    });

    if (isAdmin) {
      items.push({ type: 'divider' });
      items.push({
        key: 'terminate',
        label: 'Terminate',
        icon: <DeleteOutlined />,
        danger: true,
        onClick: () => {
          setWorkstationToDelete(record);
          setShowDeleteModal(true);
        },
      });
    }

    return items;
  };

  const columns: ColumnsType<Workstation> = [
    {
      title: 'Name',
      dataIndex: 'workstationName',
      key: 'workstationName',
      sorter: (a, b) => (a.workstationName || '').localeCompare(b.workstationName || ''),
      sortOrder: sortedInfo?.columnKey === 'workstationName' ? sortedInfo.order : null,
      render: (name, record) => {
        if (editingNameId === record.instanceId) {
          return (
            <Space size={4}>
              <Input
                size="small"
                autoFocus
                disabled={savingName}
                value={editingNameValue}
                onChange={(e) => setEditingNameValue(e.target.value)}
                onPressEnter={() => {
                  const original = name || record.instanceId;
                  if (editingNameValue.trim() && editingNameValue.trim() !== original) {
                    handleRenameWorkstation(record.instanceId, editingNameValue);
                  } else {
                    setEditingNameId(null);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setEditingNameId(null);
                  }
                }}
                style={{ width: 240 }}
              />
              <Tooltip title="Save (Enter)">
                <Button
                  type="text"
                  size="small"
                  loading={savingName}
                  icon={savingName ? undefined : <CheckOutlined style={{ color: '#52c41a', fontSize: 12 }} />}
                  onClick={() => {
                    const original = name || record.instanceId;
                    if (editingNameValue.trim() && editingNameValue.trim() !== original) {
                      handleRenameWorkstation(record.instanceId, editingNameValue);
                    } else {
                      setEditingNameId(null);
                    }
                  }}
                />
              </Tooltip>
              <Tooltip title="Cancel (Esc)">
                <Button
                  type="text"
                  size="small"
                  disabled={savingName}
                  icon={<CloseOutlined style={{ color: '#ff4d4f', fontSize: 12 }} />}
                  onClick={() => setEditingNameId(null)}
                />
              </Tooltip>
            </Space>
          );
        }
        return (
          <Space size={4}>
            <Link onClick={() => (window.location.href = `/workstations/${record.instanceId}`)}>
              {name || record.instanceId}
            </Link>
            {isAdmin && (
              <Tooltip title="Rename">
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined style={{ fontSize: 12, opacity: 0.45 }} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingNameId(record.instanceId);
                    setEditingNameValue(name || record.instanceId);
                  }}
                />
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Assigned To',
      key: 'assignedUser',
      sorter: (a, b) => (a.assignedUserDisplay || a.assignedUserId || '').localeCompare(b.assignedUserDisplay || b.assignedUserId || ''),
      sortOrder: sortedInfo?.columnKey === 'assignedUser' ? sortedInfo.order : null,
      render: (_, record) => {
        const assignedTo = record.assignedUserDisplay || record.assignedUserId;
        if (assignedTo && assignedTo.trim() !== '' && assignedTo.toLowerCase() !== 'unassigned') {
          // Check if this is a group assignment
          const isGroup = record.isGroupAssignment || assignedTo.endsWith('(Group)');
          const targetId = isGroup
            ? (record.resolvedGroupId || (record.assignedUserId?.startsWith('group:') ? record.assignedUserId.substring(6) : record.assignedUserId))
            : record.assignedUserId;
          const href = isGroup
            ? `/groups/${encodeURIComponent(targetId || '')}`
            : `/users/${encodeURIComponent(targetId || '')}`;
          return (
            <Link onClick={() => (window.location.href = href)}>
              {assignedTo}
            </Link>
          );
        }
        return isAdmin ? (
          <Button size="small" icon={<UserOutlined />} onClick={() => openAssignModal(record)}>
            Assign
          </Button>
        ) : (
          <Text type="secondary">Unassigned</Text>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      render: (_, record) => {
        const isRunning = record.instanceStatus === 'running';
        const isStopped = record.instanceStatus === 'stopped';
        const isDcvReady = record.dcvStatus === 'ready';
        const isConnectable = isRunning && isDcvReady;
        const isConnecting = connectingInstances.has(record.instanceId);
        const isStarting = startingInstances.has(record.instanceId);
        const isStopping = stoppingInstances.has(record.instanceId);

        return (
          <Space size="small">
            {isConnectable ? (
              <Tooltip title="Connect via DCV Client">
                <Button
                  type="primary"
                  size="small"
                  icon={<DesktopOutlined />}
                  loading={isConnecting}
                  onClick={() => handleConnect(record.instanceId, 'client')}
                >
                  Connect
                </Button>
              </Tooltip>
            ) : isStopped ? (
              <Tooltip title="Start workstation">
                <Button
                  size="small"
                  icon={<PlayCircleOutlined />}
                  loading={isStarting}
                  onClick={() => handleStartWorkstation(record.instanceId)}
                >
                  Start
                </Button>
              </Tooltip>
            ) : isRunning && !isDcvReady ? (
              <Button size="small" disabled icon={<SyncOutlined spin />}>
                Starting...
              </Button>
            ) : null}
            {isRunning && (
              <Tooltip title="Stop workstation">
                <Button
                  size="small"
                  icon={<PauseCircleOutlined />}
                  loading={isStopping}
                  onClick={() => handleStopWorkstation(record.instanceId)}
                />
              </Tooltip>
            )}
            {record.instanceStatus === 'terminated' && isAdmin && (
              <Tooltip title="Remove terminated workstation">
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => {
                    setWorkstationToDelete(record);
                    setShowDeleteModal(true);
                  }}
                >
                  Remove
                </Button>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Instance',
      dataIndex: 'instanceStatus',
      key: 'instanceStatus',
      sorter: (a, b) => a.instanceStatus.localeCompare(b.instanceStatus),
      sortOrder: sortedInfo?.columnKey === 'instanceStatus' ? sortedInfo.order : null,
      render: (status, record) => (
        <Space size="small">
          {getInstanceStatusTag(status)}
          {isKeepAliveActive(record) && (
            <Tooltip title={`Keep Alive active - ${getKeepAliveRemaining(record)} remaining`}>
              <Tag color="blue" icon={<ClockCircleOutlined />}>
                {getKeepAliveRemaining(record)}
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Status',
      key: 'dcvStatus',
      sorter: (a, b) => (a.dcvStatus || '').localeCompare(b.dcvStatus || ''),
      sortOrder: sortedInfo?.columnKey === 'dcvStatus' ? sortedInfo.order : null,
      render: (_, record) => getDcvStatusTag(record.dcvStatus, record.status, record.instanceStatus, record.errorMessage),
    },
    {
      title: 'Type',
      dataIndex: 'instanceType',
      key: 'instanceType',
      sorter: (a, b) => a.instanceType.localeCompare(b.instanceType),
      sortOrder: sortedInfo?.columnKey === 'instanceType' ? sortedInfo.order : null,
    },
    {
      title: 'Region',
      dataIndex: 'region',
      key: 'region',
      sorter: (a, b) => (a.region || '').localeCompare(b.region || ''),
      sortOrder: sortedInfo?.columnKey === 'region' ? sortedInfo.order : null,
      render: (region) => region || 'Primary',
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      sorter: (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      sortOrder: sortedInfo?.columnKey === 'createdAt' ? sortedInfo.order : null,
      render: (date) => new Date(date).toLocaleDateString(),
    },
  ];

  // Get instance type options based on selected AMI platform
  const getInstanceTypeOptions = (): any[] => {
    if (!selectedAmiId) return [];

    const ami = amiData.get(selectedAmiId);
    const platform = ami?.platform?.toLowerCase() || 'windows';
    const platformConfig = allowedInstanceTypes?.[platform as keyof AllowedInstanceTypes];

    if (!platformConfig || !platformConfig.enabled.length) {
      return [];
    }

    // Group by family
    const groups: Record<string, { label: string; value: string }[]> = {};
    platformConfig.enabled.forEach((type) => {
      const meta = instanceTypeCatalog[type];
      if (meta) {
        const family = meta.family;
        if (!groups[family]) groups[family] = [];
        groups[family].push({ label: meta.label, value: type });
      } else {
        if (!groups['Other']) groups['Other'] = [];
        groups['Other'].push({ label: type, value: type });
      }
    });

    // Sort instance types within each family by size
    const sizeOrder = ['medium', 'large', 'xlarge', '2xlarge', '4xlarge', '8xlarge', '12xlarge', '16xlarge', '24xlarge', '48xlarge', 'metal'];
    Object.values(groups).forEach((options) => {
      options.sort((a, b) => {
        const aSize = sizeOrder.findIndex((s) => a.value.includes(s));
        const bSize = sizeOrder.findIndex((s) => b.value.includes(s));
        return (aSize === -1 ? 999 : aSize) - (bSize === -1 ? 999 : bSize);
      });
    });

    // Sort families: GPU families first, then others alphabetically
    const familyOrder = ['GPU - NVIDIA T4', 'GPU - NVIDIA A10G', 'GPU - NVIDIA L4', 'Apple Silicon'];
    return Object.entries(groups)
      .sort(([a], [b]) => {
        const aIdx = familyOrder.findIndex((f) => a.startsWith(f.split(' ')[0]));
        const bIdx = familyOrder.findIndex((f) => b.startsWith(f.split(' ')[0]));
        if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
        if (aIdx !== -1) return -1;
        if (bIdx !== -1) return 1;
        return a.localeCompare(b);
      })
      .map(([groupLabel, options]) => ({
        label: groupLabel,
        options,
      }));
  };

  const getDefaultInstanceType = (platform: string): string => {
    const platformConfig = allowedInstanceTypes?.[platform as keyof AllowedInstanceTypes];
    return platformConfig?.default || platformConfig?.enabled?.[0] || 'g4dn.xlarge';
  };

  // User/Group options for assignment
  const assigneeOptions = useMemo(() => {
    const groupOptions = groups.map((g) => ({
      label: `👥 ${g.groupName}`,
      value: `group:${g.groupId}`,
    }));
    const userOptions = users.map((u) => ({
      label: `${u.firstName} ${u.lastName} (${u.email || u.userId})`,
      value: u.userId,
    }));
    return [
      { label: 'Groups', options: groupOptions },
      { label: 'Users', options: userOptions },
    ];
  }, [groups, users]);

  return (
    <AppLayoutAntd
      isAdmin={isAdmin}
      user={user}
      config={config}
      onSignOut={onSignOut}
      onChangePassword={onChangePassword}
    >
      <div style={{ width: '100%' }}>
        {/* Breadcrumb */}
        <Breadcrumb
          style={{ marginBottom: 16 }}
          items={[
            { href: '/dashboard', title: <><HomeOutlined /> Dashboard</> },
            { title: 'Workstations' },
          ]}
        />

        {/* Header with title and actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <Title level={3} style={{ margin: 0 }}>Workstations</Title>
          <Space>
            <Tooltip title={isAutoRefreshing ? 'Auto-refreshing...' : 'Refresh'}>
              <Button
                icon={isAutoRefreshing ? <SyncOutlined spin /> : <ReloadOutlined />}
                onClick={fetchData}
                loading={loading}
              />
            </Tooltip>
            <Button
              icon={<PlayCircleOutlined />}
              disabled={!selectedWorkstations.some((ws) => ws.instanceStatus === 'stopped')}
              onClick={handleBulkStart}
            >
              Start
            </Button>
            <Button
              icon={<PauseCircleOutlined />}
              disabled={!selectedWorkstations.some((ws) => ws.instanceStatus === 'running')}
              onClick={handleBulkStop}
            >
              Stop
            </Button>
            <Dropdown
              disabled={selectedRowKeys.length !== 1}
              menu={{
                items: selectedWorkstations.length === 1 ? getActionMenuItems(selectedWorkstations[0]) : [],
              }}
            >
              <Button disabled={selectedRowKeys.length !== 1}>
                Actions <MoreOutlined />
              </Button>
            </Dropdown>
            {isAdmin && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowCreateModal(true)}>
                Create Workstation
              </Button>
            )}
          </Space>
        </div>

        {alert && (
          <Alert
            type={alert.type}
            message={alert.message}
            closable
            onClose={() => setAlert(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        <Card >
          {/* Filters */}
          <Space style={{ marginBottom: 16 }} wrap>
            <Input.Search
              placeholder="Search by name, ID, user, or type"
              allowClear
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{ width: 280 }}
            />
            <Select
              placeholder="Instance Status"
              allowClear
              value={instanceStatusFilter || undefined}
              onChange={(value) => setInstanceStatusFilter(value || '')}
              options={instanceStatusOptions.filter((o) => o.value)}
              style={{ width: 150 }}
            />
            <Select
              placeholder="DCV Status"
              allowClear
              value={dcvStatusFilter || undefined}
              onChange={(value) => setDcvStatusFilter(value || '')}
              options={dcvStatusOptions.filter((o) => o.value)}
              style={{ width: 150 }}
            />
            <Select
              placeholder="Platform"
              allowClear
              value={platformFilter || undefined}
              onChange={(value) => setPlatformFilter(value || '')}
              options={platformOptions.filter((o) => o.value)}
              style={{ width: 130 }}
            />
            {regionOptions.length > 2 && (
              <Select
                placeholder="Region"
                allowClear
                value={regionFilter || undefined}
                onChange={(value) => setRegionFilter(value || '')}
                options={regionOptions.filter((o) => o.value)}
                style={{ width: 150 }}
              />
            )}
          </Space>

          <Table
            rowSelection={{
              selectedRowKeys,
              onChange: setSelectedRowKeys,
            }}
            columns={columns}
            dataSource={filteredWorkstations}
            rowKey="instanceId"
            loading={loading}
            onChange={handleTableChange}
            pagination={{
              pageSize,
              showSizeChanger: true,
              pageSizeOptions: ['10', '20', '50'],
              onShowSizeChange: handlePageSizeChange,
              showTotal: (total) => `${total} workstations`,
            }}
            locale={{
              emptyText: loading ? null : (
                <Space direction="vertical" align="center" style={{ padding: 24 }}>
                  <Text strong>No workstations</Text>
                  <Text type="secondary">No workstations to display.</Text>
                  {isAdmin && (
                    <Button type="primary" onClick={() => setShowCreateModal(true)}>
                      Create Workstation
                    </Button>
                  )}
                </Space>
              ),
            }}
          />
        </Card>
      </div>

      {/* Create Workstation Modal */}
      <Modal
        title={watchedInstanceCount > 1 ? `Create ${watchedInstanceCount} Workstations` : "Create Workstation"}
        open={showCreateModal}
        onCancel={() => {
          setShowCreateModal(false);
          createForm.resetFields();
        }}
        onOk={handleCreateWorkstation}
        confirmLoading={creatingWorkstation}
        okText={watchedInstanceCount > 1 ? `Create ${watchedInstanceCount} Workstations` : "Create"}
        width={600}
      >
        <Form
          form={createForm}
          layout="vertical"
          initialValues={{
            rootVolumeSize: 100,
            joinDomain: !config?.useCognitoAuth,
            instanceCount: 1,
          }}
        >
          {regionalHubs.length > 1 && (
            <Form.Item 
              name="region" 
              label="Region"
              tooltip="Select a region first to see available images for that region"
            >
              <Select
                placeholder="Select region (defaults to Primary)"
                allowClear
                options={regionalHubs.map((hub) => ({
                  label: hub.isPrimary ? `${hub.region} (Primary)` : hub.region,
                  value: hub.region,
                }))}
                onChange={() => {
                  // Clear AMI selection when region changes if the selected AMI is not available
                  const currentAmiId = createForm.getFieldValue('amiId');
                  if (currentAmiId) {
                    const ami = amiData.get(currentAmiId);
                    const newRegion = createForm.getFieldValue('region');
                    if (ami && newRegion) {
                      const isAvailable = ami.isAutoGenerated || 
                        (ami.regions?.some((r: { region: string }) => r.region === newRegion)) ||
                        ami.region === newRegion;
                      if (!isAvailable) {
                        createForm.setFieldValue('amiId', undefined);
                        createForm.setFieldValue('instanceType', undefined);
                      }
                    }
                  }
                }}
              />
            </Form.Item>
          )}

          <Form.Item name="amiId" label="Image" rules={[{ required: true, message: 'Please select an image' }]}>
            <Select
              placeholder={loadingAmiOptions ? "Loading images..." : (selectedRegion && regionalHubs.length > 1 ? `Select an image available in ${selectedRegion}` : "Select an image")}
              options={filteredAmiOptions}
              loading={loadingAmiOptions}
              disabled={loadingAmiOptions}
              notFoundContent={loadingAmiOptions ? <Spin size="small" /> : (selectedRegion ? `No images available in ${selectedRegion}` : "No images found")}
              showSearch
              filterOption={(input, option) =>
                (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
              }
              onChange={(value) => {
                // Set default instance type based on platform
                const ami = amiData.get(value);
                if (ami) {
                  const platform = ami.platform?.toLowerCase() || 'windows';
                  const defaultType = getDefaultInstanceType(platform);
                  createForm.setFieldValue('instanceType', defaultType);
                  createForm.setFieldValue('pipelineId', ami.pipelineId || '');
                }
              }}
            />
          </Form.Item>

          <Form.Item name="instanceType" label="Instance Type" rules={[{ required: true, message: 'Please select an instance type' }]}>
            <Select
              placeholder={selectedAmiId ? "Select instance type" : "Select an image first"}
              options={getInstanceTypeOptions()}
              disabled={!selectedAmiId}
              showSearch
              filterOption={(input, option) =>
                (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase()) ||
                (option?.value ?? '').toString().toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>

          <Form.Item name="rootVolumeSize" label="Root Volume Size (GB)">
            <InputNumber min={100} max={2000} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item name="instanceCount" label="Number of Workstations">
            <InputNumber min={1} max={50} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prevValues, currentValues) => prevValues.instanceCount !== currentValues.instanceCount}
          >
            {({ getFieldValue }) => {
              const instanceCount = getFieldValue('instanceCount') || 1;
              return (
                <Form.Item 
                  name="assignmentType" 
                  label="Assignment"
                  extra={instanceCount > 1 ? "Choose how to assign users to the workstations" : undefined}
                >
                  <Select
                    placeholder="Select assignment type"
                    allowClear
                    options={[
                      { 
                        label: instanceCount > 1 ? 'Assign to User(s)' : 'Assign to User', 
                        value: 'user',
                        title: instanceCount > 1 ? 'Select individual users for each workstation' : 'Assign to a specific user'
                      },
                      { label: 'Assign to Group', value: 'group', title: 'All workstations accessible by group members' },
                      { label: 'Leave Unassigned', value: 'unassigned', title: 'Create workstations without assignment - assign later' },
                    ]}
                    onChange={() => {
                      // Clear user selections when assignment type changes
                      createForm.setFieldValue('assignedUserId', undefined);
                      createForm.setFieldValue('assignedUserIds', []);
                    }}
                  />
                </Form.Item>
              );
            }}
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prevValues, currentValues) => 
              prevValues.assignmentType !== currentValues.assignmentType ||
              prevValues.instanceCount !== currentValues.instanceCount
            }
          >
            {({ getFieldValue }) => {
              const assignmentType = getFieldValue('assignmentType');
              const instanceCount = getFieldValue('instanceCount') || 1;
              
              // Single user assignment
              if (assignmentType === 'user' && instanceCount === 1) {
                return (
                  <Form.Item name="assignedUserId" label="User" rules={[{ required: true, message: 'Please select a user' }]}>
                    <Select
                      placeholder="Select a user"
                      showSearch
                      filterOption={(input, option) =>
                        (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
                      }
                      options={users
                        .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`))
                        .map((u) => ({
                          label: `${u.firstName} ${u.lastName} (${u.email || u.userId})`,
                          value: u.userId,
                        }))}
                    />
                  </Form.Item>
                );
              }
              
              // Multiple user assignment (bulk creation)
              if (assignmentType === 'user' && instanceCount > 1) {
                return (
                  <Form.Item 
                    name="assignedUserIds" 
                    label="Select Users"
                    extra={`Select up to ${instanceCount} users. Each selected user will be assigned to one workstation. Unselected slots will be unassigned.`}
                  >
                    <Select
                      mode="multiple"
                      placeholder={`Select up to ${instanceCount} users`}
                      showSearch
                      maxCount={instanceCount}
                      filterOption={(input, option) =>
                        (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
                      }
                      options={users
                        .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`))
                        .map((u) => ({
                          label: `${u.firstName} ${u.lastName} (${u.email || u.userId})`,
                          value: u.userId,
                        }))}
                    />
                  </Form.Item>
                );
              }
              
              // Group assignment
              if (assignmentType === 'group') {
                return (
                  <Form.Item 
                    name="assignedUserId" 
                    label="Group" 
                    rules={[{ required: true, message: 'Please select a group' }]}
                    extra="All workstations will be assigned to this group"
                  >
                    <Select
                      placeholder="Select a group"
                      showSearch
                      filterOption={(input, option) =>
                        (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
                      }
                      options={groups.map((g) => ({
                        label: g.groupName,
                        value: g.groupId,
                      }))}
                    />
                  </Form.Item>
                );
              }
              
              // Unassigned - show info alert
              if (assignmentType === 'unassigned') {
                return (
                  <Alert
                    type="info"
                    message={instanceCount > 1 
                      ? `${instanceCount} workstations will be created without user assignments. You can assign users later from the workstation list.`
                      : 'This workstation will be created without a user assignment. You can assign a user later from the workstation list.'
                    }
                    style={{ marginBottom: 16 }}
                  />
                );
              }
              
              return null;
            }}
          </Form.Item>

          {!config?.useCognitoAuth && (
            <Form.Item name="joinDomain" label="Join Domain" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}

          <Form.Item name="pipelineId" hidden>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      {/* Assign User Modal */}
      <Modal
        title="Assign User"
        open={showAssignModal}
        onCancel={() => {
          setShowAssignModal(false);
          setAssignUserData({ instanceId: '', currentUserId: '', newUserId: '' });
        }}
        onOk={handleAssignUser}
        confirmLoading={assigningUser}
        okText="Assign"
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Text type="secondary">Current Assignment:</Text>
            <div><Text strong>{assignUserData.currentUserId}</Text></div>
          </div>
          <div>
            <Text type="secondary">New Assignment:</Text>
            <Select
              style={{ width: '100%', marginTop: 8 }}
              placeholder="Select a user or group"
              showSearch
              filterOption={(input, option) =>
                (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
              }
              value={assignUserData.newUserId || undefined}
              onChange={(value) => setAssignUserData((prev) => ({ ...prev, newUserId: value }))}
              options={assigneeOptions}
            />
          </div>
        </Space>
      </Modal>

      {/* Change Instance Type Modal */}
      {workstationToChangeType && (() => {
        const platform = workstationToChangeType.platform?.toLowerCase() || 'windows';
        const platformConfig = allowedInstanceTypes?.[platform as keyof AllowedInstanceTypes];
        const currentType = workstationToChangeType.instanceType || '';

        // GPU family detection for driver warnings
        const getGpuFamily = (type: string) => {
          if (!type) return null;
          if (type.startsWith('g4dn')) return 'T4';
          if (type.startsWith('g4ad')) return 'AMD-Radeon';
          if (type.startsWith('g5')) return 'A10G';
          if (type.startsWith('g6') || type.startsWith('gr6')) return 'L4';
          return null;
        };

        const currentGpu = getGpuFamily(currentType);
        const newGpu = getGpuFamily(newInstanceType);
        let gpuWarning: string | null = null;
        if (newInstanceType && newInstanceType !== currentType) {
          if (currentGpu && newGpu && currentGpu !== newGpu) {
            gpuWarning = `This change requires updating NVIDIA GRID drivers after restart. The workstation may not render correctly until drivers are updated.`;
          } else if (currentGpu && !newGpu) {
            gpuWarning = `The selected instance type has no GPU. DCV will use software rendering.`;
          } else if (!currentGpu && newGpu) {
            gpuWarning = `The selected instance type requires NVIDIA GRID drivers. Install drivers via the Software Library after starting the workstation.`;
          }
        }

        // Build grouped options from allowed types for this platform
        const groups: Record<string, { label: string; value: string }[]> = {};
        (platformConfig?.enabled || []).forEach((type) => {
          const meta = instanceTypeCatalog[type];
          const family = meta?.family || type.split('.')[0].toUpperCase();
          if (!groups[family]) groups[family] = [];
          groups[family].push({
            label: meta ? `${type} — ${meta.label}` : type,
            value: type,
          });
        });
        const selectOptions = Object.entries(groups).map(([family, opts]) => ({
          label: family,
          options: opts,
        }));

        return (
          <Modal
            title={`Change Instance Type — ${workstationToChangeType.workstationName || workstationToChangeType.instanceId}`}
            open={showChangeInstanceTypeModal}
            onCancel={() => {
              setShowChangeInstanceTypeModal(false);
              setWorkstationToChangeType(null);
              setNewInstanceType('');
            }}
            onOk={handleChangeInstanceType}
            confirmLoading={changingInstanceType}
            okText="Change Instance Type"
            okButtonProps={{ disabled: !newInstanceType || newInstanceType === currentType }}
          >
            <div style={{ marginBottom: 16 }}>
              <Text type="secondary">Current type: </Text>
              <Text strong>{currentType}</Text>
            </div>
            <Form layout="vertical">
              <Form.Item label="New Instance Type" required>
                <Select
                  value={newInstanceType || undefined}
                  onChange={(val) => setNewInstanceType(val)}
                  options={selectOptions}
                  showSearch
                  placeholder="Select instance type"
                  style={{ width: '100%' }}
                  filterOption={(input, option) =>
                    (option?.value as string)?.toLowerCase().includes(input.toLowerCase()) ||
                    (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
                  }
                />
              </Form.Item>
            </Form>
            {gpuWarning && (
              <Alert
                type="warning"
                showIcon
                message={gpuWarning}
                style={{ marginTop: 8 }}
              />
            )}
            <Alert
              type="info"
              showIcon
              message="The instance is stopped and will remain stopped after the type change. Start it manually when ready."
              style={{ marginTop: 8 }}
            />
          </Modal>
        );
      })()}

      {/* Delete Confirmation Modal */}
      <Modal
        title="Terminate Workstation"
        open={showDeleteModal}
        onCancel={() => {
          setShowDeleteModal(false);
          setWorkstationToDelete(null);
        }}
        onOk={handleDeleteWorkstation}
        confirmLoading={deletingInstances.has(workstationToDelete?.instanceId || '')}
        okText="Terminate"
        okButtonProps={{ danger: true }}
      >
        <Alert
          type="warning"
          message="This action cannot be undone. The workstation and all its data will be permanently deleted."
          style={{ marginBottom: 16 }}
        />
        <div>
          <Text>Are you sure you want to terminate this workstation?</Text>
          {workstationToDelete && (
            <div style={{ marginTop: 8 }}>
              <Text strong>{workstationToDelete.workstationName || workstationToDelete.instanceId}</Text>
              {workstationToDelete.assignedUserDisplay && (
                <div>
                  <Text type="secondary">Assigned to: {workstationToDelete.assignedUserDisplay}</Text>
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* Add Storage Modal */}
      <Modal
        title={`Attach Storage - ${selectedWorkstations.length} workstation(s) selected`}
        open={showAddStorageModal}
        onCancel={() => {
          setShowAddStorageModal(false);
          setStorageAssignments([]);
          setDriveLetterError('');
        }}
        onOk={handleAddStorage}
        confirmLoading={savingStorage}
        okText="Save Changes"
        width={700}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {driveLetterError && (
            <Alert type="error" message={driveLetterError} closable onClose={() => setDriveLetterError('')} />
          )}
          {(() => {
            const selectedRegions = new Set(selectedWorkstations.map((w) => w.region || 'us-east-1'));
            if (selectedRegions.size > 1) {
              return (
                <Alert
                  type="warning"
                  message="Selected workstations are in different regions. Storage can only be mounted to workstations in the same region."
                />
              );
            }
            return null;
          })()}
          <Text type="secondary">
            Configure storage assignments for the selected workstation(s). Storage will be auto-mounted when the
            workstation starts.
          </Text>
          {selectedWorkstations.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              Only storage in the same region ({selectedWorkstations[0]?.region || 'us-east-1'}) is shown. FSx storage
              can only be mounted from instances in the same region.
            </Text>
          )}

          {loadingStorage ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin />
            </div>
          ) : availableStorage.length === 0 ? (
            <Alert
              type="info"
              message="No compatible storage resources available"
              description={(() => {
                const selectedPlatforms = new Set(selectedWorkstations.map((w) => w.platform?.toLowerCase()));
                const selectedRegion = selectedWorkstations[0]?.region || 'us-east-1';
                const hasMultipleRegions =
                  new Set(selectedWorkstations.map((w) => w.region || 'us-east-1')).size > 1;

                if (hasMultipleRegions) {
                  return 'Selected workstations are in different regions. Please select workstations from a single region.';
                }

                const regionNote = ` Storage must be in the same region as the workstation (${selectedRegion}).`;

                if (selectedPlatforms.has('linux') && selectedPlatforms.size === 1) {
                  return `Create Mountpoint for S3 or FSx for NetApp ONTAP storage resources to assign to Linux workstations.${regionNote}`;
                }
                if (selectedPlatforms.has('windows') && selectedPlatforms.size === 1) {
                  return `Create FSx for Windows or FSx for NetApp ONTAP storage resources to assign to Windows workstations.${regionNote}`;
                }
                if (selectedPlatforms.has('macos') && selectedPlatforms.size === 1) {
                  return `Create FSx for NetApp ONTAP storage resources to assign to macOS workstations.${regionNote}`;
                }
                return `Create storage resources first to assign them to workstations.${regionNote}`;
              })()}
            />
          ) : (
            <Table
              dataSource={availableStorage}
              rowKey="storageId"
              pagination={false}
              size="small"
              columns={[
                {
                  title: 'Name',
                  dataIndex: 'name',
                  key: 'name',
                },
                {
                  title: 'Type',
                  dataIndex: 'type',
                  key: 'type',
                  render: (type: string) => {
                    if (type === 'fsx-windows') return 'FSx Windows';
                    if (type === 'fsx-ontap') return 'FSx ONTAP';
                    if (type === 'mountpoint-s3') return 'S3 Mount';
                    return type;
                  },
                },
                {
                  title: 'Auto',
                  key: 'autoMount',
                  width: 80,
                  render: (_: any, item: any) => {
                    const assignment = storageAssignments.find((a: any) => a.storageId === item.storageId);
                    const selectedPlatform = selectedWorkstations[0]?.platform?.toLowerCase() || 'windows';

                    return (
                      <Switch
                        checked={assignment?.autoMount || false}
                        onChange={(checked) => {
                          const newAssignments = [...storageAssignments];
                          const existingIndex = newAssignments.findIndex((a: any) => a.storageId === item.storageId);

                          if (existingIndex >= 0) {
                            newAssignments[existingIndex] = {
                              ...newAssignments[existingIndex],
                              autoMount: checked,
                            };
                          } else {
                            if (item.type === 'mountpoint-s3') {
                              newAssignments.push({
                                storageId: item.storageId,
                                autoMount: checked,
                                mountPath: item.mountPath || '/mnt/s3',
                              });
                            } else if (item.type === 'fsx-ontap') {
                              if (selectedPlatform === 'windows') {
                                newAssignments.push({
                                  storageId: item.storageId,
                                  autoMount: checked,
                                  driveLetter: 'Z',
                                  junctionPath: item.junctionPath || '/vol1',
                                });
                              } else {
                                const defaultMountPath =
                                  selectedPlatform === 'macos'
                                    ? `/Volumes/fsxn-${item.storageId?.substring(0, 8) || 'vol'}`
                                    : `/mnt/fsxn-${item.storageId?.substring(0, 8) || 'vol'}`;
                                newAssignments.push({
                                  storageId: item.storageId,
                                  autoMount: checked,
                                  mountPath: defaultMountPath,
                                  junctionPath: item.junctionPath || '/vol1',
                                });
                              }
                            } else {
                              newAssignments.push({
                                storageId: item.storageId,
                                autoMount: checked,
                                driveLetter: 'Z',
                              });
                            }
                          }
                          setStorageAssignments(newAssignments);
                        }}
                      />
                    );
                  },
                },
                {
                  title: 'Mount Point',
                  key: 'mountPoint',
                  render: (_: any, item: any) => {
                    const assignment = storageAssignments.find((a: any) => a.storageId === item.storageId);
                    const selectedPlatform = selectedWorkstations[0]?.platform?.toLowerCase() || 'windows';

                    // For Mountpoint S3, show the mount path (read-only)
                    if (item.type === 'mountpoint-s3') {
                      return (
                        <Text type={assignment?.autoMount ? undefined : 'secondary'}>
                          {item.mountPath || '/mnt/s3'}
                        </Text>
                      );
                    }

                    // For FSxN on Linux/macOS, show editable mount path
                    if (item.type === 'fsx-ontap' && (selectedPlatform === 'linux' || selectedPlatform === 'macos')) {
                      const defaultMountPath =
                        selectedPlatform === 'macos'
                          ? `/Volumes/fsxn-${item.storageId?.substring(0, 8) || 'vol'}`
                          : `/mnt/fsxn-${item.storageId?.substring(0, 8) || 'vol'}`;
                      return (
                        <Input
                          value={assignment?.mountPath || defaultMountPath}
                          onChange={(e) => {
                            const newAssignments = [...storageAssignments];
                            const existingIndex = newAssignments.findIndex((a: any) => a.storageId === item.storageId);

                            if (existingIndex >= 0) {
                              newAssignments[existingIndex] = {
                                ...newAssignments[existingIndex],
                                mountPath: e.target.value,
                              };
                            } else {
                              newAssignments.push({
                                storageId: item.storageId,
                                autoMount: false,
                                mountPath: e.target.value,
                                junctionPath: item.junctionPath || '/vol1',
                              });
                            }
                            setStorageAssignments(newAssignments);
                          }}
                          disabled={!assignment?.autoMount}
                          placeholder={selectedPlatform === 'macos' ? '/Volumes/fsxn' : '/mnt/fsxn'}
                          size="small"
                        />
                      );
                    }

                    // For Windows storage, show drive letter selector
                    const enabledAssignments = storageAssignments.filter((a: any) => a.autoMount);
                    const conflictingLetter =
                      enabledAssignments.filter(
                        (a: any) =>
                          a.driveLetter === assignment?.driveLetter && a.autoMount && assignment?.autoMount
                      ).length > 1;

                    return (
                      <Select
                        value={assignment?.driveLetter || 'Z'}
                        onChange={(value) => {
                          const newAssignments = [...storageAssignments];
                          const existingIndex = newAssignments.findIndex((a: any) => a.storageId === item.storageId);

                          if (existingIndex >= 0) {
                            newAssignments[existingIndex] = {
                              ...newAssignments[existingIndex],
                              driveLetter: value,
                            };
                          } else {
                            newAssignments.push({
                              storageId: item.storageId,
                              autoMount: false,
                              driveLetter: value,
                              junctionPath: item.type === 'fsx-ontap' ? item.junctionPath || '/vol1' : undefined,
                            });
                          }
                          setStorageAssignments(newAssignments);
                        }}
                        options={[
                          { label: 'Z:', value: 'Z' },
                          { label: 'Y:', value: 'Y' },
                          { label: 'X:', value: 'X' },
                          { label: 'W:', value: 'W' },
                          { label: 'V:', value: 'V' },
                          { label: 'U:', value: 'U' },
                        ]}
                        disabled={!assignment?.autoMount}
                        status={conflictingLetter ? 'error' : undefined}
                        size="small"
                        style={{ width: 70 }}
                      />
                    );
                  },
                },
              ]}
            />
          )}
        </Space>
      </Modal>

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
            message="Your workstation will be protected from auto-shutdown for the selected duration. You can cancel Keep Alive at any time from the Actions menu."
            showIcon
          />
        </Space>
      </Modal>
    </AppLayoutAntd>
  );
};

export default WorkstationManagementAntd;
