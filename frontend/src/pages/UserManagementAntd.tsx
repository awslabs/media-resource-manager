// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useMemo } from 'react';
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
  Switch,
  Checkbox,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ReloadOutlined,
  HomeOutlined,
  EditOutlined,
  UserOutlined,
  TeamOutlined,
  SyncOutlined,
  StopOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { MenuProps } from 'antd';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';

const { Title, Text, Link } = Typography;

interface User {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  department?: string;
  role?: string;
  groups?: string[];
  enabled: boolean;
  createdAt: string;
}

interface Group {
  groupId: string;
  groupName: string;
  description?: string;
  createdAt: string;
}

interface UserManagementAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const UserManagementAntd: React.FC<UserManagementAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [selectedUserKeys, setSelectedUserKeys] = useState<React.Key[]>([]);
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<React.Key[]>([]);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info' | 'warning'; message: string } | null>(null);

  // Modal states
  const [showCreateUserModal, setShowCreateUserModal] = useState(false);
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [showEditGroupModal, setShowEditGroupModal] = useState(false);
  const [showDeleteGroupModal, setShowDeleteGroupModal] = useState(false);
  const [showDeleteGroupWarningModal, setShowDeleteGroupWarningModal] = useState(false);
  const [showDisableModal, setShowDisableModal] = useState(false);
  const [showEnableModal, setShowEnableModal] = useState(false);
  const [showDeleteUsersModal, setShowDeleteUsersModal] = useState(false);
  const [showManageGroupsModal, setShowManageGroupsModal] = useState(false);
  const [showManageUsersModal, setShowManageUsersModal] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);

  // Processing states
  const [creating, setCreating] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState(false);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [syncingUsers, setSyncingUsers] = useState(false);

  // Edit/Delete group state
  const [groupToEdit, setGroupToEdit] = useState<Group | null>(null);
  const [groupToDelete, setGroupToDelete] = useState<Group | null>(null);
  const [assignedWorkstations, setAssignedWorkstations] = useState<any[]>([]);

  // Manage groups/users state
  const [selectedUserForGroups, setSelectedUserForGroups] = useState<User | null>(null);
  const [desiredMemberships, setDesiredMemberships] = useState<string[]>([]);
  const [selectedGroupForUsers, setSelectedGroupForUsers] = useState<Group | null>(null);
  const [desiredGroupUsers, setDesiredGroupUsers] = useState<string[]>([]);
  const [manageUsersFilter, setManageUsersFilter] = useState('');

  // Schedule configuration state
  const [selectedUserForSchedule, setSelectedUserForSchedule] = useState<User | null>(null);
  const [scheduleTimezone, setScheduleTimezone] = useState('America/New_York');
  const [scheduleData, setScheduleData] = useState<Record<string, string | null>>({
    monday: null,
    tuesday: null,
    wednesday: null,
    thursday: null,
    friday: null,
    saturday: null,
    sunday: null,
  });
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [loadingSchedule, setLoadingSchedule] = useState(false);
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [showBulkScheduleModal, setShowBulkScheduleModal] = useState(false);

  // Filters
  const [userFilterText, setUserFilterText] = useState('');
  const [groupFilterText, setGroupFilterText] = useState('');

  // Table preferences with localStorage persistence
  const [userSortedInfo, setUserSortedInfo] = useState<{ columnKey: string; order: 'ascend' | 'descend' } | null>(() => {
    try {
      const saved = localStorage.getItem('users-table-sort');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { columnKey: 'firstName', order: 'ascend' };
  });

  const [userPageSize, setUserPageSize] = useState(() => {
    try {
      const saved = localStorage.getItem('users-table-pageSize');
      if (saved) return parseInt(saved, 10);
    } catch (e) {}
    return 10;
  });

  const [groupSortedInfo, setGroupSortedInfo] = useState<{ columnKey: string; order: 'ascend' | 'descend' } | null>(() => {
    try {
      const saved = localStorage.getItem('groups-table-sort');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { columnKey: 'groupName', order: 'ascend' };
  });

  const [groupPageSize, setGroupPageSize] = useState(() => {
    try {
      const saved = localStorage.getItem('groups-table-pageSize');
      if (saved) return parseInt(saved, 10);
    } catch (e) {}
    return 10;
  });

  // Forms
  const [createUserForm] = Form.useForm();
  const [createGroupForm] = Form.useForm();
  const [editGroupForm] = Form.useForm();

  useEffect(() => {
    fetchUsers();
    fetchGroups();
    fetchAutoStartSetting();
  }, []);

  const fetchAutoStartSetting = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall('settings', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const settings = await response.json();
        setAutoStartEnabled(settings.autoStartEnabled === true);
      }
    } catch (error) {
      console.error('Error fetching auto-start setting:', error);
    }
  };

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('users', {
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await response.json();
      setUsers(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching users:', error);
      setAlert({ type: 'error', message: 'Failed to fetch users' });
    } finally {
      setLoading(false);
    }
  };

  const fetchGroups = async () => {
    try {
      setGroupsLoading(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('groups', {
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await response.json();
      setGroups(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching groups:', error);
    } finally {
      setGroupsLoading(false);
    }
  };

  // Filter users
  const filteredUsers = useMemo(() => {
    if (!userFilterText) return users;
    const searchText = userFilterText.toLowerCase();
    return users.filter(
      (u) =>
        u.firstName?.toLowerCase().includes(searchText) ||
        u.lastName?.toLowerCase().includes(searchText) ||
        u.email?.toLowerCase().includes(searchText) ||
        u.userId?.toLowerCase().includes(searchText) ||
        u.department?.toLowerCase().includes(searchText)
    );
  }, [users, userFilterText]);

  // Filter groups
  const filteredGroups = useMemo(() => {
    if (!groupFilterText) return groups;
    const searchText = groupFilterText.toLowerCase();
    return groups.filter(
      (g) =>
        g.groupName?.toLowerCase().includes(searchText) ||
        g.description?.toLowerCase().includes(searchText)
    );
  }, [groups, groupFilterText]);

  const selectedUsers = useMemo(() => {
    return users.filter((u) => selectedUserKeys.includes(u.userId));
  }, [users, selectedUserKeys]);

  const selectedGroups = useMemo(() => {
    return groups.filter((g) => selectedGroupKeys.includes(g.groupId));
  }, [groups, selectedGroupKeys]);


  // Handlers
  const handleUserTableChange = (pagination: any, filters: any, sorter: any) => {
    const newSort = sorter.order 
      ? { columnKey: sorter.columnKey || sorter.field, order: sorter.order }
      : null;
    setUserSortedInfo(newSort);
    try {
      if (newSort) {
        localStorage.setItem('users-table-sort', JSON.stringify(newSort));
      } else {
        localStorage.removeItem('users-table-sort');
      }
    } catch (e) {}
  };

  const handleUserPageSizeChange = (current: number, size: number) => {
    setUserPageSize(size);
    try {
      localStorage.setItem('users-table-pageSize', String(size));
    } catch (e) {}
  };

  const handleGroupTableChange = (pagination: any, filters: any, sorter: any) => {
    const newSort = sorter.order 
      ? { columnKey: sorter.columnKey || sorter.field, order: sorter.order }
      : null;
    setGroupSortedInfo(newSort);
    try {
      if (newSort) {
        localStorage.setItem('groups-table-sort', JSON.stringify(newSort));
      } else {
        localStorage.removeItem('groups-table-sort');
      }
    } catch (e) {}
  };

  const handleGroupPageSizeChange = (current: number, size: number) => {
    setGroupPageSize(size);
    try {
      localStorage.setItem('groups-table-pageSize', String(size));
    } catch (e) {}
  };

  const handleCreateUser = async () => {
    try {
      const values = await createUserForm.validateFields();
      setCreating(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(values),
      });

      if (response.ok) {
        setAlert({ type: 'success', message: 'User created successfully' });
        setShowCreateUserModal(false);
        createUserForm.resetFields();
        fetchUsers();
      } else {
        const errorData = await response.json();
        setAlert({ type: 'error', message: errorData.error || 'Failed to create user' });
      }
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to create user' });
    } finally {
      setCreating(false);
    }
  };

  const handleCreateGroup = async () => {
    try {
      const values = await createGroupForm.validateFields();
      setCreatingGroup(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(values),
      });

      if (response.ok) {
        setAlert({ type: 'success', message: 'Group created successfully' });
        setShowCreateGroupModal(false);
        createGroupForm.resetFields();
        fetchGroups();
      } else {
        const errorData = await response.json();
        setAlert({ type: 'error', message: errorData.error || 'Failed to create group' });
      }
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to create group' });
    } finally {
      setCreatingGroup(false);
    }
  };

  const handleEditGroup = async () => {
    if (!groupToEdit) return;
    try {
      const values = await editGroupForm.validateFields();
      setEditingGroup(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall(`groups/${groupToEdit.groupId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(values),
      });

      if (response.ok) {
        setAlert({ type: 'success', message: 'Group updated successfully' });
        setShowEditGroupModal(false);
        setGroupToEdit(null);
        setSelectedGroupKeys([]);
        fetchGroups();
      } else {
        const errorData = await response.json();
        setAlert({ type: 'error', message: errorData.error || 'Failed to update group' });
      }
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to update group' });
    } finally {
      setEditingGroup(false);
    }
  };

  const handleDeleteGroupCheck = async (group: Group) => {
    setGroupToDelete(group);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('workstations', {
        headers: { Authorization: `Bearer ${token}` },
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
      setShowDeleteGroupModal(true);
    }
  };

  const handleDeleteGroup = async () => {
    if (!groupToDelete) return;
    setDeletingGroup(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall(`groups/${groupToDelete.groupId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        setAlert({ type: 'success', message: 'Group deleted successfully' });
        setShowDeleteGroupModal(false);
        setGroupToDelete(null);
        setSelectedGroupKeys([]);
        fetchGroups();
      } else {
        const errorData = await response.json();
        setAlert({ type: 'error', message: errorData.error || 'Failed to delete group' });
      }
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to delete group' });
    } finally {
      setDeletingGroup(false);
    }
  };

  const handleDisableUsers = async () => {
    setProcessing(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('users/disable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userIds: selectedUsers.map((u) => u.userId) }),
      });

      if (response.ok) {
        setAlert({ type: 'success', message: `${selectedUsers.length} user(s) disabled` });
        setShowDisableModal(false);
        setSelectedUserKeys([]);
        fetchUsers();
      } else {
        const errorData = await response.json();
        setAlert({ type: 'error', message: errorData.error || 'Failed to disable users' });
      }
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to disable users' });
    } finally {
      setProcessing(false);
    }
  };

  const handleEnableUsers = async () => {
    setProcessing(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('users/enable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userIds: selectedUsers.map((u) => u.userId) }),
      });

      if (response.ok) {
        setAlert({ type: 'success', message: `${selectedUsers.length} user(s) enabled` });
        setShowEnableModal(false);
        setSelectedUserKeys([]);
        fetchUsers();
      } else {
        const errorData = await response.json();
        setAlert({ type: 'error', message: errorData.error || 'Failed to enable users' });
      }
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to enable users' });
    } finally {
      setProcessing(false);
    }
  };

  const handleDeleteUsers = async () => {
    setProcessing(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('users/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userIds: selectedUsers.map((u) => u.userId) }),
      });

      if (response.ok) {
        setAlert({ type: 'success', message: `${selectedUsers.length} user(s) deleted` });
        setShowDeleteUsersModal(false);
        setSelectedUserKeys([]);
        fetchUsers();
      } else {
        const errorData = await response.json();
        setAlert({ type: 'error', message: errorData.error || 'Failed to delete users' });
      }
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to delete users' });
    } finally {
      setProcessing(false);
    }
  };

  const handleSyncFromIdentityCenter = async () => {
    setSyncingUsers(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('users/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });

      const data = await response.json();

      if (response.ok) {
        setAlert({
          type: 'success',
          message: `Synced ${data.synced || 0} users, skipped ${data.skipped || 0} existing users`,
        });
        fetchUsers();
      } else {
        setAlert({ type: 'error', message: data.error || 'Failed to sync users' });
      }
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to sync users' });
    } finally {
      setSyncingUsers(false);
    }
  };

  const openManageGroupsModal = (userRecord: User) => {
    setSelectedUserForGroups(userRecord);
    const userGroupNames = userRecord.groups || [];
    const memberGroupIds = groups
      .filter((g) => userGroupNames.includes(g.groupName))
      .map((g) => g.groupId);
    setDesiredMemberships(memberGroupIds);
    setShowManageGroupsModal(true);
  };

  const handleSaveGroupMemberships = async () => {
    if (!selectedUserForGroups) return;
    setProcessing(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const userId = selectedUserForGroups.userId;
      const currentGroupNames = selectedUserForGroups.groups || [];
      const currentGroupIds = groups
        .filter((g) => currentGroupNames.includes(g.groupName))
        .map((g) => g.groupId);

      const groupsToAdd = desiredMemberships.filter((id) => !currentGroupIds.includes(id));
      const groupsToRemove = currentGroupIds.filter((id) => !desiredMemberships.includes(id));

      if (groupsToAdd.length > 0) {
        await apiCall('users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            userIds: [userId],
            groupIds: groupsToAdd,
          }),
        });
      }

      for (const groupId of groupsToRemove) {
        await apiCall('users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            action: 'removeFromGroups',
            userId: userId,
            groupIds: [groupId],
          }),
        });
      }

      setAlert({ type: 'success', message: 'Group memberships updated' });
      setShowManageGroupsModal(false);
      setSelectedUserForGroups(null);
      setSelectedUserKeys([]);
      fetchUsers();
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to update group memberships' });
    } finally {
      setProcessing(false);
    }
  };

  const openManageUsersModal = (group: Group) => {
    setSelectedGroupForUsers(group);
    const groupUserIds = users
      .filter((u) => u.groups && u.groups.includes(group.groupName))
      .map((u) => u.userId);
    setDesiredGroupUsers(groupUserIds);
    setManageUsersFilter('');
    setShowManageUsersModal(true);
  };

  const handleSaveGroupUsers = async () => {
    if (!selectedGroupForUsers) return;
    setProcessing(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const groupId = selectedGroupForUsers.groupId;
      const currentUserIds = users
        .filter((u) => u.groups && u.groups.includes(selectedGroupForUsers.groupName))
        .map((u) => u.userId);

      const usersToAdd = desiredGroupUsers.filter((id) => !currentUserIds.includes(id));
      const usersToRemove = currentUserIds.filter((id) => !desiredGroupUsers.includes(id));

      if (usersToAdd.length > 0) {
        await apiCall('users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            userIds: usersToAdd,
            groupIds: [groupId],
          }),
        });
      }

      for (const userId of usersToRemove) {
        await apiCall('users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            action: 'removeFromGroups',
            userId: userId,
            groupIds: [groupId],
          }),
        });
      }

      setAlert({ type: 'success', message: 'Group users updated' });
      setShowManageUsersModal(false);
      setSelectedGroupForUsers(null);
      setSelectedGroupKeys([]);
      fetchUsers();
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to update group users' });
    } finally {
      setProcessing(false);
    }
  };

  const filteredUsersForModal = useMemo(() => {
    if (!manageUsersFilter) return users;
    const filter = manageUsersFilter.toLowerCase();
    return users.filter(
      (u) =>
        u.firstName?.toLowerCase().includes(filter) ||
        u.lastName?.toLowerCase().includes(filter) ||
        u.email?.toLowerCase().includes(filter)
    );
  }, [users, manageUsersFilter]);

  // Schedule configuration functions
  const openScheduleModal = async (userRecord: User) => {
    setSelectedUserForSchedule(userRecord);
    setLoadingSchedule(true);
    setShowScheduleModal(true);
    
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall(`users/${encodeURIComponent(userRecord.userId)}/schedule`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const schedule = await response.json();
        setScheduleTimezone(schedule.timezone || 'America/New_York');
        setScheduleData(schedule.schedule || {
          monday: null,
          tuesday: null,
          wednesday: null,
          thursday: null,
          friday: null,
          saturday: null,
          sunday: null,
        });
      } else {
        // No schedule configured yet, use defaults
        setScheduleTimezone('America/New_York');
        setScheduleData({
          monday: null,
          tuesday: null,
          wednesday: null,
          thursday: null,
          friday: null,
          saturday: null,
          sunday: null,
        });
      }
    } catch (error) {
      console.error('Error loading schedule:', error);
      setScheduleTimezone('America/New_York');
      setScheduleData({
        monday: null,
        tuesday: null,
        wednesday: null,
        thursday: null,
        friday: null,
        saturday: null,
        sunday: null,
      });
    } finally {
      setLoadingSchedule(false);
    }
  };

  const handleSaveSchedule = async () => {
    if (!selectedUserForSchedule) return;
    setSavingSchedule(true);
    
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      // Determine if schedule is enabled based on whether any days are selected
      const hasSchedule = Object.values(scheduleData).some(time => time !== null);

      const response = await apiCall(`users/${encodeURIComponent(selectedUserForSchedule.userId)}/schedule`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          enabled: hasSchedule,
          timezone: scheduleTimezone,
          schedule: scheduleData,
        }),
      });

      if (response.ok) {
        setAlert({ type: 'success', message: 'Schedule saved successfully' });
        setShowScheduleModal(false);
        setSelectedUserForSchedule(null);
      } else {
        const errorData = await response.json();
        setAlert({ type: 'error', message: errorData.error || 'Failed to save schedule' });
      }
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to save schedule' });
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleScheduleDayChange = (day: string, time: string | null) => {
    setScheduleData(prev => ({
      ...prev,
      [day]: time,
    }));
  };

  const openBulkScheduleModal = () => {
    // Reset to defaults for bulk configuration
    setScheduleTimezone('America/New_York');
    setScheduleData({
      monday: null,
      tuesday: null,
      wednesday: null,
      thursday: null,
      friday: null,
      saturday: null,
      sunday: null,
    });
    setShowBulkScheduleModal(true);
  };

  const handleSaveBulkSchedule = async () => {
    if (selectedUsers.length === 0) return;
    setSavingSchedule(true);
    
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const hasSchedule = Object.values(scheduleData).some(time => time !== null);
      let successCount = 0;
      let failCount = 0;

      for (const user of selectedUsers) {
        try {
          const response = await apiCall(`users/${encodeURIComponent(user.userId)}/schedule`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              enabled: hasSchedule,
              timezone: scheduleTimezone,
              schedule: scheduleData,
            }),
          });

          if (response.ok) {
            successCount++;
          } else {
            failCount++;
          }
        } catch {
          failCount++;
        }
      }

      if (failCount === 0) {
        setAlert({ type: 'success', message: `Schedule configured for ${successCount} user(s)` });
      } else {
        setAlert({ type: 'warning', message: `Schedule configured for ${successCount} user(s), ${failCount} failed` });
      }
      
      setShowBulkScheduleModal(false);
      setSelectedUserKeys([]);
    } catch (error: any) {
      setAlert({ type: 'error', message: error.message || 'Failed to save schedules' });
    } finally {
      setSavingSchedule(false);
    }
  };


  // User action menu items
  const getUserActionMenuItems = (): MenuProps['items'] => {
    if (config?.useCognitoAuth) return [];
    return [
      {
        key: 'disable',
        label: 'Disable Users',
        icon: <StopOutlined />,
        onClick: () => setShowDisableModal(true),
      },
      {
        key: 'enable',
        label: 'Enable Users',
        icon: <CheckCircleOutlined />,
        onClick: () => setShowEnableModal(true),
      },
      { type: 'divider' },
      {
        key: 'delete',
        label: 'Delete Users',
        icon: <DeleteOutlined />,
        danger: true,
        onClick: () => setShowDeleteUsersModal(true),
      },
    ];
  };

  // Group action menu items
  const getGroupActionMenuItems = (): MenuProps['items'] => {
    return [
      {
        key: 'edit',
        label: 'Edit Group',
        icon: <EditOutlined />,
        onClick: () => {
          const group = selectedGroups[0];
          setGroupToEdit(group);
          editGroupForm.setFieldsValue({
            groupName: group.groupName,
            description: group.description || '',
          });
          setShowEditGroupModal(true);
        },
      },
      {
        key: 'manageUsers',
        label: 'Manage Users',
        icon: <UserOutlined />,
        onClick: () => openManageUsersModal(selectedGroups[0]),
      },
      { type: 'divider' },
      {
        key: 'delete',
        label: 'Delete Group',
        icon: <DeleteOutlined />,
        danger: true,
        onClick: () => handleDeleteGroupCheck(selectedGroups[0]),
      },
    ];
  };

  // User columns
  const userColumns: ColumnsType<User> = [
    {
      title: 'Name',
      key: 'name',
      width: 160,
      sorter: (a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`),
      sortOrder: userSortedInfo?.columnKey === 'name' ? userSortedInfo.order : null,
      render: (_, record) => (
        <Link onClick={() => (window.location.href = `/users/${record.userId}`)}>
          {record.firstName} {record.lastName}
        </Link>
      ),
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      width: 200,
      sorter: (a, b) => (a.email || '').localeCompare(b.email || ''),
      sortOrder: userSortedInfo?.columnKey === 'email' ? userSortedInfo.order : null,
      ellipsis: true,
    },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      width: 110,
      sorter: (a, b) => (a.role || 'User').localeCompare(b.role || 'User'),
      sortOrder: userSortedInfo?.columnKey === 'role' ? userSortedInfo.order : null,
      render: (role) => (
        <Tag color={role === 'Administrator' ? 'red' : 'blue'}>{role || 'User'}</Tag>
      ),
    },
    {
      title: 'Groups',
      key: 'groups',
      width: 160,
      render: (_, record) => {
        if (!record.groups || record.groups.length === 0) {
          return <Text type="secondary">No groups</Text>;
        }
        return (
          <Space size={4} wrap>
            {record.groups.slice(0, 2).map((group, idx) => (
              <Tag key={idx} color="blue">{group}</Tag>
            ))}
            {record.groups.length > 2 && (
              <Tag>+{record.groups.length - 2}</Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Status',
      key: 'status',
      width: 90,
      sorter: (a, b) => (a.enabled ? 1 : 0) - (b.enabled ? 1 : 0),
      sortOrder: userSortedInfo?.columnKey === 'status' ? userSortedInfo.order : null,
      render: (_, record) => (
        <Tag color={record.enabled ? 'green' : 'default'}>
          {record.enabled ? 'Active' : 'Disabled'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      render: (_, record) => (
        <Space size={4}>
          <Tooltip title="Manage Groups">
            <Button
              size="small"
              icon={<TeamOutlined />}
              onClick={() => openManageGroupsModal(record)}
            >
              Groups
            </Button>
          </Tooltip>
          {autoStartEnabled && (
            <Tooltip title="Configure Schedule">
              <Button
                size="small"
                icon={<ClockCircleOutlined />}
                onClick={() => openScheduleModal(record)}
              >
                Schedule
              </Button>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  // Group columns
  const groupColumns: ColumnsType<Group> = [
    {
      title: 'Group Name',
      dataIndex: 'groupName',
      key: 'groupName',
      sorter: (a, b) => a.groupName.localeCompare(b.groupName),
      sortOrder: groupSortedInfo?.columnKey === 'groupName' ? groupSortedInfo.order : null,
      render: (text, record) => (
        <Link onClick={() => (window.location.href = `/groups/${record.groupId}`)}>
          {text}
        </Link>
      ),
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (text) => text || '-',
    },
    {
      title: 'Members',
      key: 'members',
      width: 140,
      align: 'center' as const,
      sorter: (a, b) => {
        const aCount = users.filter((u) => u.groups && u.groups.includes(a.groupName)).length;
        const bCount = users.filter((u) => u.groups && u.groups.includes(b.groupName)).length;
        return aCount - bCount;
      },
      sortOrder: groupSortedInfo?.columnKey === 'members' ? groupSortedInfo.order : null,
      render: (_, record) => {
        const memberCount = users.filter(
          (u) => u.groups && u.groups.includes(record.groupName)
        ).length;
        return memberCount;
      },
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 120,
      sorter: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
      sortOrder: groupSortedInfo?.columnKey === 'createdAt' ? groupSortedInfo.order : null,
      render: (date) => (date ? new Date(date).toLocaleDateString() : '-'),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Button
          size="small"
          icon={<UserOutlined />}
          onClick={() => openManageUsersModal(record)}
        >
          Users
        </Button>
      ),
    },
  ];

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
            { title: 'Users & Groups' },
          ]}
        />

        {/* Header */}
        <Title level={3} style={{ marginBottom: 24 }}>User Management</Title>

        {alert && (
          <Alert
            type={alert.type}
            message={alert.message}
            closable
            onClose={() => setAlert(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        {config?.useCognitoAuth && (
          <Alert
            type="info"
            message="Users are managed through your Identity Provider. You can still manage group memberships and workstation assignments."
            style={{ marginBottom: 16 }}
          />
        )}

        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {/* Users Card */}
          <Card
            title={
              <Space>
                <UserOutlined />
                <span>Users ({filteredUsers.length})</span>
              </Space>
            }
            extra={
              <Space>
                <Tooltip title="Refresh">
                  <Button icon={<ReloadOutlined />} onClick={fetchUsers} loading={loading} />
                </Tooltip>
                <Button
                  onClick={() => {
                    if (selectedUsers.length === 1) {
                      window.location.href = `/users/${selectedUsers[0].userId}`;
                    }
                  }}
                  disabled={selectedUserKeys.length !== 1}
                >
                  Details
                </Button>
                {!config?.useCognitoAuth && (
                  <Dropdown
                    menu={{ items: getUserActionMenuItems() }}
                    disabled={selectedUserKeys.length === 0}
                  >
                    <Button disabled={selectedUserKeys.length === 0}>Edit Users</Button>
                  </Dropdown>
                )}
                <Button
                  disabled={selectedUserKeys.length !== 1}
                  onClick={() => openManageGroupsModal(selectedUsers[0])}
                >
                  Manage Groups
                </Button>
                {autoStartEnabled && (
                  <Button
                    icon={<ClockCircleOutlined />}
                    disabled={selectedUserKeys.length === 0}
                    onClick={openBulkScheduleModal}
                  >
                    Configure Schedules
                  </Button>
                )}
                <Button
                  icon={<SyncOutlined />}
                  loading={syncingUsers}
                  onClick={handleSyncFromIdentityCenter}
                >
                  Sync from Identity Center
                </Button>
                {!config?.useCognitoAuth && (
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => setShowCreateUserModal(true)}
                  >
                    Create User
                  </Button>
                )}
              </Space>
            }
            
          >
            <Space style={{ marginBottom: 16 }}>
              <Input.Search
                placeholder="Search users..."
                allowClear
                value={userFilterText}
                onChange={(e) => setUserFilterText(e.target.value)}
                style={{ width: 300 }}
              />
            </Space>

            <Table
              rowSelection={{
                selectedRowKeys: selectedUserKeys,
                onChange: setSelectedUserKeys,
              }}
              columns={userColumns}
              dataSource={filteredUsers}
              rowKey="userId"
              loading={loading}
              onChange={handleUserTableChange}
              pagination={{
                pageSize: userPageSize,
                showSizeChanger: true,
                pageSizeOptions: ['10', '20', '50'],
                onShowSizeChange: handleUserPageSizeChange,
                showTotal: (total) => `${total} users`,
              }}
              locale={{
                emptyText: loading ? null : (
                  <Space direction="vertical" align="center" style={{ padding: 24 }}>
                    <Text strong>No users</Text>
                    <Text type="secondary">No users to display.</Text>
                  </Space>
                ),
              }}
            />
          </Card>

          {/* Groups Card */}
          <Card
            title={
              <Space>
                <TeamOutlined />
                <span>Groups ({filteredGroups.length})</span>
              </Space>
            }
            extra={
              <Space>
                <Tooltip title="Refresh">
                  <Button icon={<ReloadOutlined />} onClick={fetchGroups} loading={groupsLoading} />
                </Tooltip>
                <Dropdown
                  menu={{ items: getGroupActionMenuItems() }}
                  disabled={selectedGroupKeys.length !== 1}
                >
                  <Button disabled={selectedGroupKeys.length !== 1}>Actions</Button>
                </Dropdown>
                <Button
                  disabled={selectedGroupKeys.length !== 1}
                  onClick={() => {
                    window.location.href = `/groups/${selectedGroups[0].groupId}`;
                  }}
                >
                  Details
                </Button>
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => setShowCreateGroupModal(true)}
                >
                  Create Group
                </Button>
              </Space>
            }
            
          >
            <Space style={{ marginBottom: 16 }}>
              <Input.Search
                placeholder="Search groups..."
                allowClear
                value={groupFilterText}
                onChange={(e) => setGroupFilterText(e.target.value)}
                style={{ width: 300 }}
              />
            </Space>

            <Table
              rowSelection={{
                selectedRowKeys: selectedGroupKeys,
                onChange: setSelectedGroupKeys,
              }}
              columns={groupColumns}
              dataSource={filteredGroups}
              rowKey="groupId"
              loading={groupsLoading}
              onChange={handleGroupTableChange}
              pagination={{
                pageSize: groupPageSize,
                showSizeChanger: true,
                pageSizeOptions: ['10', '20', '50'],
                onShowSizeChange: handleGroupPageSizeChange,
                showTotal: (total) => `${total} groups`,
              }}
              locale={{
                emptyText: groupsLoading ? null : (
                  <Space direction="vertical" align="center" style={{ padding: 24 }}>
                    <Text strong>No groups</Text>
                    <Text type="secondary">No groups to display.</Text>
                    <Button type="primary" onClick={() => setShowCreateGroupModal(true)}>
                      Create Group
                    </Button>
                  </Space>
                ),
              }}
            />
          </Card>
        </Space>
      </div>


      {/* Create User Modal */}
      <Modal
        title="Create New User"
        open={showCreateUserModal}
        onCancel={() => {
          setShowCreateUserModal(false);
          createUserForm.resetFields();
        }}
        onOk={handleCreateUser}
        confirmLoading={creating}
        okText="Create User"
      >
        <Form
          form={createUserForm}
          layout="vertical"
          initialValues={{ temporaryPassword: '', isAdmin: false }}
        >
          <Form.Item
            name="email"
            label="Email"
            rules={[
              { required: true, message: 'Please enter an email' },
              { type: 'email', message: 'Please enter a valid email' },
            ]}
          >
            <Input placeholder="user@example.com" />
          </Form.Item>
          <Form.Item
            name="firstName"
            label="First Name"
            rules={[{ required: true, message: 'Please enter first name' }]}
          >
            <Input placeholder="John" />
          </Form.Item>
          <Form.Item
            name="lastName"
            label="Last Name"
            rules={[{ required: true, message: 'Please enter last name' }]}
          >
            <Input placeholder="Doe" />
          </Form.Item>
          <Form.Item name="department" label="Department">
            <Input placeholder="Engineering" />
          </Form.Item>
          <Form.Item name="temporaryPassword" label="Temporary Password">
            <Input.Password placeholder="Temporary password" />
          </Form.Item>
          <Form.Item name="isAdmin" valuePropName="checked">
            <Checkbox>Administrator privileges</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      {/* Create Group Modal */}
      <Modal
        title="Create New Group"
        open={showCreateGroupModal}
        onCancel={() => {
          setShowCreateGroupModal(false);
          createGroupForm.resetFields();
        }}
        onOk={handleCreateGroup}
        confirmLoading={creatingGroup}
        okText="Create Group"
      >
        <Form form={createGroupForm} layout="vertical">
          <Form.Item
            name="groupName"
            label="Group Name"
            rules={[{ required: true, message: 'Please enter a group name' }]}
          >
            <Input placeholder="Editors" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input placeholder="Group for video editors" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit Group Modal */}
      <Modal
        title="Edit Group"
        open={showEditGroupModal}
        onCancel={() => {
          setShowEditGroupModal(false);
          setGroupToEdit(null);
        }}
        onOk={handleEditGroup}
        confirmLoading={editingGroup}
        okText="Save Changes"
      >
        <Form form={editGroupForm} layout="vertical">
          <Form.Item
            name="groupName"
            label="Group Name"
            rules={[{ required: true, message: 'Please enter a group name' }]}
          >
            <Input placeholder="Editors" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input placeholder="Group description" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Delete Group Warning Modal */}
      <Modal
        title="Cannot Delete Group"
        open={showDeleteGroupWarningModal}
        onCancel={() => {
          setShowDeleteGroupWarningModal(false);
          setGroupToDelete(null);
          setAssignedWorkstations([]);
        }}
        footer={[
          <Button
            key="close"
            onClick={() => {
              setShowDeleteGroupWarningModal(false);
              setGroupToDelete(null);
              setAssignedWorkstations([]);
            }}
          >
            Close
          </Button>,
        ]}
      >
        <Alert
          type="warning"
          message={`The group "${groupToDelete?.groupName}" cannot be deleted because it has workstations assigned to it.`}
          style={{ marginBottom: 16 }}
        />
        <div>
          <Text strong>Assigned Workstations:</Text>
          <ul>
            {assignedWorkstations.map((ws: any) => (
              <li key={ws.instanceId}>
                {ws.instanceId} - {ws.instanceType}
              </li>
            ))}
          </ul>
        </div>
        <Text>Please reassign or delete these workstations before deleting the group.</Text>
      </Modal>

      {/* Delete Group Confirmation Modal */}
      <Modal
        title="Delete Group"
        open={showDeleteGroupModal}
        onCancel={() => {
          setShowDeleteGroupModal(false);
          setGroupToDelete(null);
        }}
        onOk={handleDeleteGroup}
        confirmLoading={deletingGroup}
        okText="Delete Group"
        okButtonProps={{ danger: true }}
      >
        <Alert
          type="warning"
          message={`Are you sure you want to delete the group "${groupToDelete?.groupName}"?`}
          style={{ marginBottom: 16 }}
        />
        <div>
          <Text>This action will:</Text>
          <ul>
            <li>Remove the group from Directory Services</li>
            <li>Remove all users from this group</li>
            <li>Delete the group from the system</li>
          </ul>
          <Text strong>This action cannot be undone.</Text>
        </div>
      </Modal>

      {/* Disable Users Modal */}
      <Modal
        title="Disable Users"
        open={showDisableModal}
        onCancel={() => setShowDisableModal(false)}
        onOk={handleDisableUsers}
        confirmLoading={processing}
        okText="Disable Users"
      >
        <Text>Are you sure you want to disable the following {selectedUsers.length} user(s)?</Text>
        <ul>
          {selectedUsers.map((u) => (
            <li key={u.userId}>
              {u.email} - {u.firstName} {u.lastName}
            </li>
          ))}
        </ul>
      </Modal>

      {/* Enable Users Modal */}
      <Modal
        title="Enable Users"
        open={showEnableModal}
        onCancel={() => setShowEnableModal(false)}
        onOk={handleEnableUsers}
        confirmLoading={processing}
        okText="Enable Users"
      >
        <Text>Are you sure you want to enable the following {selectedUsers.length} user(s)?</Text>
        <ul>
          {selectedUsers.map((u) => (
            <li key={u.userId}>
              {u.email} - {u.firstName} {u.lastName}
            </li>
          ))}
        </ul>
      </Modal>

      {/* Delete Users Modal */}
      <Modal
        title="Delete Users"
        open={showDeleteUsersModal}
        onCancel={() => setShowDeleteUsersModal(false)}
        onOk={handleDeleteUsers}
        confirmLoading={processing}
        okText="Delete Users"
        okButtonProps={{ danger: true }}
      >
        <Alert
          type="warning"
          message="This action cannot be undone. The users will be permanently deleted."
          style={{ marginBottom: 16 }}
        />
        <Text>Are you sure you want to delete the following {selectedUsers.length} user(s)?</Text>
        <ul>
          {selectedUsers.map((u) => (
            <li key={u.userId}>
              {u.email} - {u.firstName} {u.lastName}
            </li>
          ))}
        </ul>
      </Modal>

      {/* Manage Groups Modal */}
      <Modal
        title={`Manage Groups - ${selectedUserForGroups?.firstName} ${selectedUserForGroups?.lastName}`}
        open={showManageGroupsModal}
        onCancel={() => {
          setShowManageGroupsModal(false);
          setSelectedUserForGroups(null);
          setDesiredMemberships([]);
        }}
        onOk={handleSaveGroupMemberships}
        confirmLoading={processing}
        okText="Save Changes"
        width={600}
      >
        <Text style={{ display: 'block', marginBottom: 16 }}>
          Toggle group memberships for this user:
        </Text>
        <Table
          size="small"
          pagination={false}
          dataSource={[...groups].sort((a, b) => a.groupName.localeCompare(b.groupName))}
          rowKey="groupId"
          columns={[
            {
              title: 'Group Name',
              dataIndex: 'groupName',
              key: 'groupName',
            },
            {
              title: 'Description',
              dataIndex: 'description',
              key: 'description',
              render: (text) => text || '-',
            },
            {
              title: 'Member',
              key: 'member',
              width: 80,
              render: (_, record) => (
                <Switch
                  checked={desiredMemberships.includes(record.groupId)}
                  onChange={(checked) => {
                    if (checked) {
                      setDesiredMemberships([...desiredMemberships, record.groupId]);
                    } else {
                      setDesiredMemberships(desiredMemberships.filter((id) => id !== record.groupId));
                    }
                  }}
                />
              ),
            },
          ]}
        />
      </Modal>

      {/* Manage Users Modal */}
      <Modal
        title={`Manage Users - ${selectedGroupForUsers?.groupName}`}
        open={showManageUsersModal}
        onCancel={() => {
          setShowManageUsersModal(false);
          setSelectedGroupForUsers(null);
          setDesiredGroupUsers([]);
          setManageUsersFilter('');
        }}
        onOk={handleSaveGroupUsers}
        confirmLoading={processing}
        okText="Save Changes"
        width={700}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Input.Search
            placeholder="Filter users by name or email..."
            allowClear
            value={manageUsersFilter}
            onChange={(e) => setManageUsersFilter(e.target.value)}
          />
          <Space>
            <Button onClick={() => setDesiredGroupUsers(filteredUsersForModal.map((u) => u.userId))}>
              Select All ({filteredUsersForModal.length})
            </Button>
            <Button onClick={() => setDesiredGroupUsers([])}>Deselect All</Button>
            <Text type="secondary">
              {desiredGroupUsers.length} of {filteredUsersForModal.length} users selected
            </Text>
          </Space>
          <Table
            size="small"
            pagination={{ pageSize: 10 }}
            dataSource={[...filteredUsersForModal].sort((a, b) =>
              a.firstName.localeCompare(b.firstName)
            )}
            rowKey="userId"
            columns={[
              {
                title: 'Name',
                key: 'name',
                render: (_, record) => `${record.firstName} ${record.lastName}`,
              },
              {
                title: 'Email',
                dataIndex: 'email',
                key: 'email',
              },
              {
                title: 'Member',
                key: 'member',
                width: 80,
                render: (_, record) => (
                  <Switch
                    checked={desiredGroupUsers.includes(record.userId)}
                    onChange={(checked) => {
                      if (checked) {
                        setDesiredGroupUsers([...desiredGroupUsers, record.userId]);
                      } else {
                        setDesiredGroupUsers(desiredGroupUsers.filter((id) => id !== record.userId));
                      }
                    }}
                  />
                ),
              },
            ]}
          />
        </Space>
      </Modal>

      {/* Schedule Configuration Modal */}
      <Modal
        title={`Configure Schedule - ${selectedUserForSchedule?.firstName} ${selectedUserForSchedule?.lastName}`}
        open={showScheduleModal}
        onCancel={() => {
          setShowScheduleModal(false);
          setSelectedUserForSchedule(null);
        }}
        onOk={handleSaveSchedule}
        confirmLoading={savingSchedule}
        okText="Save Schedule"
        width={500}
      >
        {loadingSchedule ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Text>Loading schedule...</Text>
          </div>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>Timezone</Text>
              <Select
                value={scheduleTimezone}
                onChange={(value) => setScheduleTimezone(value)}
                style={{ width: '100%' }}
                showSearch
                options={[
                  { value: 'America/New_York', label: 'Eastern Time (America/New_York)' },
                  { value: 'America/Chicago', label: 'Central Time (America/Chicago)' },
                  { value: 'America/Denver', label: 'Mountain Time (America/Denver)' },
                  { value: 'America/Los_Angeles', label: 'Pacific Time (America/Los_Angeles)' },
                  { value: 'America/Phoenix', label: 'Arizona (America/Phoenix)' },
                  { value: 'America/Anchorage', label: 'Alaska (America/Anchorage)' },
                  { value: 'Pacific/Honolulu', label: 'Hawaii (Pacific/Honolulu)' },
                  { value: 'Europe/London', label: 'London (Europe/London)' },
                  { value: 'Europe/Paris', label: 'Paris (Europe/Paris)' },
                  { value: 'Europe/Berlin', label: 'Berlin (Europe/Berlin)' },
                  { value: 'Asia/Tokyo', label: 'Tokyo (Asia/Tokyo)' },
                  { value: 'Asia/Shanghai', label: 'Shanghai (Asia/Shanghai)' },
                  { value: 'Asia/Singapore', label: 'Singapore (Asia/Singapore)' },
                  { value: 'Australia/Sydney', label: 'Sydney (Australia/Sydney)' },
                  { value: 'UTC', label: 'UTC' },
                ]}
              />
            </div>

            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>Weekly Schedule</Text>
              
              {/* Horizontal day selector */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
                {[
                  { key: 'sunday', label: 'S' },
                  { key: 'monday', label: 'M' },
                  { key: 'tuesday', label: 'T' },
                  { key: 'wednesday', label: 'W' },
                  { key: 'thursday', label: 'T' },
                  { key: 'friday', label: 'F' },
                  { key: 'saturday', label: 'S' },
                ].map(({ key, label }) => {
                  const isActive = !!scheduleData[key];
                  return (
                    <div
                      key={key}
                      onClick={() => {
                        if (isActive) {
                          handleScheduleDayChange(key, null);
                        } else {
                          handleScheduleDayChange(key, '09:00');
                        }
                      }}
                      style={{
                        width: 36,
                        minWidth: 36,
                        height: 36,
                        minHeight: 36,
                        borderRadius: '50%',
                        border: `2px solid ${isActive ? '#1890ff' : 'var(--ant-color-border, #d9d9d9)'}`,
                        backgroundColor: isActive ? '#1890ff' : 'var(--ant-color-bg-container, #fff)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        flexShrink: 0,
                      }}
                    >
                      <Text strong style={{ color: isActive ? '#fff' : 'var(--ant-color-text-secondary, #595959)', fontSize: 13 }}>
                        {label}
                      </Text>
                    </div>
                  );
                })}
                    
                {/* Quick action buttons inline */}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                      <Button
                        size="small"
                        type="link"
                        style={{ padding: '0 8px', fontSize: 12 }}
                        onClick={() => {
                          const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
                          const newData = { ...scheduleData };
                          weekdays.forEach(day => { newData[day] = '09:00'; });
                          ['saturday', 'sunday'].forEach(day => { newData[day] = null; });
                          setScheduleData(newData);
                        }}
                      >
                        Weekdays
                      </Button>
                      <Button
                        size="small"
                        type="link"
                        style={{ padding: '0 8px', fontSize: 12 }}
                        onClick={() => {
                          const allDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
                          const newData = { ...scheduleData };
                          allDays.forEach(day => { newData[day] = '09:00'; });
                          setScheduleData(newData);
                        }}
                      >
                        All
                      </Button>
                      <Button
                        size="small"
                        type="link"
                        style={{ padding: '0 8px', fontSize: 12 }}
                        onClick={() => {
                          setScheduleData({
                            sunday: null, monday: null, tuesday: null, wednesday: null,
                            thursday: null, friday: null, saturday: null,
                          });
                        }}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>

                  {/* Vertical list of start times for active days */}
                  {Object.entries(scheduleData).some(([_, time]) => time) && (
                    <div style={{ 
                      background: 'var(--ant-color-fill-quaternary, #fafafa)', 
                      borderRadius: 8, 
                      padding: 12,
                      border: '1px solid var(--ant-color-border-secondary, #f0f0f0)'
                    }}>
                      {[
                        { key: 'sunday', label: 'Sunday' },
                        { key: 'monday', label: 'Monday' },
                        { key: 'tuesday', label: 'Tuesday' },
                        { key: 'wednesday', label: 'Wednesday' },
                        { key: 'thursday', label: 'Thursday' },
                        { key: 'friday', label: 'Friday' },
                        { key: 'saturday', label: 'Saturday' },
                      ].filter(({ key }) => scheduleData[key]).map(({ key, label }, index, arr) => (
                        <div 
                          key={key} 
                          style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            justifyContent: 'space-between',
                            padding: '8px 0',
                            borderBottom: index < arr.length - 1 ? '1px solid var(--ant-color-border-secondary, #f0f0f0)' : 'none',
                          }}
                        >
                          <Text>{label}</Text>
                          <input
                            type="time"
                            value={scheduleData[key] || '09:00'}
                            onChange={(e) => handleScheduleDayChange(key, e.target.value)}
                            style={{
                              padding: '4px 8px',
                              borderRadius: 6,
                              border: '1px solid var(--ant-color-border, #d9d9d9)',
                              backgroundColor: 'var(--ant-color-bg-container, #fff)',
                              color: 'var(--ant-color-text, inherit)',
                              colorScheme: 'light dark',
                              fontSize: 14,
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {!Object.entries(scheduleData).some(([_, time]) => time) && (
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      Select days above to configure start times
                    </Text>
                  )}
            </div>
          </Space>
        )}
      </Modal>

      {/* Bulk Schedule Configuration Modal */}
      <Modal
        title={`Configure Schedules - ${selectedUsers.length} User(s)`}
        open={showBulkScheduleModal}
        onCancel={() => setShowBulkScheduleModal(false)}
        onOk={handleSaveBulkSchedule}
        confirmLoading={savingSchedule}
        okText="Apply to All"
        width={500}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Alert
            type="info"
            message={`This will apply the same schedule to ${selectedUsers.length} selected user(s).`}
            style={{ marginBottom: 8 }}
          />
          
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>Timezone</Text>
            <Select
              value={scheduleTimezone}
              onChange={(value) => setScheduleTimezone(value)}
              style={{ width: '100%' }}
              showSearch
              options={[
                { value: 'America/New_York', label: 'Eastern Time (America/New_York)' },
                { value: 'America/Chicago', label: 'Central Time (America/Chicago)' },
                { value: 'America/Denver', label: 'Mountain Time (America/Denver)' },
                { value: 'America/Los_Angeles', label: 'Pacific Time (America/Los_Angeles)' },
                { value: 'America/Phoenix', label: 'Arizona (America/Phoenix)' },
                { value: 'America/Anchorage', label: 'Alaska (America/Anchorage)' },
                { value: 'Pacific/Honolulu', label: 'Hawaii (Pacific/Honolulu)' },
                { value: 'Europe/London', label: 'London (Europe/London)' },
                { value: 'Europe/Paris', label: 'Paris (Europe/Paris)' },
                { value: 'Europe/Berlin', label: 'Berlin (Europe/Berlin)' },
                { value: 'Asia/Tokyo', label: 'Tokyo (Asia/Tokyo)' },
                { value: 'Asia/Shanghai', label: 'Shanghai (Asia/Shanghai)' },
                { value: 'Asia/Singapore', label: 'Singapore (Asia/Singapore)' },
                { value: 'Australia/Sydney', label: 'Sydney (Australia/Sydney)' },
                { value: 'UTC', label: 'UTC' },
              ]}
            />
          </div>

          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>Weekly Schedule</Text>
            
            {/* Horizontal day selector */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
              {[
                { key: 'sunday', label: 'S' },
                { key: 'monday', label: 'M' },
                { key: 'tuesday', label: 'T' },
                { key: 'wednesday', label: 'W' },
                { key: 'thursday', label: 'T' },
                { key: 'friday', label: 'F' },
                { key: 'saturday', label: 'S' },
              ].map(({ key, label }) => {
                const isActive = !!scheduleData[key];
                return (
                  <div
                    key={key}
                    onClick={() => {
                      if (isActive) {
                        handleScheduleDayChange(key, null);
                      } else {
                        handleScheduleDayChange(key, '09:00');
                      }
                    }}
                    style={{
                      width: 36,
                      minWidth: 36,
                      height: 36,
                      minHeight: 36,
                      borderRadius: '50%',
                      border: `2px solid ${isActive ? '#1890ff' : 'var(--ant-color-border, #d9d9d9)'}`,
                      backgroundColor: isActive ? '#1890ff' : 'var(--ant-color-bg-container, #fff)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      flexShrink: 0,
                    }}
                  >
                    <Text strong style={{ color: isActive ? '#fff' : 'var(--ant-color-text-secondary, #595959)', fontSize: 13 }}>
                      {label}
                    </Text>
                  </div>
                );
              })}
              
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <Button
                  size="small"
                  type="link"
                  style={{ padding: '0 8px', fontSize: 12 }}
                  onClick={() => {
                    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
                    const newData = { ...scheduleData };
                    weekdays.forEach(day => { newData[day] = '09:00'; });
                    ['saturday', 'sunday'].forEach(day => { newData[day] = null; });
                    setScheduleData(newData);
                  }}
                >
                  Weekdays
                </Button>
                <Button
                  size="small"
                  type="link"
                  style={{ padding: '0 8px', fontSize: 12 }}
                  onClick={() => {
                    const allDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
                    const newData = { ...scheduleData };
                    allDays.forEach(day => { newData[day] = '09:00'; });
                    setScheduleData(newData);
                  }}
                >
                  All
                </Button>
                <Button
                  size="small"
                  type="link"
                  style={{ padding: '0 8px', fontSize: 12 }}
                  onClick={() => {
                    setScheduleData({
                      sunday: null, monday: null, tuesday: null, wednesday: null,
                      thursday: null, friday: null, saturday: null,
                    });
                  }}
                >
                  Clear
                </Button>
              </div>
            </div>

            {/* Vertical list of start times for active days */}
            {Object.entries(scheduleData).some(([_, time]) => time) && (
              <div style={{ 
                background: 'var(--ant-color-fill-quaternary, #fafafa)', 
                borderRadius: 8, 
                padding: 12,
                border: '1px solid var(--ant-color-border-secondary, #f0f0f0)'
              }}>
                {[
                  { key: 'sunday', label: 'Sunday' },
                  { key: 'monday', label: 'Monday' },
                  { key: 'tuesday', label: 'Tuesday' },
                  { key: 'wednesday', label: 'Wednesday' },
                  { key: 'thursday', label: 'Thursday' },
                  { key: 'friday', label: 'Friday' },
                  { key: 'saturday', label: 'Saturday' },
                ].filter(({ key }) => scheduleData[key]).map(({ key, label }, index, arr) => (
                  <div 
                    key={key} 
                    style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'space-between',
                      padding: '8px 0',
                      borderBottom: index < arr.length - 1 ? '1px solid var(--ant-color-border-secondary, #f0f0f0)' : 'none',
                    }}
                  >
                    <Text>{label}</Text>
                    <input
                      type="time"
                      value={scheduleData[key] || '09:00'}
                      onChange={(e) => handleScheduleDayChange(key, e.target.value)}
                      style={{
                        padding: '4px 8px',
                        borderRadius: 6,
                        border: '1px solid var(--ant-color-border, #d9d9d9)',
                        backgroundColor: 'var(--ant-color-bg-container, #fff)',
                        color: 'var(--ant-color-text, inherit)',
                        colorScheme: 'light dark',
                        fontSize: 14,
                      }}
                    />
                  </div>
                ))}
              </div>
            )}

            {!Object.entries(scheduleData).some(([_, time]) => time) && (
              <Text type="secondary" style={{ fontSize: 13 }}>
                Select days above to configure start times. Clear all days to disable schedules.
              </Text>
            )}
          </div>
        </Space>
      </Modal>
    </AppLayoutAntd>
  );
};

export default UserManagementAntd;
