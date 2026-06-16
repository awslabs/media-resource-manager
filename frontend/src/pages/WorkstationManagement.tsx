// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useMemo } from 'react';
import { Link as RouterLink, useLocation, useSearchParams } from 'react-router-dom';
import {
  AppLayout,
  ContentLayout,
  Table,
  Header,
  Button,
  ButtonDropdown,
  SpaceBetween,
  Link,
  StatusIndicator,
  Modal,
  Form,
  FormField,
  Select,
  Multiselect,
  Input,
  Icon,
  TextFilter,
  CollectionPreferences,
  Pagination,
  Alert,
  Box,
  BreadcrumbGroup,
  Grid,
  Toggle,
  Popover,
  Spinner,
} from '@cloudscape-design/components';
import WorkstationStartModal from '../components/WorkstationStartModal';
import Navigation from '../components/Navigation';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { apiCall } from '../utils/api';
import { INSTANCE_TYPE_CATALOG } from './Settings';

interface WorkstationManagementProps {
  user: any;
  isAdmin: boolean;
  config?: any;
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

const WorkstationManagement: React.FC<WorkstationManagementProps> = ({ user, isAdmin, config }) => {
  const [workstations, setWorkstations] = useState([]);
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [browserSessionsEnabled, setBrowserSessionsEnabled] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showAddStorageModal, setShowAddStorageModal] = useState(false);
  const [availableStorage, setAvailableStorage] = useState([]);
  const [storageAssignments, setStorageAssignments] = useState([]);
  const [loadingStorage, setLoadingStorage] = useState(false);
  const [savingStorage, setSavingStorage] = useState(false);
  // Connection alert state
  const [connectionAlert, setConnectionAlert] = useState<{ type: 'success' | 'error' | 'warning' | 'info'; message: string } | null>(null);
  const [driveLetterError, setDriveLetterError] = useState('');
  const [storageSuccessMessage, setStorageSuccessMessage] = useState('');
  const [selectedItems, setSelectedItems] = useState([]);
  const [connectingInstances, setConnectingInstances] = useState(new Set());
  const [creatingWorkstation, setCreatingWorkstation] = useState(false);
  const [deletingInstances, setDeletingInstances] = useState(new Set());
  const [startingInstances, setStartingInstances] = useState(new Set());
  const [stoppingInstances, setStoppingInstances] = useState(new Set());
  const [rebootingInstances, setRebootingInstances] = useState(new Set());
  const [assigningUser, setAssigningUser] = useState(false);
  const [filteringText, setFilteringText] = useState('');
  const [instanceStatusFilter, setInstanceStatusFilter] = useState<any>(null);
  const [dcvStatusFilter, setDcvStatusFilter] = useState<any>(null);
  const [platformFilter, setPlatformFilter] = useState<any>(null);
  const [regionFilter, setRegionFilter] = useState<any>(null);
  const [sortingColumn, setSortingColumn] = useState({ sortingField: 'createdAt', sortingDescending: true });
  const [currentPageIndex, setCurrentPageIndex] = useState(1);

  // Filter options for Select dropdowns
  const instanceStatusOptions = [
    { label: 'All Statuses', value: '' },
    { label: 'Running', value: 'running' },
    { label: 'Stopped', value: 'stopped' },
    { label: 'Pending', value: 'pending' },
    { label: 'Starting', value: 'starting' },
    { label: 'Stopping', value: 'stopping' }
  ];

  const dcvStatusOptions = [
    { label: 'All DCV Statuses', value: '' },
    { label: 'Ready', value: 'ready' },
    { label: 'Not Ready', value: 'not-ready' },
    { label: 'Stopped', value: 'stopped' }
  ];

  const platformOptions = [
    { label: 'All Platforms', value: '' },
    { label: 'Windows', value: 'windows' },
    { label: 'Linux', value: 'linux' },
    { label: 'macOS', value: 'macos' }
  ];
  
  // Allowed instance types from settings
  const [allowedInstanceTypes, setAllowedInstanceTypes] = useState<AllowedInstanceTypes | null>(null);
  
  // Load preferences from localStorage or use defaults
  const getInitialPreferences = () => {
    try {
      const saved = localStorage.getItem('workstation-table-preferences');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (error) {
      console.warn('Failed to load preferences from localStorage:', error);
    }
    
    return {
      pageSize: 10,
      wrapLines: false,
      stripedRows: false,
      contentDensity: 'comfortable',
      contentDisplay: [
        { id: 'instanceId', visible: true },
        { id: 'workstationName', visible: true },
        { id: 'assignedUser', visible: true },
        { id: 'region', visible: true },
        { id: 'instanceType', visible: true },
        { id: 'status', visible: true },
        { id: 'instanceStatus', visible: true },
        { id: 'dcvStatus', visible: true },
        { id: 'createdAt', visible: true }
      ],
      stickyColumns: { first: 0, last: 0 }
    };
  };

  const [preferences, setPreferences] = useState(getInitialPreferences);

  // Save preferences to localStorage whenever they change
  const updatePreferences = (newPreferences) => {
    setPreferences(newPreferences);
    setCurrentPageIndex(1); // Reset to first page when preferences change
    try {
      localStorage.setItem('workstation-table-preferences', JSON.stringify(newPreferences));
    } catch (error) {
      console.warn('Failed to save preferences to localStorage:', error);
    }
  };

  const [newWorkstation, setNewWorkstation] = useState({
    amiId: '',
    instanceType: '',
    assignedUserId: '',
    assignedUserIds: [] as string[], // For bulk creation with multiple users
    assignmentType: '', // 'user', 'group', or 'unassigned'
    rootVolumeSize: 100, // GB
    pipelineId: '',
    joinDomain: true, // Default to true, will be set based on auth mode when modal opens
    region: '', // Empty means primary region
    instanceCount: 1, // Number of instances to create
  });

  // Regional hubs for region selector
  const [regionalHubs, setRegionalHubs] = useState<any[]>([]);

  const [assignUserData, setAssignUserData] = useState({
    instanceId: '',
    currentUserId: '',
    newUserId: '',
  });
  const [assignModalFilter, setAssignModalFilter] = useState('');
  const [assignModalSorting, setAssignModalSorting] = useState<{ sortingColumn: any; isDescending: boolean }>({ sortingColumn: { sortingField: 'name' }, isDescending: false });

  const [amiOptions, setAmiOptions] = useState<Array<{ label: string; options: Array<{ label: string; value: string; description?: string }> }>>([]);
  const [amiData, setAmiData] = useState<Map<string, any>>(new Map());
  // Pipeline to regions mapping for multi-region image selection
  const [pipelineRegionMap, setPipelineRegionMap] = useState<Map<string, Array<{ region: string; amiId: string }>>>(new Map());
  // Loading state for AMI options
  const [loadingAmiOptions, setLoadingAmiOptions] = useState(true);

  // Get the platform of the selected AMI
  const getSelectedPlatform = (): string => {
    if (!newWorkstation.amiId) return 'windows';
    const ami = amiData.get(newWorkstation.amiId);
    return ami?.platform?.toLowerCase() || 'windows';
  };

  // Get instance type options based on selected AMI platform, grouped by family
  const getInstanceTypeOptions = () => {
    const platform = getSelectedPlatform();
    const platformConfig = allowedInstanceTypes?.[platform as keyof AllowedInstanceTypes];
    
    if (!platformConfig || !platformConfig.enabled.length) {
      // Fallback if no config loaded yet
      return [{ label: 'Loading...', value: '', disabled: true }];
    }
    
    // Group enabled instance types by family
    const groups: Record<string, { label: string; value: string }[]> = {};
    
    platformConfig.enabled.forEach(type => {
      const meta = INSTANCE_TYPE_CATALOG[type];
      if (meta) {
        const family = meta.family;
        if (!groups[family]) {
          groups[family] = [];
        }
        groups[family].push({ label: meta.label, value: type });
      } else {
        // Unknown type, put in "Other" group
        if (!groups['Other']) {
          groups['Other'] = [];
        }
        groups['Other'].push({ label: type, value: type });
      }
    });
    
    // Convert to grouped options format
    return Object.entries(groups).map(([groupLabel, options]) => ({
      label: groupLabel,
      options
    }));
  };

  // Get default instance type for a platform
  const getDefaultInstanceType = (platform: string): string => {
    const platformConfig = allowedInstanceTypes?.[platform as keyof AllowedInstanceTypes];
    return platformConfig?.default || platformConfig?.enabled?.[0] || 'g4dn.xlarge';
  };
  
  // Modal state for workstation start progress
  const [showStartModal, setShowStartModal] = useState(false);
  const [startingInstanceId, setStartingInstanceId] = useState<string>('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [workstationToDelete, setWorkstationToDelete] = useState<any>(null);
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  
  // DCV client install prompt modal state
  const [showDcvInstallModal, setShowDcvInstallModal] = useState(false);
  const [pendingDcvUrl, setPendingDcvUrl] = useState<string>('');

  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    fetchData();
    fetchSettings();
    fetchAllowedInstanceTypes();
    fetchRegionalHubs();
  }, []);

