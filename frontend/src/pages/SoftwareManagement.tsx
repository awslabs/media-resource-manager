// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useMemo } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  AppLayout,
  ContentLayout,
  Header,
  Button,
  Table,
  Box,
  SpaceBetween,
  Badge,
  Modal,
  FormField,
  Input,
  Textarea,
  Select,
  Grid,
  Checkbox,
  BreadcrumbGroup,
  Alert,
  TextFilter,
  CollectionPreferences,
  Pagination
} from '@cloudscape-design/components';
import Navigation from '../components/Navigation';
import InstallScriptChat from '../components/InstallScriptChat';
import AddSoftwareWizard from '../components/AddSoftwareWizard';
import { apiCall } from '../utils/api';
import { getAuthToken } from '../utils/auth';

interface SoftwareComponent {
  softwareId: string;
  name: string;
  versionNumber: string;
  componentVersion?: string;
  category: string;
  description: string;
  componentArn: string;
  estimatedInstallTime: string;
  diskSpaceRequired: string;
  gpuRequired: boolean;
  platform?: string;
  mediaS3Uri?: string;
  mediaFileName?: string;
  sourceType?: string;
}

const SoftwareManagement: React.FC<{ config?: any }> = ({ config }) => {
  const [softwareLibrary, setSoftwareLibrary] = useState<SoftwareComponent[]>([]);
  const [selectedItems, setSelectedItems] = useState<SoftwareComponent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddWizard, setShowAddWizard] = useState(false);
  const [isWizardGenerating, setIsWizardGenerating] = useState(false); // Track if wizard is generating
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showGenerateScriptModal, setShowGenerateScriptModal] = useState(false);
  const [editSoftware, setEditSoftware] = useState<SoftwareComponent | null>(null);
  const [editScript, setEditScript] = useState('');
  const [updating, setUpdating] = useState(false);
  const [filteringText, setFilteringText] = useState('');
  const [platformFilter, setPlatformFilter] = useState<any>(null);
  const [categoryFilter, setCategoryFilter] = useState<any>(null);
  const [sortingColumn, setSortingColumn] = useState<any>({ sortingField: 'name', sortingDescending: false });
  const [currentPageIndex, setCurrentPageIndex] = useState(1);

  // Platform and Category options for Select dropdowns
  const platformOptions = [
    { label: 'All Platforms', value: '' },
    { label: 'Windows', value: 'Windows' },
    { label: 'Linux', value: 'Linux' },
    { label: 'macOS', value: 'macOS' }
  ];

  const categoryOptions = [
    { label: 'All Categories', value: '' },
    { label: 'Development', value: 'development' },
    { label: 'Media', value: 'media' },
    { label: 'System', value: 'system' },
    { label: 'Utilities', value: 'utilities' }
  ];

  // Load preferences from localStorage or use defaults
  const getInitialPreferences = () => {
    try {
      const saved = localStorage.getItem('software-table-preferences');
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
        { id: 'name', visible: true },
        { id: 'version', visible: true },
        { id: 'platform', visible: true },
        { id: 'category', visible: true },
        { id: 'gpu', visible: true },
        { id: 'media', visible: true },
        { id: 'description', visible: true }
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
      localStorage.setItem('software-table-preferences', JSON.stringify(newPreferences));
    } catch (error) {
      console.warn('Failed to save preferences to localStorage:', error);
    }
  };

  // Column definitions
  const columnDefinitions = [
    { id: 'name', header: 'Name', cell: (item: SoftwareComponent) => <RouterLink to={`/software/${item.softwareId}`} style={{ color: '#0972d3', textDecoration: 'none' }}>{item.name}</RouterLink>, sortingField: 'name', isRowHeader: true },
    { id: 'version', header: 'Version', cell: (item: SoftwareComponent) => item.versionNumber || 'Latest', sortingField: 'versionNumber' },
    { id: 'platform', header: 'Platform', cell: (item: SoftwareComponent) => <Badge color={item.platform === 'Linux' ? 'green' : item.platform === 'macOS' ? 'grey' : 'blue'}>{item.platform || 'Windows'}</Badge>, sortingField: 'platform' },
    { id: 'category', header: 'Category', cell: (item: SoftwareComponent) => <Badge color="grey">{item.category ? item.category.charAt(0).toUpperCase() + item.category.slice(1) : 'N/A'}</Badge>, sortingField: 'category' },
    { id: 'gpu', header: 'GPU Required', cell: (item: SoftwareComponent) => item.gpuRequired ? <Badge color="red">Yes</Badge> : <Badge>No</Badge>, sortingField: 'gpuRequired' },
    { id: 'media', header: 'Media', cell: (item: SoftwareComponent) => item.mediaFileName ? <Badge color="green">Yes</Badge> : <Badge>No</Badge>, sortingField: 'mediaFileName' },
    { id: 'description', header: 'Description', cell: (item: SoftwareComponent) => item.description, sortingField: 'description' }
  ];

  // Visible columns based on preferences
  const visibleColumns = useMemo(() => {
    return preferences.contentDisplay
      .filter((item: any) => item.visible)
      .map((item: any) => columnDefinitions.find(col => col.id === item.id))
      .filter(Boolean);
  }, [preferences.contentDisplay]);

  // Filter and sort software
  const processedSoftware = useMemo(() => {
    let filtered = [...softwareLibrary];

    // Apply text filter (searches name, description, version)
    if (filteringText) {
      const searchText = filteringText.toLowerCase();
      filtered = filtered.filter(software => 
        software.name?.toLowerCase().includes(searchText) ||
        software.description?.toLowerCase().includes(searchText) ||
        software.versionNumber?.toLowerCase().includes(searchText)
      );
    }

    // Apply platform filter
    if (platformFilter?.value) {
      filtered = filtered.filter(software => 
        (software.platform || 'Windows') === platformFilter.value
      );
    }

    // Apply category filter
    if (categoryFilter?.value) {
      filtered = filtered.filter(software => 
        software.category === categoryFilter.value
      );
    }

    // Apply sorting
    if (sortingColumn.sortingField) {
      filtered.sort((a, b) => {
        let aValue: any = a[sortingColumn.sortingField as keyof SoftwareComponent];
        let bValue: any = b[sortingColumn.sortingField as keyof SoftwareComponent];
        
        // Handle special sorting cases
        if (sortingColumn.sortingField === 'gpuRequired') {
          aValue = a.gpuRequired ? 1 : 0;
          bValue = b.gpuRequired ? 1 : 0;
        } else if (sortingColumn.sortingField === 'platform') {
          aValue = a.platform || 'Windows';
          bValue = b.platform || 'Windows';
        } else if (sortingColumn.sortingField === 'versionNumber') {
          aValue = a.versionNumber || 'Latest';
          bValue = b.versionNumber || 'Latest';
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
  }, [softwareLibrary, filteringText, platformFilter, categoryFilter, sortingColumn]);

  // Calculate paginated software
  const paginatedSoftware = useMemo(() => {
    const pageSize = preferences.pageSize || 10;
    const startIndex = (currentPageIndex - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return processedSoftware.slice(startIndex, endIndex);
  }, [processedSoftware, currentPageIndex, preferences.pageSize]);

  const totalPages = Math.ceil(processedSoftware.length / (preferences.pageSize || 10));

  // Reset to first page when filtering changes
  useEffect(() => {
    setCurrentPageIndex(1);
  }, [filteringText, platformFilter, categoryFilter]);

  useEffect(() => {
    loadSoftwareLibrary();
  }, []);

  const loadSoftwareLibrary = async () => {
    setLoading(true);
    try {
      const token = getAuthToken();
      if (!token) return;
      const response = await apiCall('/images/software', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        const data = await response.json();
        setSoftwareLibrary(data.items || []);
      }
    } catch (error) {
      console.error('Failed to load software library:', error);
    } finally {
      setLoading(false);
    }
  };

  const deleteSelected = async () => {
    const errors: string[] = [];
    for (const item of selectedItems) {
      try {
        const token = getAuthToken();
        if (!token) {
          errors.push(`${item.name}: No auth token`);
          continue;
        }
        const response = await apiCall(`/images/software/${item.softwareId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          errors.push(`${item.name}: ${errorData.error || response.statusText || 'Delete failed'}`);
        }
      } catch (error) {
        console.error('Failed to delete software:', error);
        errors.push(`${item.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
    
    setShowDeleteModal(false);
    setSelectedItems([]);
    loadSoftwareLibrary();
    
    if (errors.length > 0) {
      setError(`Failed to delete: ${errors.join(', ')}`);
    }
  };

  const openEditModal = () => {
    if (selectedItems.length === 1) {
      setEditSoftware({ ...selectedItems[0] });
      setEditScript(''); // Script will be entered if user wants to update it
      setShowEditModal(true);
    }
  };

  const updateSoftware = async () => {
    if (!editSoftware) return;
    setUpdating(true);
    try {
      const token = getAuthToken();
      if (!token) return;
      
      const payload: Record<string, any> = { ...editSoftware };
      // Include script if user entered one (triggers version increment)
      if (editScript.trim()) {
        payload.script = editScript;
      }
      
      const response = await apiCall(`/images/software/${editSoftware.softwareId}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (response.ok) {
        const result = await response.json();
        setShowEditModal(false);
        setEditSoftware(null);
        setEditScript('');
        setSelectedItems([]);
        loadSoftwareLibrary();
        
        // Show success message if version was incremented
        if (result.versionIncremented) {
          setError(null); // Clear any previous errors
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error || 'Failed to update software');
      }
    } catch (error) {
      console.error('Failed to update software:', error);
      setError(error instanceof Error ? error.message : 'Failed to update software');
    } finally {
      setUpdating(false);
    }
  };

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
                { text: 'Images', href: '/images' },
                { text: 'Software', href: '#' }
              ]}
              ariaLabel="Breadcrumbs"
            />
          }
          header={
            <Box padding={{ vertical: "l" }}>
              <div style={{ maxWidth: '1200px' }}>
              <Grid gridDefinition={[{ colspan: { default: 12, xs: 8, s: 9 } }, { colspan: { default: 12, xs: 4, s: 3 } }]}>
                <div>
                  <Box variant="h1" fontSize="display-l">Software Management</Box>
                  <Box variant="p" color="text-body-secondary" margin={{ top: "xxs", bottom: "s" }}>
                    Manage software components and scripts for EC2 Image Builder pipelines.
                  </Box>
                </div>
              </Grid>
              </div>
            </Box>
          }
        >
          {error && (
            <Alert
              type="error"
              dismissible
              onDismiss={() => setError(null)}
              header="Error"
            >
              {error}
            </Alert>
          )}
          <Table
            columnDefinitions={visibleColumns}
            items={paginatedSoftware}
            loading={loading}
            loadingText="Loading software..."
            selectionType="multi"
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
            trackBy="softwareId"
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
                    { value: 10, label: "10 items" },
                    { value: 20, label: "20 items" },
                    { value: 50, label: "50 items" }
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
                    { id: "name", label: "Name", alwaysVisible: true },
                    { id: "version", label: "Version" },
                    { id: "platform", label: "Platform" },
                    { id: "category", label: "Category" },
                    { id: "gpu", label: "GPU Required" },
                    { id: "media", label: "Media" },
                    { id: "description", label: "Description" }
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
                  filteringPlaceholder="Search by name, description, or version"
                  filteringAriaLabel="Filter software"
                  onChange={({ detail }) => setFilteringText(detail.filteringText)}
                />
                <Select
                  selectedOption={platformFilter}
                  onChange={({ detail }) => setPlatformFilter(detail.selectedOption)}
                  options={platformOptions}
                  placeholder="Platform"
                  selectedAriaLabel="Selected platform"
                />
                <Select
                  selectedOption={categoryFilter}
                  onChange={({ detail }) => setCategoryFilter(detail.selectedOption)}
                  options={categoryOptions}
                  placeholder="Category"
                  selectedAriaLabel="Selected category"
                />
              </SpaceBetween>
            }
            header={
              <Header
                counter={selectedItems.length > 0 ? `(${selectedItems.length}/${processedSoftware.length})` : `(${processedSoftware.length})`}
                actions={
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button iconName="refresh" onClick={loadSoftwareLibrary} loading={loading} />
                    <Button disabled={selectedItems.length === 0} onClick={() => setShowDeleteModal(true)}>Delete</Button>
                    <Button disabled={selectedItems.length !== 1} onClick={openEditModal}>Edit</Button>
                    <Button 
                      disabled={selectedItems.length !== 1 || selectedItems[0]?.sourceType !== 'script'} 
                      onClick={() => setShowGenerateScriptModal(true)}
                      iconName="gen-ai"
                    >
                      Generate Script
                    </Button>
                    <Button variant="primary" onClick={() => setShowAddWizard(true)}>Add Software</Button>
                  </SpaceBetween>
                }
              >
                Software Library
              </Header>
            }
            empty={<Box textAlign="center" color="inherit"><b>No software components</b></Box>}
          />

          {/* Add Software Wizard */}
          <Modal
            visible={showAddWizard}
            onDismiss={() => {
              // Prevent dismissal by clicking outside when generating
              if (!isWizardGenerating) {
                setShowAddWizard(false);
              }
            }}
            header="Add Software to Library"
            size="large"
          >
            <AddSoftwareWizard
              onComplete={() => {
                setShowAddWizard(false);
                setIsWizardGenerating(false);
                loadSoftwareLibrary();
              }}
              onCancel={() => {
                setShowAddWizard(false);
                setIsWizardGenerating(false);
              }}
              onGeneratingChange={setIsWizardGenerating}
            />
          </Modal>

          {/* Edit Software Modal */}
          <Modal
            visible={showEditModal}
            onDismiss={() => { setShowEditModal(false); setEditSoftware(null); setEditScript(''); }}
            header="Edit Software"
            footer={
              <Box float="right">
                <SpaceBetween direction="horizontal" size="xs">
                  <Button variant="link" onClick={() => { setShowEditModal(false); setEditSoftware(null); setEditScript(''); }}>Cancel</Button>
                  <Button variant="primary" onClick={updateSoftware} loading={updating}>Save Changes</Button>
                </SpaceBetween>
              </Box>
            }
          >
            {editSoftware && (
              <SpaceBetween direction="vertical" size="m">
                <Grid gridDefinition={[{ colspan: 8 }, { colspan: 4 }]}>
                  <FormField label="Software Name">
                    <Input value={editSoftware.name} onChange={({ detail }) => setEditSoftware({...editSoftware, name: detail.value})} />
                  </FormField>
                  <FormField 
                    label="Current Version" 
                    constraintText={editSoftware.versionNumber === 'Latest' && editSoftware.componentVersion 
                      ? `Internal: ${editSoftware.componentVersion}` 
                      : 'Read-only'}
                  >
                    <Input value={editSoftware.versionNumber || '1.0.0'} disabled={true} />
                  </FormField>
                </Grid>
                <FormField label="Category">
                  <Select
                    selectedOption={editSoftware.category ? { label: editSoftware.category, value: editSoftware.category } : null}
                    onChange={({ detail }) => setEditSoftware({...editSoftware, category: detail.selectedOption.value!})}
                    options={[
                      { label: 'Development', value: 'development' },
                      { label: 'Media', value: 'media' },
                      { label: 'System', value: 'system' },
                      { label: 'Utilities', value: 'utilities' }
                    ]}
                  />
                </FormField>
                <FormField label="Description">
                  <Textarea value={editSoftware.description} onChange={({ detail }) => setEditSoftware({...editSoftware, description: detail.value})} rows={2} />
                </FormField>
                <FormField label="Component ARN" constraintText="Read-only">
                  <Input value={editSoftware.componentArn} disabled={true} />
                </FormField>
                <FormField label="Platform" constraintText="Read-only">
                  <Input value={editSoftware.platform || 'Windows'} disabled={true} />
                </FormField>
                {editSoftware.mediaFileName && (
                  <FormField label="Media File" constraintText="Read-only">
                    <Input value={editSoftware.mediaFileName} disabled={true} />
                  </FormField>
                )}
                
                {/* Script editing section - only for script-based components */}
                {editSoftware.sourceType === 'script' && (
                  <>
                    <Alert type="info">
                      {editSoftware.versionNumber === 'Latest' ? (
                        <>
                          To update the installation script, enter the new script below. A new component version will be created 
                          internally ({editSoftware.componentVersion || '1.0.0'} → {(() => {
                            const v = (editSoftware.componentVersion || '1.0.0').split('.').map(Number);
                            v[2] = v[2] + 1;
                            return v.join('.');
                          })()}) but the display will remain "Latest". The old version will be kept if it's used by existing recipes.
                        </>
                      ) : (
                        <>
                          To update the installation script, enter the new script below. This will create a new component version 
                          ({editSoftware.componentVersion || editSoftware.versionNumber || '1.0.0'} → {(() => {
                            const v = (editSoftware.componentVersion || editSoftware.versionNumber || '1.0.0').split('.').map(Number);
                            v[2] = v[2] + 1;
                            return v.join('.');
                          })()}). The old version will be kept if it's used by existing recipes.
                        </>
                      )}
                    </Alert>
                    <FormField 
                      label={`Update ${editSoftware.platform === 'Linux' ? 'Bash' : 'PowerShell'} Script`}
                      description="Leave empty to keep the current script unchanged"
                    >
                      <Textarea
                        value={editScript}
                        onChange={({ detail }) => setEditScript(detail.value)}
                        placeholder={editSoftware.platform === 'Windows' 
                          ? '# Enter new PowerShell script to create a new version...'
                          : '# Enter new Bash script to create a new version...'}
                        rows={8}
                      />
                    </FormField>
                  </>
                )}
                
                <Grid gridDefinition={[{ colspan: 6 }, { colspan: 6 }]}>
                  <FormField label="Estimated Install Time">
                    <Input value={editSoftware.estimatedInstallTime} onChange={({ detail }) => setEditSoftware({...editSoftware, estimatedInstallTime: detail.value})} />
                  </FormField>
                  <FormField label="Disk Space Required">
                    <Input value={editSoftware.diskSpaceRequired} onChange={({ detail }) => setEditSoftware({...editSoftware, diskSpaceRequired: detail.value})} />
                  </FormField>
                </Grid>
                <Checkbox checked={editSoftware.gpuRequired} onChange={({ detail }) => setEditSoftware({...editSoftware, gpuRequired: detail.checked})}>
                  This software requires GPU
                </Checkbox>
              </SpaceBetween>
            )}
          </Modal>

          {/* Delete Confirmation Modal */}
          <Modal
            visible={showDeleteModal}
            onDismiss={() => setShowDeleteModal(false)}
            header={`Delete ${selectedItems.length === 1 ? 'Software Component' : 'Software Components'}`}
            footer={
              <Box float="right">
                <SpaceBetween direction="horizontal" size="xs">
                  <Button variant="link" onClick={() => setShowDeleteModal(false)}>Cancel</Button>
                  <Button variant="primary" onClick={deleteSelected}>Delete</Button>
                </SpaceBetween>
              </Box>
            }
          >
            <SpaceBetween size="m">
              <Box>Are you sure you want to delete {selectedItems.length === 1 ? 'this software component' : `these ${selectedItems.length} software components`}?</Box>
              <Alert type="warning">
                This will permanently delete the software component(s) from both the software library database and the EC2 Image Builder component registry. Any uploaded media files will also be deleted.
              </Alert>
              {selectedItems.length > 0 && (
                <Box>
                  <Box variant="strong">Components to be deleted:</Box>
                  <ul>
                    {selectedItems.map(item => (
                      <li key={item.softwareId}>{item.name} {item.versionNumber && `v${item.versionNumber}`}</li>
                    ))}
                  </ul>
                </Box>
              )}
            </SpaceBetween>
          </Modal>

          {/* Generate Script Modal */}
          <Modal
            visible={showGenerateScriptModal}
            onDismiss={() => setShowGenerateScriptModal(false)}
            header="AI Script Generator"
            size="large"
          >
            {selectedItems.length === 1 && (
              <InstallScriptChat
                softwareId={selectedItems[0].softwareId}
                softwareName={selectedItems[0].name}
                platform={(selectedItems[0].platform as 'Windows' | 'Linux') || 'Windows'}
                mediaS3Uri={selectedItems[0].mediaS3Uri}
                onScriptGenerated={(script, componentArn) => {
                  // Reload the software library to get the updated component
                  loadSoftwareLibrary();
                  setShowGenerateScriptModal(false);
                }}
                onClose={() => setShowGenerateScriptModal(false)}
              />
            )}
          </Modal>
        </ContentLayout>
      }
    />
  );
};

export default SoftwareManagement;
