// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  AppLayout,
  ContentLayout,
  Header,
  SpaceBetween,
  Container,
  ColumnLayout,
  Box,
  Badge,
  Table,
  Button,
  Alert,
  BreadcrumbGroup,
  Tabs,
  StatusIndicator,
  Grid,
} from '@cloudscape-design/components';
import { apiCall } from '../utils/api';
import { getAuthToken } from '../utils/auth';

interface Group {
  groupId: string;
  groupName: string;
  description?: string;
  createdAt: string;
}

interface User {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  groups?: string[];
}

interface Workstation {
  instanceId: string;
  assignedUserId: string;
  assignedUser?: string;
  amiId: string;
  instanceType: string;
  status: string;
  createdAt: string;
}

const GroupDetails: React.FC = () => {
  const { groupId } = useParams<{ groupId: string }>();
  const [group, setGroup] = useState<Group | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [workstations, setWorkstations] = useState<Workstation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTabId, setActiveTabId] = useState('overview');

  const fetchGroupDetails = async () => {
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No authentication token');

      // Fetch group details first
      const groupResponse = await apiCall(`groups/${groupId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (!groupResponse.ok) {
        throw new Error('Failed to fetch group details');
      }

      const groupData = await groupResponse.json();
      setGroup(groupData);

      // Now fetch users and filter by this group
      const usersResponse = await apiCall('users', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (usersResponse.ok) {
        const usersData = await usersResponse.json();
        console.log('Group data:', groupData);
        console.log('Sample user groups:', usersData[0]?.groups);
        
        // Filter users who belong to this group - try both groupName and groupId
        const groupUsers = usersData.filter((user: User) => {
          if (!user.groups || !Array.isArray(user.groups)) return false;
          
          // Check if user's groups array contains either the groupName or groupId
          return user.groups.includes(groupData.groupName) || 
                 user.groups.includes(groupData.groupId) ||
                 user.groups.some((userGroup: string) => 
                   userGroup.toLowerCase() === groupData.groupName?.toLowerCase()
                 );
        });
        
        console.log('Filtered group users:', groupUsers);
        setUsers(groupUsers);

        // Fetch workstations assigned to group members
        const workstationsResponse = await apiCall('workstations', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (workstationsResponse.ok) {
          const workstationsData = await workstationsResponse.json();
          // Filter workstations assigned to group members
          const groupUserIds = groupUsers.map(user => user.userId);
          const groupWorkstations = workstationsData.filter((ws: Workstation) => 
            groupUserIds.includes(ws.assignedUserId)
          );
          setWorkstations(groupWorkstations);
        }
      }

    } catch (error: any) {
      setError(error.message || 'Failed to load group details');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (groupId) {
      fetchGroupDetails();
    }
  }, [groupId]);

  if (loading) {
    return (
      <AppLayout
        content={
          <ContentLayout header={<Header variant="h1">Group Details</Header>}>
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <StatusIndicator type="loading">Loading group details...</StatusIndicator>
            </div>
          </ContentLayout>
        }
        navigationHide={true}
      />
    );
  }

  if (error || !group) {
    return (
      <AppLayout
        content={
          <ContentLayout header={<Header variant="h1">Group Details</Header>}>
            <Alert type="error">
              {error || 'Group not found'}
            </Alert>
          </ContentLayout>
        }
        navigationHide={true}
      />
    );
  }

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
            { text: group.groupName }
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
                Group Details
              </Box>
              <Box
                variant="h3"
                color="text-body-secondary"
                margin={{ top: "xxs", bottom: "s" }}
              >
                {group.groupName}
              </Box>
            </div>
          </Grid>
        </Box>
      }
    >
      <Container>
        <SpaceBetween direction="vertical" size="l">
            <Tabs
              activeTabId={activeTabId}
              onChange={({ detail }) => setActiveTabId(detail.activeTabId)}
              tabs={[
                {
                  label: "Overview",
                  id: "overview",
                  content: (
                    <SpaceBetween direction="vertical" size="l">
                      <Container header={<Header variant="h2">Group Information</Header>}>
                        <ColumnLayout columns={2} variant="text-grid">
                          <div>
                            <Box variant="awsui-key-label">Group Name</Box>
                            <div>{group.groupName}</div>
                          </div>
                          <div>
                            <Box variant="awsui-key-label">Description</Box>
                            <div>{group.description || 'No description'}</div>
                          </div>
                          <div>
                            <Box variant="awsui-key-label">Group ID</Box>
                            <div>{group.groupId}</div>
                          </div>
                          <div>
                            <Box variant="awsui-key-label">Created</Box>
                            <div>{new Date(group.createdAt).toLocaleString()}</div>
                          </div>
                          <div>
                            <Box variant="awsui-key-label">Members</Box>
                            <div>
                              <Badge color="blue">{users.length} users</Badge>
                            </div>
                          </div>
                          <div>
                            <Box variant="awsui-key-label">Workstations</Box>
                            <div>
                              <Badge color="green">{workstations.length} assigned</Badge>
                            </div>
                          </div>
                        </ColumnLayout>
                      </Container>
                    </SpaceBetween>
                  )
                },
                {
                  label: `Users (${users.length})`,
                  id: "users",
                  content: (
                    <Table
                      columnDefinitions={[
                        {
                          id: 'name',
                          header: 'Name',
                          cell: (item) => (
                            <Link to={`/users/${item.userId}`}>
                              {item.firstName} {item.lastName}
                            </Link>
                          ),
                          sortingField: 'firstName'
                        },
                        {
                          id: 'email',
                          header: 'Email',
                          cell: (item) => item.email,
                          sortingField: 'email'
                        }
                      ]}
                      items={users}
                      loading={loading}
                      sortingDisabled={false}
                      empty="No users in this group."
                      header={<Header variant="h2">Group Members</Header>}
                    />
                  )
                },
                {
                  label: `Workstations (${workstations.length})`,
                  id: "workstations", 
                  content: (
                    <Table
                      columnDefinitions={[
                        {
                          id: 'instanceId',
                          header: 'Instance ID',
                          cell: (item) => (
                            <Link to={`/workstations/${item.instanceId}`}>
                              {item.instanceId}
                            </Link>
                          )
                        },
                        {
                          id: 'assignedUser',
                          header: 'Assigned User',
                          cell: (item) => item.assignedUser || item.assignedUserId
                        },
                        {
                          id: 'instanceType',
                          header: 'Instance Type',
                          cell: (item) => item.instanceType
                        },
                        {
                          id: 'instanceStatus',
                          header: 'Instance Status',
                          cell: (item) => (
                            <Badge 
                              color={
                                item.instanceStatus === 'running' ? 'green' :
                                item.instanceStatus === 'stopped' ? 'red' :
                                item.instanceStatus === 'pending' ? 'blue' : 'grey'
                              }
                            >
                              {item.instanceStatus}
                            </Badge>
                          )
                        }
                      ]}
                      items={workstations}
                      loading={loading}
                      sortingDisabled={false}
                      empty="No workstations assigned to group members."
                      header={<Header variant="h2">Group Workstations</Header>}
                    />
                  )
                }
              ]}
            />
          </SpaceBetween>
      </Container>
    </ContentLayout>
  );
};

export default GroupDetails;