  // Check for create parameter in URL and open modal
  useEffect(() => {
    if (searchParams.get('create') === 'true') {
      const preselectedImageId = searchParams.get('imageId');
      const preselectedPipelineId = searchParams.get('pipelineId');
      
      // Reset form with defaults when opening modal from URL
      setNewWorkstation({
        amiId: preselectedImageId || '',
        instanceType: '',
        assignedUserId: '',
        assignedUserIds: [],
        assignmentType: '',
        rootVolumeSize: 100,
        pipelineId: preselectedPipelineId || '',
        joinDomain: !config?.useCognitoAuth,
        region: '',
        instanceCount: 1
      });
      setShowCreateModal(true);
      // Remove the parameters from URL without causing a navigation
      searchParams.delete('create');
      searchParams.delete('imageId');
      searchParams.delete('pipelineId');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Update instance type when image is pre-selected and AMI data is loaded
  useEffect(() => {
    if (showCreateModal && amiData.size > 0 && allowedInstanceTypes && !newWorkstation.instanceType) {
      // If we have a pipelineId but no amiId, select the AMI for the current region
      if (newWorkstation.pipelineId && !newWorkstation.amiId) {
        const pipelineRegions = pipelineRegionMap.get(newWorkstation.pipelineId);
        if (pipelineRegions && pipelineRegions.length > 0) {
          // Find AMI for selected region, or primary region if none selected
          const targetRegion = newWorkstation.region || regionalHubs.find(h => h.isPrimary)?.region || 'us-east-1';
          const regionAmi = pipelineRegions.find(r => r.region === targetRegion) || pipelineRegions[0];
          if (regionAmi) {
            const ami = amiData.get(regionAmi.amiId);
            if (ami) {
              const platform = ami.platform?.toLowerCase() || 'windows';
              const defaultInstanceType = getDefaultInstanceType(platform);
              setNewWorkstation(prev => ({
                ...prev,
                amiId: regionAmi.amiId,
                instanceType: defaultInstanceType
              }));
            }
          }
        }
      } else if (newWorkstation.amiId) {
        // We have an amiId, set the instance type based on platform
        const ami = amiData.get(newWorkstation.amiId);
        if (ami) {
          const platform = ami.platform?.toLowerCase() || 'windows';
          const defaultInstanceType = getDefaultInstanceType(platform);
          setNewWorkstation(prev => ({
            ...prev,
            pipelineId: ami.pipelineId || prev.pipelineId,
            instanceType: defaultInstanceType
          }));
        }
      }
    }
  }, [showCreateModal, newWorkstation.amiId, newWorkstation.pipelineId, amiData, allowedInstanceTypes, pipelineRegionMap, regionalHubs]);

  // Update AMI when region changes and we have a pipelineId/groupKey (multi-region image)
  useEffect(() => {
    if (showCreateModal && newWorkstation.pipelineId && amiData.size > 0) {
      // pipelineId now stores the groupKey (pipelineId::name) for grouped images
      const pipelineRegions = pipelineRegionMap.get(newWorkstation.pipelineId);
      if (pipelineRegions && pipelineRegions.length > 1) {
        // Find AMI for selected region
        const targetRegion = newWorkstation.region || regionalHubs.find(h => h.isPrimary)?.region || 'us-east-1';
        const regionAmi = pipelineRegions.find(r => r.region === targetRegion);
        if (regionAmi && regionAmi.amiId !== newWorkstation.amiId) {
          setNewWorkstation(prev => ({
            ...prev,
            amiId: regionAmi.amiId
          }));
        }
      }
    }
  }, [showCreateModal, newWorkstation.region, newWorkstation.pipelineId, pipelineRegionMap, regionalHubs]);

  const fetchSettings = async () => {
    try {
      const token = getAuthToken();
      if (!token) return; // Not logged in, use default
      
      const response = await apiCall('settings', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        setBrowserSessionsEnabled(data.browserSessionsEnabled !== false); // Default to true
      }
    } catch (error) {
      console.log('Could not fetch browser sessions config:', error);
      // Use default value on error
    }
  };

  const fetchAllowedInstanceTypes = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;
      
      const response = await apiCall('settings/instance-types', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
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
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      
      if (response.ok) {
        const responseData = await response.json();
        // API returns { success: true, data: [...] }
        const hubs = responseData.data || responseData;
        // Filter to only available hubs (including primary)
        const availableHubs = (Array.isArray(hubs) ? hubs : []).filter((hub: any) => 
          hub.status === 'available' || hub.isPrimary
        );
        setRegionalHubs(availableHubs);
      }
    } catch (error) {
      console.log('Could not fetch regional hubs:', error);
    }
  };

  // Update selected items when workstation data changes to refresh button states
  useEffect(() => {
    if (selectedItems.length > 0) {
      const updatedSelectedItems = selectedItems.map(selectedItem => 
        workstations.find(ws => ws.instanceId === selectedItem.instanceId) || selectedItem
      );
      setSelectedItems(updatedSelectedItems);
    }
  }, [workstations]);

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
      // Only refresh if page is visible
      if (!document.hidden) {
        fetchData();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [workstations]);

  const fetchWorkstations = async () => {
    const token = getAuthToken();
    if (!token) throw new Error('No current user');
    return apiCall('workstations', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  };

  const fetchUsers = async () => {
    const token = getAuthToken();
    if (!token) throw new Error('No current user');
    return apiCall('users', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  };

  const fetchAmiOptions = async () => {
    // Only show loading spinner on initial load, not on auto-refresh
    // This prevents the modal from flashing every 5 seconds during auto-refresh
    if (amiData.size === 0) {
      setLoadingAmiOptions(true);
    }
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');
      
      const response = await apiCall('images', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      
      // Store full AMI data in a map
      const dataMap = new Map();
      data.forEach((ami: any) => {
        dataMap.set(ami.amiId, ami);
      });
      setAmiData(dataMap);
      
      // Build pipeline+name to regions mapping (same build distributed to multiple regions)
      // Different builds from the same pipeline have different names (with timestamps)
      const pipelineMap = new Map<string, Array<{ region: string; amiId: string }>>();
      data.forEach((ami: any) => {
        if (ami.pipelineId) {
          // Use pipelineId + name as the key to group same build across regions
          const groupKey = `${ami.pipelineId}::${ami.name}`;
          const existing = pipelineMap.get(groupKey) || [];
          existing.push({ region: ami.region || 'us-east-1', amiId: ami.amiId });
          pipelineMap.set(groupKey, existing);
        }
      });
      setPipelineRegionMap(pipelineMap);
      
      // Filter out AMIs that require pipeline processing (raw macOS AMIs)
      const filteredData = data.filter((ami: any) => !ami.requiresPipeline);
      
      // Group images by pipelineId + name (same build distributed to multiple regions)
      // Different builds from the same pipeline will have different names (with timestamps)
      const buildGroups = new Map<string, any>();
      const standaloneImages: any[] = [];
      
      filteredData.forEach((ami: any) => {
        if (ami.pipelineId) {
          // Use pipelineId + name as the grouping key
          const groupKey = `${ami.pipelineId}::${ami.name}`;
          if (!buildGroups.has(groupKey)) {
            buildGroups.set(groupKey, {
              ...ami,
              groupKey, // Store the groupKey for later use
              regions: [{ region: ami.region || 'us-east-1', amiId: ami.amiId }]
            });
          } else {
            const existing = buildGroups.get(groupKey);
            existing.regions.push({ region: ami.region || 'us-east-1', amiId: ami.amiId });
          }
        } else {
          standaloneImages.push(ami);
        }
      });
      
      // Combine grouped pipeline images and standalone images
      const allImages = [...buildGroups.values(), ...standaloneImages];
      
      // Group by platform for display
      const windowsImages = allImages
        .filter((ami: any) => ami.platform?.toLowerCase() === 'windows')
        .sort((a: any, b: any) => a.name.localeCompare(b.name))
        .map((ami: any) => ({
          label: ami.regions?.length > 1 ? `${ami.name} (${ami.regions.length} regions)` : ami.name,
          value: ami.groupKey || ami.amiId, // Use groupKey for pipeline images
          description: ami.pipelineId 
            ? `Pipeline: ${ami.pipelineId}${ami.regions?.length > 1 ? '\n' + ami.regions.map((r: any) => r.region).join('   ') : ''}`
            : ami.amiId,
          tags: ami.regions?.length > 1 ? ami.regions.map((r: any) => r.region) : undefined
        }));
      
      const linuxImages = allImages
        .filter((ami: any) => ami.platform?.toLowerCase() === 'linux')
        .sort((a: any, b: any) => a.name.localeCompare(b.name))
        .map((ami: any) => ({
          label: ami.regions?.length > 1 ? `${ami.name} (${ami.regions.length} regions)` : ami.name,
          value: ami.groupKey || ami.amiId, // Use groupKey for pipeline images
          description: ami.pipelineId 
            ? `Pipeline: ${ami.pipelineId}${ami.regions?.length > 1 ? '\n' + ami.regions.map((r: any) => r.region).join('   ') : ''}`
            : ami.amiId,
          tags: ami.regions?.length > 1 ? ami.regions.map((r: any) => r.region) : undefined
        }));
      
      const macosImages = allImages
        .filter((ami: any) => ami.platform?.toLowerCase() === 'macos')
        .sort((a: any, b: any) => a.name.localeCompare(b.name))
        .map((ami: any) => ({
          label: ami.regions?.length > 1 ? `${ami.name} (${ami.regions.length} regions)` : ami.name,
          value: ami.groupKey || ami.amiId, // Use groupKey for pipeline images
          description: ami.pipelineId 
            ? `Pipeline: ${ami.pipelineId}${ami.regions?.length > 1 ? '\n' + ami.regions.map((r: any) => r.region).join('   ') : ''}`
            : ami.amiId,
          tags: ami.regions?.length > 1 ? ami.regions.map((r: any) => r.region) : undefined
        }));
      
      // Build grouped options (only include groups that have images)
      const groupedOptions: Array<{ label: string; options: Array<{ label: string; value: string; description?: string }> }> = [];
      
      if (windowsImages.length > 0) {
        groupedOptions.push({ label: 'Windows', options: windowsImages });
      }
      if (linuxImages.length > 0) {
        groupedOptions.push({ label: 'Linux', options: linuxImages });
      }
      if (macosImages.length > 0) {
        groupedOptions.push({ label: 'macOS', options: macosImages });
      }
      
      setAmiOptions(groupedOptions);
    } catch (error) {
      console.error('Error fetching AMI options:', error);
      // Fallback to default Windows Server 2022
      setAmiOptions([
        { 
          label: 'Windows', 
          options: [{ label: 'Windows Server 2022 Base', value: 'ami-028dc1123403bd543', description: 'ami-028dc1123403bd543' }]
        }
      ]);
    } finally {
      setLoadingAmiOptions(false);
    }
  };

  // Region options computed from regional hubs
  const regionOptions = useMemo(() => {
    const options = [{ label: 'All Regions', value: '' }];
    regionalHubs.forEach(hub => {
      options.push({
        label: hub.isPrimary ? `${hub.region} (Primary)` : hub.region,
        value: hub.region
      });
    });
    return options;
  }, [regionalHubs]);

  // Filtered and combined list of groups and users for assignment modal
  const filteredAssignees = useMemo(() => {
    const filter = assignModalFilter.toLowerCase();
    
    // Filter groups
    const filteredGroups = groups
      .filter(g => !filter || g.groupName?.toLowerCase().includes(filter))
      .map(g => ({ type: 'group' as const, id: g.groupId, name: g.groupName, email: '' }));
    
    // Filter users
    const filteredUsers = users
      .filter(u => !filter || 
        u.firstName?.toLowerCase().includes(filter) ||
        u.lastName?.toLowerCase().includes(filter) ||
        u.email?.toLowerCase().includes(filter) ||
        u.userId?.toLowerCase().includes(filter)
      )
      .map(u => ({ 
        type: 'user' as const, 
        id: u.userId, 
        name: `${u.firstName} ${u.lastName}`, 
        email: u.email || u.userId 
      }));
    
    let combined = [...filteredGroups, ...filteredUsers];
    
    // Apply sorting
    const sortField = assignModalSorting.sortingColumn?.sortingField;
    if (sortField) {
      combined.sort((a, b) => {
        const aVal = (a[sortField as keyof typeof a] || '').toString().toLowerCase();
        const bVal = (b[sortField as keyof typeof b] || '').toString().toLowerCase();
        const comparison = aVal.localeCompare(bVal);
        return assignModalSorting.isDescending ? -comparison : comparison;
      });
    }
    
    return combined;
  }, [groups, users, assignModalFilter, assignModalSorting]);

  // Filter and sort workstations
  const processedWorkstations = useMemo(() => {
    let filtered = [...workstations];

    // Apply text filter (searches workstationName, instanceId, assignedUser, instanceType)
    if (filteringText) {
      const searchText = filteringText.toLowerCase();
      filtered = filtered.filter(workstation => 
        workstation.workstationName?.toLowerCase().includes(searchText) ||
        workstation.instanceId?.toLowerCase().includes(searchText) ||
        (workstation.assignedUserDisplay || workstation.assignedUserId || '')?.toLowerCase().includes(searchText) ||
        workstation.instanceType?.toLowerCase().includes(searchText)
      );
    }

    // Apply instance status filter
    if (instanceStatusFilter?.value) {
      filtered = filtered.filter(workstation => 
        workstation.instanceStatus === instanceStatusFilter.value
      );
    }

    // Apply DCV status filter
    if (dcvStatusFilter?.value) {
      if (dcvStatusFilter.value === 'ready') {
        filtered = filtered.filter(workstation => workstation.dcvStatus === 'ready');
      } else if (dcvStatusFilter.value === 'not-ready') {
        filtered = filtered.filter(workstation => workstation.dcvStatus !== 'ready' && workstation.dcvStatus !== 'stopped');
      } else if (dcvStatusFilter.value === 'stopped') {
        filtered = filtered.filter(workstation => workstation.dcvStatus === 'stopped' || workstation.instanceStatus === 'stopped');
      }
    }

    // Apply platform filter
    if (platformFilter?.value) {
      filtered = filtered.filter(workstation => 
        workstation.platform?.toLowerCase() === platformFilter.value
      );
    }

    // Apply region filter
    if (regionFilter?.value) {
      filtered = filtered.filter(workstation => 
        workstation.region === regionFilter.value
      );
    }

    // Apply sorting
    if (sortingColumn.sortingField) {
      filtered.sort((a, b) => {
        let aValue = a[sortingColumn.sortingField];
        let bValue = b[sortingColumn.sortingField];
        
        // Handle special sorting cases
        if (sortingColumn.sortingField === 'assignedUserId') {
          aValue = a.assignedUserDisplay || a.assignedUserId || 'Unassigned';
          bValue = b.assignedUserDisplay || b.assignedUserId || 'Unassigned';
        } else if (sortingColumn.sortingField === 'groups') {
          // Sort by first group name, or 'zzz' if no groups (puts at end)
          aValue = (a.groups && a.groups.length > 0) ? a.groups[0] : 'zzz';
          bValue = (b.groups && b.groups.length > 0) ? b.groups[0] : 'zzz';
        } else if (sortingColumn.sortingField === 'createdAt') {
          aValue = new Date(aValue).getTime();
          bValue = new Date(bValue).getTime();
        }
        
        // Convert to string for comparison if not numbers
        if (typeof aValue !== 'number') {
          aValue = String(aValue || '').toLowerCase();
          bValue = String(bValue || '').toLowerCase();
        }
        
        if (aValue < bValue) return sortingColumn.sortingDescending ? 1 : -1;
        if (aValue > bValue) return sortingColumn.sortingDescending ? -1 : 1;
        return 0;
      });
    }

    return filtered;
  }, [workstations, filteringText, instanceStatusFilter, dcvStatusFilter, platformFilter, regionFilter, sortingColumn]);

  // Calculate paginated workstations
  const paginatedWorkstations = useMemo(() => {
    const pageSize = preferences.pageSize || 10;
    const startIndex = (currentPageIndex - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return processedWorkstations.slice(startIndex, endIndex);
  }, [processedWorkstations, currentPageIndex, preferences.pageSize]);

  const totalPages = Math.ceil(processedWorkstations.length / (preferences.pageSize || 10));

  // Reset to first page when filtering changes
  useEffect(() => {
    setCurrentPageIndex(1);
  }, [filteringText, instanceStatusFilter, dcvStatusFilter, platformFilter, regionFilter]);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const token = getAuthToken();
      if (!token) {
        throw new Error('No current user');
      }
      
      const promises = [
        fetchWorkstations(),
        fetchAmiOptions()
      ];

      // Only fetch users and groups if user is admin
      if (isAdmin) {
        promises.push(
          apiCall('users', {
            headers: { 'Authorization': `Bearer ${token}` },
          }),
          apiCall('groups', {
            headers: { 'Authorization': `Bearer ${token}` },
          })
        );
      }

      const responses = await Promise.all(promises);
      const workstationsData = await responses[0].json();
      
      setWorkstations(workstationsData);
      
      if (isAdmin && responses[2]) {
        const usersData = await responses[2].json();
        setUsers(usersData);
        
        if (responses[3]) {
          const groupsData = await responses[3].json();
          setGroups(groupsData);
        }
      }
    } catch (error) {
      console.error('Error fetching data:', error);
      if (!handleAuthError(error)) {
        // Handle other errors if needed
      }
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async (instanceId: string, connectionType: 'client' | 'browser') => {
    setConnectingInstances(prev => new Set(prev).add(instanceId));
    
    try {
      const token = getAuthToken();
      if (!token) {
        throw new Error('No current user');
      }
      
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
          // Note: owner is determined by the Lambda based on the workstation's OS platform
        })
      });

      if (!response.ok) {
        // Try to get error details from response body
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error || `HTTP ${response.status}`;
        throw new Error(errorMessage);
      }

      const sessionData = await response.json();
      
      // Check if the response contains an error
      if (sessionData.error) {
        throw new Error(sessionData.error);
      }
      
      if (sessionData.connectionUrl) {
        if (connectionType === 'client') {
          // Use QUIC URL (port 8444) for native client - better streaming performance
          // Falls back to standard URL if quicConnectionUrl not available
          const baseUrl = sessionData.quicConnectionUrl || sessionData.connectionUrl;
          const dcvUrl = baseUrl.replace('https://', 'dcv://');
          
          // Store the URL in case we need to show the install prompt
          setPendingDcvUrl(dcvUrl);
          
          // Try to launch the DCV client
          // We use a hidden iframe to attempt the protocol launch
          // This prevents the browser from navigating away if the protocol isn't registered
          const iframe = document.createElement('iframe');
          iframe.style.display = 'none';
          document.body.appendChild(iframe);
          
          // Set a timeout to show the install modal if the client doesn't launch
          const timeoutId = setTimeout(() => {
            setShowDcvInstallModal(true);
            document.body.removeChild(iframe);
          }, 3500);
          
          // Listen for blur event which indicates the client launched
          const handleBlur = () => {
            clearTimeout(timeoutId);
            window.removeEventListener('blur', handleBlur);
            setTimeout(() => {
              if (document.body.contains(iframe)) {
                document.body.removeChild(iframe);
              }
            }, 100);
          };
          window.addEventListener('blur', handleBlur);
          
          // Attempt to launch via iframe
          if (iframe.contentWindow) {
            iframe.contentWindow.location.href = dcvUrl;
          }
        } else {
          // Open in web browser (uses TCP port 8443)
          window.open(sessionData.connectionUrl, '_blank');
        }
      }
    } catch (error) {
      console.error('Error connecting to workstation:', error);
      if (!handleAuthError(error)) {
        // Parse error message from API response if available
        let errorMessage = 'Failed to connect to workstation. Please try again.';
        if (error instanceof Error) {
          // Try to extract error details from the response
          try {
            const errorData = JSON.parse((error as any).message || '{}');
            if (errorData.error) {
              errorMessage = errorData.error;
            }
          } catch {
            // If parsing fails, check for HTTP status
            if (error.message.includes('HTTP 500')) {
              errorMessage = 'Server error while connecting. The workstation may not be ready yet.';
            } else if (error.message.includes('HTTP 404')) {
              errorMessage = 'Workstation not found. It may have been deleted.';
            }
          }
        }
        setConnectionAlert({ type: 'error', message: errorMessage });
      }
    } finally {
      setConnectingInstances(prev => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
    }
  };

  const handleCreateWorkstation = async () => {
    // Validate required fields
    if (!newWorkstation.amiId) {
      alert('Please select an AMI.');
      return;
    }

    // Validate user selection for bulk creation with individual users
    if (newWorkstation.assignmentType === 'user' && newWorkstation.instanceCount > 1) {
      if (newWorkstation.assignedUserIds.length > newWorkstation.instanceCount) {
        alert(`You can select at most ${newWorkstation.instanceCount} users for ${newWorkstation.instanceCount} workstations.`);
        return;
      }
    }

    setCreatingWorkstation(true);
    
    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }
      
      // Get platform from AMI data to ensure correct state machine routing
      const selectedAmi = amiData.get(newWorkstation.amiId);
      if (!selectedAmi?.platform) {
        alert(`Cannot create workstation: Platform information is missing for AMI ${newWorkstation.amiId}. Please ensure the image has a platform defined.`);
        setCreatingWorkstation(false);
        return;
      }
      
      const basePayload = {
        amiId: newWorkstation.amiId,
        instanceType: newWorkstation.instanceType,
        rootVolumeSize: newWorkstation.rootVolumeSize,
        pipelineId: newWorkstation.pipelineId,
        joinDomain: newWorkstation.joinDomain,
        acronym: config?.acronym || 'MRM',
        platform: selectedAmi.platform, // Explicitly pass platform to ensure correct state machine routing
        ...(newWorkstation.region && { region: newWorkstation.region })
      };

      // Build array of workstations to create
      const workstationsToCreate: any[] = [];
      
      if (newWorkstation.assignmentType === 'group') {
        // All workstations go to the same group
        for (let i = 0; i < newWorkstation.instanceCount; i++) {
          workstationsToCreate.push({
            ...basePayload,
            assignedUserId: newWorkstation.assignedUserId,
            assignmentType: 'group'
          });
        }
      } else if (newWorkstation.assignmentType === 'user' && newWorkstation.instanceCount > 1) {
        // Bulk creation with individual user assignments
        for (let i = 0; i < newWorkstation.instanceCount; i++) {
          const userId = newWorkstation.assignedUserIds[i] || ''; // Empty if no user selected for this slot
          workstationsToCreate.push({
            ...basePayload,
            assignedUserId: userId,
            assignmentType: userId ? 'user' : 'unassigned'
          });
        }
      } else if (newWorkstation.assignmentType === 'unassigned') {
        // Create unassigned workstations
        for (let i = 0; i < newWorkstation.instanceCount; i++) {
          workstationsToCreate.push({
            ...basePayload,
            assignedUserId: '',
            assignmentType: 'unassigned'
          });
        }
      } else {
        // Single workstation with single user
        workstationsToCreate.push({
          ...basePayload,
          assignedUserId: newWorkstation.assignedUserId,
          assignmentType: newWorkstation.assignmentType || 'user'
        });
      }

      // Single API call for bulk creation
      console.log('Creating workstations:', workstationsToCreate);
      const response = await apiCall('workstations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ workstations: workstationsToCreate }),
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Failed to create workstation:', response.status, errorData);
        alert(`Failed to create workstation: ${errorData.message || errorData.error || response.statusText}`);
        return;
      }
      
      console.log('Workstation creation response:', await response.clone().json());
      setShowCreateModal(false);
      setNewWorkstation({ 
        amiId: '', 
        instanceType: 'g4dn.xlarge', 
        assignedUserId: '', 
        assignedUserIds: [],
        assignmentType: '', 
        rootVolumeSize: 100, 
        pipelineId: '', 
        joinDomain: !config?.useCognitoAuth, 
        region: '',
        instanceCount: 1
      });
      
      // Immediate refresh
      await fetchData();
      
      // Additional refresh after 5 seconds to show the new instance
      setTimeout(async () => {
        await fetchData();
      }, 5000);
      
    } catch (error) {
      console.error('Error creating workstation:', error);
      if (!handleAuthError(error)) {
        // Handle other errors if needed
      }
    } finally {
      setCreatingWorkstation(false);
    }
  };

