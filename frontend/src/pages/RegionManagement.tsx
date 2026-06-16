// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useMemo } from 'react';
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
  Alert,
  Badge,
  BreadcrumbGroup,
  Grid,
  Link,
  Checkbox,
  Multiselect,
  ColumnLayout,
  Container,
  StatusIndicator,
  Tabs,
  CollectionPreferences,
  Pagination,
  PropertyFilter
} from '@cloudscape-design/components';
import Navigation from '../components/Navigation';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';

interface RegionalHub {
  region: string;
  displayName: string;
  status: string;
  vpcCidr?: string;
  availabilityZones?: string[];
  vpcId?: string;
  nlbDnsName?: string;
  workstationSecurityGroupId?: string;
  launchTemplateId?: string;
  dcvSessionManagerEndpoint?: string;
  dcvDomainName?: string;
  enableWindows?: boolean;
  enableLinux?: boolean;
  enableMacOS?: boolean;
  workstationCount?: number;
  amis?: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
  errorMessage?: string;
  isPrimary?: boolean;
}

interface AvailabilityZone {
  zoneId: string;
  zoneName: string;
  state: string;
}

interface RegionManagementProps {
  user: any;
  isAdmin: boolean;
  config?: any;
}

// AWS Regions list - includes region code in label for clarity
const AWS_REGIONS = [
  { value: 'us-east-1', label: 'us-east-1 - US East (N. Virginia)' },
  { value: 'us-east-2', label: 'us-east-2 - US East (Ohio)' },
  { value: 'us-west-1', label: 'us-west-1 - US West (N. California)' },
  { value: 'us-west-2', label: 'us-west-2 - US West (Oregon)' },
  { value: 'eu-west-1', label: 'eu-west-1 - Europe (Ireland)' },
  { value: 'eu-west-2', label: 'eu-west-2 - Europe (London)' },
  { value: 'eu-west-3', label: 'eu-west-3 - Europe (Paris)' },
  { value: 'eu-central-1', label: 'eu-central-1 - Europe (Frankfurt)' },
  { value: 'eu-north-1', label: 'eu-north-1 - Europe (Stockholm)' },
  { value: 'ap-northeast-1', label: 'ap-northeast-1 - Asia Pacific (Tokyo)' },
  { value: 'ap-northeast-2', label: 'ap-northeast-2 - Asia Pacific (Seoul)' },
  { value: 'ap-southeast-1', label: 'ap-southeast-1 - Asia Pacific (Singapore)' },
  { value: 'ap-southeast-2', label: 'ap-southeast-2 - Asia Pacific (Sydney)' },
  { value: 'ap-south-1', label: 'ap-south-1 - Asia Pacific (Mumbai)' },
  { value: 'sa-east-1', label: 'sa-east-1 - South America (São Paulo)' },
  { value: 'ca-central-1', label: 'ca-central-1 - Canada (Central)' },
];

// Helper to get display name without region code
const getRegionDisplayName = (regionCode: string): string => {
  const region = AWS_REGIONS.find(r => r.value === regionCode);
  if (region) {
    // Extract just the friendly name part (after the " - ")
    const parts = region.label.split(' - ');
    return parts.length > 1 ? parts[1] : region.label;
  }
  return regionCode;
};

