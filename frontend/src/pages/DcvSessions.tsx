// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useMemo } from 'react';
import {
  AppLayout,
  ContentLayout,
  Table,
  Header,
  Button,
  SpaceBetween,
  StatusIndicator,
  Box,
  Popover,
  TextFilter,
  Select,
  Toggle,
  CollectionPreferences,
  Pagination,
  BreadcrumbGroup,
  Grid,
  Link,
} from '@cloudscape-design/components';
import Navigation from '../components/Navigation';
import { apiCall } from '../utils/api';
import { getAuthToken } from '../utils/auth';

interface DcvSessionsProps {
  user: any;
  isAdmin: boolean;
  config?: any;
}

const DcvSessions: React.FC<DcvSessionsProps> = ({ user, isAdmin, config }) => {
  const [sessions, setSessions] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [loadBalancers, setLoadBalancers] = useState<any[]>([]);
  const [autoScalingGroups, setAutoScalingGroups] = useState<any[]>([]);
  const [workstationAssignments, setWorkstationAssignments] = useState<Record<string, string>>({});
  const [workstationAssignmentDisplays, setWorkstationAssignmentDisplays] = useState<Record<string, string>>({});
  const [instanceStates, setInstanceStates] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<any[]>([]);
  const [deletingSessions, setDeletingSessions] = useState(false);
  const [filteringText, setFilteringText] = useState('');
  const [stateFilter, setStateFilter] = useState<any>(null);
  const [platformFilter, setPlatformFilter] = useState<any>(null);
  const [noConnectionsFilter, setNoConnectionsFilter] = useState(false);
  const [sortingColumn, setSortingColumn] = useState({ sortingField: 'CreationTime', sortingDescending: true });
  const [sessionsPageIndex, setSessionsPageIndex] = useState(1);
  const [workstationsPageIndex, setWorkstationsPageIndex] = useState(1);

  // Filter options for Select dropdowns
  const stateOptions = [
    { label: 'All States', value: '' },
    { label: 'Ready', value: 'READY' },
    { label: 'Creating', value: 'CREATING' },
    { label: 'Deleting', value: 'DELETING' },
    { label: 'Unknown', value: 'UNKNOWN' }
  ];

  const platformOptions = [
    { label: 'All Platforms', value: '' },
    { label: 'Windows', value: 'windows' },
    { label: 'Linux', value: 'linux' },
    { label: 'macOS', value: 'macos' }
  ];

  const [preferences, setPreferences] = useState({
    pageSize: 10,
    wrapLines: false,
    stripedRows: true,
    contentDensity: 'comfortable',
    contentDisplay: [
      { id: 'id', visible: true },
      { id: 'name', visible: true },
      { id: 'owner', visible: true },
      { id: 'platform', visible: true },
      { id: 'instanceId', visible: true },
      { id: 'assignedUser', visible: true },
      { id: 'instanceState', visible: true },
      { id: 'type', visible: true },
      { id: 'state', visible: true },
      { id: 'connections', visible: true },
      { id: 'lastDisconnection', visible: true },
      { id: 'creationTime', visible: true },
    ],
    stickyColumns: { first: 0, last: 0 }
  });
  const [workstationsPreferences, setWorkstationsPreferences] = useState({
    pageSize: 10,
    wrapLines: false,
    stripedRows: true,
    contentDensity: 'comfortable' as 'comfortable' | 'compact',
    contentDisplay: [
      { id: 'id', visible: true },
      { id: 'instanceId', visible: true },
      { id: 'assignedUser', visible: true },
      { id: 'instanceState', visible: true },
      { id: 'availability', visible: true },
      { id: 'version', visible: true },
      { id: 'agentVersion', visible: true },
    ],
    stickyColumns: { first: 0, last: 0 }
  });

  useEffect(() => {
    loadData();
  }, []);

  // Reset to first page when filtering changes
  useEffect(() => {
    setSessionsPageIndex(1);
  }, [filteringText, stateFilter, platformFilter, noConnectionsFilter]);

  const loadData = async () => {
    try {
      setLoading(true);
      
      const token = getAuthToken();
      if (!token) throw new Error('No current user');
      
      // Load sessions, servers, and load balancers
      const [sessionsResponse, serversResponse, loadBalancersResponse, autoScalingGroupsResponse, workstationAssignmentsResponse, instanceStatesResponse] = await Promise.all([
        apiCall('/dcv', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ action: 'describe-sessions' })
        }),
        apiCall('/dcv', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ action: 'describe-servers' })
        }),
        apiCall('/dcv', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ action: 'get-load-balancers' })
        }),
        apiCall('/dcv', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ action: 'get-autoscaling-groups' })
        }),
        apiCall('/dcv', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ action: 'get-workstation-assignments' })
        }),
        apiCall('/dcv', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ action: 'get-instance-states' })
        })
      ]);

      const sessionsData = await sessionsResponse.json();
      const serversData = await serversResponse.json();
      const loadBalancersData = await loadBalancersResponse.json();
      const autoScalingGroupsData = await autoScalingGroupsResponse.json();
      const workstationAssignmentsData = await workstationAssignmentsResponse.json();
      const instanceStatesData = await instanceStatesResponse.json();

      setSessions(sessionsData.Sessions || []);
      setServers(serversData.Servers || []);
      setLoadBalancers(loadBalancersData.LoadBalancers || []);
      setAutoScalingGroups(autoScalingGroupsData.AutoScalingGroups || []);
      setWorkstationAssignments(workstationAssignmentsData.Assignments || {});
      setWorkstationAssignmentDisplays(workstationAssignmentsData.AssignmentDisplays || {});
      setInstanceStates(instanceStatesData.InstanceStates || {});
      
      // Debug logging
      console.log('DCV Data loaded:', {
        sessionsCount: (sessionsData.Sessions || []).length,
        serversCount: (serversData.Servers || []).length,
        sampleSession: sessionsData.Sessions?.[0],
        sampleServer: serversData.Servers?.[0],
        assignmentsCount: Object.keys(workstationAssignmentsData.Assignments || {}).length,
        instanceStatesCount: Object.keys(instanceStatesData.InstanceStates || {}).length
      });
    } catch (error) {
      console.error('Failed to load DCV data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const handleDeleteSessions = async () => {
    if (selectedSessions.length === 0) return;
    
    setDeletingSessions(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      // Delete sessions one by one
      for (const session of selectedSessions) {
        await apiCall('/dcv', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ 
            action: 'delete-session',
            sessionId: session.Id
          })
        });
      }

      // Refresh data and clear selection
      await loadData();
      setSelectedSessions([]);
    } catch (error) {
      console.error('Failed to delete sessions:', error);
    } finally {
      setDeletingSessions(false);
    }
  };

  const getServerInfo = (serverId: string) => {
    // First try to match by server Id
    let server = servers.find(s => s.Id === serverId);
    if (server) return server;
    
    // If no match by Id, the serverId might actually be a hostname or IP
    // (DCV Session API returns Server with Hostname/Ip but not always Id)
    server = servers.find(s => s.Hostname === serverId || s.Ip === serverId);
    return server;
  };

  // Get server info from session - handles different data structures
  const getServerFromSession = (session: any) => {
    const sessionServer = session.Server;
    if (!sessionServer) return null;
    
    // Try matching by Server.Id first (if present)
    if (sessionServer.Id) {
      const server = servers.find(s => s.Id === sessionServer.Id);
      if (server) return server;
    }
    
    // Try matching by Hostname
    if (sessionServer.Hostname) {
      const server = servers.find(s => s.Hostname === sessionServer.Hostname);
      if (server) return server;
    }
    
    // Try matching by IP
    if (sessionServer.Ip) {
      const server = servers.find(s => s.Ip === sessionServer.Ip);
      if (server) return server;
    }
    
    return null;
  };

  const getStatusIndicator = (state: string, substate?: string) => {
    const formatSubstate = (sub: string) => {
      switch (sub) {
        case 'SESSION_PLACING':
          return 'Waiting to be placed on an available DCV Server';
        case 'PENDING_PREPARATION':
          return 'Session created but not yet usable';
        default:
          return sub;
      }
    };

    let indicator;
    switch (state) {
      case 'READY':
        indicator = <StatusIndicator type="success">Ready</StatusIndicator>;
        break;
      case 'CREATING':
        indicator = <StatusIndicator type="in-progress">Creating</StatusIndicator>;
        break;
      case 'DELETING':
        indicator = <StatusIndicator type="in-progress">Deleting</StatusIndicator>;
        break;
      case 'DELETED':
        indicator = <StatusIndicator type="stopped">Deleted</StatusIndicator>;
        break;
      case 'UNKNOWN':
        indicator = <StatusIndicator type="warning">Unknown</StatusIndicator>;
        break;
      default:
        indicator = <StatusIndicator type="error">{state}</StatusIndicator>;
    }

    // If there's a substate, wrap in a popover
    if (substate) {
      return (
        <Popover
          header="Session Substate"
          content={formatSubstate(substate)}
        >
          {indicator}
        </Popover>
      );
    }

    return indicator;
  };

  // Filter and sort sessions
  const processedSessions = useMemo(() => {
    let filtered = [...sessions];

    // Apply text filter (searches name, owner, session ID, instance ID, assigned user)
    if (filteringText) {
      const searchText = filteringText.toLowerCase();
      filtered = filtered.filter(session => {
        const server = getServerFromSession(session);
        const instanceId = server?.Host?.Aws?.EC2InstanceId || '';
        const assignedUser = instanceId ? workstationAssignmentDisplays[instanceId] || workstationAssignments[instanceId] || '' : '';
        
        return (
          session.Id?.toLowerCase().includes(searchText) ||
          session.Name?.toLowerCase().includes(searchText) ||
          session.Owner?.toLowerCase().includes(searchText) ||
          instanceId.toLowerCase().includes(searchText) ||
          assignedUser.toLowerCase().includes(searchText)
        );
      });
    }

    // Apply state filter
    if (stateFilter?.value) {
      filtered = filtered.filter(session => session.State === stateFilter.value);
    }

    // Apply platform filter
    if (platformFilter?.value) {
      filtered = filtered.filter(session => {
        const server = getServerFromSession(session);
        const osFamily = server?.Host?.Os?.Family?.toLowerCase();
        // Handle macos/darwin
        if (platformFilter.value === 'macos') {
          return osFamily === 'macos' || osFamily === 'darwin';
        }
        return osFamily === platformFilter.value;
      });
    }

    // Apply no connections filter
    if (noConnectionsFilter) {
      filtered = filtered.filter(session => (session.NumOfConnections || 0) === 0);
    }

    // Apply sorting
    if (sortingColumn.sortingField) {
      filtered.sort((a, b) => {
        let aVal: any = a[sortingColumn.sortingField];
        let bVal: any = b[sortingColumn.sortingField];
        
        // Handle custom sorting fields
        if (sortingColumn.sortingField === 'assignedUser') {
          const serverA = servers.find(s => s.Id === a.Server?.Id || s.Hostname === a.Server?.Hostname || s.Ip === a.Server?.Ip);
          const serverB = servers.find(s => s.Id === b.Server?.Id || s.Hostname === b.Server?.Hostname || s.Ip === b.Server?.Ip);
          const instanceIdA = serverA?.Host?.Aws?.EC2InstanceId;
          const instanceIdB = serverB?.Host?.Aws?.EC2InstanceId;
          aVal = instanceIdA ? workstationAssignmentDisplays[instanceIdA] || workstationAssignments[instanceIdA] || 'Unassigned' : 'Unknown';
          bVal = instanceIdB ? workstationAssignmentDisplays[instanceIdB] || workstationAssignments[instanceIdB] || 'Unassigned' : 'Unknown';
        } else if (sortingColumn.sortingField === 'instanceState') {
          const serverA = servers.find(s => s.Id === a.Server?.Id || s.Hostname === a.Server?.Hostname || s.Ip === a.Server?.Ip);
          const serverB = servers.find(s => s.Id === b.Server?.Id || s.Hostname === b.Server?.Hostname || s.Ip === b.Server?.Ip);
          const instanceIdA = serverA?.Host?.Aws?.EC2InstanceId;
          const instanceIdB = serverB?.Host?.Aws?.EC2InstanceId;
          aVal = instanceIdA ? instanceStates[instanceIdA] || 'unknown' : 'unknown';
          bVal = instanceIdB ? instanceStates[instanceIdB] || 'unknown' : 'unknown';
        } else if (sortingColumn.sortingField === 'platform') {
          const serverA = servers.find(s => s.Id === a.Server?.Id || s.Hostname === a.Server?.Hostname || s.Ip === a.Server?.Ip);
          const serverB = servers.find(s => s.Id === b.Server?.Id || s.Hostname === b.Server?.Hostname || s.Ip === b.Server?.Ip);
          aVal = serverA?.Host?.Os?.Family || 'unknown';
          bVal = serverB?.Host?.Os?.Family || 'unknown';
        } else if (sortingColumn.sortingField === 'CreationTime' || sortingColumn.sortingField === 'LastDisconnectionTime') {
          aVal = aVal ? new Date(aVal).getTime() : 0;
          bVal = bVal ? new Date(bVal).getTime() : 0;
        }
        
        if (aVal < bVal) return sortingColumn.sortingDescending ? 1 : -1;
        if (aVal > bVal) return sortingColumn.sortingDescending ? -1 : 1;
        return 0;
      });
    }

    return filtered;
  }, [sessions, filteringText, stateFilter, platformFilter, noConnectionsFilter, sortingColumn, servers, workstationAssignments, workstationAssignmentDisplays, instanceStates]);

  // Paginated sessions
  const paginatedSessions = useMemo(() => {
    const pageSize = preferences.pageSize || 10;
    const startIndex = (sessionsPageIndex - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return processedSessions.slice(startIndex, endIndex);
  }, [processedSessions, sessionsPageIndex, preferences.pageSize]);

  const sessionsTotalPages = Math.ceil(processedSessions.length / (preferences.pageSize || 10));

  // Paginated workstations (servers)
  const paginatedServers = useMemo(() => {
    const pageSize = workstationsPreferences.pageSize || 10;
    const startIndex = (workstationsPageIndex - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return servers.slice(startIndex, endIndex);
  }, [servers, workstationsPageIndex, workstationsPreferences.pageSize]);

  const workstationsTotalPages = Math.ceil(servers.length / (workstationsPreferences.pageSize || 10));

  // Workstations column definitions
  const workstationColumnDefinitions = useMemo(() => [
    {
      id: 'id',
      header: 'Server ID',
      cell: (item: any) => (
        <Popover
          header="Full Server ID"
          content={item.Id}
        >
          {item.Id.substring(0, 20)}...
        </Popover>
      ),
    },
    {
      id: 'instanceId',
      header: 'Instance ID',
      cell: (item: any) => {
        const instanceId = item.Host?.Aws?.EC2InstanceId;
        if (!instanceId) return 'Unknown';
        return (
          <Link 
            variant="primary"
            onFollow={(event) => {
              event.preventDefault();
              window.location.href = `/workstations/${instanceId}`;
            }}
          >
            {instanceId}
          </Link>
        );
      },
    },
    {
      id: 'assignedUser',
      header: 'Assigned User',
      cell: (item: any) => {
        const instanceId = item.Host?.Aws?.EC2InstanceId;
        const assignedUser = instanceId ? workstationAssignmentDisplays[instanceId] || workstationAssignments[instanceId] : null;
        return assignedUser || 'Unassigned';
      },
    },
    {
      id: 'instanceState',
      header: 'Instance State',
      cell: (item: any) => {
        const instanceId = item.Host?.Aws?.EC2InstanceId;
        const state = instanceId ? instanceStates[instanceId] : null;
        
        if (!state) return 'Unknown';
        
        let indicatorType: 'success' | 'error' | 'warning' | 'info' = 'info';
        if (state === 'running') indicatorType = 'success';
        else if (state === 'stopped') indicatorType = 'error';
        else if (state === 'stopping' || state === 'pending') indicatorType = 'warning';
        
        return (
          <StatusIndicator type={indicatorType}>
            {state.charAt(0).toUpperCase() + state.slice(1)}
          </StatusIndicator>
        );
      },
    },
    {
      id: 'availability',
      header: 'Session Availability',
      cell: (item: any) => {
        if (item.Availability === 'AVAILABLE') {
          return <StatusIndicator type="success">Available for new sessions</StatusIndicator>;
        } else {
          const reason = item.UnavailabilityReason || 'Unknown reason';
          return (
            <Popover
              header="Cannot create new sessions"
              content={reason}
            >
              <StatusIndicator type="error">
                No new sessions
              </StatusIndicator>
            </Popover>
          );
        }
      },
    },
    {
      id: 'version',
      header: 'DCV Version',
      cell: (item: any) => item.Version || 'Unknown',
    },
    {
      id: 'agentVersion',
      header: 'Session Manager Agent',
      cell: (item: any) => item.SessionManagerAgentVersion || 'Unknown',
    },
  ], [workstationAssignments, workstationAssignmentDisplays, instanceStates]);

  const visibleWorkstationColumns = useMemo(() => {
    return workstationsPreferences.contentDisplay
      .filter(item => item.visible)
      .map(item => workstationColumnDefinitions.find(col => col.id === item.id))
      .filter(Boolean);
  }, [workstationsPreferences.contentDisplay, workstationColumnDefinitions]);

  const sessionColumnDefinitions = useMemo(() => [
    {
      id: 'id',
      header: 'Session ID',
      cell: (item: any) => (
        <Popover
          header="Full Session ID"
          content={item.Id}
        >
          {item.Id.substring(0, 20)}...
        </Popover>
      ),
      sortingField: 'Id',
    },
    {
      id: 'name',
      header: 'Name',
      cell: (item: any) => item.Name || '-',
      sortingField: 'Name',
    },
    {
      id: 'owner',
      header: 'Owner',
      cell: (item: any) => item.Owner,
      sortingField: 'Owner',
    },
    {
      id: 'platform',
      header: 'Platform',
      cell: (item: any) => {
        const server = getServerFromSession(item);
        const osFamily = server?.Host?.Os?.Family;
        if (!osFamily) return 'Unknown';
        
        // Handle macOS/darwin naming
        if (osFamily === 'macos' || osFamily === 'darwin') {
          return 'macOS';
        }
        
        // Capitalize first letter for windows/linux
        return osFamily.charAt(0).toUpperCase() + osFamily.slice(1);
      },
      sortingField: 'platform',
    },
    {
      id: 'type',
      header: 'Type',
      cell: (item: any) => item.Type,
      sortingField: 'Type',
    },
    {
      id: 'state',
      header: 'State',
      cell: (item: any) => getStatusIndicator(item.State, item.Substate),
      sortingField: 'State',
    },
    {
      id: 'connections',
      header: 'Connections',
      cell: (item: any) => item.NumOfConnections || 0,
      sortingField: 'NumOfConnections',
    },
    {
      id: 'lastDisconnection',
      header: 'Last Disconnection',
      cell: (item: any) => item.LastDisconnectionTime ? new Date(item.LastDisconnectionTime).toLocaleString() : 'Never',
      sortingField: 'LastDisconnectionTime',
    },
    {
      id: 'instanceId',
      header: 'Instance ID',
      cell: (item: any) => {
        const server = getServerFromSession(item);
        const instanceId = server?.Host?.Aws?.EC2InstanceId;
        if (!instanceId || instanceId === 'Unknown') {
          return 'Unknown';
        }
        return (
          <Link 
            variant="primary"
            onFollow={(event) => {
              event.preventDefault();
              window.location.href = `/workstations/${instanceId}`;
            }}
          >
            {instanceId}
          </Link>
        );
      },
      sortingField: 'Server',
    },
    {
      id: 'assignedUser',
      header: 'Assigned User',
      cell: (item: any) => {
        const server = getServerFromSession(item);
        const instanceId = server?.Host?.Aws?.EC2InstanceId;
        const assignedUser = instanceId ? workstationAssignmentDisplays[instanceId] || workstationAssignments[instanceId] : null;
        return assignedUser || 'Unassigned';
      },
      sortingField: 'assignedUser',
    },
    {
      id: 'instanceState',
      header: 'Instance State',
      cell: (item: any) => {
        const server = getServerFromSession(item);
        const instanceId = server?.Host?.Aws?.EC2InstanceId;
        const state = instanceId ? instanceStates[instanceId] : null;
        
        if (!state) return 'Unknown';
        
        let indicatorType: 'success' | 'error' | 'warning' | 'info' = 'info';
        if (state === 'running') indicatorType = 'success';
        else if (state === 'stopped') indicatorType = 'error';
        else if (state === 'stopping' || state === 'pending') indicatorType = 'warning';
        
        return (
          <StatusIndicator type={indicatorType}>
            {state.charAt(0).toUpperCase() + state.slice(1)}
          </StatusIndicator>
        );
      },
      sortingField: 'instanceState',
    },
    {
      id: 'creationTime',
      header: 'Created',
      cell: (item: any) => item.CreationTime ? new Date(item.CreationTime).toLocaleString() : 'Unknown',
      sortingField: 'CreationTime',
    },
  ], [servers, workstationAssignments, workstationAssignmentDisplays, instanceStates]);

  const visibleColumns = useMemo(() => {
    return preferences.contentDisplay
      .filter(item => item.visible)
      .map(item => sessionColumnDefinitions.find(col => col.id === item.id))
      .filter(Boolean);
  }, [preferences.contentDisplay, sessionColumnDefinitions]);

  return (
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
                { text: 'DCV Sessions' }
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
                    DCV Session Management
                  </Box>
                  <Box
                    variant="p"
                    color="text-body-secondary"
                    margin={{ top: "xxs", bottom: "s" }}
                  >
                    Monitor and manage DCV sessions, servers, and connection status across your workstation infrastructure.
                  </Box>
                </div>
              </Grid>
              </div>
            </Box>
          }
                    loading={refreshing}
        >
      <SpaceBetween size="l">

          <Table
            columnDefinitions={visibleColumns}
            items={paginatedSessions}
            loading={loading}
            loadingText="Loading DCV sessions..."
            selectedItems={selectedSessions}
            onSelectionChange={({ detail }) => setSelectedSessions(detail.selectedItems)}
            selectionType="multi"
            sortingColumn={sortingColumn}
            sortingDescending={sortingColumn.sortingDescending}
            onSortingChange={({ detail }) => {
              setSortingColumn({
                sortingField: detail.sortingColumn.sortingField,
                sortingDescending: detail.isDescending || false
              });
            }}
            pagination={
              sessionsTotalPages > 1 ? (
                <Pagination
                  currentPageIndex={sessionsPageIndex}
                  pagesCount={sessionsTotalPages}
                  onChange={({ detail }) => setSessionsPageIndex(detail.currentPageIndex)}
                />
              ) : null
            }
            preferences={
              <CollectionPreferences
                title="Preferences"
                confirmLabel="Confirm"
                cancelLabel="Cancel"
                preferences={preferences}
                onConfirm={({ detail }) => {
                  setPreferences(detail);
                  setSessionsPageIndex(1);
                }}
                pageSizePreference={{
                  title: "Page size",
                  options: [
                    { value: 10, label: "10 sessions" },
                    { value: 20, label: "20 sessions" },
                    { value: 50, label: "50 sessions" }
                  ]
                }}
                wrapLinesPreference={{
                  label: "Wrap lines",
                  description: "Check to see all the text and wrap the lines"
                }}
                stripedRowsPreference={{
                  label: "Striped rows",
                  description: "Check to add alternating shaded rows"
                }}
                contentDensityPreference={{
                  label: "Compact mode",
                  description: "Check to display content in a denser, more compact mode"
                }}
                contentDisplayPreference={{
                  title: "Column preferences",
                  description: "Customize which columns are shown and in what order.",
                  options: [
                    { id: 'id', label: 'Session ID', alwaysVisible: true },
                    { id: 'name', label: 'Name' },
                    { id: 'owner', label: 'Owner' },
                    { id: 'platform', label: 'Platform' },
                    { id: 'instanceId', label: 'Instance ID' },
                    { id: 'assignedUser', label: 'Assigned User' },
                    { id: 'instanceState', label: 'Instance State' },
                    { id: 'type', label: 'Type' },
                    { id: 'state', label: 'State' },
                    { id: 'connections', label: 'Connections' },
                    { id: 'lastDisconnection', label: 'Last Disconnection' },
                    { id: 'creationTime', label: 'Created' }
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
                  filteringPlaceholder="Search by name, ID, owner, or user"
                  filteringAriaLabel="Filter sessions"
                  onChange={({ detail }) => setFilteringText(detail.filteringText)}
                />
                <Select
                  selectedOption={stateFilter}
                  onChange={({ detail }) => setStateFilter(detail.selectedOption)}
                  options={stateOptions}
                  placeholder="State"
                  selectedAriaLabel="Selected state"
                />
                <Select
                  selectedOption={platformFilter}
                  onChange={({ detail }) => setPlatformFilter(detail.selectedOption)}
                  options={platformOptions}
                  placeholder="Platform"
                  selectedAriaLabel="Selected platform"
                />
                <Toggle
                  checked={noConnectionsFilter}
                  onChange={({ detail }) => setNoConnectionsFilter(detail.checked)}
                >
                  No connections
                </Toggle>
              </SpaceBetween>
            }
            empty={
              <Box textAlign="center" color="inherit">
                <b>No DCV sessions found</b>
                <Box padding={{ bottom: 's' }} variant="p" color="inherit">
                  No active DCV sessions are currently available.
                </Box>
              </Box>
            }
            header={
              <Header
                counter={selectedSessions.length > 0 ? `(${selectedSessions.length}/${processedSessions.length})` : `(${processedSessions.length})`}
                description="Active DCV sessions across all servers"
                actions={
                  isAdmin ? (
                    <Button
                      variant="primary"
                      disabled={selectedSessions.length === 0}
                      loading={deletingSessions}
                      onClick={handleDeleteSessions}
                    >
                      Delete Selected ({selectedSessions.length})
                    </Button>
                  ) : null
                }
              >
                Sessions
              </Header>
            }
          />

          <Table
            columnDefinitions={visibleWorkstationColumns}
            items={paginatedServers}
            loading={loading}
            loadingText="Loading DCV servers..."
            pagination={
              workstationsTotalPages > 1 ? (
                <Pagination
                  currentPageIndex={workstationsPageIndex}
                  pagesCount={workstationsTotalPages}
                  onChange={({ detail }) => setWorkstationsPageIndex(detail.currentPageIndex)}
                />
              ) : null
            }
            preferences={
              <CollectionPreferences
                title="Preferences"
                confirmLabel="Confirm"
                cancelLabel="Cancel"
                preferences={workstationsPreferences}
                onConfirm={({ detail }) => {
                  setWorkstationsPreferences(detail as typeof workstationsPreferences);
                  setWorkstationsPageIndex(1);
                }}
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
                  description: "Check to see all the text and wrap the lines"
                }}
                stripedRowsPreference={{
                  label: "Striped rows",
                  description: "Check to add alternating shaded rows"
                }}
                contentDensityPreference={{
                  label: "Compact mode",
                  description: "Check to display content in a denser, more compact mode"
                }}
                contentDisplayPreference={{
                  title: "Column preferences",
                  description: "Customize which columns are shown and in what order.",
                  options: [
                    { id: 'id', label: 'Server ID' },
                    { id: 'instanceId', label: 'Instance ID', alwaysVisible: true },
                    { id: 'assignedUser', label: 'Assigned User' },
                    { id: 'instanceState', label: 'Instance State' },
                    { id: 'availability', label: 'Session Availability' },
                    { id: 'version', label: 'DCV Version' },
                    { id: 'agentVersion', label: 'Session Manager Agent' }
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
                <b>No DCV servers found</b>
                <Box padding={{ bottom: 's' }} variant="p" color="inherit">
                  No DCV servers are currently registered.
                </Box>
              </Box>
            }
            header={
              <Header
                counter={`(${servers.length})`}
                description="DCV workstations registered with Session Manager"
              >
                Workstations
              </Header>
            }
          />

          <Table
            columnDefinitions={[
              {
                id: 'name',
                header: 'Name',
                cell: (item: any) => item.Name,
              },
              {
                id: 'region',
                header: 'Region',
                cell: (item: any) => item.Region || 'Unknown',
              },
              {
                id: 'type',
                header: 'Type',
                cell: (item: any) => item.Type,
              },
              {
                id: 'endpoint',
                header: 'Endpoint',
                cell: (item: any) => item.Endpoint,
              },
              {
                id: 'targets',
                header: 'Target Health',
                cell: (item: any) => {
                  const status = item.HealthStatus || 'Unknown';
                  const healthy = item.HealthyTargets || 0;
                  const total = item.TotalTargets || 0;
                  
                  let indicatorType = 'info';
                  if (status === 'Healthy') indicatorType = 'success';
                  else if (status === 'Degraded') indicatorType = 'warning';
                  else if (status === 'Unhealthy') indicatorType = 'error';
                  
                  return (
                    <StatusIndicator type={indicatorType}>
                      {healthy}/{total} healthy
                    </StatusIndicator>
                  );
                },
              },
              {
                id: 'port',
                header: 'Port',
                cell: (item: any) => item.Port,
              },
              {
                id: 'protocol',
                header: 'Protocol',
                cell: (item: any) => item.Protocol,
              },
            ]}
            items={loadBalancers}
            loading={loading}
            loadingText="Loading load balancers..."
            empty={
              <Box textAlign="center" color="inherit">
                <b>No load balancers found</b>
                <Box padding={{ bottom: 's' }} variant="p" color="inherit">
                  No load balancers are currently configured.
                </Box>
              </Box>
            }
            header={
              <Header
                counter={`(${loadBalancers.length})`}
                description="Network load balancers used by DCV infrastructure"
              >
                Load Balancers
              </Header>
            }
          />

          <Table
            columnDefinitions={[
              {
                id: 'name',
                header: 'Auto Scaling Group',
                cell: (item: any) => item.AutoScalingGroupName,
              },
              {
                id: 'instances',
                header: 'Instances',
                cell: (item: any) => {
                  const healthy = item.HealthyInstances || 0;
                  const total = item.TotalInstances || 0;
                  
                  let indicatorType = 'info';
                  if (item.HealthStatus === 'Healthy') indicatorType = 'success';
                  else if (item.HealthStatus === 'Partially healthy') indicatorType = 'warning';
                  else if (item.HealthStatus === 'Unhealthy') indicatorType = 'error';
                  
                  return (
                    <StatusIndicator type={indicatorType}>
                      {healthy}/{total} healthy
                    </StatusIndicator>
                  );
                },
              },
              {
                id: 'desired',
                header: 'Desired',
                cell: (item: any) => item.DesiredCapacity,
              },
              {
                id: 'min',
                header: 'Min',
                cell: (item: any) => item.MinSize,
              },
              {
                id: 'max',
                header: 'Max',
                cell: (item: any) => item.MaxSize,
              },
              {
                id: 'zones',
                header: 'Availability Zones',
                cell: (item: any) => item.AvailabilityZones?.join(', ') || 'N/A',
              },
            ]}
            items={autoScalingGroups}
            loading={loading}
            loadingText="Loading auto scaling groups..."
            empty={
              <Box textAlign="center" color="inherit">
                <b>No auto scaling groups found</b>
                <Box padding={{ bottom: 's' }} variant="p" color="inherit">
                  No auto scaling groups are currently configured.
                </Box>
              </Box>
            }
            header={
              <Header
                counter={`(${autoScalingGroups.length})`}
                description="Auto scaling groups managing DCV infrastructure instances"
              >
                Auto Scaling Groups
              </Header>
            }
          />
        </SpaceBetween>
      </ContentLayout>
    }
  />
  );
  };

export default DcvSessions;
