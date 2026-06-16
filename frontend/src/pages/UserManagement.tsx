// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useMemo } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  AppLayout,
  ContentLayout,
  Table,
  Header,
  Button,
  ButtonDropdown,
  SpaceBetween,
  Link,
  Badge,
  Modal,
  Form,
  FormField,
  Input,
  Checkbox,
  Alert,
  Box,
  PropertyFilter,
  CollectionPreferences,
  Toggle,
  Icon,
  Pagination,
  BreadcrumbGroup,
  Grid,
} from '@cloudscape-design/components';
import Navigation from '../components/Navigation';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';

const UserManagement: React.FC<{ config?: any }> = ({ config }) => {
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [selectedItems, setSelectedItems] = useState([]);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [showEditGroupModal, setShowEditGroupModal] = useState(false);
  const [showDeleteGroupModal, setShowDeleteGroupModal] = useState(false);
  const [showDeleteGroupWarningModal, setShowDeleteGroupWarningModal] = useState(false);
  const [groupToDelete, setGroupToDelete] = useState(null);
  const [groupToEdit, setGroupToEdit] = useState(null);
  const [assignedWorkstations, setAssignedWorkstations] = useState([]);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState(false);
  const [editGroupData, setEditGroupData] = useState({ groupName: '', description: '' });
  const [showAssignGroupsModal, setShowAssignGroupsModal] = useState(false);
  const [selectedGroupsForAssignment, setSelectedGroupsForAssignment] = useState([]);
  const [currentUserMemberships, setCurrentUserMemberships] = useState([]);
  const [desiredMemberships, setDesiredMemberships] = useState([]);
  const [showManageUsersModal, setShowManageUsersModal] = useState(false);
  const [selectedGroupForUserManagement, setSelectedGroupForUserManagement] = useState(null);
  const [currentGroupUsers, setCurrentGroupUsers] = useState([]);
  const [desiredGroupUsers, setDesiredGroupUsers] = useState([]);
  const [manageUsersFilter, setManageUsersFilter] = useState('');
  const [showDisableModal, setShowDisableModal] = useState(false);
  const [showEnableModal, setShowEnableModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [groupsCurrentPageIndex, setGroupsCurrentPageIndex] = useState(1);
  const [groupError, setGroupError] = useState('');
  const [syncingUsers, setSyncingUsers] = useState(false);
  const [syncResult, setSyncResult] = useState<{ synced: number; skipped: number; errors: any[] } | null>(null);
  const [filteringQuery, setFilteringQuery] = useState({ tokens: [], operation: 'and' });
  const [sortingColumn, setSortingColumn] = useState({ sortingField: 'firstName', sortingDescending: false });
  // Load preferences from localStorage or use defaults
  const getInitialPreferences = () => {
    try {
      const saved = localStorage.getItem('users-table-preferences');
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
        { id: 'username', visible: true },
        { id: 'email', visible: false },
        { id: 'department', visible: false },
        { id: 'role', visible: true },
        { id: 'groups', visible: true },
        { id: 'status', visible: true },
        { id: 'createdAt', visible: false }
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
      localStorage.setItem('users-table-preferences', JSON.stringify(newPreferences));
    } catch (error) {
      console.warn('Failed to save preferences to localStorage:', error);
    }
  };
  const [formData, setFormData] = useState({
    email: '',
    firstName: '',
    lastName: '',
    department: '',
    isAdmin: false,
    temporaryPassword: '',
  });

  const [groupFormData, setGroupFormData] = useState({
    groupName: '',
    description: '',
  });

  useEffect(() => {
    fetchUsers();
    fetchGroups();
  }, []);

  // PropertyFilter configuration
  const filteringProperties = [
    {
      key: 'firstName',
      operators: ['=', '!=', ':', '!:'],
      propertyLabel: 'First Name',
      groupValuesLabel: 'First Name values'
    },
    {
      key: 'lastName', 
      operators: ['=', '!=', ':', '!:'],
      propertyLabel: 'Last Name',
      groupValuesLabel: 'Last Name values'
    },
    {
      key: 'email',
      operators: ['=', '!=', ':', '!:'],
      propertyLabel: 'Email',
      groupValuesLabel: 'Email values'
    },
    {
      key: 'userId',
      operators: ['=', '!=', ':', '!:'],
      propertyLabel: 'Username',
      groupValuesLabel: 'Username values'
    },
    {
      key: 'department',
      operators: ['=', '!=', ':', '!:'],
      propertyLabel: 'Department',
      groupValuesLabel: 'Department values'
    },
    {
      key: 'role',
      operators: ['=', '!='],
      propertyLabel: 'Role',
      groupValuesLabel: 'Role values'
    },
    {
      key: 'groups',
      operators: ['=', '!=', ':', '!:'],
      propertyLabel: 'Groups',
      groupValuesLabel: 'Group values'
    },
    {
      key: 'enabled',
      operators: ['=', '!='],
      propertyLabel: 'Status',
      groupValuesLabel: 'Status values'
    }
  ];

  // Filter and sort users
  const processedUsers = useMemo(() => {
    let filtered = [...users];

    // Apply PropertyFilter
    if (filteringQuery.tokens.length > 0) {
      filtered = filtered.filter(user => {
        return filteringQuery.tokens.every(token => {
          const { propertyKey, operator, value } = token;
          let itemValue = user[propertyKey];
          
          // Handle special cases
          if (propertyKey === 'role') {
            itemValue = user.role || 'User';
          } else if (propertyKey === 'enabled') {
            itemValue = user.enabled ? 'Active' : 'Disabled';
          } else if (propertyKey === 'groups') {
            // For groups, search within the array of group names
            const groupsArray = user.groups || [];
            const searchValue = value.toLowerCase();
            
            switch (operator) {
              case '=':
                return groupsArray.some((group: string) => 
                  group.toLowerCase() === searchValue
                );
              case '!=':
                return !groupsArray.some((group: string) => 
                  group.toLowerCase() === searchValue
                );
              case ':':
                return groupsArray.some((group: string) => 
                  group.toLowerCase().includes(searchValue)
                );
              case '!:':
                return !groupsArray.some((group: string) => 
                  group.toLowerCase().includes(searchValue)
                );
              default:
                return false;
            }
          }
          
          if (!itemValue) itemValue = '';
          
          const searchValue = value.toLowerCase();
          const itemValueLower = String(itemValue).toLowerCase();
          
          switch (operator) {
            case '=':
              return itemValueLower === searchValue;
            case '!=':
              return itemValueLower !== searchValue;
            case ':':
              return itemValueLower.includes(searchValue);
            case '!:':
              return !itemValueLower.includes(searchValue);
            default:
              return true;
          }
        });
      });
    }

    // Apply sorting
    if (sortingColumn.sortingField) {
      filtered.sort((a, b) => {
        let aValue = a[sortingColumn.sortingField];
        let bValue = b[sortingColumn.sortingField];
        
        // Handle special sorting cases
        if (sortingColumn.sortingField === 'role') {
          aValue = a.role || 'User';
          bValue = b.role || 'User';
        } else if (sortingColumn.sortingField === 'enabled') {
          aValue = a.enabled ? 1 : 0;
          bValue = b.enabled ? 1 : 0;
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
  }, [users, filteringQuery, sortingColumn]);

  // Calculate paginated users
  const paginatedUsers = useMemo(() => {
    const pageSize = preferences.pageSize || 10; // Default to 10 if undefined
    const startIndex = (currentPageIndex - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return processedUsers.slice(startIndex, endIndex);
  }, [processedUsers, currentPageIndex, preferences.pageSize]);

  const totalPages = Math.ceil(processedUsers.length / (preferences.pageSize || 10));

  // Reset to first page when filtering changes
  useEffect(() => {
    setCurrentPageIndex(1);
  }, [filteringQuery]);

  // Calculate paginated groups
  const paginatedGroups = useMemo(() => {
    const pageSize = preferences.pageSize || 10; // Use same page size as users
    const startIndex = (groupsCurrentPageIndex - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return groups.slice(startIndex, endIndex);
  }, [groups, groupsCurrentPageIndex, preferences.pageSize]);

  const groupsTotalPages = Math.ceil(groups.length / (preferences.pageSize || 10));

  const fetchUsers = async () => {
    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }
      
      const response = await apiCall('users', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      
      const data = await response.json();
      setUsers(data);
    } catch (error) {
      console.error('Error fetching users:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleEditGroup = async () => {
    if (!groupToEdit) return;
    
    setEditingGroup(true);
    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }
      
      const response = await apiCall(`groups/${groupToEdit.groupId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(editGroupData),
      });
      
      if (response.ok) {
        setShowEditGroupModal(false);
        setGroupToEdit(null);
        setEditGroupData({ groupName: '', description: '' });
        setSelectedGroups([]);
        fetchGroups();
      } else {
        const errorData = await response.json();
        setGroupError(errorData.error || 'Failed to update group');
      }
    } catch (error: any) {
      setGroupError(error.message || 'Failed to update group');
    } finally {
      setEditingGroup(false);
    }
  };

  const handleDeleteGroup = async (group: any) => {
    setGroupToDelete(group);
    
    // Check if group has assigned workstations
    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }
      
      const response = await apiCall('workstations', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      
      const workstations = await response.json();
      const groupWorkstations = workstations.filter((ws: any) => ws.assignedUserId === group.groupId);
      
      if (groupWorkstations.length > 0) {
        setAssignedWorkstations(groupWorkstations);
        setShowDeleteGroupWarningModal(true);
      } else {
        setShowDeleteGroupModal(true);
      }
    } catch (error) {
      console.error('Error checking group workstations:', error);
      setShowDeleteGroupModal(true); // Show modal anyway if check fails
    }
  };

  const confirmDeleteGroup = async () => {
    if (!groupToDelete) return;
    
    setDeletingGroup(true);
    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }
      
      const response = await apiCall(`groups/${groupToDelete.groupId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      
      if (response.ok) {
        setShowDeleteGroupModal(false);
        setGroupToDelete(null);
        setSelectedGroups([]);
        fetchGroups();
      } else {
        const errorData = await response.json();
        setGroupError(errorData.error || 'Failed to delete group');
      }
    } catch (error: any) {
      setGroupError(error.message || 'Failed to delete group');
    } finally {
      setDeletingGroup(false);
    }
  };

  const fetchGroups = async () => {
    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }
      
      const response = await apiCall('groups', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      
      const data = await response.json();
      setGroups(data);
    } catch (error) {
      console.error('Error fetching groups:', error);
    } finally {
      setGroupsLoading(false);
    }
  };

  const handleCreateGroup = async () => {
    setCreatingGroup(true);
    setGroupError('');

    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }

      const response = await apiCall('groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(groupFormData),
      });

      if (response.ok) {
        setShowCreateGroupModal(false);
        setGroupFormData({
          groupName: '',
          description: '',
        });
        fetchGroups();
      } else {
        const errorData = await response.json();
        setGroupError(errorData.error || 'Failed to create group');
      }
    } catch (error: any) {
      setGroupError(error.message || 'Failed to create group');
    } finally {
      setCreatingGroup(false);
    }
  };

  const handleCreateUser = async () => {
    setCreating(true);
    setError('');

    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }

      const response = await apiCall('users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(formData),
      });

      if (response.ok) {
        setShowCreateModal(false);
        setFormData({
          email: '',
          firstName: '',
          lastName: '',
          department: '',
          isAdmin: false,
          temporaryPassword: '',
        });
        fetchUsers();
      } else {
        const errorData = await response.json();
        setError(errorData.error || 'Failed to create user');
      }
    } catch (error: any) {
      setError(error.message || 'Failed to create user');
    } finally {
      setCreating(false);
    }
  };

  const handleDisableUsers = async () => {
    setProcessing(true);
    setError('');

    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }

      const response = await apiCall('users/disable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ userIds: selectedItems.map(item => item.userId) }),
      });

      if (response.ok) {
        setShowDisableModal(false);
        setSelectedItems([]);
        fetchUsers();
      } else {
        const errorData = await response.json();
        setError(errorData.error || 'Failed to disable users');
      }
    } catch (error: any) {
      setError(error.message || 'Failed to disable users');
    } finally {
      setProcessing(false);
    }
  };

  const handleEnableUsers = async () => {
    setProcessing(true);
    setError('');

    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }

      const response = await apiCall('users/enable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ userIds: selectedItems.map(item => item.userId) }),
      });

      if (response.ok) {
        setShowEnableModal(false);
        setSelectedItems([]);
        fetchUsers();
      } else {
        const errorData = await response.json();
        setError(errorData.error || 'Failed to enable users');
      }
    } catch (error: any) {
      setError(error.message || 'Failed to enable users');
    } finally {
      setProcessing(false);
    }
  };

  const handleDeleteUsers = async () => {
    setProcessing(true);
    setError('');

    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }

      const response = await apiCall('users/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ userIds: selectedItems.map(item => item.userId) }),
      });

      if (response.ok) {
        setShowDeleteModal(false);
        setSelectedItems([]);
        fetchUsers();
      } else {
        const errorData = await response.json();
        setError(errorData.error || 'Failed to delete users');
      }
    } catch (error: any) {
      setError(error.message || 'Failed to delete users');
    } finally {
      setProcessing(false);
    }
  };

  const handleSyncFromIdentityCenter = async () => {
    setSyncingUsers(true);
    setSyncResult(null);
    setError('');

    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }

      const response = await apiCall('users/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });

      const data = await response.json();
      
      if (response.ok) {
        setSyncResult({
          synced: data.synced || 0,
          skipped: data.skipped || 0,
          errors: data.errors || []
        });
        fetchUsers(); // Refresh the users list
      } else {
        setError(data.error || 'Failed to sync users from Identity Center');
      }
    } catch (error: any) {
      setError(error.message || 'Failed to sync users from Identity Center');
    } finally {
      setSyncingUsers(false);
    }
  };

  const handleAssignUsersToGroups = async () => {
    setProcessing(true);
    setError('');

    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }

      const userId = selectedItems[0].userId;
      const currentGroupIds = currentUserMemberships.map(g => g.groupId);
      const desiredGroupIds = desiredMemberships.map(g => g.groupId);
      
      const groupsToAdd = desiredGroupIds.filter(id => !currentGroupIds.includes(id));
      const groupsToRemove = currentGroupIds.filter(id => !desiredGroupIds.includes(id));

      // Add to groups
      if (groupsToAdd.length > 0) {
        await apiCall('users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ 
            userIds: [userId],
            groupIds: groupsToAdd
          }),
        });
      }

      // Remove from groups  
      if (groupsToRemove.length > 0) {
        await apiCall('users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ 
            action: 'removeFromGroups',
            userId: userId,
            groupIds: groupsToRemove 
          }),
        });
      }

      setShowAssignGroupsModal(false);
      setSelectedItems([]);
      setSelectedGroupsForAssignment([]);
      setCurrentUserMemberships([]);
      setDesiredMemberships([]);
      fetchUsers();
    } catch (error: any) {
      setError(error.message || 'Failed to assign users to groups');
    } finally {
      setProcessing(false);
    }
  };

  const handleManageUsers = async () => {
    setProcessing(true);
    setError('');

    try {
      const token = getAuthToken();
      if (!token) { throw new Error("No current user"); }

      const groupId = selectedGroupForUserManagement.groupId;
      const currentUserIds = currentGroupUsers.map(u => u.userId);
      const desiredUserIds = desiredGroupUsers.map(u => u.userId);
      
      const usersToAdd = desiredUserIds.filter(id => !currentUserIds.includes(id));
      const usersToRemove = currentUserIds.filter(id => !desiredUserIds.includes(id));

      // Add users to group
      if (usersToAdd.length > 0) {
        await apiCall('users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ 
            userIds: usersToAdd,
            groupIds: [groupId]
          }),
        });
      }

      // Remove users from group
      for (const userId of usersToRemove) {
        await apiCall('users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ 
            action: 'removeFromGroups',
            userId: userId,
            groupIds: [groupId] 
          }),
        });
      }

      setShowManageUsersModal(false);
      setSelectedGroupForUserManagement(null);
      setCurrentGroupUsers([]);
      setDesiredGroupUsers([]);
      fetchUsers();
    } catch (error: any) {
      setError(error.message || 'Failed to manage group users');
    } finally {
      setProcessing(false);
    }
  };

  // Filter users for Manage Users modal
  const filteredUsersForModal = useMemo(() => {
    if (!manageUsersFilter) return users;
    const filter = manageUsersFilter.toLowerCase();
    return users.filter(user => 
      user.firstName?.toLowerCase().includes(filter) ||
      user.lastName?.toLowerCase().includes(filter) ||
      user.email?.toLowerCase().includes(filter)
    );
  }, [users, manageUsersFilter]);

  const handleSelectAllUsers = () => {
    setDesiredGroupUsers([...filteredUsersForModal]);
  };

  const handleDeselectAllUsers = () => {
    setDesiredGroupUsers([]);
  };

  // Apply password styling to prevent browser save prompt
  useEffect(() => {
    const passwordInputs = document.querySelectorAll('input[data-password-field="true"]');
    passwordInputs.forEach(input => {
      (input as HTMLInputElement).style.webkitTextSecurity = 'disc';
      (input as HTMLInputElement).style.textSecurity = 'disc';
    });
  }, [showCreateModal]);

  const columnDefinitions = [
    {
      id: 'name',
      header: 'Name',
      cell: (item: any) => (
        <Link 
          variant="primary"
          onFollow={(event) => {
            event.preventDefault();
            window.location.href = `/users/${item.userId}`;
          }}
        >
          {`${item.firstName} ${item.lastName}`}
        </Link>
      ),
      sortingField: 'firstName',
      isRowHeader: true,
    },
    {
      id: 'username',
      header: 'User name',
      cell: (item: any) => item.userId,
      sortingField: 'userId',
    },
    {
      id: 'email',
      header: 'Email',
      cell: (item: any) => item.email,
      sortingField: 'email',
    },
    {
      id: 'department',
      header: 'Department',
      cell: (item: any) => item.department || 'N/A',
      sortingField: 'department',
    },
    {
      id: 'role',
      header: 'Role',
      cell: (item: any) => (
        <Badge color={item.role === 'Administrator' ? 'red' : 'blue'}>
          {item.role || 'User'}
        </Badge>
      ),
      sortingField: 'role',
    },
    {
      id: 'groups',
      header: 'Groups',
      cell: (item: any) => {
        if (!item.groups || item.groups.length === 0) {
          return <Badge color="grey">No groups</Badge>;
        }
        return (
          <SpaceBetween direction="horizontal" size="xs">
            {item.groups.map((group: string, index: number) => (
              <Badge key={index} color="blue">{group}</Badge>
            ))}
          </SpaceBetween>
        );
      },
      sortingField: 'groups',
    },
    {
      id: 'status',
      header: 'Status',
      cell: (item: any) => (
        <Badge color={item.enabled ? 'green' : 'grey'}>
          {item.enabled ? 'Active' : 'Disabled'}
        </Badge>
      ),
      sortingField: 'enabled',
    },
    {
      id: 'createdAt',
      header: 'Created',
      cell: (item: any) => new Date(item.createdAt).toLocaleString(),
      sortingField: 'createdAt',
    },
  ];

  const visibleColumns = useMemo(() => {
    return preferences.contentDisplay
      .filter(item => item.visible)
      .map(item => columnDefinitions.find(col => col.id === item.id))
      .filter(Boolean);
  }, [preferences.contentDisplay]);

  // Filter users based on search text
  return (
    <>
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
                  { text: 'Users / Groups' }
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
                      User Management
                    </Box>
                    <Box
                      variant="p"
                      color="text-body-secondary"
                      margin={{ top: "xxs", bottom: "s" }}
                    >
                      Manage user accounts, group memberships, and access permissions across your organization.
                    </Box>
                  </div>
                </Grid>
                </div>
              </Box>
            }
          >
            <SpaceBetween size="l">
              {config?.useCognitoAuth && (
                <Alert type="info">
                  Users are managed through your Identity Provider (Okta, IAM Identity Center, etc.). 
                  You can still manage group memberships and workstation assignments for federated users.
                </Alert>
              )}
              {syncResult && (
                <Alert 
                  type="success" 
                  dismissible 
                  onDismiss={() => setSyncResult(null)}
                  header="Identity Center Sync Complete"
                >
                  Synced {syncResult.synced} users, skipped {syncResult.skipped} existing users.
                  {syncResult.errors.length > 0 && (
                    <Box margin={{ top: 'xs' }}>
                      {syncResult.errors.length} error(s) occurred during sync.
                    </Box>
                  )}
                </Alert>
              )}
              {error && (
                <Alert 
                  type="error" 
                  dismissible 
                  onDismiss={() => setError('')}
                  header="Sync Error"
                >
                  {error}
                </Alert>
              )}
              <Table
                columnDefinitions={visibleColumns}
                items={paginatedUsers}
                loading={loading}
                loadingText="Loading users..."
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
                trackBy="userId"
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
                        { value: 10, label: "10 users" },
                        { value: 20, label: "20 users" },
                        { value: 50, label: "50 users" }
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
                          id: "name",
                          label: "Name",
                          alwaysVisible: true
                        },
                        { id: "username", label: "User name" },
                        { id: "email", label: "Email" },
                        { id: "department", label: "Department" },
                        { id: "role", label: "Role" },
                        { id: "groups", label: "Groups" },
                        { id: "status", label: "Status" },
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
                      ...users.map(user => ({ propertyKey: 'firstName', value: user.firstName })),
                      ...users.map(user => ({ propertyKey: 'lastName', value: user.lastName })),
                      ...users.map(user => ({ propertyKey: 'email', value: user.email })),
                      ...users.map(user => ({ propertyKey: 'userId', value: user.userId })),
                      ...users.map(user => ({ propertyKey: 'department', value: user.department || 'N/A' })),
                      ...users.flatMap(user => (user.groups || []).map((group: string) => ({ propertyKey: 'groups', value: group }))),
                      { propertyKey: 'role', value: 'Administrator' },
                      { propertyKey: 'role', value: 'User' },
                      { propertyKey: 'enabled', value: 'Active' },
                      { propertyKey: 'enabled', value: 'Disabled' }
                    ].filter((option, index, self) => 
                      index === self.findIndex(o => o.propertyKey === option.propertyKey && o.value === option.value)
                    )}
                    filteringPlaceholder="Filter users"
                    filteringAriaLabel="Filter users"
                    i18nStrings={{
                      filteringAriaLabel: "Filter users",
                      dismissAriaLabel: "Dismiss",
                      filteringPlaceholder: "Filter users",
                      groupValuesText: "Values",
                      groupPropertiesText: "Properties",
                      operatorsText: "Operators",
                      operationAndText: "and",
                      operationOrText: "or",
                      operatorLessText: "Less than",
                      operatorLessOrEqualText: "Less than or equal",
                      operatorGreaterText: "Greater than",
                      operatorGreaterOrEqualText: "Greater than or equal",
                      operatorContainsText: "Contains",
                      operatorDoesNotContainText: "Does not contain",
                      operatorEqualsText: "Equals",
                      operatorDoesNotEqualText: "Does not equal",
                      editTokenText: "Edit filter",
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
                selectionType="multi"
                header={
                  <Header
                    counter={
                      selectedItems.length
                        ? `(${selectedItems.length}/${processedUsers.length})`
                        : `(${processedUsers.length})`
                    }
                    actions={
                      <SpaceBetween direction="horizontal" size="xs">
                        <Button
                          iconName="refresh"
                          onClick={fetchUsers}
                          loading={loading}
                        />
                        <Button
                          disabled={selectedItems.length !== 1}
                          onClick={() => {
                            if (selectedItems.length === 1) {
                              window.location.href = `/users/${selectedItems[0].userId}`;
                            }
                          }}
                        >
                          Details
                        </Button>
                        {!config?.useCognitoAuth && (
                          <ButtonDropdown
                            items={[
                              { text: 'Disable Users', id: 'disable' },
                              { text: 'Enable Users', id: 'enable' },
                              { text: 'Delete Users', id: 'delete' }
                            ]}
                            disabled={selectedItems.length === 0}
                            onItemClick={({ detail }) => {
                              if (detail.id === 'disable') setShowDisableModal(true);
                              else if (detail.id === 'enable') setShowEnableModal(true);
                              else if (detail.id === 'delete') setShowDeleteModal(true);
                            }}
                          >
                            Edit Users
                          </ButtonDropdown>
                        )}
                        <Button 
                          disabled={selectedItems.length !== 1}
                          onClick={() => {
                            // Use existing group data from the selected user
                            const selectedUser = selectedItems[0];
                            const userGroups = selectedUser.groups || [];
                            
                            // Set desired memberships based on current user groups
                            const currentMemberships = groups.filter(group => 
                              userGroups.includes(group.groupName)
                            );
                            
                            setCurrentUserMemberships(currentMemberships);
                            setDesiredMemberships([...currentMemberships]);
                            setShowAssignGroupsModal(true);
                          }}
                        >
                          Manage Groups
                        </Button>
                        <Button
                          iconName="download"
                          loading={syncingUsers}
                          onClick={handleSyncFromIdentityCenter}
                        >
                          Sync from Identity Center
                        </Button>
                        {!config?.useCognitoAuth && (
                          <Button variant="primary" onClick={() => setShowCreateModal(true)}>
                            Create User
                          </Button>
                        )}
                      </SpaceBetween>
                    }
                  >
                    Users
                  </Header>
                }
                empty="No users found."
              />

              <Table
                columnDefinitions={[
                  {
                    id: 'groupName',
                    header: 'Group Name',
                    cell: (item) => (
                      <Link 
                        variant="primary"
                        onFollow={(event) => {
                          event.preventDefault();
                          window.location.href = `/groups/${item.groupId}`;
                        }}
                      >
                        {item.groupName}
                      </Link>
                    ),
                    sortingField: 'groupName'
                  },
                  {
                    id: 'description',
                    header: 'Description',
                    cell: (item) => item.description || '-'
                  },
                  {
                    id: 'createdAt',
                    header: 'Created',
                    cell: (item) => new Date(item.createdAt).toLocaleDateString()
                  }
                ]}
                items={paginatedGroups}
                loading={groupsLoading}
                selectedItems={selectedGroups}
                onSelectionChange={({ detail }) => setSelectedGroups(detail.selectedItems)}
                trackBy="groupId"
                selectionType="multi"
                pagination={
                  groupsTotalPages > 1 ? (
                    <Pagination 
                      currentPageIndex={groupsCurrentPageIndex} 
                      pagesCount={groupsTotalPages}
                      onChange={({ detail }) => setGroupsCurrentPageIndex(detail.currentPageIndex)}
                    />
                  ) : null
                }
                header={
                  <Header
                    counter={`(${groups.length})`}
                    actions={
                      <SpaceBetween direction="horizontal" size="xs">
                        <Button
                          iconName="refresh"
                          onClick={fetchGroups}
                          loading={groupsLoading}
                        />
                        <ButtonDropdown
                          disabled={selectedGroups.length !== 1}
                          loading={editingGroup || deletingGroup}
                          items={[
                            {
                              text: "Edit Group",
                              id: "edit",
                              disabled: false
                            },
                            {
                              text: "Delete Group", 
                              id: "delete",
                              disabled: false
                            }
                          ]}
                          onItemClick={({ detail }) => {
                            if (detail.id === "edit") {
                              const group = selectedGroups[0];
                              setGroupToEdit(group);
                              setEditGroupData({
                                groupName: group.groupName,
                                description: group.description || ''
                              });
                              setShowEditGroupModal(true);
                            } else if (detail.id === "delete") {
                              handleDeleteGroup(selectedGroups[0]);
                            }
                          }}
                        >
                          Actions
                        </ButtonDropdown>
                        <Button 
                          disabled={selectedGroups.length !== 1}
                          onClick={() => {
                            const selectedGroup = selectedGroups[0];
                            const groupUsers = users.filter(user => 
                              user.groups && user.groups.includes(selectedGroup.groupName)
                            );
                            
                            setSelectedGroupForUserManagement(selectedGroup);
                            setCurrentGroupUsers(groupUsers);
                            setDesiredGroupUsers([...groupUsers]);
                            setShowManageUsersModal(true);
                          }}
                        >
                          Manage Users
                        </Button>
                        <Button 
                          disabled={selectedGroups.length !== 1}
                          onClick={() => {
                            // Navigate to group details using React Router
                            const groupId = selectedGroups[0].groupId;
                            window.open(`/groups/${groupId}`, '_blank');
                          }}
                        >
                          Details
                        </Button>
                        <Button variant="primary" onClick={() => setShowCreateGroupModal(true)}>
                          Create Group
                        </Button>
                      </SpaceBetween>
                    }
                  >
                    Groups
                  </Header>
                }
                empty="No groups found."
              />
            </SpaceBetween>
          </ContentLayout>
        }
      />

      <Modal
        visible={showCreateModal}
        onDismiss={() => setShowCreateModal(false)}
        header="Create New User"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => setShowCreateModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={creating} onClick={handleCreateUser}>
              Create User
            </Button>
          </SpaceBetween>
        }
      >
        <Form autoComplete="off">
          <input type="text" autoComplete="username" style={{display: 'none'}} />
          <SpaceBetween direction="vertical" size="l">
            {error && (
              <Alert type="error" dismissible onDismiss={() => setError('')}>
                {error}
              </Alert>
            )}

            <FormField label="Email" required>
              <Input
                value={formData.email}
                onChange={({ detail }) => setFormData({ ...formData, email: detail.value })}
                placeholder="user@example.com"
                type="email"
              />
            </FormField>

            <FormField label="First Name" required>
              <Input
                value={formData.firstName}
                onChange={({ detail }) => setFormData({ ...formData, firstName: detail.value })}
                placeholder="John"
              />
            </FormField>

            <FormField label="Last Name" required>
              <Input
                value={formData.lastName}
                onChange={({ detail }) => setFormData({ ...formData, lastName: detail.value })}
                placeholder="Doe"
              />
            </FormField>

            <FormField label="Department">
              <Input
                value={formData.department}
                onChange={({ detail }) => setFormData({ ...formData, department: detail.value })}
                placeholder="Engineering"
              />
            </FormField>

            <FormField label="Temporary Password">
              <Input
                value={formData.temporaryPassword}
                onChange={({ detail }) => setFormData({ ...formData, temporaryPassword: detail.value })}
                type="text"
                autoComplete="off"
                data-password-field="true"
                data-form-type="other"
                data-lpignore="true"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </FormField>

            <Checkbox
              checked={formData.isAdmin}
              onChange={({ detail }) => setFormData({ ...formData, isAdmin: detail.checked })}
            >
              Administrator privileges
            </Checkbox>
          </SpaceBetween>
        </Form>
      </Modal>

      <Modal
        visible={showCreateGroupModal}
        onDismiss={() => setShowCreateGroupModal(false)}
        header="Create New Group"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => setShowCreateGroupModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={creatingGroup} onClick={handleCreateGroup}>
              Create Group
            </Button>
          </SpaceBetween>
        }
      >
        <Form>
          <SpaceBetween direction="vertical" size="l">
            {groupError && (
              <Alert type="error" dismissible onDismiss={() => setGroupError('')}>
                {groupError}
              </Alert>
            )}

            <FormField label="Group Name" required>
              <Input
                value={groupFormData.groupName}
                onChange={({ detail }) => setGroupFormData({ ...groupFormData, groupName: detail.value })}
                placeholder="Editors"
              />
            </FormField>

            <FormField label="Description">
              <Input
                value={groupFormData.description}
                onChange={({ detail }) => setGroupFormData({ ...groupFormData, description: detail.value })}
                placeholder="Group for video editors"
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Modal>

      <Modal
        visible={showDisableModal}
        onDismiss={() => setShowDisableModal(false)}
        header="Disable Users"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => setShowDisableModal(false)}>
              Cancel
            </Button>
            <Button loading={processing} onClick={handleDisableUsers}>
              Disable Users
            </Button>
          </SpaceBetween>
        }
      >
        <SpaceBetween direction="vertical" size="l">
          {error && (
            <Alert type="error" dismissible onDismiss={() => setError('')}>
              {error}
            </Alert>
          )}
          <Box>
            Are you sure you want to disable the following {selectedItems.length} user(s)?
          </Box>
          <ul>
            {selectedItems.map((user: any) => (
              <li key={user.userId}>{user.email} - {user.firstName} {user.lastName}</li>
            ))}
          </ul>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={showEnableModal}
        onDismiss={() => setShowEnableModal(false)}
        header="Enable Users"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => setShowEnableModal(false)}>
              Cancel
            </Button>
            <Button loading={processing} onClick={handleEnableUsers}>
              Enable Users
            </Button>
          </SpaceBetween>
        }
      >
        <SpaceBetween direction="vertical" size="l">
          {error && (
            <Alert type="error" dismissible onDismiss={() => setError('')}>
              {error}
            </Alert>
          )}
          <Box>
            Are you sure you want to enable the following {selectedItems.length} user(s)?
          </Box>
          <ul>
            {selectedItems.map((user: any) => (
              <li key={user.userId}>{user.email} - {user.firstName} {user.lastName}</li>
            ))}
          </ul>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={showDeleteModal}
        onDismiss={() => setShowDeleteModal(false)}
        header="Delete Users"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => setShowDeleteModal(false)}>
              Cancel
            </Button>
            <Button loading={processing} onClick={handleDeleteUsers}>
              Delete Users
            </Button>
          </SpaceBetween>
        }
      >
        <SpaceBetween direction="vertical" size="l">
          {error && (
            <Alert type="error" dismissible onDismiss={() => setError('')}>
              {error}
            </Alert>
          )}
          <Alert type="warning">
            <strong>Warning:</strong> This action cannot be undone. The users will be permanently deleted from both Cognito and the database.
          </Alert>
          <Box>
            Are you sure you want to delete the following {selectedItems.length} user(s)?
          </Box>
          <ul>
            {selectedItems.map((user: any) => (
              <li key={user.userId}>{user.email} - {user.firstName} {user.lastName}</li>
            ))}
          </ul>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={showAssignGroupsModal}
        onDismiss={() => {
          setShowAssignGroupsModal(false);
          setSelectedGroupsForAssignment([]);
          setCurrentUserMemberships([]);
          setDesiredMemberships([]);
        }}
        header={`Manage Groups - ${selectedItems[0]?.firstName} ${selectedItems[0]?.lastName}`}
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => {
              setShowAssignGroupsModal(false);
              setSelectedGroupsForAssignment([]);
              setCurrentUserMemberships([]);
              setDesiredMemberships([]);
            }}>
              Cancel
            </Button>
            <Button 
              loading={processing} 
              onClick={handleAssignUsersToGroups}
            >
              Save Changes
            </Button>
          </SpaceBetween>
        }
      >
        <SpaceBetween direction="vertical" size="l">
          {error && (
            <Alert type="error" dismissible onDismiss={() => setError('')}>
              {error}
            </Alert>
          )}
          <Box>
            Manage group memberships for: {selectedItems[0]?.firstName} {selectedItems[0]?.lastName}
          </Box>
          <FormField label="Group Memberships">
            <Table
              columnDefinitions={[
                {
                  id: 'groupName',
                  header: 'Group Name',
                  cell: (item: any) => item.groupName,
                },
                {
                  id: 'description',
                  header: 'Description',
                  cell: (item: any) => item.description || '-',
                },
                {
                  id: 'membership',
                  header: 'Member',
                  cell: (item: any) => {
                    const isMember = desiredMemberships.some((membership: any) => membership.groupId === item.groupId);
                    
                    return (
                      <Toggle
                        checked={isMember}
                        onChange={({ detail }) => {
                          if (detail.checked) {
                            // Add to desired memberships
                            if (!isMember) {
                              setDesiredMemberships([...desiredMemberships, item]);
                            }
                          } else {
                            // Remove from desired memberships
                            setDesiredMemberships(desiredMemberships.filter((membership: any) => membership.groupId !== item.groupId));
                          }
                        }}
                      />
                    );
                  }
                }
              ]}
              items={[...groups].sort((a, b) => a.groupName.localeCompare(b.groupName))}
              loading={groupsLoading}
              trackBy="groupId"
              empty="No groups available."
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* Manage Users Modal */}
      <Modal
        visible={showManageUsersModal}
        onDismiss={() => {
          setShowManageUsersModal(false);
          setSelectedGroupForUserManagement(null);
          setCurrentGroupUsers([]);
          setDesiredGroupUsers([]);
          setManageUsersFilter('');
        }}
        header={`Manage Users - ${selectedGroupForUserManagement?.groupName}`}
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => {
              setShowManageUsersModal(false);
              setSelectedGroupForUserManagement(null);
              setCurrentGroupUsers([]);
              setDesiredGroupUsers([]);
              setManageUsersFilter('');
            }}>
              Cancel
            </Button>
            <Button 
              loading={processing} 
              onClick={handleManageUsers}
              variant="primary"
            >
              Save Changes
            </Button>
          </SpaceBetween>
        }
      >
        <SpaceBetween direction="vertical" size="l">
          {error && (
            <Alert type="error" dismissible onDismiss={() => setError('')}>
              {error}
            </Alert>
          )}
          <Box>
            Manage user memberships for group: {selectedGroupForUserManagement?.groupName}
          </Box>
          <FormField label="Filter Users">
            <Input
              value={manageUsersFilter}
              onChange={({ detail }) => setManageUsersFilter(detail.value)}
              placeholder="Search by name or email..."
              clearAriaLabel="Clear filter"
              type="search"
            />
          </FormField>
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={handleSelectAllUsers}>
              Select All ({filteredUsersForModal.length})
            </Button>
            <Button onClick={handleDeselectAllUsers}>
              Deselect All
            </Button>
            <Box color="text-status-info">
              {desiredGroupUsers.length} of {filteredUsersForModal.length} users selected
            </Box>
          </SpaceBetween>
          <FormField label="User Memberships">
            <Table
              columnDefinitions={[
                {
                  id: 'name',
                  header: 'Name',
                  cell: (item: any) => `${item.firstName} ${item.lastName}`,
                },
                {
                  id: 'email',
                  header: 'Email',
                  cell: (item: any) => item.email,
                },
                {
                  id: 'membership',
                  header: 'Member',
                  cell: (item: any) => {
                    const isMember = desiredGroupUsers.some((user: any) => user.userId === item.userId);
                    
                    return (
                      <Toggle
                        checked={isMember}
                        onChange={({ detail }) => {
                          if (detail.checked) {
                            // Add to desired users
                            if (!isMember) {
                              setDesiredGroupUsers([...desiredGroupUsers, item]);
                            }
                          } else {
                            // Remove from desired users
                            setDesiredGroupUsers(desiredGroupUsers.filter((user: any) => user.userId !== item.userId));
                          }
                        }}
                      />
                    );
                  }
                }
              ]}
              items={[...filteredUsersForModal].sort((a, b) => a.firstName.localeCompare(b.firstName))}
              loading={loading}
              trackBy="userId"
              empty={manageUsersFilter ? "No users match the filter." : "No users available."}
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* Edit Group Modal */}
      <Modal
        visible={showEditGroupModal}
        onDismiss={() => {
          setShowEditGroupModal(false);
          setGroupToEdit(null);
          setEditGroupData({ groupName: '', description: '' });
        }}
        header="Edit Group"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => {
              setShowEditGroupModal(false);
              setGroupToEdit(null);
              setEditGroupData({ groupName: '', description: '' });
            }}>
              Cancel
            </Button>
            <Button 
              variant="primary"
              loading={editingGroup}
              onClick={handleEditGroup}
            >
              Save Changes
            </Button>
          </SpaceBetween>
        }
      >
        <Form>
          <SpaceBetween direction="vertical" size="l">
            {groupError && <Alert type="error">{groupError}</Alert>}
            <FormField label="Group Name" constraintText="Name used in Directory Services">
              <Input
                value={editGroupData.groupName}
                onChange={({ detail }) => setEditGroupData(prev => ({ ...prev, groupName: detail.value }))}
                placeholder="Enter group name"
              />
            </FormField>
            <FormField label="Description" constraintText="Optional description for the group">
              <Input
                value={editGroupData.description}
                onChange={({ detail }) => setEditGroupData(prev => ({ ...prev, description: detail.value }))}
                placeholder="Enter group description"
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Modal>

      {/* Delete Group Warning Modal */}
      <Modal
        visible={showDeleteGroupWarningModal}
        onDismiss={() => {
          setShowDeleteGroupWarningModal(false);
          setGroupToDelete(null);
          setAssignedWorkstations([]);
        }}
        header="Cannot Delete Group"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => {
              setShowDeleteGroupWarningModal(false);
              setGroupToDelete(null);
              setAssignedWorkstations([]);
            }}>
              Close
            </Button>
          </SpaceBetween>
        }
      >
        <SpaceBetween direction="vertical" size="m">
          <Alert type="warning">
            The group "{groupToDelete?.groupName}" cannot be deleted because it has workstations assigned to it.
          </Alert>
          <Box>
            <strong>Assigned Workstations:</strong>
            <ul>
              {assignedWorkstations.map((ws: any) => (
                <li key={ws.instanceId}>{ws.instanceId} - {ws.instanceType}</li>
              ))}
            </ul>
          </Box>
          <Box>
            Please reassign or delete these workstations before deleting the group.
          </Box>
        </SpaceBetween>
      </Modal>

      {/* Delete Group Confirmation Modal */}
      <Modal
        visible={showDeleteGroupModal}
        onDismiss={() => {
          setShowDeleteGroupModal(false);
          setGroupToDelete(null);
        }}
        header="Delete Group"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => {
              setShowDeleteGroupModal(false);
              setGroupToDelete(null);
            }}>
              Cancel
            </Button>
            <Button 
              variant="primary"
              loading={deletingGroup}
              onClick={confirmDeleteGroup}
            >
              Delete Group
            </Button>
          </SpaceBetween>
        }
      >
        <SpaceBetween direction="vertical" size="m">
          <Alert type="warning">
            Are you sure you want to delete the group "{groupToDelete?.groupName}"?
          </Alert>
          <Box>
            This action will:
            <ul>
              <li>Remove the group from Directory Services</li>
              <li>Remove all users from this group</li>
              <li>Delete the group from the system</li>
            </ul>
          </Box>
          <Box>
            <strong>This action cannot be undone.</strong>
          </Box>
        </SpaceBetween>
      </Modal>
    </>
  );
};

export default UserManagement;
