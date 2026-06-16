// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useMemo } from 'react';
import {
  AppLayout,
  ContentLayout,
  Header,
  Grid,
  Box,
  ColumnLayout,
  StatusIndicator,
  SpaceBetween,
  Cards,
  Button,
  ButtonDropdown,
  PropertyFilter,
  CollectionPreferences,
  Container,
  Alert,
} from '@cloudscape-design/components';
import WorkstationStartModal from '../components/WorkstationStartModal';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { apiCall } from '../utils/api';

interface DashboardProps {
  user: any;
}

const Dashboard: React.FC<DashboardProps> = ({ user }) => {
  const [workstations, setWorkstations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [browserSessionsEnabled, setBrowserSessionsEnabled] = useState(true);
  const [connectingInstances, setConnectingInstances] = useState(new Set());
  const [startingInstances, setStartingInstances] = useState(new Set());
  const [stoppingInstances, setStoppingInstances] = useState(new Set());
  const [filteringQuery, setFilteringQuery] = useState({ tokens: [], operation: 'and' });
  const [preferences, setPreferences] = useState({
    pageSize: 10,
    visibleContent: ['workstationName', 'instanceId', 'status', 'instanceStatus', 'dcvStatus', 'type', 'created']
  });
  const [selectedWorkstations, setSelectedWorkstations] = useState([]);

  // Modal state for workstation start progress
  const [showStartModal, setShowStartModal] = useState(false);
  const [startingInstanceId, setStartingInstanceId] = useState<string>('');
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const [bulkStarting, setBulkStarting] = useState(false);
  const [bulkStopping, setBulkStopping] = useState(false);
  const [actionAlert, setActionAlert] = useState<{type: 'success' | 'error', message: string} | null>(null);

  useEffect(() => {
    fetchWorkstations();
    fetchSettings();
    
    // Listen for refresh events from header
    const handleRefresh = () => fetchWorkstations();
    window.addEventListener('refreshWorkstations', handleRefresh);
    
    return () => {
      window.removeEventListener('refreshWorkstations', handleRefresh);
    };
  }, []);

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

  // Auto-refresh when there are workstations in transitional states
  useEffect(() => {
    const hasTransitionalStates = workstations.some(ws => 
      ['pending', 'starting', 'stopping'].includes(ws.instanceStatus) || 
      ['launching', 'installing-dcv', 'configuring-dcv', 'joining-domain', 'configuring-system', 'finalizing', 
       'starting-instance', 'instance-running', 'configuring-autologin', 'starting-dcv-agents', 'dcv-ready', 'testing-dcv', 'dcv-session-created', 'cleaning-up',
       'Stopping'].includes(ws.status) ||
      ws.dcvStatus === null || ws.dcvStatus === 'installing'
    );

    console.log('Auto-refresh check:', { hasTransitionalStates, workstationCount: workstations.length });
    setIsAutoRefreshing(hasTransitionalStates);

    if (!hasTransitionalStates) return;

    const interval = setInterval(() => {
      // Only refresh if page is visible
      if (!document.hidden) {
        fetchWorkstations();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [workstations]);

  // PropertyFilter configuration
  const filteringProperties = [
    {
      key: 'workstationName',
      operators: ['=', '!=', ':', '!:'],
      propertyLabel: 'Workstation Name',
      groupValuesLabel: 'Workstation Name values'
    },
    {
      key: 'instanceId',
      operators: ['=', '!=', ':', '!:'],
      propertyLabel: 'Instance ID',
      groupValuesLabel: 'Instance ID values'
    },
    {
      key: 'assignedUserId',
      operators: ['=', '!=', ':', '!:'],
      propertyLabel: 'Assigned To',
      groupValuesLabel: 'Assigned To values'
    },
    {
      key: 'instanceType',
      operators: ['=', '!=', ':', '!:'],
      propertyLabel: 'Instance Type',
      groupValuesLabel: 'Instance Type values'
    },
    {
      key: 'instanceStatus',
      operators: ['=', '!='],
      propertyLabel: 'Instance Status',
      groupValuesLabel: 'Instance Status values'
    },
    {
      key: 'dcvStatus',
      operators: ['=', '!='],
      propertyLabel: 'DCV Status',
      groupValuesLabel: 'DCV Status values'
    }
  ];

  // Filter workstations
  const processedWorkstations = useMemo(() => {
    let filtered = [...workstations];

    // Apply PropertyFilter
    if (filteringQuery.tokens.length > 0) {
      filtered = filtered.filter(workstation => {
        return filteringQuery.tokens.every(token => {
          const { propertyKey, operator, value } = token;
          let itemValue = workstation[propertyKey];
          
          // Handle special cases
          if (propertyKey === 'assignedUserId') {
            itemValue = workstation.assignedUserDisplay || workstation.assignedUserId || 'Unassigned';
          } else if (propertyKey === 'instanceStatus') {
            itemValue = workstation.instanceStatus;
          } else if (propertyKey === 'dcvStatus') {
            itemValue = workstation.dcvStatus === 'ready' ? 'Ready' : 'Not Ready';
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

    return filtered;
  }, [workstations, filteringQuery]);

  const fetchWorkstations = async () => {
    try {
      const token = getAuthToken();
      if (!token) {
        throw new Error('No current user');
      }
      
      const response = await apiCall('workstations', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      
      const data = await response.json();
      setWorkstations(data);
    } catch (error) {
      console.error('Error fetching workstations:', error);
      if (!handleAuthError(error)) {
        // Handle other errors if needed
      }
    } finally {
      setLoading(false);
    }
  };

  const handleWorkstationAction = async (instanceId: string, action: 'start' | 'stop') => {
    if (action === 'start') {
      // Show progress modal for start action
      setStartingInstanceId(instanceId);
      setShowStartModal(true);
      setStartingInstances(prev => new Set(prev).add(instanceId));
      
      try {
        const token = getAuthToken();
        if (!token) {
          throw new Error('No current user');
        }
        
        await apiCall(`workstations/${action}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ instanceId }),
        });
        
        // Refresh workstations to show updated status
        fetchWorkstations();
      } catch (error) {
        console.error('Error', action + 'ing workstation:', error);
        if (!handleAuthError(error)) {
          setShowStartModal(false);
          setStartingInstanceId('');
          setStartingInstances(prev => {
            const newSet = new Set(prev);
            newSet.delete(instanceId);
            return newSet;
          });
        }
      }
      return;
    }

    // Handle stop action (existing logic)
    setStoppingInstances(prev => new Set(prev).add(instanceId));
    
    try {
      const token = getAuthToken();
      if (!token) {
        throw new Error('No current user');
      }
      
      await apiCall(`workstations/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ instanceId }),
      });
      
      await fetchWorkstations();
    } catch (error) {
      console.error('Error', action + 'ing workstation:', error);
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

      if (response.ok) {
        const data = await response.json();
        
        if (connectionType === 'client') {
          // Use QUIC URL (port 8444) for native client - better streaming performance
          const baseUrl = data.quicConnectionUrl || data.connectionUrl;
          window.location.href = baseUrl.replace('https://', 'dcv://');
        } else {
          // Open in browser (uses TCP port 8443)
          window.open(data.connectionUrl, '_blank');
        }
      } else {
        throw new Error('Failed to create DCV session');
      }
    } catch (error) {
      console.error('Error connecting to workstation:', error);
      if (!handleAuthError(error)) {
        // Fallback: open DCV endpoint directly
        window.open('https://dcv-nlb-4102d2ead4b978c5.elb.us-east-1.amazonaws.com:8443', '_blank');
      }
    } finally {
      setConnectingInstances(prev => {
        const newSet = new Set(prev);
        newSet.delete(instanceId);
        return newSet;
      });
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

  const getWorkflowStatusIndicator = (status: string) => {
    switch (status) {
      case 'launching':
        return <StatusIndicator type="pending">Launching</StatusIndicator>;
      case 'setting-hostname':
        return <StatusIndicator type="pending">Setting Hostname</StatusIndicator>;
      case 'installing-dcv':
        return <StatusIndicator type="pending">Installing DCV</StatusIndicator>;
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

  // Check if user is admin based on Cognito groups
  const isAdmin = () => {
    if (!user?.signInUserSession?.idToken?.payload) return false;
    const groups = user.signInUserSession.idToken.payload['cognito:groups'] || [];
    return groups.includes('Administrator');
  };

  const userIsAdmin = isAdmin();
  
  // Server already filters workstations based on user permissions, so no need for client-side filtering

  return (
    <form autoComplete="off" style={{ display: 'contents' }}>
    <Container
      header={
        <Header 
          variant="h2"
          counter={
            selectedWorkstations?.length
              ? `(${selectedWorkstations.length}/${workstations.length})`
              : `(${workstations.length})`
          }
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              {selectedWorkstations.length > 0 && (
                <>
                  <Button
                    onClick={async () => {
                      setBulkStarting(true);
                      const stoppedWorkstations = selectedWorkstations.filter((ws: any) => ws.instanceStatus === 'stopped');
                      
                      try {
                        for (const ws of stoppedWorkstations) {
                          await handleWorkstationAction(ws.instanceId, 'start');
                        }
                        // Refresh workstations after all start actions complete
                        await fetchWorkstations();
                        setActionAlert({
                          type: 'success',
                          message: `Started ${stoppedWorkstations.length} workstation(s) successfully`
                        });
                        setTimeout(() => setActionAlert(null), 5000);
                      } catch (error) {
                        setActionAlert({
                          type: 'error',
                          message: 'Failed to start some workstations'
                        });
                        setTimeout(() => setActionAlert(null), 5000);
                      } finally {
                        setBulkStarting(false);
                      }
                    }}
                    disabled={!selectedWorkstations.some((ws: any) => ws.instanceStatus === 'stopped')}
                    loading={bulkStarting}
                  >
                    Start selected
                  </Button>
                  <Button
                    onClick={async () => {
                      setBulkStopping(true);
                      const runningWorkstations = selectedWorkstations.filter((ws: any) => ws.instanceStatus === 'running');
                      
                      try {
                        for (const ws of runningWorkstations) {
                          await handleWorkstationAction(ws.instanceId, 'stop');
                        }
                        // Refresh workstations after all stop actions complete
                        await fetchWorkstations();
                        setActionAlert({
                          type: 'success',
                          message: `Stopped ${runningWorkstations.length} workstation(s) successfully`
                        });
                        setTimeout(() => setActionAlert(null), 5000);
                      } catch (error) {
                        setActionAlert({
                          type: 'error',
                          message: 'Failed to stop some workstations'
                        });
                        setTimeout(() => setActionAlert(null), 5000);
                      } finally {
                        setBulkStopping(false);
                      }
                    }}
                    disabled={!selectedWorkstations.some((ws: any) => ws.instanceStatus === 'running')}
                    loading={bulkStopping}
                  >
                    Stop selected
                  </Button>
                  <ButtonDropdown
                    items={[
                      {
                        text: 'Connect via DCV Client',
                        id: 'client'
                      },
                      ...(browserSessionsEnabled ? [{
                        text: 'Connect via Browser',
                        id: 'browser'
                      }] : [])
                    ]}
                    onItemClick={({ detail }) => {
                      // Only connect to the first selected workstation
                      const connectableWorkstation = selectedWorkstations.find((ws: any) => 
                        ws.instanceStatus === 'running' && ws.dcvStatus === 'ready'
                      );
                      if (connectableWorkstation) {
                        handleConnect(connectableWorkstation.instanceId, detail.id as 'client' | 'browser');
                      }
                    }}
                    disabled={
                      selectedWorkstations.length !== 1 || 
                      !selectedWorkstations.some((ws: any) => ws.instanceStatus === 'running' && ws.dcvStatus === 'ready')
                    }
                  >
                    Connect selected
                  </ButtonDropdown>
                </>
              )}
              <Button
                iconName={isAutoRefreshing ? "status-in-progress" : "refresh"}
                onClick={fetchWorkstations}
                loading={loading}
              >
                {isAutoRefreshing ? "Auto-refreshing..." : ""}
              </Button>
            </SpaceBetween>
          }
        >
          Workstations
        </Header>
      }
    >
      {actionAlert && (
        <Alert
          type={actionAlert.type}
          dismissible
          onDismiss={() => setActionAlert(null)}
        >
          {actionAlert.message}
        </Alert>
      )}
      <Cards
      variant="full-page"
      onSelectionChange={({ detail }) =>
        setSelectedWorkstations(detail?.selectedItems ?? [])
      }
      selectedItems={selectedWorkstations}
      selectionType="multi"
      entireCardClickable
      trackBy="instanceId"
      ariaLabels={{
        itemSelectionLabel: (e, item) => `select ${item.assignedUserDisplay || item.assignedUserId || 'Unassigned'}`,
        selectionGroupLabel: "Workstation selection"
      }}
              cardDefinition={{
          header: (item: any) => (
            <div style={{
              display: 'flex',
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <span>{item.assignedUserDisplay || item.assignedUserId || 'Unassigned'}</span>
              <ButtonDropdown
                items={[
                  ...(item.instanceStatus === 'stopped' ? [{
                    text: 'Start',
                    id: 'start',
                    disabled: startingInstances.has(item.instanceId)
                  }] : []),
                  ...(item.instanceStatus === 'running' ? [{
                    text: 'Stop',
                    id: 'stop',
                    disabled: stoppingInstances.has(item.instanceId)
                  }] : []),
                  ...(item.instanceStatus === 'running' && item.dcvStatus === 'ready' ? [{
                    text: 'Connect via DCV Client',
                    id: 'client',
                    disabled: connectingInstances.has(item.instanceId)
                  }] : []),
                  ...(item.instanceStatus === 'running' && item.dcvStatus === 'ready' && browserSessionsEnabled ? [{
                    text: 'Connect via Browser',
                    id: 'browser',
                    disabled: connectingInstances.has(item.instanceId)
                  }] : [])
                ]}
                onItemClick={({ detail }) => {
                  if (detail.id === 'start') {
                    handleWorkstationAction(item.instanceId, 'start');
                  } else if (detail.id === 'stop') {
                    handleWorkstationAction(item.instanceId, 'stop');
                  } else if (detail.id === 'client' || detail.id === 'browser') {
                    handleConnect(item.instanceId, detail.id as 'client' | 'browser');
                  }
                }}
                ariaLabel="Workstation actions"
                variant="inline-icon"
              />
            </div>
          ),
          sections: [
            {
              id: 'workstationName',
              header: 'Workstation Name',
              content: (item: any) => item.workstationName || '-',
            },
            {
              id: 'instanceId',
              header: 'Instance ID',
              content: (item: any) => item.instanceId,
            },
            {
              id: 'status',
              header: 'Workflow Status',
              content: (item: any) => getWorkflowStatusIndicator(item.status),
            },
            {
              id: 'instanceStatus',
              header: 'Instance Status',
              content: (item: any) => getStatusIndicator(item.instanceStatus),
            },
            {
              id: 'dcvStatus',
              header: 'DCV Status',
              content: (item: any) => {
                if (item.instanceStatus === 'stopped') {
                  return <StatusIndicator type="stopped">Stopped</StatusIndicator>;
                }
                if (!item.dcvStatus) {
                  return <StatusIndicator type="pending">Installing...</StatusIndicator>;
                }
                return getDcvStatusIndicator(item.dcvStatus, item.status, item.instanceStatus);
              },
            },
            {
              id: 'type',
              header: 'Instance Type',
              content: (item: any) => item.instanceType,
            },
            {
              id: 'created',
              header: 'Created',
              content: (item: any) => new Date(item.createdAt).toLocaleString(),
            },
          ].filter(section => preferences.visibleContent.includes(section.id)),
        }}
          items={processedWorkstations}
          loading={loading}
          loadingText="Loading workstations..."
          empty="No workstations found."
              preferences={
                <CollectionPreferences
                  title="Preferences"
                  confirmLabel="Confirm"
                  cancelLabel="Cancel"
                  onConfirm={({ detail }) => setPreferences(detail)}
                  preferences={preferences}
                  pageSizePreference={{
                    title: "Page size",
                    options: [
                      { value: 10, label: "10 workstations" },
                      { value: 20, label: "20 workstations" },
                      { value: 50, label: "50 workstations" }
                    ]
                  }}
                  visibleContentPreference={{
                    title: "Select visible content",
                    options: [
                      {
                        label: "Workstation properties",
                        options: [
                          { id: "workstationName", label: "Workstation Name" },
                          { id: "instanceId", label: "Instance ID" },
                          { id: "status", label: "Workflow Status" },
                          { id: "instanceStatus", label: "Instance Status" },
                          { id: "dcvStatus", label: "DCV Status" },
                          { id: "type", label: "Instance Type" },
                          { id: "created", label: "Created" }
                        ]
                      }
                    ]
                  }}
                />
              }
              filter={
                <PropertyFilter
                  query={filteringQuery}
                  onChange={({ detail }) => setFilteringQuery(detail)}
                  filteringProperties={filteringProperties}
                  filteringOptions={[
                    ...workstations.map(ws => ({ propertyKey: 'workstationName', value: ws.workstationName })).filter(opt => opt.value),
                    ...workstations.map(ws => ({ propertyKey: 'instanceId', value: ws.instanceId })),
                    ...workstations.map(ws => ({ propertyKey: 'assignedUserId', value: ws.assignedUserDisplay || ws.assignedUserId || 'Unassigned' })),
                    ...workstations.map(ws => ({ propertyKey: 'instanceType', value: ws.instanceType })),
                    { propertyKey: 'instanceStatus', value: 'running' },
                    { propertyKey: 'instanceStatus', value: 'stopped' },
                    { propertyKey: 'instanceStatus', value: 'pending' },
                    { propertyKey: 'instanceStatus', value: 'starting' },
                    { propertyKey: 'instanceStatus', value: 'stopping' },
                    { propertyKey: 'dcvStatus', value: 'Ready' },
                    { propertyKey: 'dcvStatus', value: 'Not Ready' }
                  ].filter((option, index, self) => 
                    index === self.findIndex(o => o.propertyKey === option.propertyKey && o.value === option.value)
                  )}
                  filteringPlaceholder="Filter workstations"
                  filteringAriaLabel="Filter workstations"
                  i18nStrings={{
                    filteringAriaLabel: "Filter workstations",
                    dismissAriaLabel: "Dismiss",
                    filteringPlaceholder: "Filter workstations",
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
            />
    </Container>
    </form>
  );
};

export default Dashboard;
// Updated Tue Sep  2 13:07:23 UTC 2025
