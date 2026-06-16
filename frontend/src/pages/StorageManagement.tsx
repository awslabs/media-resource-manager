// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import {
  AppLayout,
  ContentLayout,
  Header,
  SpaceBetween,
  Button,
  Table,
  Box,
  Modal,
  FormField,
  Input,
  Select,
  Textarea,
  Alert,
  Badge,
  TextFilter,
  CollectionPreferences,
  Pagination,
  BreadcrumbGroup,
  Grid,
  Link,
  Checkbox,
  ExpandableSection
} from '@cloudscape-design/components';
import Navigation from '../components/Navigation';
import DataTransferSection from '../components/DataTransferSection';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';

interface StorageResource {
  storageId: string;
  name: string;
  type: string;
  status: string;
  region?: string;
  configuration?: any;
  createdAt?: string;
  cloudFormationStackName?: string;
  resourceArn?: string;
  fsxFileSystemId?: string;
  storageGatewayId?: string;
}

interface RegionalHub {
  region: string;
  status: string;
  vpcId?: string;
}

interface StorageManagementProps {
  user: any;
  isAdmin: boolean;
  config?: any;
}

const StorageManagement: React.FC<StorageManagementProps> = ({ user, isAdmin, config }) => {
  console.log('StorageManagement: Component rendering');
  const [storageResources, setStorageResources] = useState<StorageResource[]>([]);
  const [regionalHubs, setRegionalHubs] = useState<RegionalHub[]>([]);
  const [primaryRegion, setPrimaryRegion] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [selectedItems, setSelectedItems] = useState<StorageResource[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingResource, setEditingResource] = useState<StorageResource | null>(null);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [filteringText, setFilteringText] = useState('');
  const [typeFilter, setTypeFilter] = useState<any>(null);
  const [regionFilter, setRegionFilter] = useState<any>(null);
  const [sortingColumn, setSortingColumn] = useState<any>({});
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  // Load preferences from localStorage or use defaults
  const getInitialPreferences = () => {
    try {
      const saved = localStorage.getItem('storage-table-preferences');
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
        { id: 'resourceId', visible: true },
        { id: 'storageId', visible: false },
        { id: 'name', visible: true },
        { id: 'type', visible: true },
        { id: 'region', visible: true },
        { id: 'description', visible: false },
        { id: 'status', visible: true },
        { id: 'storageCapacity', visible: true },
        { id: 'throughput', visible: true },
        { id: 'backupRetention', visible: false },
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
      localStorage.setItem('storage-table-preferences', JSON.stringify(newPreferences));
    } catch (error) {
      console.warn('Failed to save preferences to localStorage:', error);
    }
  };

  const visibleColumns = React.useMemo(() => {
    const allColumns = [
      {
        id: 'resourceId',
        header: 'Resource ID',
        cell: (item: StorageResource) => (
          <Link 
            variant="primary"
            onFollow={(event) => {
              event.preventDefault();
              window.location.href = `/storage/${item.storageId}`;
            }}
          >
            {item.type === 'fsx-windows' ? item.fsxFileSystemId : item.storageGatewayId || item.fsxFileSystemId}
          </Link>
        ),
        sortingField: 'fsxFileSystemId', // Could be dynamic based on type
        isRowHeader: true,
      },
      {
        id: 'storageId',
        header: 'Storage ID',
        cell: (item: StorageResource) => item.storageId,
        sortingField: 'storageId'
      },
      {
        id: 'name',
        header: 'Name',
        cell: (item: StorageResource) => item.name,
        sortingField: 'name'
      },
      {
        id: 'type',
        header: 'Type',
        cell: (item: StorageResource) => (
          <Badge color={
            item.type === 'fsx-windows' ? 'blue' : 
            item.type === 'mountpoint-s3' ? 'green' :
            item.type === 'fsx-ontap' ? 'grey' : 'grey'
          }>
            {item.type === 'fsx-windows' ? 'FSx for Windows' : 
             item.type === 'mountpoint-s3' ? 'Mountpoint for S3' :
             item.type === 'fsx-ontap' ? 'FSx for ONTAP' : item.type}
          </Badge>
        ),
        sortingField: 'type'
      },
      {
        id: 'region',
        header: 'Region',
        cell: (item: StorageResource) => item.region || primaryRegion || '-',
        sortingField: 'region'
      },
      {
        id: 'description',
        header: 'Description',
        cell: (item: StorageResource) => item.description || '-',
        sortingField: 'description'
      },
      {
        id: 'status',
        header: 'Status',
        cell: (item: StorageResource) => (
          <Badge color={
            item.status === 'available' ? 'green' : 
            item.status === 'creating' ? 'blue' : 
            item.status === 'deleting' ? 'grey' : 'red'
          }>
            {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
          </Badge>
        ),
        sortingField: 'status'
      },
      {
        id: 'storageCapacity',
        header: 'Storage (GiB)',
        cell: (item: StorageResource) => item.storageCapacity || '-',
        sortingField: 'storageCapacity'
      },
      {
        id: 'throughput',
        header: 'Throughput (MB/s)',
        cell: (item: StorageResource) => item.throughput || '-',
        sortingField: 'throughput'
      },
      {
        id: 'backupRetention',
        header: 'Backup Retention (days)',
        cell: (item: StorageResource) => item.backupRetention || '-',
        sortingField: 'backupRetention'
      },
      {
        id: 'createdAt',
        header: 'Created',
        cell: (item: StorageResource) => item.createdAt ? new Date(item.createdAt).toLocaleString() : '-',
        sortingField: 'createdAt'
      }
    ];

    return preferences.contentDisplay
      .filter(item => item.visible)
      .map(item => allColumns.find(col => col.id === item.id))
      .filter(Boolean);
  }, [preferences.contentDisplay]);

  console.log('StorageManagement: Current state - storageResources:', storageResources, 'loading:', loading);

  const [formData, setFormData] = useState({
    name: '',
    type: 'fsx-ontap',
    description: '',
    region: '', // Empty means primary region
    configuration: {
      // FSx Windows configuration
      automaticBackupRetentionPeriod: 7,
      throughputCapacity: 64,
      ssdStorageCapacity: 256,
      // Storage Gateway configuration
      cacheVolumeSizeGB: 150,
      deploymentSubnetType: 'private',
      // Mountpoint for S3 configuration
      bucketName: '',
      prefix: '',
      mountPath: '/mnt/s3',
      accessMode: 'read-only',
      allowDelete: false,
      allowOther: true,
      uid: '',
      gid: '',
      cachePath: '',
      // FSx ONTAP configuration
      teamSize: 'medium',
      storageCapacity: 2048, // Minimum for 2 HA pairs (medium)
      backupRetention: 30,
      deploymentType: 'SINGLE_AZ_2',
      haPairs: 2,
      throughputCapacityPerHaPair: 3072,
      volumeSize: 1600, // Minimum for 2 HA pairs: 100 GiB * 8 constituents * 2 HA pairs
      securityStyle: 'MIXED',
      tieringPolicy: 'AUTO'
    }
  });

  const platformOptions = [
    { label: 'Windows', value: 'windows' },
    { label: 'Linux', value: 'linux' },
    { label: 'macOS', value: 'macos' }
  ];

  // Filter options for Select dropdowns
  const typeFilterOptions = [
    { label: 'All Types', value: '' },
    { label: 'FSx for Windows', value: 'fsx-windows' },
    { label: 'FSx for ONTAP', value: 'fsx-ontap' },
    { label: 'Mountpoint for S3', value: 'mountpoint-s3' }
  ];

  // Build region filter options dynamically from available regions
  const regionFilterOptions = React.useMemo(() => {
    const regions = new Set<string>();
    storageResources.forEach(resource => {
      if (resource.region) {
        regions.add(resource.region);
      }
    });
    // Also add regions from regional hubs
    regionalHubs.forEach(hub => {
      if (hub.region) {
        regions.add(hub.region);
      }
    });
    
    const options = [{ label: 'All Regions', value: '' }];
    Array.from(regions).sort().forEach(region => {
      options.push({ label: region, value: region });
    });
    return options;
  }, [storageResources, regionalHubs]);

  console.log('StorageManagement: Filter options ready');

  useEffect(() => {
    fetchData();
  }, []);

  // Update form data when editing resource changes
  useEffect(() => {
    if (editingResource) {
      setFormData({
        name: editingResource.name,
        type: editingResource.type,
        description: editingResource.description || '',
        configuration: editingResource.configuration || {
          automaticBackupRetentionPeriod: 30,
          throughputCapacity: 64,
          ssdStorageCapacity: 256
        }
      });
    }
  }, [editingResource]);

  const fetchStorageResources = async () => {
    const token = getAuthToken();
    if (!token) throw new Error('No current user');
    return apiCall('storage', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  };

  const fetchRegionalHubs = async () => {
    const token = getAuthToken();
    if (!token) throw new Error('No current user');
    return apiCall('regions', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  };

  const fetchData = async () => {
    try {
      console.log('StorageManagement: Starting fetchData');
      setLoading(true);
      
      // Fetch storage resources and regional hubs in parallel
      const [storageResponse, hubsResponse] = await Promise.all([
        fetchStorageResources(),
        fetchRegionalHubs().catch(err => {
          console.warn('Failed to fetch regional hubs:', err);
          return null;
        })
      ]);
      
      console.log('StorageManagement: Got storage response:', storageResponse);
      
      if (!storageResponse.ok) {
        throw new Error(`HTTP ${storageResponse.status}: ${storageResponse.statusText}`);
      }
      
      const data = await storageResponse.json();
      console.log('StorageManagement: Parsed data:', data);
      console.log('StorageManagement: Is data an array?', Array.isArray(data));
      
      // Handle both formats: direct array or {success: true, data: []}
      const safeData = Array.isArray(data) ? data : (data.data && Array.isArray(data.data) ? data.data : []);
      console.log('StorageManagement: Setting storage resources to:', safeData);
      setStorageResources(safeData);
      
      // Process regional hubs response
      if (hubsResponse && hubsResponse.ok) {
        const hubsData = await hubsResponse.json();
        console.log('StorageManagement: Regional hubs data:', hubsData);
        const hubs = Array.isArray(hubsData) ? hubsData : (hubsData.data || []);
        // Filter to only available hubs (excluding primary which is always available)
        const availableHubs = hubs.filter((hub: RegionalHub) => hub.status === 'available' && !hub.isPrimary);
        setRegionalHubs(availableHubs);
        
        // Set primary region from the primary hub or config
        const primaryHub = hubs.find((hub: any) => hub.isPrimary);
        if (primaryHub) {
          setPrimaryRegion(primaryHub.region);
        } else if (config?.region) {
          setPrimaryRegion(config.region);
        } else if (safeData.length > 0 && safeData[0].region) {
          setPrimaryRegion(safeData[0].region);
        }
      }
    } catch (error) {
      console.error('StorageManagement: Error fetching storage resources:', error);
      setAlert({ type: 'error', message: `Failed to fetch storage resources: ${error.message}` });
      console.log('StorageManagement: Setting storage resources to empty array due to error');
      setStorageResources([]);
    } finally {
      setLoading(false);
      console.log('StorageManagement: fetchData completed');
    }
  };

  const handleCreateStorage = async () => {
    setCreating(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');
      
      // Build request body, only include region if it's set (non-primary)
      const requestBody: any = { ...formData };
      if (!requestBody.region) {
        delete requestBody.region; // Don't send empty region, let backend default to primary
      }
      
      const response = await apiCall('storage', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error: ${response.status} - ${errorText}`);
      }
      
      const timeEstimate = formData.type === 'fsx-windows' ? '30-45 minutes' : 
                          formData.type === 'storage-gateway' ? '10-15 minutes' : '30-45 minutes';
      const resourceType = formData.type === 'fsx-windows' ? 'FSx Windows file system' :
                          formData.type === 'storage-gateway' ? 'Storage Gateway file gateway' : 'storage resource';
      const regionInfo = formData.region ? ` in ${formData.region}` : '';
      
      setAlert({ 
        type: 'info', 
        message: `${resourceType} creation started${regionInfo}. This process typically takes ${timeEstimate} to complete.` 
      });
      setShowCreateModal(false);
      setFormData({ 
        name: '', 
        type: 'fsx-windows', 
        description: '',
        region: '',
        configuration: { 
          // FSx Windows defaults
          automaticBackupRetentionPeriod: 30, 
          throughputCapacity: 64, 
          ssdStorageCapacity: 256,
          // Storage Gateway defaults
          cacheVolumeSizeGB: 150,
          deploymentSubnetType: 'private'
        } 
      });
      fetchData();
    } catch (error) {
      console.error('Error creating storage resource:', error);
      setAlert({ type: 'error', message: `Failed to create storage resource: ${error.message}` });
    } finally {
      setCreating(false);
    }
  };

  const handleUpdateStorage = async () => {
    if (!editingResource) return;
    
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');
      
      await apiCall(`storage/${editingResource.storageId}`, {
        method: 'PUT',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: formData.name,
          description: formData.description
        })
      });
      setAlert({ type: 'success', message: 'Storage resource updated successfully' });
      setShowEditModal(false);
      setEditingResource(null);
      fetchData();
    } catch (error) {
      console.error('Error updating storage resource:', error);
      setAlert({ type: 'error', message: 'Failed to update storage resource' });
    }
  };

  const handleDeleteStorage = async () => {
    if (selectedItems.length === 0) return;
    
    setDeleting(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');
      
      await Promise.all(selectedItems.map(resource => 
        apiCall(`storage/${resource.storageId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        })
      ));
      
      setAlert({ 
        type: 'info', 
        message: `Deletion started for ${selectedItems.length} storage resource(s). FSx file system deletion typically takes 5-10 minutes to complete.` 
      });
      setSelectedItems([]);
      setShowDeleteModal(false);
      fetchData();
    } catch (error) {
      console.error('Error deleting storage resources:', error);
      setAlert({ type: 'error', message: 'Failed to delete storage resources' });
    } finally {
      setDeleting(false);
    }
  };

  const handleEditClick = () => {
    if (selectedItems.length !== 1) return;
    const resource = selectedItems[0];
    
    // Check if it's a system-managed resource
    if (resource.status === 'creating' || resource.status === 'deleting') {
      setAlert({
        type: 'error',
        message: 'Cannot edit storage resource while it is being created or deleted.'
      });
      return;
    }
    
    setEditingResource(resource);
    setFormData({
      name: resource.name,
      type: resource.type,
      configuration: resource.configuration || {
        automaticBackupRetentionPeriod: 30,
        throughputCapacity: 64,
        ssdStorageCapacity: 256
      }
    });
    setShowEditModal(true);
  };

  const filteredStorageResources = React.useMemo(() => {
    console.log('StorageManagement: filteredStorageResources useMemo called');
    console.log('StorageManagement: storageResources state:', storageResources);
    
    if (!Array.isArray(storageResources)) {
      console.log('StorageManagement: storageResources is not an array, returning empty array');
      return [];
    }
    
    let filtered = [...storageResources];
    console.log('StorageManagement: Starting with filtered:', filtered);

    // Apply text filter (searches name, storageId, resourceId)
    if (filteringText) {
      const searchText = filteringText.toLowerCase();
      filtered = filtered.filter(resource => 
        resource.name?.toLowerCase().includes(searchText) ||
        resource.storageId?.toLowerCase().includes(searchText) ||
        resource.fsxFileSystemId?.toLowerCase().includes(searchText) ||
        resource.storageGatewayId?.toLowerCase().includes(searchText)
      );
    }

    // Apply type filter
    if (typeFilter?.value) {
      filtered = filtered.filter(resource => resource.type === typeFilter.value);
    }

    // Apply region filter
    if (regionFilter?.value) {
      filtered = filtered.filter(resource => resource.region === regionFilter.value);
    }

    // Apply sorting
    if (sortingColumn.sortingField) {
      console.log('StorageManagement: Applying sorting:', sortingColumn);
      filtered = [...filtered].sort((a, b) => {
        const aValue = a[sortingColumn.sortingField as keyof StorageResource] || '';
        const bValue = b[sortingColumn.sortingField as keyof StorageResource] || '';
        if (aValue < bValue) return sortingColumn.sortingDescending ? 1 : -1;
        if (aValue > bValue) return sortingColumn.sortingDescending ? -1 : 1;
        return 0;
      });
    }

    console.log('StorageManagement: Final filtered result:', filtered);
    return filtered;
  }, [storageResources, filteringText, typeFilter, regionFilter, sortingColumn]);

  // Calculate paginated storage resources
  const paginatedStorageResources = React.useMemo(() => {
    const pageSize = preferences.pageSize || 10;
    const startIndex = (currentPageIndex - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return filteredStorageResources.slice(startIndex, endIndex);
  }, [filteredStorageResources, currentPageIndex, preferences.pageSize]);

  const totalPages = Math.ceil(filteredStorageResources.length / (preferences.pageSize || 10));

  // Reset page index when filters change
  useEffect(() => {
    setCurrentPageIndex(1);
  }, [filteringText, typeFilter, regionFilter]);

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
                  { text: 'Storage' }
                ]}
                ariaLabel="Breadcrumbs"
              />
            }
          header={
            <Box padding={{ vertical: "l" }}>
              <div style={{ maxWidth: '1200px' }}>
              <Grid
                gridDefinition={[
                  { colspan: { default: 12, xs: 8, s: 9 } },
                  { colspan: { default: 12, xs: 4, s: 3 } }
                ]}
              >
                <div>
                  <Box variant="h1" fontSize="display-l">
                    Storage Management
                  </Box>
                  <Box
                    variant="p"
                    color="text-body-secondary"
                    margin={{ top: "xxs", bottom: "s" }}
                  >
                    Manage storage resources for your workstations and applications.
                  </Box>
                </div>
              </Grid>
              </div>
            </Box>
          }
        >
          <SpaceBetween size="l">
            {alert && (
              <Alert
                type={alert.type}
                dismissible
                onDismiss={() => setAlert(null)}
              >
                {alert.message}
              </Alert>
            )}

            <Table
              header={
                <Header
                  counter={
                    selectedItems.length
                      ? `(${selectedItems.length}/${filteredStorageResources.length})`
                      : `(${filteredStorageResources.length})`
                  }
                  actions={
                    <SpaceBetween direction="horizontal" size="xs">
                      <Button
                        iconName="refresh"
                        onClick={fetchData}
                        loading={loading}
                      />
                      <Button 
                        onClick={handleEditClick}
                        disabled={selectedItems.length !== 1}
                      >
                        Edit
                      </Button>
                      <Button 
                        onClick={() => {
                          // Check if any selected items are auto-generated
                          const autoGeneratedItems = selectedItems.filter(item => item.isAutoGenerated);
                          if (autoGeneratedItems.length > 0) {
                            setAlert({
                              type: 'error',
                              message: `Cannot delete system-managed storage resources. These resources are currently being processed.`
                            });
                            return;
                          }
                          setShowDeleteModal(true);
                        }}
                        disabled={selectedItems.length === 0}
                      >
                        Delete
                      </Button>
                      <Button 
                        variant="primary"
                        onClick={() => setShowCreateModal(true)}
                      >
                        Create Storage
                      </Button>
                    </SpaceBetween>
                  }
                >
                  Storage Resources
                </Header>
              }
              columnDefinitions={visibleColumns}
              items={paginatedStorageResources}
              loading={loading}
              loadingText="Loading storage resources..."
              selectedItems={selectedItems}
              onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
              selectionType="multi"
              trackBy="storageId"
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
                      { value: 10, label: "10 resources" },
                      { value: 20, label: "20 resources" },
                      { value: 50, label: "50 resources" }
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
                        id: "resourceId",
                        label: "Resource ID",
                        alwaysVisible: true
                      },
                      {
                        id: "storageId",
                        label: "Storage ID"
                      },
                      { id: "name", label: "Name" },
                      { id: "type", label: "Type" },
                      { id: "region", label: "Region" },
                      { id: "description", label: "Description" },
                      { id: "status", label: "Status" },
                      { id: "storageCapacity", label: "Storage (GiB)" },
                      { id: "throughput", label: "Throughput (MB/s)" },
                      { id: "backupRetention", label: "Backup Retention (days)" },
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
              empty={
                <Box textAlign="center" color="inherit">
                  <b>No storage resources</b>
                  <Box padding={{ bottom: 's' }} variant="p" color="inherit">
                    No storage resources to display.
                  </Box>
                  <Button 
                    variant="primary"
                    onClick={() => setShowCreateModal(true)}
                  >
                    Create Storage
                  </Button>
                </Box>
              }
              filter={
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px' }}>
                  <div style={{ width: '300px' }}>
                    <TextFilter
                      filteringText={filteringText}
                      filteringPlaceholder="Search by name or ID"
                      filteringAriaLabel="Filter storage resources"
                      onChange={({ detail }) => setFilteringText(detail.filteringText)}
                    />
                  </div>
                  <Select
                    selectedOption={typeFilter}
                    onChange={({ detail }) => setTypeFilter(detail.selectedOption?.value ? detail.selectedOption : null)}
                    options={typeFilterOptions}
                    placeholder="Any Type"
                    selectedAriaLabel="Selected type"
                    inlineLabelText="Type"
                  />
                  <Select
                    selectedOption={regionFilter}
                    onChange={({ detail }) => setRegionFilter(detail.selectedOption?.value ? detail.selectedOption : null)}
                    options={regionFilterOptions}
                    placeholder="Any Region"
                    selectedAriaLabel="Selected region"
                    inlineLabelText="Region"
                  />
                  {(filteringText || typeFilter?.value || regionFilter?.value) && (
                    <span style={{ 
                      whiteSpace: 'nowrap', 
                      fontSize: '14px',
                      lineHeight: '32px'
                    }}>
                      {filteredStorageResources.length} {filteredStorageResources.length === 1 ? 'match' : 'matches'}
                    </span>
                  )}
                </div>
              }
              sortingColumn={sortingColumn}
              sortingDescending={sortingColumn.sortingDescending}
              onSortingChange={({ detail }) => {
                setSortingColumn({
                  sortingField: detail.sortingColumn.sortingField,
                  sortingDescending: detail.isDescending || false
                });
              }}
            />

            {/* Data Transfer Section */}
            {isAdmin && (
              <DataTransferSection
                isAdmin={isAdmin}
                storageResources={storageResources}
              />
            )}

            {/* Create Modal */}
            <Modal
              visible={showCreateModal}
              onDismiss={() => setShowCreateModal(false)}
              header="Create New Storage Resource"
              footer={
                <Box float="right">
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button variant="link" onClick={() => setShowCreateModal(false)}>
                      Cancel
                    </Button>
                    <Button 
                      variant="primary" 
                      onClick={handleCreateStorage}
                      disabled={!formData.name || !formData.type}
                      loading={creating}
                    >
                      Create
                    </Button>
                  </SpaceBetween>
                </Box>
              }
            >
              <SpaceBetween size="m">
                <FormField label="Name" description="Enter a name for the storage resource">
                  <Input
                    value={formData.name}
                    onChange={({ detail }) => setFormData({ ...formData, name: detail.value })}
                    placeholder="Enter storage resource name"
                  />
                </FormField>
                <FormField label="Type">
                  <Select
                    selectedOption={
                      formData.type === 'fsx-ontap'
                        ? { label: 'FSx for NetApp ONTAP', value: 'fsx-ontap' }
                        : formData.type === 'fsx-windows' 
                        ? { label: 'FSx for Windows File System', value: 'fsx-windows' }
                        : formData.type === 'mountpoint-s3'
                        ? { label: 'Mountpoint for Amazon S3', value: 'mountpoint-s3' }
                        : { label: 'Storage Gateway File Gateway', value: 'storage-gateway' }
                    }
                    onChange={({ detail }) => setFormData({ ...formData, type: detail.selectedOption?.value || 'fsx-ontap' })}
                    options={[
                      { label: 'FSx for NetApp ONTAP', value: 'fsx-ontap', description: 'Multi-protocol storage for Windows, Mac, and Linux' },
                      { label: 'FSx for Windows File System', value: 'fsx-windows', description: 'Windows-only file system with AD integration' },
                      { label: 'Mountpoint for Amazon S3', value: 'mountpoint-s3', description: 'Mount S3 buckets on Linux workstations' },
                      { label: 'Storage Gateway File Gateway (Coming Soon)', value: 'storage-gateway', disabled: true }
                    ]}
                    placeholder="Select storage type"
                  />
                </FormField>
                {/* FSx Windows Configuration Fields */}
                {formData.type === 'fsx-windows' && (
                  <>
                    <FormField 
                      label="Automatic Backup Retention Period (days)" 
                      description="Choose the number of days that Amazon FSx should retain automatic backups for this file system."
                    >
                      <Input
                        type="number"
                        value={formData.configuration?.automaticBackupRetentionPeriod?.toString() || '30'}
                        onChange={({ detail }) => setFormData({ 
                          ...formData, 
                          configuration: { 
                            ...formData.configuration, 
                            automaticBackupRetentionPeriod: parseInt(detail.value) || 30 
                          } 
                        })}
                        placeholder="30"
                      />
                    </FormField>
                    <FormField 
                      label="Throughput Capacity (MB/s)" 
                      description="The sustained speed for your file system."
                    >
                      <Select
                        selectedOption={{ 
                          label: `${formData.configuration?.throughputCapacity || 64} MB/s`, 
                          value: (formData.configuration?.throughputCapacity || 64).toString() 
                        }}
                        onChange={({ detail }) => setFormData({ 
                          ...formData, 
                          configuration: { 
                            ...formData.configuration, 
                            throughputCapacity: parseInt(detail.selectedOption?.value || '64') 
                          } 
                        })}
                        options={[
                          { label: '32 MB/s', value: '32' },
                          { label: '64 MB/s', value: '64' },
                          { label: '128 MB/s', value: '128' },
                          { label: '256 MB/s', value: '256' },
                          { label: '512 MB/s', value: '512' },
                          { label: '1024 MB/s (1 GB/s)', value: '1024' },
                          { label: '2048 MB/s (2 GB/s)', value: '2048' },
                        ]}
                      />
                    </FormField>
                    <FormField 
                      label="SSD Storage Capacity (GiB)" 
                      description="Minimum 32 GiB; maximum 65,536 GiB"
                    >
                      <Input
                        type="number"
                        value={formData.configuration?.ssdStorageCapacity?.toString() || '256'}
                        onChange={({ detail }) => setFormData({ 
                          ...formData, 
                          configuration: { 
                            ...formData.configuration, 
                            ssdStorageCapacity: parseInt(detail.value) || 256 
                          } 
                        })}
                        placeholder="256"
                      />
                    </FormField>
                  </>
                )}

                {/* FSx for NetApp ONTAP Configuration Fields */}
                {formData.type === 'fsx-ontap' && (
                  <>
                    <Alert type="info">
                      FSx for NetApp ONTAP provides multi-protocol storage (NFS + SMB) for mixed Windows, Mac, and Linux environments. 
                      Ideal for video editing workflows requiring high throughput and shared access.
                    </Alert>
                    
                    {/* Region selector - only show if there are regional hubs */}
                    {regionalHubs.length > 0 && (
                      <FormField 
                        label="Region" 
                        description="Select the region where the storage will be created. Storage can only be mounted by workstations in the same region."
                      >
                        <Select
                          selectedOption={
                            formData.region 
                              ? { label: formData.region, value: formData.region }
                              : { label: `${primaryRegion || 'Primary Region'} (Primary)`, value: '' }
                          }
                          onChange={({ detail }) => setFormData({ 
                            ...formData, 
                            region: detail.selectedOption?.value || '' 
                          })}
                          options={[
                            { label: `${primaryRegion || 'Primary Region'} (Primary)`, value: '' },
                            ...regionalHubs.map(hub => ({
                              label: hub.region,
                              value: hub.region
                            }))
                          ]}
                          placeholder="Select region"
                        />
                      </FormField>
                    )}
                    
                    <FormField 
                      label="Team Size" 
                      description="Select a preset based on your team size. This configures throughput capacity automatically."
                    >
                      <Select
                        selectedOption={
                          formData.configuration?.teamSize === 'small' ? { label: 'Small (1-5 users) - 3 GB/s', value: 'small' } :
                          formData.configuration?.teamSize === 'medium' ? { label: 'Medium (5-15 users) - 6 GB/s', value: 'medium' } :
                          formData.configuration?.teamSize === 'large' ? { label: 'Large (15-30 users) - 18 GB/s', value: 'large' } :
                          formData.configuration?.teamSize === 'enterprise' ? { label: 'Enterprise (30+ users) - 36 GB/s', value: 'enterprise' } :
                          formData.configuration?.teamSize === 'custom' ? { label: 'Custom Configuration', value: 'custom' } :
                          { label: 'Medium (5-15 users) - 6 GB/s', value: 'medium' }
                        }
                        onChange={({ detail }) => {
                          const teamSize = detail.selectedOption?.value || 'medium';
                          // Map team size to HA pairs for UI display
                          const haPairsMap: Record<string, number> = {
                            'small': 1,
                            'medium': 2,
                            'large': 6,
                            'enterprise': 6,
                            'custom': formData.configuration?.haPairs || 1
                          };
                          const newHaPairs = haPairsMap[teamSize] || 1;
                          const minCapacity = 1024 * newHaPairs;
                          // FlexGroup volumes require minimum 100 GiB per constituent, 8 constituents per HA pair
                          const minVolumeSize = 100 * 8 * newHaPairs;
                          // For preset team sizes, set storage to minimum for that tier
                          // For custom, preserve current value but enforce minimum
                          const newStorageCapacity = teamSize === 'custom' 
                            ? Math.max(minCapacity, formData.configuration?.storageCapacity || minCapacity)
                            : minCapacity;
                          const newVolumeSize = teamSize === 'custom'
                            ? Math.max(minVolumeSize, formData.configuration?.volumeSize || minVolumeSize)
                            : minVolumeSize;
                          setFormData({ 
                            ...formData, 
                            configuration: { 
                              ...formData.configuration, 
                              teamSize,
                              haPairs: newHaPairs,
                              storageCapacity: newStorageCapacity,
                              volumeSize: newVolumeSize
                            } 
                          });
                        }}
                        options={[
                          { label: 'Small (1-5 users) - 3 GB/s', value: 'small', description: '1 HA pair @ 3072 MBps' },
                          { label: 'Medium (5-15 users) - 6 GB/s', value: 'medium', description: '2 HA pairs @ 3072 MBps' },
                          { label: 'Large (15-30 users) - 18 GB/s', value: 'large', description: '6 HA pairs @ 3072 MBps' },
                          { label: 'Enterprise (30+ users) - 36 GB/s', value: 'enterprise', description: '6 HA pairs @ 6144 MBps' },
                          { label: 'Custom Configuration', value: 'custom', description: 'Manually configure HA pairs and throughput' }
                        ]}
                        placeholder="Select team size"
                      />
                    </FormField>
                    <FormField 
                      label="SSD Storage Capacity (GiB)" 
                      description={`Total SSD storage pool capacity. Minimum ${1024 * (formData.configuration?.haPairs || 1)} GiB (1,024 GiB × ${formData.configuration?.haPairs || 1} HA pairs).`}
                      constraintText="This is the raw storage capacity. Actual usable space depends on storage efficiency settings."
                    >
                      <Input
                        type="number"
                        value={formData.configuration?.storageCapacity?.toString() || (1024 * (formData.configuration?.haPairs || 1)).toString()}
                        onChange={({ detail }) => {
                          const minCapacity = 1024 * (formData.configuration?.haPairs || 1);
                          const value = parseInt(detail.value) || minCapacity;
                          setFormData({ 
                            ...formData, 
                            configuration: { 
                              ...formData.configuration, 
                              storageCapacity: Math.max(minCapacity, value)
                            } 
                          });
                        }}
                        placeholder={(1024 * (formData.configuration?.haPairs || 1)).toString()}
                      />
                    </FormField>
                    <FormField 
                      label="Backup Retention (days)" 
                      description="Number of days to retain automatic backups. Set to 0 to disable automatic backups."
                    >
                      <Input
                        type="number"
                        value={formData.configuration?.backupRetention?.toString() || '30'}
                        onChange={({ detail }) => setFormData({ 
                          ...formData, 
                          configuration: { 
                            ...formData.configuration, 
                            backupRetention: parseInt(detail.value) || 30 
                          } 
                        })}
                        placeholder="30"
                      />
                    </FormField>
                    
                    <ExpandableSection headerText="Advanced Options" variant="footer">
                      <SpaceBetween size="m">
                        <FormField 
                          label="Deployment Type" 
                          description="Single-AZ Gen 2 supports up to 12 HA pairs for maximum throughput. Multi-AZ provides cross-AZ failover but is limited to 1 HA pair."
                        >
                          <Select
                            selectedOption={
                              formData.configuration?.deploymentType === 'MULTI_AZ_1' 
                                ? { label: 'Multi-AZ (Gen 1)', value: 'MULTI_AZ_1' }
                                : { label: 'Single-AZ (Gen 2)', value: 'SINGLE_AZ_2' }
                            }
                            onChange={({ detail }) => setFormData({ 
                              ...formData, 
                              configuration: { 
                                ...formData.configuration, 
                                deploymentType: detail.selectedOption?.value || 'SINGLE_AZ_2',
                                // Reset HA pairs to 1 if switching to Multi-AZ
                                haPairs: detail.selectedOption?.value === 'MULTI_AZ_1' ? 1 : formData.configuration?.haPairs
                              } 
                            })}
                            options={[
                              { label: 'Single-AZ (Gen 2)', value: 'SINGLE_AZ_2', description: 'Up to 12 HA pairs, maximum throughput' },
                              { label: 'Multi-AZ (Gen 1)', value: 'MULTI_AZ_1', description: 'Cross-AZ failover, 1 HA pair only' }
                            ]}
                            placeholder="Select deployment type"
                          />
                        </FormField>
                        
                        {formData.configuration?.teamSize === 'custom' && (
                          <>
                            <FormField 
                              label="HA Pairs" 
                              description="Number of high-availability pairs. Each pair adds throughput capacity. (1-12 for Single-AZ Gen 2)"
                            >
                              <Input
                                type="number"
                                value={formData.configuration?.haPairs?.toString() || '1'}
                                onChange={({ detail }) => {
                                  const newHaPairs = Math.min(12, Math.max(1, parseInt(detail.value) || 1));
                                  const minCapacity = 1024 * newHaPairs;
                                  const currentCapacity = formData.configuration?.storageCapacity || 1024;
                                  // FlexGroup volumes require minimum 100 GiB per constituent, 8 constituents per HA pair
                                  const minVolumeSize = 100 * 8 * newHaPairs;
                                  const currentVolumeSize = formData.configuration?.volumeSize || 1024;
                                  setFormData({ 
                                    ...formData, 
                                    configuration: { 
                                      ...formData.configuration, 
                                      haPairs: newHaPairs,
                                      // Automatically increase storage capacity if below new minimum
                                      storageCapacity: Math.max(minCapacity, currentCapacity),
                                      // Automatically increase volume size if below new minimum for FlexGroup
                                      volumeSize: Math.max(minVolumeSize, currentVolumeSize)
                                    } 
                                  });
                                }}
                                placeholder="1"
                                disabled={formData.configuration?.deploymentType === 'MULTI_AZ_1'}
                              />
                            </FormField>
                            <FormField 
                              label="Throughput per HA Pair (MBps)" 
                              description="Throughput capacity per HA pair. Total throughput = HA pairs × throughput per pair."
                            >
                              <Select
                                selectedOption={
                                  formData.configuration?.throughputCapacityPerHaPair === 1536 ? { label: '1536 MBps (1.5 GB/s)', value: '1536' } :
                                  formData.configuration?.throughputCapacityPerHaPair === 6144 ? { label: '6144 MBps (6 GB/s)', value: '6144' } :
                                  { label: '3072 MBps (3 GB/s)', value: '3072' }
                                }
                                onChange={({ detail }) => setFormData({ 
                                  ...formData, 
                                  configuration: { 
                                    ...formData.configuration, 
                                    throughputCapacityPerHaPair: parseInt(detail.selectedOption?.value || '3072')
                                  } 
                                })}
                                options={[
                                  { label: '1536 MBps (1.5 GB/s)', value: '1536' },
                                  { label: '3072 MBps (3 GB/s)', value: '3072' },
                                  { label: '6144 MBps (6 GB/s)', value: '6144' }
                                ]}
                                placeholder="Select throughput"
                              />
                            </FormField>
                          </>
                        )}
                        
                        <FormField 
                          label="Initial Volume Size (GiB)" 
                          description={`Size of the initial volume. Minimum ${100 * 8 * (formData.configuration?.haPairs || 1)} GiB for ${formData.configuration?.haPairs || 1} HA pair(s).`}
                        >
                          <Input
                            type="number"
                            value={formData.configuration?.volumeSize?.toString() || '1024'}
                            onChange={({ detail }) => {
                              const haPairs = formData.configuration?.haPairs || 1;
                              const minVolumeSize = 100 * 8 * haPairs;
                              const requestedSize = parseInt(detail.value) || minVolumeSize;
                              setFormData({ 
                                ...formData, 
                                configuration: { 
                                  ...formData.configuration, 
                                  volumeSize: Math.max(minVolumeSize, requestedSize)
                                } 
                              });
                            }}
                            placeholder={`${100 * 8 * (formData.configuration?.haPairs || 1)}`}
                          />
                        </FormField>
                        <FormField 
                          label="Security Style" 
                          description="MIXED supports both NFS and SMB access. UNIX is for NFS-only, NTFS is for SMB-only."
                        >
                          <Select
                            selectedOption={
                              formData.configuration?.securityStyle === 'UNIX' ? { label: 'UNIX (NFS only)', value: 'UNIX' } :
                              formData.configuration?.securityStyle === 'NTFS' ? { label: 'NTFS (SMB only)', value: 'NTFS' } :
                              { label: 'MIXED (NFS + SMB)', value: 'MIXED' }
                            }
                            onChange={({ detail }) => setFormData({ 
                              ...formData, 
                              configuration: { 
                                ...formData.configuration, 
                                securityStyle: detail.selectedOption?.value || 'MIXED'
                              } 
                            })}
                            options={[
                              { label: 'MIXED (NFS + SMB)', value: 'MIXED', description: 'Recommended for mixed environments' },
                              { label: 'UNIX (NFS only)', value: 'UNIX', description: 'Linux/Mac only' },
                              { label: 'NTFS (SMB only)', value: 'NTFS', description: 'Windows only' }
                            ]}
                            placeholder="Select security style"
                          />
                        </FormField>
                        <FormField 
                          label="Tiering Policy" 
                          description="AUTO automatically moves cold data to cheaper capacity pool storage after 31 days."
                        >
                          <Select
                            selectedOption={
                              formData.configuration?.tieringPolicy === 'SNAPSHOT_ONLY' ? { label: 'Snapshot Only', value: 'SNAPSHOT_ONLY' } :
                              formData.configuration?.tieringPolicy === 'ALL' ? { label: 'All Data', value: 'ALL' } :
                              formData.configuration?.tieringPolicy === 'NONE' ? { label: 'None (SSD only)', value: 'NONE' } :
                              { label: 'Auto (Recommended)', value: 'AUTO' }
                            }
                            onChange={({ detail }) => setFormData({ 
                              ...formData, 
                              configuration: { 
                                ...formData.configuration, 
                                tieringPolicy: detail.selectedOption?.value || 'AUTO'
                              } 
                            })}
                            options={[
                              { label: 'Auto (Recommended)', value: 'AUTO', description: 'Tier cold data after 31 days' },
                              { label: 'Snapshot Only', value: 'SNAPSHOT_ONLY', description: 'Only tier snapshot data' },
                              { label: 'All Data', value: 'ALL', description: 'Tier all data immediately' },
                              { label: 'None (SSD only)', value: 'NONE', description: 'Keep all data on SSD' }
                            ]}
                            placeholder="Select tiering policy"
                          />
                        </FormField>
                      </SpaceBetween>
                    </ExpandableSection>
                  </>
                )}

                {/* Storage Gateway Configuration Fields - TEMPORARILY DISABLED */}
                {/* TODO: Re-enable when Storage Gateway backend is implemented */}
                {formData.type === 'storage-gateway' && (
                  <>
                    <FormField 
                      label="Cache Volume Size (GB)" 
                      description="Size of the cache volume in GB. Minimum 150 GB recommended."
                    >
                      <Input
                        type="number"
                        value={formData.configuration?.cacheVolumeSizeGB?.toString() || '150'}
                        onChange={({ detail }) => setFormData({ 
                          ...formData, 
                          configuration: { 
                            ...formData.configuration, 
                            cacheVolumeSizeGB: parseInt(detail.value) || 150 
                          } 
                        })}
                        placeholder="150"
                      />
                    </FormField>
                    <FormField 
                      label="Deployment Subnet Type" 
                      description="Deploy Storage Gateway in public or private subnet"
                    >
                      <Select
                        selectedOption={
                          formData.configuration?.deploymentSubnetType === 'public'
                            ? { label: 'Public Subnet', value: 'public' }
                            : { label: 'Private Subnet', value: 'private' }
                        }
                        onChange={({ detail }) => setFormData({ 
                          ...formData, 
                          configuration: { 
                            ...formData.configuration, 
                            deploymentSubnetType: detail.selectedOption?.value || 'private' 
                          } 
                        })}
                        options={[
                          { label: 'Private Subnet', value: 'private' },
                          { label: 'Public Subnet', value: 'public' }
                        ]}
                        placeholder="Select subnet type"
                      />
                    </FormField>
                  </>
                )}

                {/* Mountpoint for S3 Configuration Fields */}
                {formData.type === 'mountpoint-s3' && (
                  <>
                    <Alert type="info">
                      Mountpoint for Amazon S3 allows you to mount an S3 bucket as a local file system on Linux workstations. 
                      Ideal for read-heavy workflows like video editing where source media is stored in S3.
                    </Alert>
                    <FormField 
                      label="S3 Bucket Name" 
                      description="The name of the existing S3 bucket to mount. The bucket must already exist."
                      constraintText="Example: my-media-bucket"
                    >
                      <Input
                        value={formData.configuration?.bucketName || ''}
                        onChange={({ detail }) => setFormData({ 
                          ...formData, 
                          configuration: { 
                            ...formData.configuration, 
                            bucketName: detail.value 
                          } 
                        })}
                        placeholder="my-media-bucket"
                      />
                    </FormField>
                    <FormField 
                      label="Prefix (Optional)" 
                      description="Mount only objects under this prefix. Leave empty to mount the entire bucket."
                      constraintText="Example: project-xyz/camera-originals/"
                    >
                      <Input
                        value={formData.configuration?.prefix || ''}
                        onChange={({ detail }) => setFormData({ 
                          ...formData, 
                          configuration: { 
                            ...formData.configuration, 
                            prefix: detail.value 
                          } 
                        })}
                        placeholder="project-xyz/camera-originals/"
                      />
                    </FormField>
                    <FormField 
                      label="Mount Path" 
                      description="The local directory path where the S3 bucket will be mounted on Linux workstations."
                      constraintText="Example: /mnt/s3/media"
                    >
                      <Input
                        value={formData.configuration?.mountPath || '/mnt/s3'}
                        onChange={({ detail }) => setFormData({ 
                          ...formData, 
                          configuration: { 
                            ...formData.configuration, 
                            mountPath: detail.value || '/mnt/s3' 
                          } 
                        })}
                        placeholder="/mnt/s3/media"
                      />
                    </FormField>
                    <FormField 
                      label="Access Mode" 
                      description="Read-only is recommended for source media. Read-write allows creating new files but has limitations (cannot modify existing files)."
                    >
                      <Select
                        selectedOption={
                          formData.configuration?.accessMode === 'read-write'
                            ? { label: 'Read-Write', value: 'read-write' }
                            : { label: 'Read-Only', value: 'read-only' }
                        }
                        onChange={({ detail }) => setFormData({ 
                          ...formData, 
                          configuration: { 
                            ...formData.configuration, 
                            accessMode: detail.selectedOption?.value || 'read-only',
                            // Reset allowDelete when switching to read-only
                            allowDelete: detail.selectedOption?.value === 'read-only' ? false : formData.configuration?.allowDelete
                          } 
                        })}
                        options={[
                          { label: 'Read-Only', value: 'read-only', description: 'Recommended for source media' },
                          { label: 'Read-Write', value: 'read-write', description: 'Can create new files, cannot modify existing' }
                        ]}
                        placeholder="Select access mode"
                      />
                    </FormField>
                    
                    {/* Allow Delete - only shown for read-write mode */}
                    {formData.configuration?.accessMode === 'read-write' && (
                      <Checkbox
                        checked={formData.configuration?.allowDelete || false}
                        onChange={({ detail }) => setFormData({
                          ...formData,
                          configuration: {
                            ...formData.configuration,
                            allowDelete: detail.checked
                          }
                        })}
                      >
                        Allow file deletion
                        <Box variant="small" color="text-body-secondary">
                          When enabled, deleting files will immediately delete the corresponding S3 objects
                        </Box>
                      </Checkbox>
                    )}
                    
                    <Checkbox
                      checked={formData.configuration?.allowOther !== false}
                      onChange={({ detail }) => setFormData({
                        ...formData,
                        configuration: {
                          ...formData.configuration,
                          allowOther: detail.checked
                        }
                      })}
                    >
                      Allow other users to access
                      <Box variant="small" color="text-body-secondary">
                        Recommended for multi-user workstations. Allows all users on the workstation to access the mounted files.
                      </Box>
                    </Checkbox>
                    
                    <ExpandableSection headerText="Advanced Options" variant="footer">
                      <SpaceBetween size="m">
                        <FormField 
                          label="Local Cache Path (Optional)" 
                          description="Enable local caching for improved performance on repeated reads. Useful for video scrubbing."
                          constraintText="Example: /tmp/s3-cache"
                        >
                          <Input
                            value={formData.configuration?.cachePath || ''}
                            onChange={({ detail }) => setFormData({ 
                              ...formData, 
                              configuration: { 
                                ...formData.configuration, 
                                cachePath: detail.value 
                              } 
                            })}
                            placeholder="/tmp/s3-cache"
                          />
                        </FormField>
                        <FormField 
                          label="User ID (Optional)" 
                          description="Set the owner user ID for mounted files. Leave empty to use the mounting user."
                          constraintText="Example: 1000"
                        >
                          <Input
                            value={formData.configuration?.uid || ''}
                            onChange={({ detail }) => setFormData({ 
                              ...formData, 
                              configuration: { 
                                ...formData.configuration, 
                                uid: detail.value 
                              } 
                            })}
                            placeholder="1000"
                          />
                        </FormField>
                        <FormField 
                          label="Group ID (Optional)" 
                          description="Set the owner group ID for mounted files. Leave empty to use the mounting user's group."
                          constraintText="Example: 1000"
                        >
                          <Input
                            value={formData.configuration?.gid || ''}
                            onChange={({ detail }) => setFormData({ 
                              ...formData, 
                              configuration: { 
                                ...formData.configuration, 
                                gid: detail.value 
                              } 
                            })}
                            placeholder="1000"
                          />
                        </FormField>
                      </SpaceBetween>
                    </ExpandableSection>
                  </>
                )}
                <FormField label="Description" description="Optional description">
                  <Textarea
                    value={formData.description}
                    onChange={({ detail }) => setFormData({ ...formData, description: detail.value })}
                    placeholder="Enter description"
                  />
                </FormField>
              </SpaceBetween>
            </Modal>

            {/* Edit Modal */}
            <Modal
              visible={showEditModal}
              onDismiss={() => setShowEditModal(false)}
              header="Edit Storage Resource"
              footer={
                <Box float="right">
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button variant="link" onClick={() => setShowEditModal(false)}>
                      Cancel
                    </Button>
                    <Button 
                      variant="primary" 
                      onClick={handleUpdateStorage}
                      disabled={!formData.name || !formData.type}
                    >
                      Update
                    </Button>
                  </SpaceBetween>
                </Box>
              }
            >
              <SpaceBetween size="m">
                <FormField label="Storage ID" description="Storage ID cannot be changed">
                  <Input
                    value={editingResource?.storageId || ''}
                    disabled
                  />
                </FormField>
                <FormField label="Name">
                  <Input
                    value={formData.name}
                    onChange={({ detail }) => setFormData({ ...formData, name: detail.value })}
                    placeholder="Enter storage resource name"
                  />
                </FormField>
                <FormField label="Description" description="Optional description">
                  <Textarea
                    value={formData.description}
                    onChange={({ detail }) => setFormData({ ...formData, description: detail.value })}
                    placeholder="Enter description"
                  />
                </FormField>
              </SpaceBetween>
            </Modal>

            {/* Delete Confirmation Modal */}
            <Modal
              visible={showDeleteModal}
              onDismiss={() => setShowDeleteModal(false)}
              header="Delete Storage Resources"
              footer={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button variant="link" onClick={() => setShowDeleteModal(false)}>
                    Cancel
                  </Button>
                  <Button 
                    variant="primary"
                    loading={deleting}
                    onClick={handleDeleteStorage}
                  >
                    Delete Storage
                  </Button>
                </SpaceBetween>
              }
            >
              <SpaceBetween direction="vertical" size="m">
                <Alert type="info">
                  <strong>Note:</strong> This will delete the storage resources and their associated AWS resources (FSx file systems, etc.). This action cannot be undone.
                </Alert>
                <Box>
                  Are you sure you want to delete the following {selectedItems.length} storage resource(s)?
                </Box>
                <ul>
                  {selectedItems.map((resource: any) => (
                    <li key={resource.storageId}>{resource.name} ({resource.storageId})</li>
                  ))}
                </ul>
              </SpaceBetween>
            </Modal>
          </SpaceBetween>
        </ContentLayout>
      }
    />
    </>
  );
};

export default StorageManagement;
