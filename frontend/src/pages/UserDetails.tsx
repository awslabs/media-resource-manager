// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  AppLayout,
  ContentLayout,
  Header,
  Tabs,
  SpaceBetween,
  ColumnLayout,
  Container,
  StatusIndicator,
  KeyValuePairs,
  Alert,
  Spinner,
  BreadcrumbGroup,
  Table,
  Badge,
  Button,
  Box,
  Grid,
} from '@cloudscape-design/components';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { apiCall } from '../utils/api';
import { DcvApiService } from '../utils/dcvApi';

const UserDetails: React.FC = () => {
  const { userId } = useParams<{ userId: string }>();
  const [details, setDetails] = useState<any>(null);
  const [dcvSessions, setDcvSessions] = useState<any[]>([]);
  const [allGroups, setAllGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dcvLoading, setDcvLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTabId, setActiveTabId] = useState('user-info');

  useEffect(() => {
    if (userId) {
      fetchUserDetails();
      fetchAllGroups();
    }
  }, [userId]);

  const fetchAllGroups = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall('groups', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.ok) {
        const groupsData = await response.json();
        setAllGroups(groupsData);
      }
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  };

  const handleTabChange = (tabId: string) => {
    setActiveTabId(tabId);
    // Auto-load DCV sessions when DCV Sessions tab is clicked
    if (tabId === 'dcv-sessions' && dcvSessions.length === 0) {
      fetchDcvSessions();
    }
  };

  const fetchDcvSessions = async () => {
    if (!userId || !details?.user) return;
    
    setDcvLoading(true);
    try {
      console.log('Looking for DCV sessions for userId:', userId);

      const userSessions = await DcvApiService.getSessionsForUser(userId);
      
      console.log('User sessions found:', userSessions);
      setDcvSessions(userSessions);
    } catch (error) {
      console.error('Error fetching DCV sessions:', error);
      setDcvSessions([]);
    } finally {
      setDcvLoading(false);
    }
  };

  const fetchUserDetails = async () => {
    try {
      const token = getAuthToken();
      if (!token) {
        throw new Error('No current user');
      }

      const response = await apiCall(`users/${userId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setDetails(data);
        // Fetch DCV sessions after user details are loaded
        setTimeout(() => fetchDcvSessions(), 100);
      } else if (response.status === 404) {
        setError('User not found');
      } else if (response.status === 403) {
        setError('Access denied');
      } else {
        setError('Failed to load user details');
      }
    } catch (error) {
      console.error('Error fetching user details:', error);
      if (!handleAuthError(error)) {
        setError('Failed to load user details');
      }
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getWorkstationStatusIndicator = (status: string) => {
    switch (status) {
      case 'running':
        return <StatusIndicator type="success">Running</StatusIndicator>;
      case 'stopped':
        return <StatusIndicator type="stopped">Stopped</StatusIndicator>;
      case 'pending':
        return <StatusIndicator type="pending">Starting</StatusIndicator>;
      case 'stopping':
        return <StatusIndicator type="pending">Stopping</StatusIndicator>;
      case 'terminated':
        return <StatusIndicator type="error">Terminated</StatusIndicator>;
      default:
        return <StatusIndicator type="info">{status}</StatusIndicator>;
    }
  };

  if (loading) {
    return (
      <AppLayout
        content={
          <ContentLayout header={<Header>Loading...</Header>}>
            <Container>
              <Spinner size="large" />
            </Container>
          </ContentLayout>
        }
        navigationHide={true}
      />
    );
  }

  if (error) {
    return (
      <AppLayout
        content={
          <ContentLayout 
            breadcrumbs={
              <BreadcrumbGroup
                items={[
                  { text: 'Dashboard', href: '/dashboard' },
                  { text: 'Users / Groups', href: '/users' },
                  { text: 'User Details' }
                ]}
                ariaLabel="Breadcrumbs"
              />
            }
            header={<Header>User Details</Header>}
          >
            <Alert type="error">{error}</Alert>
          </ContentLayout>
        }
        navigationHide={true}
      />
    );
  }

  const { user, directoryUser, groups, workstations } = details;

  const userItems = [
    {
      type: 'group',
      title: 'Account Information',
      items: [
        { label: 'User ID', value: user.userId },
        { label: 'Email', value: user.email },
        { label: 'Created', value: user.createdAt ? formatDate(user.createdAt) : 'Unknown' },
        { label: 'Admin', value: user.isAdmin ? 'Yes' : 'No' }
      ]
    },
    
    {
      type: 'group',
      title: 'Personal Information',
      items: [
        { label: 'First Name', value: user.firstName },
        { label: 'Last Name', value: user.lastName },
        { label: 'Department', value: user.department || 'Not specified' }
      ]
    }
  ];

  const directoryItems = directoryUser ? [
    {
      type: 'group',
      title: 'Account Details',
      items: [
        { label: 'Username', value: directoryUser.SAMAccountName },
        { label: 'Display Name', value: directoryUser.GivenName + ' ' + directoryUser.Surname },
        { label: 'Enabled', value: directoryUser.Enabled ? 'Yes' : 'No' }
      ]
    },
    
    {
      type: 'group',
      title: 'Contact Information',
      items: [
        { label: 'Email Address', value: directoryUser.EmailAddress }
      ]
    },
    
    {
      type: 'group',
      title: 'Directory Details',
      items: [
        { label: 'Distinguished Name', value: directoryUser.DistinguishedName }
      ]
    }
  ] : [];

  const dcvSessionColumns = [
    {
      id: 'sessionId',
      header: 'Session ID',
      cell: (item: any) => item.Id,
    },
    {
      id: 'sessionName',
      header: 'Session Name',
      cell: (item: any) => item.Name || 'N/A',
    },
    {
      id: 'owner',
      header: 'Owner',
      cell: (item: any) => item.Owner,
    },
    {
      id: 'sessionType',
      header: 'Type',
      cell: (item: any) => item.Type || 'N/A',
    },
    {
      id: 'creationTime',
      header: 'Created',
      cell: (item: any) => {
        const time = item.CreationTime;
        return time ? new Date(time).toLocaleString() : 'N/A';
      },
    },
  ];

  const groupColumns = [
    {
      id: 'groupName',
      header: 'Group Name',
      cell: (item: any) => {
        const groupName = item.GroupName;
        
        // Find the corresponding group from allGroups to get the groupId
        const matchingGroup = allGroups.find(group => 
          group.groupName === groupName || 
          group.groupName?.toLowerCase() === groupName?.toLowerCase()
        );
        
        if (matchingGroup) {
          return (
            <Link to={`/groups/${matchingGroup.groupId}`}>
              {groupName}
            </Link>
          );
        }
        
        // Fallback to plain text if no matching group found
        return groupName;
      },
    },
    {
      id: 'description',
      header: 'Description',
      cell: (item: any) => item.Description || 'No description',
    },
  ];

  const workstationColumns = [
    {
      id: 'instanceId',
      header: 'Instance ID',
      cell: (item: any) => (
        <Link 
          to={`/workstations/${item.instanceId}`}
          style={{ color: '#0073bb', textDecoration: 'none' }}
        >
          {item.instanceId}
        </Link>
      ),
    },
    {
      id: 'instanceType',
      header: 'Instance Type',
      cell: (item: any) => item.instanceType,
    },
    {
      id: 'instanceStatus',
      header: 'Instance Status',
      cell: (item: any) => getWorkstationStatusIndicator(item.instanceStatus),
    },
    {
      id: 'assignmentType',
      header: 'Access Type',
      cell: (item: any) => {
        if (item.assignedUserId === userId) {
          return <Badge color="blue">Direct Assignment</Badge>;
        } else {
          return <Badge color="green">Group Access</Badge>;
        }
      },
    },
  ];

  return (
    <ContentLayout
      defaultPadding
      headerVariant="high-contrast"
      maxContentWidth={1200}
      breadcrumbs={
        <BreadcrumbGroup
          items={[
            { text: 'Dashboard', href: '/dashboard' },
            { text: 'Users / Groups', href: '/users' },
            { text: user?.email || userId }
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
                User Details
              </Box>
              <Box
                variant="h3"
                color="text-body-secondary"
                margin={{ top: "xxs", bottom: "s" }}
              >
                {user?.firstName} {user?.lastName} ({user?.email})
              </Box>
            </div>
          </Grid>
        </Box>
      }
    >
      <Container>
        <Tabs
            activeTabId={activeTabId}
            onChange={({ detail }) => handleTabChange(detail.activeTabId)}
            tabs={[
              {
                label: 'User Information',
                id: 'user-info',
                content: (
                  <SpaceBetween direction="vertical" size="l">
                    <Container header={<Header variant="h2">User Profile</Header>}>
                      <KeyValuePairs columns={3} items={userItems} />
                    </Container>
                    {directoryUser && (
                      <Container header={<Header variant="h2">Directory Information</Header>}>
                        <KeyValuePairs columns={3} items={directoryItems} />
                      </Container>
                    )}
                  </SpaceBetween>
                ),
              },
              {
                label: 'Groups',
                id: 'groups',
                content: (
                  <SpaceBetween direction="vertical" size="l">
                    <Container header={<Header variant="h2">Active Directory Groups</Header>}>
                      <Table
                        columnDefinitions={groupColumns}
                        items={groups || []}
                        empty="No groups found"
                        header={
                          <Header
                            counter={`(${groups?.length || 0})`}
                          >
                            Group Memberships
                          </Header>
                        }
                      />
                    </Container>
                  </SpaceBetween>
                ),
              },
              {
                label: 'Workstations',
                id: 'workstations',
                content: (
                  <SpaceBetween direction="vertical" size="l">
                    <Container header={<Header variant="h2">Accessible Workstations</Header>}>
                      <Table
                        columnDefinitions={workstationColumns}
                        items={workstations || []}
                        empty="No workstations accessible to this user"
                        header={
                          <Header
                            counter={`(${workstations?.length || 0})`}
                          >
                            Workstations
                          </Header>
                        }
                      />
                    </Container>
                  </SpaceBetween>
                ),
              },
              {
                label: 'DCV Sessions',
                id: 'dcv-sessions',
                content: (
                  <SpaceBetween direction="vertical" size="l">
                    <Container header={<Header variant="h2">DCV Sessions</Header>}>
                      <Table
                        columnDefinitions={dcvSessionColumns}
                        items={dcvSessions}
                        loading={dcvLoading}
                        empty="No DCV sessions found"
                        header={
                          <Header
                            counter={`(${dcvSessions.length})`}
                            actions={
                              <Button
                                iconName="refresh"
                                onClick={fetchDcvSessions}
                                loading={dcvLoading}
                              >
                                Refresh
                              </Button>
                            }
                          >
                            Active Sessions
                          </Header>
                        }
                      />
                    </Container>
                  </SpaceBetween>
                ),
              },
            ]}
          />
      </Container>
    </ContentLayout>
  );
};

export default UserDetails;