  const fetchAvailableStorage = async () => {
    setLoadingStorage(true);
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall('storage', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        // Filter storage by status and platform compatibility with selected workstations
        const availableStorageList = data.filter((storage: any) => storage.status === 'available');
        
        // Get unique platforms from selected workstations (normalize to lowercase)
        const selectedPlatforms = new Set(selectedItems.map((w: any) => w.platform?.toLowerCase()));
        
        // Get unique regions from selected workstations
        // Default to primary region if workstation doesn't have region set
        const selectedRegions = new Set(selectedItems.map((w: any) => w.region || 'us-east-1'));
        
        // Filter storage based on platform compatibility AND region
        const compatibleStorage = availableStorageList.filter((storage: any) => {
          // Check platform compatibility
          let platformCompatible = true;
          if (storage.type === 'mountpoint-s3') {
            // S3 mounts only work on Linux (but S3 is global, so no region restriction)
            platformCompatible = selectedPlatforms.has('linux');
          } else if (storage.type === 'fsx-windows') {
            // FSx Windows only works on Windows
            platformCompatible = selectedPlatforms.has('windows');
          } else if (storage.type === 'fsx-ontap') {
            // FSxN works on all platforms (NFS for Linux/macOS, SMB for Windows)
            platformCompatible = true;
          }
          
          if (!platformCompatible) return false;
          
          // Check region compatibility for FSx storage types
          // FSx file systems can only be mounted from instances in the same region
          // S3 is global, so no region restriction for mountpoint-s3
          if (storage.type === 'fsx-windows' || storage.type === 'fsx-ontap') {
            const storageRegion = storage.region || 'us-east-1'; // Default to primary region for legacy storage
            // Storage must be in one of the selected workstations' regions
            if (!selectedRegions.has(storageRegion)) {
              return false;
            }
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

  const handleAddStorage = async () => {
    setSavingStorage(true);
    try {
      const token = getAuthToken();
      if (!token) return;

      // Validate drive letter conflicts (only for Windows storage)
      const enabledWindowsAssignments = storageAssignments.filter((a: any) => {
        const storage = availableStorage.find((s: any) => s.storageId === a.storageId);
        const platform = selectedItems[0]?.platform?.toLowerCase() || 'windows';
        // Check for drive letter conflicts on Windows (FSx Windows or FSxN on Windows)
        return a.autoMount && storage?.type !== 'mountpoint-s3' && 
               (storage?.type === 'fsx-windows' || (storage?.type === 'fsx-ontap' && platform === 'windows'));
      });
      const driveLetters = enabledWindowsAssignments.map((a: any) => a.driveLetter);
      const duplicates = driveLetters.filter((letter, index) => driveLetters.indexOf(letter) !== index);
      
      if (duplicates.length > 0) {
        setDriveLetterError(`Drive letter conflict: ${duplicates[0]}: is assigned to multiple storage resources. Please select different drive letters.`);
        return;
      }
      
      setDriveLetterError(''); // Clear any existing error

      // Include all storage assignments (both enabled and disabled)
      const allAssignments = storageAssignments;
      
      if (allAssignments.length === 0) {
        setShowAddStorageModal(false);
        setStorageAssignments([]);
        return;
      }

      // Update each selected workstation
      for (const workstation of selectedItems) {
        const existingConfig = workstation.storageConfig || {};
        const platform = workstation.platform?.toLowerCase() || 'windows';
        
        const storageConfig = allAssignments.reduce((acc: any, assignment: any) => {
          // Find the storage details to get the share name and type
          const storageDetails = availableStorage.find((s: any) => s.storageId === assignment.storageId);
          
          if (storageDetails?.type === 'mountpoint-s3') {
            // S3 mount configuration
            acc[assignment.storageId] = {
              autoMount: assignment.autoMount,
              mountPath: storageDetails.mountPath || '/mnt/s3',
              type: 'mountpoint-s3',
              bucketName: storageDetails.bucketName,
              prefix: storageDetails.prefix || ''
            };
          } else if (storageDetails?.type === 'fsx-ontap') {
            // FSxN configuration - different for Windows vs Linux/macOS
            if (platform === 'windows') {
              acc[assignment.storageId] = {
                autoMount: assignment.autoMount,
                driveLetter: assignment.driveLetter || 'Z',
                type: 'fsx-ontap',
                junctionPath: assignment.junctionPath || storageDetails?.junctionPath || '/vol1'
              };
            } else {
              // Linux/macOS use NFS mount path - use /Volumes for macOS, /mnt for Linux
              const defaultMountPath = platform === 'macos'
                ? `/Volumes/fsxn-${assignment.storageId?.substring(0, 8) || 'vol'}`
                : `/mnt/fsxn-${assignment.storageId?.substring(0, 8) || 'vol'}`;
              acc[assignment.storageId] = {
                autoMount: assignment.autoMount,
                mountPath: assignment.mountPath || defaultMountPath,
                type: 'fsx-ontap',
                junctionPath: assignment.junctionPath || storageDetails?.junctionPath || '/vol1'
              };
            }
          } else {
            // Windows FSx configuration
            acc[assignment.storageId] = {
              autoMount: assignment.autoMount,
              driveLetter: assignment.driveLetter,
              type: storageDetails?.type || 'fsx-windows',
              shareName: storageDetails?.name || 'share'
            };
          }
          return acc;
        }, {});

        // Save the storage config to the workstation
        await apiCall(`workstations/${workstation.instanceId}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            storageConfig
          }),
        });

        // Handle mount/unmount for running workstations
        if (workstation.instanceStatus === 'running') {
          for (const assignment of allAssignments) {
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
                      'Authorization': `Bearer ${token}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      action: 'mount',
                      instanceId: workstation.instanceId,
                      storageId: assignment.storageId
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
                      'Authorization': `Bearer ${token}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      action: 'unmount',
                      instanceId: workstation.instanceId,
                      storageId: assignment.storageId
                    }),
                  });
                } catch (unmountError) {
                  console.error(`Failed to unmount S3 storage ${assignment.storageId}:`, unmountError);
                }
              }
            }
            
            // Note: FSxN NFS mounts (Linux/macOS) are handled automatically by the backend
            // when storageConfig is updated - workstation-manager triggers fsx-nfs-mount-manager
          }
        }
      }

      setShowAddStorageModal(false);
      setStorageAssignments([]);
      setStorageSuccessMessage(`Storage configuration updated successfully for ${selectedItems.length} workstation(s).`);
      await fetchData(); // Refresh workstation data
    } catch (error) {
      console.error('Error adding storage:', error);
      if (!handleAuthError(error)) {
        // Handle other errors if needed
      }
    } finally {
      setSavingStorage(false);
    }
  };

  // Fetch available storage when modal opens
  useEffect(() => {
    if (showAddStorageModal) {
      fetchAvailableStorage();
      loadExistingStorageConfig();
    }
  }, [showAddStorageModal]);

  const loadExistingStorageConfig = () => {
    if (selectedItems.length === 0) return;
    
    // If multiple workstations selected, use the first one's config as base
    const workstation = selectedItems[0];
    const existingConfig = workstation.storageConfig || {};
    const platform = workstation.platform?.toLowerCase() || 'windows';
    
    // Convert existing config to assignments format
    const assignments = Object.entries(existingConfig).map(([storageId, config]: [string, any]) => {
      if (config.type === 'mountpoint-s3') {
        return {
          storageId,
          autoMount: config.autoMount || false,
          mountPath: config.mountPath || '/mnt/s3'
        };
      } else if (config.type === 'fsx-ontap') {
        // FSxN: use mount path for Linux/macOS, drive letter for Windows
        if (platform === 'windows') {
          return {
            storageId,
            autoMount: config.autoMount || false,
            driveLetter: (config.driveLetter || 'Z').replace(':', ''),
            junctionPath: config.junctionPath || '/vol1'
          };
        } else {
          // Use /Volumes for macOS, /mnt for Linux
          const defaultMountPath = platform === 'macos'
            ? `/Volumes/fsxn-${storageId.substring(0, 8)}`
            : `/mnt/fsxn-${storageId.substring(0, 8)}`;
          return {
            storageId,
            autoMount: config.autoMount || false,
            mountPath: config.mountPath || defaultMountPath,
            junctionPath: config.junctionPath || '/vol1'
          };
        }
      } else {
        return {
          storageId,
          autoMount: config.autoMount || false,
          driveLetter: (config.driveLetter || 'Z').replace(':', '') // Store without colon
        };
      }
    });
    
    setStorageAssignments(assignments);
  };

  const handleStopWorkstation = async (instanceId: string) => {
    setStoppingInstances(prev => new Set(prev).add(instanceId));
    
    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }
      
      await apiCall(`workstations/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ instanceId }),
      });
      
      // Wait 3 seconds before refreshing to allow status change
      setTimeout(async () => {
        await fetchData();
        // Additional refresh after 5 more seconds to show updated state
        setTimeout(async () => {
          await fetchData();
        }, 5000);
      }, 3000);
    } catch (error) {
      console.error('Error stopping workstation:', error);
      if (!handleAuthError(error)) {
        // Handle other errors if needed
      }
    } finally {
      setStoppingInstances(prev => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
    }
  };

  const handleRebootWorkstation = async (instanceId: string) => {
    setRebootingInstances(prev => new Set(prev).add(instanceId));
    
    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }
      
      await apiCall(`workstations/reboot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ instanceId }),
      });
      
      // Wait 3 seconds before refreshing to allow status change
      setTimeout(async () => {
        await fetchData();
        // Additional refresh after 10 more seconds to show updated state (reboot takes longer)
        setTimeout(async () => {
          await fetchData();
        }, 10000);
      }, 3000);
    } catch (error) {
      console.error('Error rebooting workstation:', error);
      if (!handleAuthError(error)) {
        // Handle other errors if needed
      }
    } finally {
      setRebootingInstances(prev => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
    }
  };

  const handleStartWorkstation = async (instanceId: string) => {
    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }
      
      // Show modal and start the workstation
      setStartingInstanceId(instanceId);
      setShowStartModal(true);
      
      await apiCall(`workstations/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ instanceId }),
      });
      
    } catch (error) {
      console.error('Error starting workstation:', error);
      if (!handleAuthError(error)) {
        setShowStartModal(false);
        setStartingInstanceId('');
      }
    }
  };

  const handleDeleteWorkstation = async () => {
    if (!workstationToDelete) return;
    
    setDeletingInstances(prev => new Set(prev).add(workstationToDelete.instanceId));
    
    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }
      
      await apiCall(`workstations/${workstationToDelete.instanceId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      
      setShowDeleteModal(false);
      setWorkstationToDelete(null);
      await fetchData();
    } catch (error) {
      console.error('Error deleting workstation:', error);
      if (!handleAuthError(error)) {
        // Handle other errors if needed
      }
    } finally {
      setDeletingInstances(prev => {
        const newSet = new Set(prev);
        newSet.delete(workstationToDelete?.instanceId);
        return newSet;
      });
    }
  };

  const handleAssignUser = async () => {
    setAssigningUser(true);
    
    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }

      const response = await apiCall(`/workstations/${assignUserData.instanceId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          assignedUserId: assignUserData.newUserId
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await fetchData();
      setShowAssignModal(false);
      setAssignUserData({ instanceId: '', currentUserId: '', newUserId: '' });
    } catch (error) {
      console.error('Error assigning user:', error);
      if (!handleAuthError(error)) {
        // Handle other errors if needed
      }
    } finally {
      setAssigningUser(false);
    }
  };

  const openAssignModal = (workstation: any) => {
    setAssignUserData({
      instanceId: workstation.instanceId,
      currentUserId: workstation.assignedUserDisplay || workstation.assignedUserId || 'Unassigned',
      newUserId: workstation.assignedUserId || ''
    });
    setAssignModalFilter('');
    setShowAssignModal(true);
  };

  const handleUnassign = async (instanceId: string) => {
    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }

      const response = await apiCall(`/workstations/${instanceId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          assignedUserId: ''
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await fetchData();
    } catch (error) {
      console.error('Error unassigning workstation:', error);
      if (!handleAuthError(error)) {
        // Handle other errors if needed
      }
    }
  };

  const getStatusIndicator = (status: string) => {
    switch (status) {
      case 'running':
        return <StatusIndicator type="success">Running</StatusIndicator>;
      case 'stopped':
        return <StatusIndicator type="stopped">Stopped</StatusIndicator>;
      case 'pending':
      case 'starting':
        return <StatusIndicator type="pending">Starting</StatusIndicator>;
      case 'stopping':
        return <StatusIndicator type="pending">Stopping</StatusIndicator>;
      default:
        return <StatusIndicator type="info">{status}</StatusIndicator>;
    }
  };

  const getWorkflowStatusIndicator = (status: string, failureReason?: string) => {
    switch (status) {
      case 'launching':
        return <StatusIndicator type="pending">Launching</StatusIndicator>;
      case 'setting-hostname':
        return <StatusIndicator type="pending">Setting Hostname</StatusIndicator>;
      case 'installing-dcv':
        return <StatusIndicator type="pending">Installing DCV</StatusIndicator>;
      case 'installing-base':
        return <StatusIndicator type="pending">Installing Base</StatusIndicator>;
      case 'installing-gpu':
        return <StatusIndicator type="pending">Installing GPU</StatusIndicator>;
      case 'rebooting':
      case 'Rebooting':
        return <StatusIndicator type="pending">Rebooting</StatusIndicator>;
      case 'starting-services':
        return <StatusIndicator type="pending">Starting Services</StatusIndicator>;
      case 'configuring-dcv':
        return <StatusIndicator type="pending">Configuring DCV</StatusIndicator>;
      case 'joining-domain':
        return <StatusIndicator type="pending">Joining Domain</StatusIndicator>;
      case 'configuring-system':
        return <StatusIndicator type="pending">Configuring System</StatusIndicator>;
      case 'finalizing':
        return <StatusIndicator type="pending">Finalizing</StatusIndicator>;
      case 'ready':
        return <StatusIndicator type="success">Ready</StatusIndicator>;
      case 'Complete':
      case 'complete':
        return <StatusIndicator type="success">Complete</StatusIndicator>;
      case 'Stopped':
        return <StatusIndicator type="info">Stopped</StatusIndicator>;
      case 'Stopping':
        return <StatusIndicator type="pending">Stopping</StatusIndicator>;
      case 'Terminated':
        return <StatusIndicator type="error">Terminated</StatusIndicator>;
      case 'failed':
        return (
          <Popover
            dismissButton={false}
            position="top"
            size="medium"
            triggerType="custom"
            content={failureReason || 'Workstation creation failed'}
          >
            <StatusIndicator type="error">Failed</StatusIndicator>
          </Popover>
        );
      case 'starting-instance':
        return <StatusIndicator type="pending">Starting Instance</StatusIndicator>;
      case 'instance-running':
        return <StatusIndicator type="pending">Instance Running</StatusIndicator>;
      case 'configuring-autologin':
        return <StatusIndicator type="pending">Configuring Auto-Login</StatusIndicator>;
      case 'starting-dcv-agents':
        return <StatusIndicator type="pending">Starting DCV Agents</StatusIndicator>;
      case 'dcv-ready':
        return <StatusIndicator type="pending">DCV Ready</StatusIndicator>;
      case 'testing-dcv':
        return <StatusIndicator type="pending">Testing DCV</StatusIndicator>;
      case 'dcv-session-created':
        return <StatusIndicator type="pending">DCV Session Created</StatusIndicator>;
      case 'cleaning-up':
        return <StatusIndicator type="pending">Cleaning Up</StatusIndicator>;
      case 'starting-dcv':
        return <StatusIndicator type="pending">Starting DCV</StatusIndicator>;
      default:
        return <StatusIndicator type="info">{status || 'Unknown'}</StatusIndicator>;
    }
  };

  const getDcvStatusIndicator = (dcvStatus: string, workflowStatus: string, instanceStatus: string) => {
    if (dcvStatus === 'ready') {
      return <StatusIndicator type="success">Ready</StatusIndicator>;
    }
    
    // Show more descriptive status based on workflow and instance state
    if (instanceStatus === 'pending' || instanceStatus === 'starting') {
      return <StatusIndicator type="pending">Instance Starting</StatusIndicator>;
    }
    
    if (workflowStatus === 'launching') {
      return <StatusIndicator type="pending">Launching</StatusIndicator>;
    }
    
    if (workflowStatus === 'installing-dcv') {
      return <StatusIndicator type="pending">Installing DCV</StatusIndicator>;
    }
    
    if (workflowStatus === 'configuring-dcv') {
      return <StatusIndicator type="pending">Configuring DCV</StatusIndicator>;
    }
    
    if (workflowStatus === 'joining-domain' || workflowStatus === 'configuring-system') {
      return <StatusIndicator type="pending">Setting up System</StatusIndicator>;
    }
    
    if (workflowStatus === 'finalizing') {
      return <StatusIndicator type="pending">Finalizing Setup</StatusIndicator>;
    }
    
    if (dcvStatus === 'stopped' && instanceStatus === 'stopped') {
      return <StatusIndicator type="stopped">Stopped</StatusIndicator>;
    }
    
    if (dcvStatus === 'stopped' && instanceStatus === 'running') {
      return <StatusIndicator type="pending">Starting DCV</StatusIndicator>;
    }
    
    // Default fallback
    return <StatusIndicator type="warning">Not Ready</StatusIndicator>;
  };

  const columnDefinitions = useMemo(() => [
    {
      id: 'instanceId',
      header: 'Instance ID',
      cell: (item: any) => (
        <Link 
          variant="primary"
          onFollow={(event) => {
            event.preventDefault();
            window.location.href = `/workstations/${item.instanceId}`;
          }}
        >
          {item.instanceId}
        </Link>
      ),
      sortingField: 'instanceId',
      isRowHeader: true,
    },
    {
      id: 'workstationName',
      header: 'Name',
      cell: (item: any) => item.workstationName || '-',
      sortingField: 'workstationName',
    },
    {
      id: 'assignedUser',
      header: 'Assigned To',
      minWidth: 150,
      cell: (item: any) => {
        const assignedTo = item.assignedUserDisplay || item.assignedUserId;
        // Check for actual assigned value (not empty string or "Unassigned")
        if (assignedTo && assignedTo.trim() !== '' && assignedTo.toLowerCase() !== 'unassigned') {
          // Link to user details page
          return (
            <Link
              variant="primary"
              onFollow={(e) => {
                e.preventDefault();
                window.location.href = `/users/${encodeURIComponent(item.assignedUserId)}`;
              }}
            >
              {assignedTo}
            </Link>
          );
        }
        // Show button to assign workstation (mimics "Manage Users" button style)
        return (
          <Button
            iconName="user-profile"
            onClick={() => openAssignModal(item)}
          >
            Assign
          </Button>
        );
      },
      sortingField: 'assignedUserId',
    },
    {
      id: 'region',
      header: 'Region',
      cell: (item: any) => item.region || process.env.AWS_REGION || 'Primary',
      sortingField: 'region',
    },
    {
      id: 'instanceType',
      header: 'Instance Type',
      cell: (item: any) => item.instanceType,
      sortingField: 'instanceType',
    },
    {
      id: 'status',
      header: 'Workflow Status',
      cell: (item: any) => getWorkflowStatusIndicator(item.status, item.failureReason),
      sortingField: 'status',
    },
    {
      id: 'instanceStatus',
      header: 'Instance Status',
      cell: (item: any) => getStatusIndicator(item.instanceStatus),
      sortingField: 'instanceStatus',
    },
    {
      id: 'dcvStatus',
      header: 'DCV Status',
      cell: (item: any) => {
        // If instance is stopped, show "Stopped"
        if (item.instanceStatus === 'stopped') {
          return <StatusIndicator type="stopped">Stopped</StatusIndicator>;
        }
        
        // If no DCV status yet (still installing), show "Installing..."
        if (!item.dcvStatus) {
          return <StatusIndicator type="pending">Installing...</StatusIndicator>;
        }
        
        // Show detailed DCV status based on workflow and DCV state
        return getDcvStatusIndicator(item.dcvStatus, item.status, item.instanceStatus);
      },
      sortingField: 'dcvStatus',
    },
    {
      id: 'createdAt',
      header: 'Created',
      cell: (item: any) => new Date(item.createdAt).toLocaleString(),
      sortingField: 'createdAt',
    },
  ], []);

  const visibleColumns = useMemo(() => {
    return preferences.contentDisplay
      .filter(item => item.visible)
      .map(item => columnDefinitions.find(col => col.id === item.id))
      .filter(Boolean);
  }, [preferences.contentDisplay, columnDefinitions]);

  const userOptions = users.map((user: any) => ({
    label: `${user.email} (${user.firstName} ${user.lastName})`,
    value: user.userId,
  }));

  return (
    <>
      <AppLayout
        navigation={<Navigation isAdmin={isAdmin} productName={config?.productName} acronym={config?.acronym} />}
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
                  { text: 'Workstations' }
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
                      Workstation Management
                    </Box>
                    <Box
                      variant="p"
                      color="text-body-secondary"
                      margin={{ top: "xxs", bottom: "s" }}
                    >
                      Create, configure, and manage virtual workstations for your organization. Assign workstations to users and monitor their status.
                    </Box>
                  </div>
                </Grid>
              </Box>
            }
          >
          <SpaceBetween size="l">
            {storageSuccessMessage && (
              <Alert 
                type="success" 
                dismissible 
                onDismiss={() => setStorageSuccessMessage('')}
              >
                {storageSuccessMessage}
              </Alert>
            )}
            {connectionAlert && (
              <Alert 
                type={connectionAlert.type} 
                dismissible 
                onDismiss={() => setConnectionAlert(null)}
                header={connectionAlert.type === 'error' ? 'Connection Failed' : connectionAlert.type === 'success' ? 'Connected' : 'Connection Status'}
              >
                {connectionAlert.message}
              </Alert>
            )}
            <div style={{ 
              minHeight: '400px',
              overflow: 'visible',
              position: 'relative',
              zIndex: 1
            }}>
              <Table
                columnDefinitions={visibleColumns}
                items={paginatedWorkstations}
                loading={loading}
                loadingText="Loading workstations..."
                selectionType="single"
                selectedItems={selectedItems}
                onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
                sortingColumn={sortingColumn}
                sortingDescending={sortingColumn.sortingDescending}
                onSortingChange={({ detail }) => {
                  setSortingColumn({
                    sortingField: detail.sortingColumn.sortingField,
                    sortingDescending: detail.isDescending || false
                  });
                }}
                trackBy="instanceId"
                wrapLines={preferences.wrapLines}
                stripedRows={preferences.stripedRows}
                contentDensity={preferences.contentDensity}
                stickyColumns={preferences.stickyColumns}
                pagination={
                  totalPages > 1 ? (
                    <Pagination 
                      currentPageIndex={currentPageIndex} 
                      pagesCount={totalPages}
                      onChange={({ detail }) => setCurrentPageIndex(detail.currentPageIndex)}
                    />
                  ) : null
                }
                preferences={
                  <CollectionPreferences
                    title="Preferences"
                    confirmLabel="Confirm"
                    cancelLabel="Cancel"
                    onConfirm={({ detail }) => updatePreferences(detail)}
                    preferences={preferences}
                    pageSizePreference={{
                      title: "Page size",
                      options: [
                        { value: 10, label: "10 workstations" },
                        { value: 20, label: "20 workstations" },
                        { value: 50, label: "50 workstations" }
                      ]
                    }}
                    wrapLinesPreference={{
                      label: "Wrap lines",
                      description: "Wrap text content in table cells"
                    }}
                    stripedRowsPreference={{
                      label: "Striped rows",
                      description: "Add alternating row colors"
                    }}
                    contentDensityPreference={{
                      label: "Compact mode",
                      description: "Display content in a denser, more compact mode"
                    }}
                    contentDisplayPreference={{
                      title: "Column preferences",
                      description: "Customize which columns are displayed",
                      options: [
                        {
                          id: "instanceId",
                          label: "Instance ID",
                          alwaysVisible: true
                        },
                        { id: "workstationName", label: "Name" },
                        { id: "assignedUser", label: "Assigned To" },
                        { id: "region", label: "Region" },
                        { id: "instanceType", label: "Instance Type" },
                        { id: "status", label: "Workflow Status" },
                        { id: "instanceStatus", label: "Instance Status" },
                        { id: "dcvStatus", label: "DCV Status" },
                        { id: "createdAt", label: "Created" }
                      ]
                    }}
                    stickyColumnsPreference={{
                      firstColumns: {
                        title: "Stick first column(s)",
                        description: "Keep the first column(s) visible while horizontally scrolling",
                        options: [
                          { label: "None", value: 0 },
                          { label: "First column", value: 1 },
                          { label: "First two columns", value: 2 }
                        ]
                      },
                      lastColumns: {
                        title: "Stick last column",
                        description: "Keep the last column visible while horizontally scrolling",
                        options: [
                          { label: "None", value: 0 },
                          { label: "Last column", value: 1 }
                        ]
                      }
                    }}
                  />
                }
                filter={
                  <SpaceBetween direction="horizontal" size="s">
                    <TextFilter
                      filteringText={filteringText}
                      filteringPlaceholder="Search by name, ID, user, or type"
                      filteringAriaLabel="Filter workstations"
                      onChange={({ detail }) => setFilteringText(detail.filteringText)}
                    />
                    <Select
                      selectedOption={instanceStatusFilter}
                      onChange={({ detail }) => setInstanceStatusFilter(detail.selectedOption)}
                      options={instanceStatusOptions}
                      placeholder="Instance Status"
                      selectedAriaLabel="Selected instance status"
                    />
                    <Select
                      selectedOption={dcvStatusFilter}
                      onChange={({ detail }) => setDcvStatusFilter(detail.selectedOption)}
                      options={dcvStatusOptions}
                      placeholder="DCV Status"
                      selectedAriaLabel="Selected DCV status"
                    />
                    <Select
                      selectedOption={platformFilter}
                      onChange={({ detail }) => setPlatformFilter(detail.selectedOption)}
                      options={platformOptions}
                      placeholder="Platform"
                      selectedAriaLabel="Selected platform"
                    />
                    {regionOptions.length > 2 && (
                      <Select
                        selectedOption={regionFilter}
                        onChange={({ detail }) => setRegionFilter(detail.selectedOption)}
                        options={regionOptions}
                        placeholder="Region"
                        selectedAriaLabel="Selected region"
                      />
                    )}
                  </SpaceBetween>
                }
                header={
                  <Header
                    counter={`(${workstations.length})`}
                    actions={
                      <SpaceBetween direction="horizontal" size="xs">
                        <Button
                          iconName={isAutoRefreshing ? "status-in-progress" : "refresh"}
                          onClick={fetchData}
                          loading={loading}
                        >
                          {isAutoRefreshing ? "Auto-refreshing..." : ""}
                        </Button>
                        <ButtonDropdown
                          disabled={selectedItems.length !== 1}
                          items={[
                            {
                              text: 'View Details',
                              id: 'details'
                            },
                            ...(isAdmin ? [
                              {
                                text: 'Mount Storage',
                                id: 'add-storage'
                              },
                              {
                                text: 'Assignment',
                                items: [
                                  {
                                    text: 'Assign',
                                    id: 'assign'
                                  },
                                  {
                                    text: 'Unassign',
                                    id: 'unassign',
                                    disabled: !selectedItems[0]?.assignedUserId
                                  }
                                ]
                              }
                            ] : []),
                            {
                              text: 'Power',
                              items: [
                                {
                                  text: 'Start',
                                  id: 'start',
                                  disabled: selectedItems.length !== 1 || selectedItems[0]?.instanceStatus !== 'stopped'
                                },
                                {
                                  text: 'Stop',
                                  id: 'stop',
                                  disabled: selectedItems.length !== 1 || selectedItems[0]?.instanceStatus !== 'running'
                                },
                                {
                                  text: 'Reboot',
                                  id: 'reboot',
                                  disabled: selectedItems.length !== 1 || selectedItems[0]?.instanceStatus !== 'running'
                                }
                              ]
                            },
                            ...(isAdmin ? [
                              {
                                text: 'Terminate',
                                id: 'delete'
                              }
                            ] : [])
                          ]}
                          onItemClick={({ detail }) => {
                            if (selectedItems.length === 1) {
                              const instance = selectedItems[0];
                              switch (detail.id) {
                                case 'details':
                                  window.location.href = `/workstations/${instance.instanceId}`;
                                  break;
                                case 'assign':
                                  setAssignUserData({
                                    instanceId: instance.instanceId,
                                    currentUserId: instance.assignedUserDisplay || instance.assignedUserId || 'Unassigned',
                                    newUserId: instance.assignedUserId || ''
                                  });
                                  setAssignModalFilter('');
                                  setShowAssignModal(true);
                                  break;
                                case 'unassign':
                                  handleUnassign(instance.instanceId);
                                  break;
                                case 'add-storage':
                                  setShowAddStorageModal(true);
                                  break;
                                case 'start':
                                  handleStartWorkstation(instance.instanceId);
                                  break;
                                case 'stop':
                                  handleStopWorkstation(instance.instanceId);
                                  break;
                                case 'reboot':
                                  handleRebootWorkstation(instance.instanceId);
                                  break;
                                case 'delete':
                                  setWorkstationToDelete(instance);
                                  setShowDeleteModal(true);
                                  break;
                              }
                            }
                          }}
                        >
                          Actions
                        </ButtonDropdown>
                        {(() => {
                          const hasSelection = selectedItems.length === 1;
                          const isRunning = hasSelection && selectedItems[0]?.instanceStatus === 'running';
                          const isDcvReady = hasSelection && selectedItems[0]?.dcvStatus === 'ready';
                          const isConnectable = hasSelection && isRunning && isDcvReady;
                          const isLoading = hasSelection && connectingInstances.has(selectedItems[0]?.instanceId);
                          
                          if (browserSessionsEnabled && isConnectable) {
                            return (
                              <ButtonDropdown
                                variant="primary"
                                loading={isLoading}
                                items={[
                                  {
                                    text: 'Connect in Browser',
                                    id: 'browser'
                                  }
                                ]}
                                onItemClick={({ detail }) => {
                                  handleConnect(selectedItems[0].instanceId, detail.id as 'client' | 'browser');
                                }}
                                mainAction={{
                                  text: 'Connect',
                                  onClick: () => {
                                    handleConnect(selectedItems[0].instanceId, 'client');
                                  }
                                }}
                              />
                            );
                          } else {
                            return (
                              <Button
                                variant={isConnectable ? "primary" : "normal"}
                                disabled={!isConnectable}
                                loading={isLoading}
                                onClick={() => {
                                  if (isConnectable) {
                                    handleConnect(selectedItems[0].instanceId, 'client');
                                  }
                                }}
                              >
                                Connect
                              </Button>
                            );
                          }
                        })()}
                        {isAdmin && (
                          <Button
                            variant="primary"
                            onClick={() => {
                              // Reset form with defaults when opening modal
                              setNewWorkstation({
                                amiId: '',
                                instanceType: '',
                                assignedUserId: '',
                                assignedUserIds: [],
                                assignmentType: '',
                                rootVolumeSize: 100,
                                pipelineId: '',
                                joinDomain: !config?.useCognitoAuth,
                                region: '',
                                instanceCount: 1
                              });
                              setShowCreateModal(true);
                            }}
                          >
                            Create Workstation
                          </Button>
                        )}
                      </SpaceBetween>
                    }
                  >
                    Workstations
                  </Header>
                }
                empty="No workstations found."
              />
            </div>
          </SpaceBetween>
        </ContentLayout>
      }
    />

      <Modal
        visible={showCreateModal}
        onDismiss={() => setShowCreateModal(false)}
        header={newWorkstation.instanceCount > 1 ? `Create ${newWorkstation.instanceCount} Workstations` : "Create New Workstation"}
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => setShowCreateModal(false)}>
              Cancel
            </Button>
            <Button 
              variant="primary" 
              loading={creatingWorkstation}
              disabled={!newWorkstation.amiId || loadingAmiOptions}
              onClick={handleCreateWorkstation}
            >
              {newWorkstation.instanceCount > 1 ? `Create ${newWorkstation.instanceCount} Workstations` : 'Create Workstation'}
            </Button>
          </SpaceBetween>
        }
      >
        {loadingAmiOptions ? (
          <Box textAlign="center" padding="xl">
            <SpaceBetween direction="vertical" size="m" alignItems="center">
              <Spinner size="large" />
              <Box variant="p" color="text-body-secondary">Loading images...</Box>
            </SpaceBetween>
          </Box>
        ) : (
        <Form>
          <SpaceBetween direction="vertical" size="l">
            <FormField label="Image">
              <Select
                selectedOption={(() => {
                  // For grouped images, the value is groupKey (pipelineId::name)
                  // For standalone images, the value is amiId
                  if (newWorkstation.pipelineId && newWorkstation.amiId) {
                    const ami = amiData.get(newWorkstation.amiId);
                    if (ami) {
                      const groupKey = `${ami.pipelineId}::${ami.name}`;
                      const regions = pipelineRegionMap.get(groupKey);
                      return { 
                        label: regions && regions.length > 1 ? `${ami.name} (${regions.length} regions)` : ami.name, 
                        value: groupKey,
                        description: `Pipeline: ${ami.pipelineId}`
                      };
                    }
                  } else if (newWorkstation.amiId) {
                    const ami = amiData.get(newWorkstation.amiId);
                    return ami ? { label: ami.name, value: ami.amiId, description: ami.amiId } : null;
                  }
                  return null;
                })()}
                onChange={({ detail }) => {
                  const selectedValue = detail.selectedOption?.value;
                  if (!selectedValue) return;
                  
                  // Check if this is a groupKey (pipelineId::name) or a direct amiId
                  if (selectedValue.includes('::')) {
                    // It's a grouped pipeline image - get the AMI for the selected region
                    const regions = pipelineRegionMap.get(selectedValue);
                    if (regions && regions.length > 0) {
                      // Check if current region is available for this image
                      const currentRegion = newWorkstation.region || regionalHubs.find(h => h.isPrimary)?.region || 'us-east-1';
                      const regionAmi = regions.find(r => r.region === currentRegion) || regions[0];
                      const ami = amiData.get(regionAmi.amiId);
                      const platform = ami?.platform?.toLowerCase() || 'windows';
                      const defaultInstanceType = getDefaultInstanceType(platform);
                      setNewWorkstation({ 
                        ...newWorkstation, 
                        amiId: regionAmi.amiId,
                        pipelineId: selectedValue, // Store the groupKey for region switching
                        instanceType: defaultInstanceType,
                        // Update region if current region is not available for this image
                        region: regions.find(r => r.region === currentRegion) ? newWorkstation.region : (regions[0].region === (regionalHubs.find(h => h.isPrimary)?.region || 'us-east-1') ? '' : regions[0].region)
                      });
                    }
                  } else {
                    // It's a standalone image - use the amiId directly
                    const selectedAmi = amiData.get(selectedValue);
                    const platform = selectedAmi?.platform?.toLowerCase() || 'windows';
                    const defaultInstanceType = getDefaultInstanceType(platform);
                    
                    // Determine the region for this image
                    // If the image has a specific region that's not the primary, use that region
                    const primaryRegion = regionalHubs.find(h => h.isPrimary)?.region || 'us-east-1';
                    const imageRegion = selectedAmi?.region;
                    const targetRegion = imageRegion && imageRegion !== primaryRegion ? imageRegion : '';
                    
                    setNewWorkstation({ 
                      ...newWorkstation, 
                      amiId: selectedValue,
                      pipelineId: '',
                      instanceType: defaultInstanceType,
                      region: targetRegion
                    });
                  }
                }}
                options={amiOptions}
                placeholder="Select an image"
                filteringType="auto"
              />
            </FormField>

            {/* Show region selector if image is selected and either:
                1. Has multiple regions available, OR
                2. Is only available in a non-primary region (so user knows where it will be created) */}
            {newWorkstation.amiId && (() => {
              const ami = amiData.get(newWorkstation.amiId);
              
              // Base images (isAutoGenerated=true, no region) are available in ALL regions via SSM parameters
              const isBaseImage = ami?.isAutoGenerated && !ami?.region;
              
              // Get available regions for the selected image
              let availableRegions: Array<{ region: string; amiId: string }> = [];
              let availableHubs: any[] = [];
              
              if (isBaseImage) {
                // Base images are available in all regional hubs
                availableHubs = regionalHubs;
              } else if (newWorkstation.pipelineId) {
                // Pipeline images - only available in regions where distributed
                availableRegions = pipelineRegionMap.get(newWorkstation.pipelineId) || [];
                availableHubs = regionalHubs.filter(hub => 
                  availableRegions.some(r => r.region === hub.region)
                );
              } else if (ami) {
                // Standalone imported image - only available in its specific region
                availableRegions = [{ region: ami.region || 'us-east-1', amiId: ami.amiId }];
                availableHubs = regionalHubs.filter(hub => 
                  availableRegions.some(r => r.region === hub.region)
                );
              }
              
              // Determine if we should show the region selector:
              // - Multiple hubs available, OR
              // - Single hub that is NOT the primary region (so user sees where it will be created)
              const primaryHub = regionalHubs.find(h => h.isPrimary);
              const isSingleNonPrimaryRegion = availableHubs.length === 1 && !availableHubs[0]?.isPrimary;
              const shouldShowRegionSelector = availableHubs.length > 1 || isSingleNonPrimaryRegion;
              
              if (shouldShowRegionSelector && availableHubs.length > 0) {
                return (
                  <FormField 
                    label="Region" 
                    description={isBaseImage 
                      ? "Base images are available in all regions" 
                      : availableHubs.length === 1
                        ? `This image is only available in ${availableHubs[0]?.displayName || availableHubs[0]?.region}`
                        : "Select the region where the workstation will be created"
                    }
                  >
                    <Select
                      selectedOption={
                        newWorkstation.region 
                          ? availableHubs.find(h => h.region === newWorkstation.region)
                            ? { label: availableHubs.find(h => h.region === newWorkstation.region)?.displayName || newWorkstation.region, value: newWorkstation.region }
                            : null
                          : availableHubs.length === 1 && !availableHubs[0]?.isPrimary
                            // Single non-primary region - show it as selected
                            ? { label: availableHubs[0]?.displayName || availableHubs[0]?.region, value: availableHubs[0]?.region }
                            : { label: `${primaryHub?.displayName || 'Primary Region'} (Primary)`, value: '' }
                      }
                      onChange={({ detail }) => setNewWorkstation({ ...newWorkstation, region: detail.selectedOption?.value || '' })}
                      options={availableHubs.map(hub => ({
                        label: hub.isPrimary ? `${hub.displayName} (Primary)` : hub.displayName,
                        value: hub.isPrimary ? '' : hub.region,
                        description: hub.region
                      }))}
                      placeholder="Select a region"
                      disabled={availableHubs.length === 1}
                    />
                  </FormField>
                );
              }
              return null;
            })()}

            <FormField label="Instance Type" description={getSelectedPlatform() === 'macos' ? 'macOS requires Dedicated Host instances (24hr minimum allocation)' : undefined}>
              <Select
                selectedOption={
                  newWorkstation.instanceType 
                    ? { 
                        label: INSTANCE_TYPE_CATALOG[newWorkstation.instanceType]?.label || newWorkstation.instanceType, 
                        value: newWorkstation.instanceType 
                      }
                    : null
                }
                onChange={({ detail }) => setNewWorkstation({ ...newWorkstation, instanceType: detail.selectedOption.value || '' })}
                options={getInstanceTypeOptions()}
                placeholder="Select an instance type"
              />
            </FormField>

            <FormField label="Root Volume Size (GB)" constraintText="Minimum 30 GB, recommended 100+ GB for workstations">
              <Input
                type="number"
                value={newWorkstation.rootVolumeSize.toString()}
                onChange={({ detail }) => setNewWorkstation({ ...newWorkstation, rootVolumeSize: parseInt(detail.value) || 100 })}
                placeholder="100"
              />
            </FormField>

            <FormField 
              label="Number of Workstations" 
              description="Create multiple workstations at once"
              constraintText="1-50 workstations"
            >
              <Input
                type="number"
                value={newWorkstation.instanceCount.toString()}
                onChange={({ detail }) => {
                  const count = Math.max(1, Math.min(50, parseInt(detail.value) || 1));
                  setNewWorkstation({ 
                    ...newWorkstation, 
                    instanceCount: count,
                    // Reset user selections when count changes
                    assignedUserIds: newWorkstation.assignedUserIds.slice(0, count)
                  });
                }}
                placeholder="1"
              />
            </FormField>

            <FormField 
              label="Assignment Type" 
              description={newWorkstation.instanceCount > 1 
                ? "Choose how to assign users to the workstations" 
                : "Assign to a group, user, or leave unassigned"
              }
            >
              <Select
                selectedOption={
                  newWorkstation.assignmentType 
                    ? { 
                        label: newWorkstation.assignmentType === 'group' ? 'Assign to Group' 
                             : newWorkstation.assignmentType === 'user' ? 'Assign to User(s)' 
                             : 'Unassigned (Pool)',
                        value: newWorkstation.assignmentType 
                      }
                    : null
                }
                onChange={({ detail }) => {
                  setNewWorkstation({ 
                    ...newWorkstation, 
                    assignmentType: detail.selectedOption?.value || '',
                    assignedUserId: '',
                    assignedUserIds: []
                  });
                }}
                options={[
                  { label: 'Unassigned (Pool)', value: 'unassigned', description: 'Create workstations without assignment - assign later' },
                  { label: 'Assign to Group', value: 'group', description: 'All workstations accessible by group members' },
                  { label: 'Assign to User(s)', value: 'user', description: newWorkstation.instanceCount > 1 ? 'Select individual users for each workstation' : 'Assign to a specific user' }
                ]}
                placeholder="Select assignment type"
              />
            </FormField>

            {newWorkstation.assignmentType === 'group' && (
              <FormField label="Select Group" constraintText="All workstations will be assigned to this group">
                <Select
                  selectedOption={newWorkstation.assignedUserId ? 
                    (() => {
                      const group = groups.find(g => g.groupId === newWorkstation.assignedUserId);
                      if (group) {
                        return { label: group.groupName, value: group.groupId };
                      }
                      return null;
                    })()
                    : null
                  }
                  onChange={({ detail }) => {
                    setNewWorkstation({ 
                      ...newWorkstation, 
                      assignedUserId: detail.selectedOption?.value || ''
                    });
                  }}
                  options={groups
                    .sort((a, b) => a.groupName.localeCompare(b.groupName))
                    .map(group => ({
                      label: group.groupName,
                      value: group.groupId
                    }))
                  }
                  placeholder="Select a group"
                  filteringType="auto"
                />
              </FormField>
            )}

            {newWorkstation.assignmentType === 'user' && newWorkstation.instanceCount === 1 && (
              <FormField label="Select User" constraintText="Assign to a specific user">
                <Select
                  selectedOption={newWorkstation.assignedUserId ? 
                    (() => {
                      const user = users.find(u => u.userId === newWorkstation.assignedUserId);
                      if (user) {
                        return { label: `${user.firstName} ${user.lastName} (${user.userId})`, value: user.userId };
                      }
                      return null;
                    })()
                    : null
                  }
                  onChange={({ detail }) => {
                    setNewWorkstation({ 
                      ...newWorkstation, 
                      assignedUserId: detail.selectedOption?.value || ''
                    });
                  }}
                  options={users
                    .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`))
                    .map(user => ({
                      label: `${user.firstName} ${user.lastName} (${user.userId})`,
                      value: user.userId
                    }))
                  }
                  placeholder="Select a user"
                  filteringType="auto"
                />
              </FormField>
            )}

            {newWorkstation.assignmentType === 'user' && newWorkstation.instanceCount > 1 && (
              <FormField 
                label="Select Users" 
                constraintText={`Select up to ${newWorkstation.instanceCount} users (${newWorkstation.assignedUserIds.length} of ${newWorkstation.instanceCount} selected). Unselected slots will be unassigned.`}
                description="Each selected user will be assigned to one workstation"
              >
                <Multiselect
                  selectedOptions={newWorkstation.assignedUserIds.map(userId => {
                    const user = users.find(u => u.userId === userId);
                    return user 
                      ? { label: `${user.firstName} ${user.lastName} (${user.userId})`, value: user.userId }
                      : { label: userId, value: userId };
                  })}
                  onChange={({ detail }) => {
                    const selectedIds = detail.selectedOptions
                      .map(opt => opt.value)
                      .filter((v): v is string => v !== undefined)
                      .slice(0, newWorkstation.instanceCount);
                    setNewWorkstation({ 
                      ...newWorkstation, 
                      assignedUserIds: selectedIds
                    });
                  }}
                  options={users
                    .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`))
                    .map(user => ({
                      label: `${user.firstName} ${user.lastName} (${user.userId})`,
                      value: user.userId
                    }))
                  }
                  placeholder={`Select up to ${newWorkstation.instanceCount} users`}
                  filteringType="auto"
                  tokenLimit={5}
                  hideTokens={false}
                />
              </FormField>
            )}

            {newWorkstation.assignmentType === 'unassigned' && (
              <Alert type="info">
                {newWorkstation.instanceCount > 1 
                  ? `${newWorkstation.instanceCount} workstations will be created without user assignments. You can assign users later from the workstation list.`
                  : 'This workstation will be created without a user assignment. You can assign a user later from the workstation list.'
                }
              </Alert>
            )}

            <FormField 
              label="Join Active Directory Domain"
              description={config?.useCognitoAuth 
                ? "When using Cognito authentication, workstations don't need to join the AD domain. Auto-login will be configured instead."
                : "Join the workstation to the Active Directory domain for centralized user management."
              }
            >
              <Toggle
                checked={newWorkstation.joinDomain}
                onChange={({ detail }) => setNewWorkstation({ ...newWorkstation, joinDomain: detail.checked })}
              >
                {newWorkstation.joinDomain ? 'Domain-joined' : 'Standalone (auto-login enabled)'}
              </Toggle>
            </FormField>
          </SpaceBetween>
        </Form>
        )}
      </Modal>

      <Modal
        visible={showAssignModal}
        onDismiss={() => {
          setShowAssignModal(false);
          setAssignModalFilter('');
        }}
        header="Assign to Workstation"
        size="medium"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => {
              setShowAssignModal(false);
              setAssignModalFilter('');
            }}>
              Cancel
            </Button>
            <Button 
              variant="primary" 
              loading={assigningUser}
              onClick={handleAssignUser}
              disabled={!assignUserData.newUserId}
            >
              Assign
            </Button>
          </SpaceBetween>
        }
      >
        <SpaceBetween direction="vertical" size="m">
          <SpaceBetween direction="horizontal" size="m">
            <FormField label="Instance ID">
              <Box>{assignUserData.instanceId}</Box>
            </FormField>
            <FormField label="Currently Assigned To">
              <Box>{assignUserData.currentUserId || 'Unassigned'}</Box>
            </FormField>
          </SpaceBetween>

          <FormField label="Search">
            <Input
              value={assignModalFilter}
              onChange={({ detail }) => setAssignModalFilter(detail.value)}
              placeholder="Filter by name or email..."
              type="search"
            />
          </FormField>

          <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
            <Table
              columnDefinitions={[
                {
                  id: 'type',
                  header: 'Type',
                  cell: (item: any) => item.type === 'group' ? 'Group' : 'User',
                  width: 80,
                  sortingField: 'type'
                },
                {
                  id: 'name',
                  header: 'Name',
                  cell: (item: any) => item.name,
                  sortingField: 'name'
                },
                {
                  id: 'email',
                  header: 'Email',
                  cell: (item: any) => item.email || '-',
                  sortingField: 'email'
                }
              ]}
              items={filteredAssignees}
              selectionType="single"
              selectedItems={filteredAssignees.filter(a => a.id === assignUserData.newUserId)}
              onSelectionChange={({ detail }) => {
                const selected = detail.selectedItems[0];
                setAssignUserData({ ...assignUserData, newUserId: selected?.id || '' });
              }}
              sortingColumn={assignModalSorting.sortingColumn}
              sortingDescending={assignModalSorting.isDescending}
              onSortingChange={({ detail }) => {
                setAssignModalSorting({
                  sortingColumn: detail.sortingColumn,
                  isDescending: detail.isDescending || false
                });
              }}
              trackBy="id"
              empty={assignModalFilter ? "No matches found." : "No groups or users available."}
              variant="embedded"
              stickyHeader
            />
          </div>
        </SpaceBetween>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={showDeleteModal}
        onDismiss={() => {
          setShowDeleteModal(false);
          setWorkstationToDelete(null);
        }}
        header="Delete Workstation"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => {
              setShowDeleteModal(false);
              setWorkstationToDelete(null);
            }}>
              Cancel
            </Button>
            <Button 
              variant="primary"
              loading={workstationToDelete && deletingInstances.has(workstationToDelete.instanceId)}
              onClick={handleDeleteWorkstation}
            >
              Delete Workstation
            </Button>
          </SpaceBetween>
        }
      >
        <SpaceBetween direction="vertical" size="m">
          <Alert type="warning">
            <strong>Warning:</strong> This action will permanently delete the workstation and terminate the EC2 instance. This cannot be undone.
          </Alert>
          <Box>
            Are you sure you want to delete the following workstation?
          </Box>
          {workstationToDelete && (
            <Box>
              <strong>Instance ID:</strong> {workstationToDelete.instanceId}<br/>
              <strong>Instance Type:</strong> {workstationToDelete.instanceType}<br/>
              <strong>Assigned User:</strong> {workstationToDelete.assignedUserDisplay || 'Unassigned'}<br/>
              <strong>Instance Status:</strong> {workstationToDelete.instanceStatus}
            </Box>
          )}
        </SpaceBetween>
      </Modal>

      {/* Add Storage Modal */}
        <Modal
          visible={showAddStorageModal}
          size="large"
          onDismiss={() => {
            setShowAddStorageModal(false);
            setStorageAssignments([]);
            setDriveLetterError('');
            setStorageSuccessMessage('');
          }}
          header={`Add Storage - ${selectedItems.length} workstation(s) selected`}
          footer={
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => {
                setShowAddStorageModal(false);
                setStorageAssignments([]);
                setDriveLetterError('');
                setStorageSuccessMessage('');
              }}>
                Cancel
              </Button>
              <Button 
                variant="primary"
                onClick={handleAddStorage}
                loading={savingStorage}
                disabled={savingStorage}
              >
                Save Changes
              </Button>
            </SpaceBetween>
          }
        >
        <SpaceBetween direction="vertical" size="l">
          {driveLetterError && (
            <Alert type="error" dismissible onDismiss={() => setDriveLetterError('')}>
              {driveLetterError}
            </Alert>
          )}
          {(() => {
            const selectedRegions = new Set(selectedItems.map((w: any) => w.region || 'us-east-1'));
            if (selectedRegions.size > 1) {
              return (
                <Alert type="warning">
                  Selected workstations are in different regions. Storage can only be mounted to workstations in the same region.
                </Alert>
              );
            }
            return null;
          })()}
          <Box>
            Configure storage assignments for the selected workstation(s). Storage will be auto-mounted when the workstation starts.
            {selectedItems.length > 0 && (
              <Box variant="small" color="text-body-secondary" margin={{ top: 'xs' }}>
                <Icon name="status-info" /> Only storage in the same region ({selectedItems[0]?.region || 'us-east-1'}) is shown. FSx storage can only be mounted from instances in the same region.
              </Box>
            )}
          </Box>
          <Box>
            <Box variant="awsui-key-label" margin={{ bottom: 'xs' }}>Storage Assignments</Box>
            <Table
              columnDefinitions={[
                {
                  id: 'name',
                  header: 'Name',
                  cell: (item: any) => item.name,
                },
                {
                  id: 'type',
                  header: 'Type',
                  cell: (item: any) => {
                    if (item.type === 'fsx-windows') return 'FSx Windows';
                    if (item.type === 'fsx-ontap') return 'FSx ONTAP';
                    if (item.type === 'mountpoint-s3') return 'S3 Mount';
                    return item.type;
                  },
                },
                {
                  id: 'autoMount',
                  header: 'Auto',
                  cell: (item: any) => {
                    const assignment = storageAssignments.find((a: any) => a.storageId === item.storageId);
                    // Get the platform of the first selected workstation to determine mount type
                    const selectedPlatform = selectedItems[0]?.platform?.toLowerCase() || 'windows';
                    
                    return (
                      <Toggle
                        checked={assignment?.autoMount || false}
                        onChange={({ detail }) => {
                          const newAssignments = [...storageAssignments];
                          const existingIndex = newAssignments.findIndex((a: any) => a.storageId === item.storageId);
                          
                          if (existingIndex >= 0) {
                            newAssignments[existingIndex] = {
                              ...newAssignments[existingIndex],
                              autoMount: detail.checked
                            };
                          } else {
                            // Set defaults based on storage type and platform
                            if (item.type === 'mountpoint-s3') {
                              newAssignments.push({
                                storageId: item.storageId,
                                autoMount: detail.checked,
                                mountPath: item.mountPath || '/mnt/s3'
                              });
                            } else if (item.type === 'fsx-ontap') {
                              // FSxN: use mount path for Linux/macOS, drive letter for Windows
                              if (selectedPlatform === 'windows') {
                                newAssignments.push({
                                  storageId: item.storageId,
                                  autoMount: detail.checked,
                                  driveLetter: 'Z',
                                  junctionPath: item.junctionPath || '/vol1'
                                });
                              } else {
                                // Use /Volumes for macOS, /mnt for Linux
                                const defaultMountPath = selectedPlatform === 'macos'
                                  ? `/Volumes/fsxn-${item.storageId?.substring(0, 8) || 'vol'}`
                                  : `/mnt/fsxn-${item.storageId?.substring(0, 8) || 'vol'}`;
                                newAssignments.push({
                                  storageId: item.storageId,
                                  autoMount: detail.checked,
                                  mountPath: defaultMountPath,
                                  junctionPath: item.junctionPath || '/vol1'
                                });
                              }
                            } else {
                              newAssignments.push({
                                storageId: item.storageId,
                                autoMount: detail.checked,
                                driveLetter: 'Z'
                              });
                            }
                          }
                          setStorageAssignments(newAssignments);
                        }}
                      />
                    );
                  }
                },
                {
                  id: 'driveLetterOrMountPath',
                  header: 'Mount Point',
                  cell: (item: any) => {
                    const assignment = storageAssignments.find((a: any) => a.storageId === item.storageId);
                    // Get the platform of the first selected workstation
                    const selectedPlatform = selectedItems[0]?.platform?.toLowerCase() || 'windows';
                    
                    // For Mountpoint S3, show the mount path (read-only, configured at storage creation)
                    if (item.type === 'mountpoint-s3') {
                      return (
                        <Box color={assignment?.autoMount ? 'text-body-primary' : 'text-status-inactive'}>
                          {item.mountPath || '/mnt/s3'}
                        </Box>
                      );
                    }
                    
                    // For FSxN on Linux/macOS, show editable mount path
                    if (item.type === 'fsx-ontap' && (selectedPlatform === 'linux' || selectedPlatform === 'macos')) {
                      // Use /Volumes for macOS, /mnt for Linux
                      const defaultMountPath = selectedPlatform === 'macos'
                        ? `/Volumes/fsxn-${item.storageId?.substring(0, 8) || 'vol'}`
                        : `/mnt/fsxn-${item.storageId?.substring(0, 8) || 'vol'}`;
                      const placeholder = selectedPlatform === 'macos' ? '/Volumes/fsxn' : '/mnt/fsxn';
                      return (
                        <Input
                          value={assignment?.mountPath || defaultMountPath}
                          onChange={({ detail }) => {
                            const newAssignments = [...storageAssignments];
                            const existingIndex = newAssignments.findIndex((a: any) => a.storageId === item.storageId);
                            
                            if (existingIndex >= 0) {
                              newAssignments[existingIndex] = {
                                ...newAssignments[existingIndex],
                                mountPath: detail.value
                              };
                            } else {
                              newAssignments.push({
                                storageId: item.storageId,
                                autoMount: false,
                                mountPath: detail.value,
                                junctionPath: item.junctionPath || '/vol1'
                              });
                            }
                            setStorageAssignments(newAssignments);
                          }}
                          disabled={!assignment?.autoMount}
                          placeholder={placeholder}
                        />
                      );
                    }
                    
                    // For Windows storage (FSx Windows or FSxN on Windows), show drive letter selector
                    const displayLetter = assignment?.driveLetter ? `${assignment.driveLetter}:` : 'Z:';
                    
                    // Check for drive letter conflicts among enabled storage
                    const enabledAssignments = storageAssignments.filter((a: any) => a.autoMount);
                    const conflictingLetter = enabledAssignments.filter((a: any) => 
                      a.driveLetter === assignment?.driveLetter && a.autoMount && assignment?.autoMount
                    ).length > 1;
                    
                    return (
                      <Select
                        selectedOption={{ label: displayLetter, value: assignment?.driveLetter || 'Z' }}
                        onChange={({ detail }) => {
                          const newAssignments = [...storageAssignments];
                          const existingIndex = newAssignments.findIndex((a: any) => a.storageId === item.storageId);
                          
                          if (existingIndex >= 0) {
                            newAssignments[existingIndex] = {
                              ...newAssignments[existingIndex],
                              driveLetter: detail.selectedOption?.value || 'Z' // Store without colon
                            };
                          } else {
                            newAssignments.push({
                              storageId: item.storageId,
                              autoMount: false,
                              driveLetter: detail.selectedOption?.value || 'Z', // Store without colon
                              junctionPath: item.type === 'fsx-ontap' ? (item.junctionPath || '/vol1') : undefined
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
                          { label: 'U:', value: 'U' }
                        ]}
                        disabled={!assignment?.autoMount}
                        expandToViewport={true}
                        invalid={conflictingLetter}
                      />
                    );
                  }
                }
              ]}
              items={availableStorage}
              loading={loadingStorage}
              variant="embedded"
              resizableColumns={true}
              empty={
                <Box textAlign="center" color="inherit">
                  <SpaceBetween size="m">
                    <b>No compatible storage resources available</b>
                    <p>
                      {(() => {
                        const selectedPlatforms = new Set(selectedItems.map((w: any) => w.platform?.toLowerCase()));
                        const selectedRegion = selectedItems[0]?.region || 'us-east-1';
                        const hasMultipleRegions = new Set(selectedItems.map((w: any) => w.region || 'us-east-1')).size > 1;
                        
                        if (hasMultipleRegions) {
                          return 'Selected workstations are in different regions. Storage can only be mounted to workstations in the same region. Please select workstations from a single region.';
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
                    </p>
                  </SpaceBetween>
                </Box>
              }
            />
          </Box>
        </SpaceBetween>
      </Modal>

      {/* DCV Client Install Prompt Modal */}
      <Modal
        visible={showDcvInstallModal}
        onDismiss={() => {
          setShowDcvInstallModal(false);
          setPendingDcvUrl('');
        }}
        header="DCV Client Not Detected"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => {
              setShowDcvInstallModal(false);
              setPendingDcvUrl('');
            }}>
              Cancel
            </Button>
            <Button 
              variant="normal"
              onClick={() => {
                // Try to launch again (user may have just installed)
                if (pendingDcvUrl) {
                  window.location.href = pendingDcvUrl;
                }
                setShowDcvInstallModal(false);
                setPendingDcvUrl('');
              }}
            >
              Try Again
            </Button>
            <Button 
              variant="primary" 
              iconName="external"
              onClick={() => {
                window.open('https://download.nice-dcv.com/', '_blank');
              }}
            >
              Download DCV Client
            </Button>
          </SpaceBetween>
        }
      >
        <SpaceBetween size="m">
          <Alert type="info">
            The NICE DCV Client doesn't appear to be installed on your computer.
          </Alert>
          <Box>
            To connect to your workstation, you need to install the NICE DCV Client:
          </Box>
          <ol style={{ margin: '0', paddingLeft: '20px' }}>
            <li>Click "Download DCV Client" to visit the download page</li>
            <li>Download and install the client for your operating system</li>
            <li>Once installed, click "Try Again" or reconnect from the workstation list</li>
          </ol>
          <Box color="text-body-secondary" fontSize="body-s">
            The DCV Client provides better performance and features compared to browser-based connections.
          </Box>
        </SpaceBetween>
      </Modal>

      {/* Workstation Start Progress Modal */}
      <WorkstationStartModal
        visible={showStartModal}
        instanceId={startingInstanceId}
        onDismiss={() => {
          setShowStartModal(false);
          setStartingInstanceId('');
        }}
        onComplete={() => {
          setShowStartModal(false);
          setStartingInstanceId('');
          fetchData(); // Refresh the data when complete
        }}
        authToken={getAuthToken() || ''}
      />
    </>
  );
};

export default WorkstationManagement;