const RegionManagement: React.FC<RegionManagementProps> = ({ user, isAdmin, config }) => {
  const [regions, setRegions] = useState<RegionalHub[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItems, setSelectedItems] = useState<RegionalHub[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showDetailsPanel, setShowDetailsPanel] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<RegionalHub | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [filteringQuery, setFilteringQuery] = useState({ tokens: [], operation: 'and' });
  const [sortingColumn, setSortingColumn] = useState<any>({ sortingField: 'region', sortingDescending: false });
  const [currentPageIndex, setCurrentPageIndex] = useState(1);

  // Load preferences from localStorage or use defaults
  const getInitialPreferences = () => {
    try {
      const saved = localStorage.getItem('regions-table-preferences');
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
        { id: 'region', visible: true },
        { id: 'displayName', visible: true },
        { id: 'status', visible: true },
        { id: 'workstationCount', visible: true },
        { id: 'vpcCidr', visible: true },
        { id: 'platforms', visible: true },
        { id: 'createdAt', visible: true }
      ],
      stickyColumns: { first: 0, last: 0 }
    };
  };

  const [preferences, setPreferences] = useState(getInitialPreferences);

  // Save preferences to localStorage whenever they change
  const updatePreferences = (newPreferences: any) => {
    setPreferences(newPreferences);
    setCurrentPageIndex(1); // Reset to first page when preferences change
    try {
      localStorage.setItem('regions-table-preferences', JSON.stringify(newPreferences));
    } catch (error) {
      console.warn('Failed to save preferences to localStorage:', error);
    }
  };

  const [formData, setFormData] = useState({
    region: '',
    displayName: '',
    vpcCidr: '10.100.0.0/22',
    availabilityZonesInput: '', // Raw input string
    publicSubnetMask: 28,
    privateSubnetMask: 24,
    dcvDomainName: '',
    enableWindows: true,
    enableLinux: true,
    enableMacOS: false
  });

  // Parse AZ input into array
  const getAvailabilityZones = (): string[] => {
    return formData.availabilityZonesInput
      .split(/[,\s]+/)
      .map(az => az.trim())
      .filter(az => az.length > 0);
  };

  useEffect(() => {
    fetchRegions();
  }, []);

  // Auto-populate display name when region changes
  useEffect(() => {
    if (formData.region) {
      setFormData(prev => ({ ...prev, displayName: getRegionDisplayName(formData.region) }));
    }
  }, [formData.region]);

  const fetchRegions = async () => {
    try {
      setLoading(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('regions', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const regionsData = data.success ? data.data : (Array.isArray(data) ? data : []);
      setRegions(regionsData);
    } catch (error) {
      console.error('Error fetching regions:', error);
      setAlert({ type: 'error', message: `Failed to fetch regions: ${(error as Error).message}` });
      setRegions([]);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateRegion = async () => {
    try {
      setCreating(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      // Build the payload with parsed availability zones
      const payload = {
        region: formData.region,
        displayName: formData.displayName,
        vpcCidr: formData.vpcCidr,
        availabilityZones: getAvailabilityZones(),
        publicSubnetMask: formData.publicSubnetMask,
        privateSubnetMask: formData.privateSubnetMask,
        dcvDomainName: formData.dcvDomainName,
        enableWindows: formData.enableWindows,
        enableLinux: formData.enableLinux,
        enableMacOS: formData.enableMacOS
      };

      const response = await apiCall('regions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      setAlert({
        type: 'info',
        message: `Regional hub creation started for ${formData.displayName}. This process typically takes 15-30 minutes.`
      });
      setShowCreateModal(false);
      resetForm();
      fetchRegions();
    } catch (error) {
      console.error('Error creating regional hub:', error);
      setAlert({ type: 'error', message: `Failed to create regional hub: ${(error as Error).message}` });
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteRegion = async () => {
    if (selectedItems.length === 0) return;

    setDeleting(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      for (const region of selectedItems) {
        if (region.isPrimary) continue; // Skip primary region

        const response = await apiCall(`regions/${region.region}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Failed to delete ${region.region}`);
        }
      }

      setAlert({
        type: 'info',
        message: `Deletion started for ${selectedItems.filter(r => !r.isPrimary).length} regional hub(s). This process may take several minutes.`
      });
      setSelectedItems([]);
      setShowDeleteModal(false);
      fetchRegions();
    } catch (error) {
      console.error('Error deleting regional hub:', error);
      setAlert({ type: 'error', message: `Failed to delete regional hub: ${(error as Error).message}` });
    } finally {
      setDeleting(false);
    }
  };

  const resetForm = () => {
    setFormData({
      region: '',
      displayName: '',
      vpcCidr: '10.100.0.0/22',
      availabilityZonesInput: '',
      publicSubnetMask: 28,
      privateSubnetMask: 24,
      dcvDomainName: '',
      enableWindows: true,
      enableLinux: true,
      enableMacOS: false
    });
  };

  const getStatusBadge = (status: string, isPrimary?: boolean) => {
    if (isPrimary) {
      return <Badge color="blue">Primary</Badge>;
    }
    switch (status) {
      case 'available':
        return <Badge color="green">Available</Badge>;
      case 'creating':
      case 'validating':
        return <Badge color="blue">Creating</Badge>;
      case 'deleting':
        return <Badge color="grey">Deleting</Badge>;
      case 'failed':
      case 'delete-failed':
        return <Badge color="red">Failed</Badge>;
      case 'initializing':
        return <Badge color="blue">Initializing</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const getAvailableRegions = () => {
    const existingRegions = regions.map(r => r.region);
    return AWS_REGIONS.filter(r => !existingRegions.includes(r.value));
  };

  const columnDefinitions = [
    {
      id: 'region',
      header: 'Region',
      cell: (item: RegionalHub) => (
        <Link
          variant="primary"
          onFollow={(event) => {
            event.preventDefault();
            setSelectedRegion(item);
            setShowDetailsPanel(true);
          }}
        >
          {item.region}
        </Link>
      ),
      sortingField: 'region',
      isRowHeader: true,
    },
    {
      id: 'displayName',
      header: 'Display Name',
      cell: (item: RegionalHub) => item.displayName,
      sortingField: 'displayName'
    },
    {
      id: 'status',
      header: 'Status',
      cell: (item: RegionalHub) => getStatusBadge(item.status, item.isPrimary),
      sortingField: 'status'
    },
    {
      id: 'workstationCount',
      header: 'Workstations',
      cell: (item: RegionalHub) => item.workstationCount ?? 0,
      sortingField: 'workstationCount'
    },
    {
      id: 'vpcCidr',
      header: 'VPC CIDR',
      cell: (item: RegionalHub) => item.vpcCidr || '-',
    },
    {
      id: 'platforms',
      header: 'Platforms',
      cell: (item: RegionalHub) => (
        <SpaceBetween direction="horizontal" size="xs">
          {item.enableWindows && <Badge color="blue">Windows</Badge>}
          {item.enableLinux && <Badge color="green">Linux</Badge>}
          {item.enableMacOS && <Badge color="grey">macOS</Badge>}
        </SpaceBetween>
      ),
    },
    {
      id: 'createdAt',
      header: 'Created',
      cell: (item: RegionalHub) => item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '-',
      sortingField: 'createdAt'
    }
  ];

  // Visible columns based on preferences
  const visibleColumns = useMemo(() => {
    return preferences.contentDisplay
      .filter((item: any) => item.visible)
      .map((item: any) => columnDefinitions.find(col => col.id === item.id))
      .filter(Boolean);
  }, [preferences.contentDisplay]);

  // PropertyFilter configuration
  const filteringProperties = [
    {
      key: 'region',
      operators: ['=', '!=', ':', '!:'],
      propertyLabel: 'Region',
      groupValuesLabel: 'Region values'
    },
    {
      key: 'displayName',
      operators: ['=', '!=', ':', '!:'],
      propertyLabel: 'Display Name',
      groupValuesLabel: 'Display Name values'
    },
    {
      key: 'status',
      operators: ['=', '!='],
      propertyLabel: 'Status',
      groupValuesLabel: 'Status values'
    }
  ];

  // Filter and sort regions
  const filteredRegions = useMemo(() => {
    let filtered = [...regions];

    // Apply PropertyFilter
    if (filteringQuery.tokens.length > 0) {
      filtered = filtered.filter(region => {
        return filteringQuery.tokens.every((token: any) => {
          const { propertyKey, operator, value } = token;
          let itemValue = region[propertyKey as keyof RegionalHub];
          
          if (typeof itemValue === 'string') {
            itemValue = itemValue.toLowerCase();
          }
          const filterValue = value.toLowerCase();
          
          switch (operator) {
            case '=':
              return itemValue === filterValue;
            case '!=':
              return itemValue !== filterValue;
            case ':':
              return itemValue && String(itemValue).toLowerCase().includes(filterValue);
            case '!:':
              return !itemValue || !String(itemValue).toLowerCase().includes(filterValue);
            default:
              return true;
          }
        });
      });
    }

    // Apply sorting
    if (sortingColumn.sortingField) {
      filtered.sort((a, b) => {
        const aValue = a[sortingColumn.sortingField as keyof RegionalHub] || '';
        const bValue = b[sortingColumn.sortingField as keyof RegionalHub] || '';
        if (aValue < bValue) return sortingColumn.sortingDescending ? 1 : -1;
        if (aValue > bValue) return sortingColumn.sortingDescending ? -1 : 1;
        return 0;
      });
    }

    return filtered;
  }, [regions, filteringQuery, sortingColumn]);

  // Calculate paginated regions
  const paginatedRegions = useMemo(() => {
    const pageSize = preferences.pageSize || 10;
    const startIndex = (currentPageIndex - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return filteredRegions.slice(startIndex, endIndex);
  }, [filteredRegions, currentPageIndex, preferences.pageSize]);

  const totalPages = Math.ceil(filteredRegions.length / (preferences.pageSize || 10));

  // Reset to first page when filtering changes
  useEffect(() => {
    setCurrentPageIndex(1);
  }, [filteringQuery]);


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
                  { text: 'Regions' }
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
                      Regional Hubs
                    </Box>
                    <Box
                      variant="p"
                      color="text-body-secondary"
                      margin={{ top: "xxs", bottom: "s" }}
                    >
                      Manage satellite regions for workstation deployment. Add regions to expand capacity and reduce latency for users in different geographic locations.
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
                        ? `(${selectedItems.length}/${filteredRegions.length})`
                        : `(${filteredRegions.length})`
                    }
                    actions={
                      <SpaceBetween direction="horizontal" size="xs">
                        <Button
                          iconName="refresh"
                          onClick={fetchRegions}
                          loading={loading}
                        />
                        <Button
                          onClick={() => setShowDeleteModal(true)}
                          disabled={selectedItems.length === 0 || selectedItems.every(r => r.isPrimary)}
                        >
                          Delete
                        </Button>
                        <Button
                          variant="primary"
                          onClick={() => setShowCreateModal(true)}
                          disabled={getAvailableRegions().length === 0}
                        >
                          Add Region
                        </Button>
                      </SpaceBetween>
                    }
                  >
                    Regional Hubs
                  </Header>
                }
                columnDefinitions={visibleColumns}
                items={paginatedRegions}
                loading={loading}
                loadingText="Loading regional hubs..."
                selectedItems={selectedItems}
                onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
                selectionType="multi"
                trackBy="region"
                sortingColumn={sortingColumn}
                sortingDescending={sortingColumn.sortingDescending}
                onSortingChange={({ detail }) => {
                  setSortingColumn({
                    sortingField: detail.sortingColumn.sortingField,
                    sortingDescending: detail.isDescending || false
                  });
                }}
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
                        { value: 10, label: "10 regions" },
                        { value: 20, label: "20 regions" },
                        { value: 50, label: "50 regions" }
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
                        { id: "region", label: "Region", alwaysVisible: true },
                        { id: "displayName", label: "Display Name" },
                        { id: "status", label: "Status" },
                        { id: "workstationCount", label: "Workstations" },
                        { id: "vpcCidr", label: "VPC CIDR" },
                        { id: "platforms", label: "Platforms" },
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
                  <PropertyFilter
                    query={filteringQuery}
                    onChange={({ detail }) => setFilteringQuery(detail)}
                    filteringProperties={filteringProperties}
                    filteringOptions={[
                      ...regions.map(r => ({ propertyKey: 'region', value: r.region })),
                      ...regions.map(r => ({ propertyKey: 'displayName', value: r.displayName })),
                      { propertyKey: 'status', value: 'available' },
                      { propertyKey: 'status', value: 'creating' },
                      { propertyKey: 'status', value: 'deleting' },
                      { propertyKey: 'status', value: 'failed' }
                    ].filter((option, index, self) => 
                      index === self.findIndex(o => o.propertyKey === option.propertyKey && o.value === option.value)
                    )}
                    filteringPlaceholder="Filter regions"
                    filteringAriaLabel="Filter regions"
                    i18nStrings={{
                      filteringAriaLabel: "Filter regions",
                      dismissAriaLabel: "Dismiss",
                      filteringPlaceholder: "Filter regions",
                      groupValuesText: "Values",
                      groupPropertiesText: "Properties",
                      operatorsText: "Operators",
                      operationAndText: "and",
                      operationOrText: "or",
                      operatorContainsText: "Contains",
                      operatorDoesNotContainText: "Does not contain",
                      operatorEqualsText: "Equals",
                      operatorDoesNotEqualText: "Does not equal",
                      editTokenHeader: "Edit filter",
                      propertyText: "Property",
                      operatorText: "Operator",
                      valueText: "Value",
                      cancelActionText: "Cancel",
                      applyActionText: "Apply",
                      allPropertiesLabel: "All properties",
                      tokenLimitShowMore: "Show more",
                      tokenLimitShowFewer: "Show fewer",
                      clearFiltersText: "Clear filters",
                      removeTokenButtonAriaLabel: (token) => `Remove token ${token.propertyKey} ${token.operator} ${token.value}`,
                      enteredTextLabel: (text) => `Use: "${text}"`
                    }}
                    expandToViewport={true}
                  />
                }
                empty={
                  <Box textAlign="center" color="inherit">
                    <b>No satellite regions</b>
                    <Box padding={{ bottom: 's' }} variant="p" color="inherit">
                      Only the primary region is configured. Add satellite regions to expand capacity.
                    </Box>
                    <Button
                      variant="primary"
                      onClick={() => setShowCreateModal(true)}
                    >
                      Add Region
                    </Button>
                  </Box>
                }
              />
            </SpaceBetween>
          </ContentLayout>
        }
      />

      {/* Create Region Modal */}
      <Modal
        visible={showCreateModal}
        onDismiss={() => { setShowCreateModal(false); resetForm(); }}
        header="Add Regional Hub"
        size="large"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => { setShowCreateModal(false); resetForm(); }}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleCreateRegion}
                loading={creating}
                disabled={!formData.region || !formData.vpcCidr || getAvailabilityZones().length === 0}
              >
                Create Regional Hub
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="l">
          <Alert type="info">
            Creating a regional hub will deploy VPC infrastructure, DCV gateway, and networking components in the selected region. This process typically takes 15-30 minutes.
          </Alert>

          <ColumnLayout columns={2}>
            <FormField label="Region" description="Select the AWS region for this hub">
              <Select
                selectedOption={formData.region ? { value: formData.region, label: AWS_REGIONS.find(r => r.value === formData.region)?.label || formData.region } : null}
                onChange={({ detail }) => setFormData({ ...formData, region: detail.selectedOption?.value || '' })}
                options={getAvailableRegions().map(r => ({ value: r.value, label: r.label }))}
                placeholder="Select a region"
              />
            </FormField>

            <FormField label="Display Name" description="Friendly name for this region">
              <Input
                value={formData.displayName}
                onChange={({ detail }) => setFormData({ ...formData, displayName: detail.value })}
                placeholder="e.g., US West (Oregon)"
              />
            </FormField>
          </ColumnLayout>

          <FormField
            label="VPC CIDR"
            description="CIDR block for the regional VPC (must not overlap with other regions)"
          >
            <Input
              value={formData.vpcCidr}
              onChange={({ detail }) => setFormData({ ...formData, vpcCidr: detail.value })}
              placeholder="10.100.0.0/22"
            />
          </FormField>

          <FormField
            label="Availability Zones"
            description="Enter availability zone IDs separated by commas (e.g., usw2-az1, usw2-az2)"
          >
            <Input
              value={formData.availabilityZonesInput}
              onChange={({ detail }) => setFormData({ ...formData, availabilityZonesInput: detail.value })}
              placeholder="usw2-az1, usw2-az2, usw2-az3"
              disableBrowserAutocorrect={true}
            />
          </FormField>

          <ColumnLayout columns={2}>
            <FormField label="Public Subnet Mask" description="CIDR mask for public subnets">
              <Input
                type="number"
                value={String(formData.publicSubnetMask)}
                onChange={({ detail }) => setFormData({ ...formData, publicSubnetMask: parseInt(detail.value) || 28 })}
              />
            </FormField>

            <FormField label="Private Subnet Mask" description="CIDR mask for private subnets">
              <Input
                type="number"
                value={String(formData.privateSubnetMask)}
                onChange={({ detail }) => setFormData({ ...formData, privateSubnetMask: parseInt(detail.value) || 24 })}
              />
            </FormField>
          </ColumnLayout>

          <Container header={<Header variant="h3">DCV Configuration (Optional)</Header>}>
            <FormField 
              label="DCV Domain Name" 
              description="Custom domain for DCV gateway. TLS certificate is automatically replicated from primary region."
            >
              <Input
                value={formData.dcvDomainName}
                onChange={({ detail }) => setFormData({ ...formData, dcvDomainName: detail.value })}
                placeholder="dcv-usw2.example.com"
              />
            </FormField>
          </Container>

          <Container header={<Header variant="h3">Enabled Platforms</Header>}>
            <SpaceBetween direction="horizontal" size="l">
              <Checkbox
                checked={formData.enableWindows}
                onChange={({ detail }) => setFormData({ ...formData, enableWindows: detail.checked })}
              >
                Windows
              </Checkbox>
              <Checkbox
                checked={formData.enableLinux}
                onChange={({ detail }) => setFormData({ ...formData, enableLinux: detail.checked })}
              >
                Linux
              </Checkbox>
              <Checkbox
                checked={formData.enableMacOS}
                onChange={({ detail }) => setFormData({ ...formData, enableMacOS: detail.checked })}
              >
                macOS (Dedicated Hosts)
              </Checkbox>
            </SpaceBetween>
          </Container>
        </SpaceBetween>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={showDeleteModal}
        onDismiss={() => setShowDeleteModal(false)}
        header="Delete Regional Hub"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowDeleteModal(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleDeleteRegion}
                loading={deleting}
              >
                Delete
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Alert type="warning">
            This will delete all infrastructure in the selected region(s), including VPC, subnets, and DCV gateway. This action cannot be undone.
          </Alert>
          <Box>
            <b>Selected regions to delete:</b>
            <ul>
              {selectedItems.filter(r => !r.isPrimary).map(r => (
                <li key={r.region}>{r.displayName} ({r.region})</li>
              ))}
            </ul>
            {selectedItems.some(r => r.isPrimary) && (
              <Alert type="info">
                The primary region cannot be deleted and will be skipped.
              </Alert>
            )}
          </Box>
        </SpaceBetween>
      </Modal>

      {/* Region Details Panel */}
      <Modal
        visible={showDetailsPanel}
        onDismiss={() => { setShowDetailsPanel(false); setSelectedRegion(null); }}
        header={selectedRegion ? `${selectedRegion.displayName} Details` : 'Region Details'}
        size="large"
      >
        {selectedRegion && (
          <Tabs
            tabs={[
              {
                id: 'overview',
                label: 'Overview',
                content: (
                  <ColumnLayout columns={2} variant="text-grid">
                    <SpaceBetween size="l">
                      <div>
                        <Box variant="awsui-key-label">Region</Box>
                        <div>{selectedRegion.region}</div>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">Display Name</Box>
                        <div>{selectedRegion.displayName}</div>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">Status</Box>
                        <div>{getStatusBadge(selectedRegion.status, selectedRegion.isPrimary)}</div>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">Workstations</Box>
                        <div>{selectedRegion.workstationCount ?? 0}</div>
                      </div>
                    </SpaceBetween>
                    <SpaceBetween size="l">
                      <div>
                        <Box variant="awsui-key-label">VPC CIDR</Box>
                        <div>{selectedRegion.vpcCidr || '-'}</div>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">VPC ID</Box>
                        <div>{selectedRegion.vpcId || '-'}</div>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">Created</Box>
                        <div>{selectedRegion.createdAt ? new Date(selectedRegion.createdAt).toLocaleString() : '-'}</div>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">Last Updated</Box>
                        <div>{selectedRegion.updatedAt ? new Date(selectedRegion.updatedAt).toLocaleString() : '-'}</div>
                      </div>
                    </SpaceBetween>
                  </ColumnLayout>
                )
              },
              {
                id: 'infrastructure',
                label: 'Infrastructure',
                content: (
                  <ColumnLayout columns={2} variant="text-grid">
                    <SpaceBetween size="l">
                      <div>
                        <Box variant="awsui-key-label">NLB DNS Name</Box>
                        <div>{selectedRegion.nlbDnsName || '-'}</div>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">Security Group ID</Box>
                        <div>{selectedRegion.workstationSecurityGroupId || '-'}</div>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">Launch Template ID</Box>
                        <div>{selectedRegion.launchTemplateId || '-'}</div>
                      </div>
                    </SpaceBetween>
                    <SpaceBetween size="l">
                      <div>
                        <Box variant="awsui-key-label">DCV Session Manager Endpoint</Box>
                        <div>{selectedRegion.dcvSessionManagerEndpoint || '-'}</div>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">DCV Domain Name</Box>
                        <div>{selectedRegion.dcvDomainName || '-'}</div>
                      </div>
                      <div>
                        <Box variant="awsui-key-label">Availability Zones</Box>
                        <div>{selectedRegion.availabilityZones?.join(', ') || '-'}</div>
                      </div>
                    </SpaceBetween>
                  </ColumnLayout>
                )
              },
              {
                id: 'amis',
                label: 'AMIs',
                content: (
                  <Box>
                    {selectedRegion.amis && Object.keys(selectedRegion.amis).length > 0 ? (
                      <Table
                        columnDefinitions={[
                          { id: 'sourceAmi', header: 'Source AMI', cell: (item: any) => item.sourceAmi },
                          { id: 'targetAmi', header: 'Regional AMI', cell: (item: any) => item.targetAmiId },
                          { id: 'type', header: 'Type', cell: (item: any) => item.amiType },
                          { id: 'status', header: 'Status', cell: (item: any) => (
                            <StatusIndicator type={item.status === 'available' ? 'success' : item.status === 'pending' ? 'pending' : 'error'}>
                              {item.status}
                            </StatusIndicator>
                          )},
                        ]}
                        items={Object.entries(selectedRegion.amis).map(([sourceAmi, data]: [string, any]) => ({
                          sourceAmi,
                          ...data
                        }))}
                        variant="embedded"
                      />
                    ) : (
                      <Box textAlign="center" color="inherit" padding="l">
                        No AMIs replicated to this region yet.
                      </Box>
                    )}
                  </Box>
                )
              }
            ]}
          />
        )}
      </Modal>
    </>
  );
};

export default RegionManagement;
