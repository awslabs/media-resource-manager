// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
  Button,
  Alert,
  Spinner,
  BreadcrumbGroup,
  Box,
  Grid,
  Table,
  Link,
} from '@cloudscape-design/components';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { apiCall } from '../utils/api';

const WorkstationDetails: React.FC = () => {
  const { instanceId } = useParams<{ instanceId: string }>();
  const navigate = useNavigate();
  const [details, setDetails] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [storageResources, setStorageResources] = useState<any[]>([]);
  const [loadingStorage, setLoadingStorage] = useState(false);

  useEffect(() => {
    if (instanceId) {
      fetchWorkstationDetails();
    }
  }, [instanceId]);

  useEffect(() => {
    if (details?.workstation?.storageConfig) {
      fetchStorageDetails();
    }
  }, [details]);

  const fetchStorageDetails = async () => {
    if (!details?.workstation?.storageConfig) return;
    
    setLoadingStorage(true);
    try {
      const token = getAuthToken();
      if (!token) return;

      const storageIds = Object.keys(details.workstation.storageConfig);
      const storagePromises = storageIds.map(async (storageId) => {
        const response = await apiCall(`storage/${storageId}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (response.ok) {
          const storageData = await response.json();
          return {
            ...storageData,
            config: details.workstation.storageConfig[storageId]
          };
        }
        return null;
      });

      const results = await Promise.all(storagePromises);
      setStorageResources(results.filter(Boolean));
    } catch (error) {
      console.error('Error fetching storage details:', error);
    } finally {
      setLoadingStorage(false);
    }
  };

  const fetchWorkstationDetails = async () => {
    try {
      const token = getAuthToken();
      if (!token) {
        throw new Error('No current user');
      }

      const response = await apiCall(`workstations/${instanceId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setDetails(data);
      } else if (response.status === 404) {
        setError('Workstation not found');
      } else if (response.status === 403) {
        setError('Access denied');
      } else {
        setError('Failed to load workstation details');
      }
    } catch (error) {
      console.error('Error fetching workstation details:', error);
      if (!handleAuthError(error)) {
        setError('Failed to load workstation details');
      }
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getStatusIndicator = (state: string) => {
    switch (state) {
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
        return <StatusIndicator type="info">{state}</StatusIndicator>;
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
            header={
              <Header
                actions={
                  <Button onClick={() => navigate('/workstations')}>
                    Back to Workstations
                  </Button>
                }
              >
                Workstation Details
              </Header>
            }
          >
            <Alert type="error">{error}</Alert>
          </ContentLayout>
        }
        navigationHide={true}
      />
    );
  }

  const { workstation, ec2Instance } = details;

  const generalItems = [
    {
      type: 'group',
      title: 'Instance Details',
      items: [
        { label: 'Instance ID', value: ec2Instance.InstanceId },
        { label: 'State', value: getStatusIndicator(ec2Instance.State.Name) },
        { label: 'Launch Time', value: formatDate(ec2Instance.LaunchTime) },
        { label: 'Assigned User', value: workstation.assignedUserId || 'Unassigned' }
      ]
    },
    
    {
      type: 'group',
      title: 'Compute Configuration',
      items: [
        { label: 'Instance Type', value: ec2Instance.InstanceType },
        { label: 'Architecture', value: ec2Instance.Architecture },
        { label: 'Platform', value: ec2Instance.Platform || 'Linux' }
      ]
    },
    
    {
      type: 'group',
      title: 'Image Information',
      items: [
        { label: 'AMI ID', value: ec2Instance.ImageId }
      ]
    }
  ];

  const networkItems = [
    {
      type: 'group',
      title: 'VPC Configuration',
      items: [
        { label: 'VPC ID', value: ec2Instance.VpcId },
        { label: 'Subnet ID', value: ec2Instance.SubnetId }
      ]
    },
    
    {
      type: 'group',
      title: 'IP Addresses',
      items: [
        { label: 'Private IP', value: ec2Instance.PrivateIpAddress },
        { label: 'Public IP', value: ec2Instance.PublicIpAddress || 'None' }
      ]
    },
    
    {
      type: 'group',
      title: 'DNS Names',
      items: [
        { label: 'Private DNS', value: ec2Instance.PrivateDnsName },
        { label: 'Public DNS', value: ec2Instance.PublicDnsName || 'None' }
      ]
    }
  ];

  const securityGroups = ec2Instance.SecurityGroups?.map((sg: any) => ({
    label: sg.GroupName,
    value: sg.GroupId,
  })) || [];

  const storageItems = ec2Instance.BlockDeviceMappings?.map((bdm: any, index: number) => ({
    label: `Device ${bdm.DeviceName}`,
    value: `${bdm.Ebs?.VolumeId} (${bdm.Ebs?.VolumeSize}GB)`,
  })) || [];

  const tags = ec2Instance.Tags?.map((tag: any) => ({
    label: tag.Key,
    value: tag.Value,
  })) || [];

  return (
    <ContentLayout
      defaultPadding
      headerVariant="high-contrast"
      maxContentWidth={1200}
      breadcrumbs={
        <BreadcrumbGroup
          items={[
            { text: 'Dashboard', href: '/dashboard' },
            { text: 'Workstations', href: '/workstations' },
            { text: workstation?.workstationName || instanceId || 'Details' }
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
                Workstation Details
              </Box>
              <Box
                variant="h3"
                color="text-body-secondary"
                margin={{ top: "xxs", bottom: "s" }}
              >
                {workstation?.workstationName || instanceId}
              </Box>
            </div>
          </Grid>
        </Box>
      }
    >
      <Container>
        <Tabs
            tabs={[
              {
                label: 'General',
                id: 'general',
                content: (
                  <Container header={<Header variant="h2">Instance Information</Header>}>
                    <KeyValuePairs columns={3} items={generalItems} />
                  </Container>
                ),
              },
              {
                label: 'Network',
                id: 'network',
                content: (
                  <SpaceBetween direction="vertical" size="l">
                    <Container header={<Header variant="h2">Network Configuration</Header>}>
                      <KeyValuePairs columns={3} items={networkItems} />
                    </Container>
                    {securityGroups.length > 0 && (
                      <Container header={<Header variant="h2">Security Groups</Header>}>
                        <KeyValuePairs columns={2} items={securityGroups} />
                      </Container>
                    )}
                  </SpaceBetween>
                ),
              },
              {
                label: 'Storage',
                id: 'storage',
                content: (
                  <SpaceBetween direction="vertical" size="l">
                    {storageResources.length > 0 && (
                      <Container header={<Header variant="h2">FSx File Systems (Auto-Mount)</Header>}>
                        {loadingStorage ? (
                          <Spinner />
                        ) : (
                          <Table
                            columnDefinitions={[
                              {
                                id: 'name',
                                header: 'Storage Name',
                                cell: (item: any) => (
                                  <Link 
                                    variant="primary"
                                    onFollow={(event) => {
                                      event.preventDefault();
                                      window.location.href = `/storage/${item.storageId}`;
                                    }}
                                  >
                                    {item.name}
                                  </Link>
                                ),
                              },
                              {
                                id: 'type',
                                header: 'Type',
                                cell: (item: any) => item.type === 'fsx-windows' ? 'FSx for Windows' : item.type,
                              },
                              {
                                id: 'driveLetter',
                                header: 'Drive Letter',
                                cell: (item: any) => item.config?.driveLetter ? `${item.config.driveLetter}:` : '-',
                              },
                              {
                                id: 'autoMount',
                                header: 'Auto Mount',
                                cell: (item: any) => item.config?.autoMount ? 'Yes' : 'No',
                              }
                            ]}
                            items={storageResources}
                            empty="No FSx storage configured"
                          />
                        )}
                      </Container>
                    )}
                    <Container header={<Header variant="h2">Block Device Mappings</Header>}>
                      {storageItems.length > 0 ? (
                        <KeyValuePairs columns={2} items={storageItems} />
                      ) : (
                        <div>No block device information available</div>
                      )}
                    </Container>
                  </SpaceBetween>
                ),
              },
              {
                label: 'Tags',
                id: 'tags',
                content: (
                  <Container header={<Header variant="h2">Instance Tags</Header>}>
                    {tags.length > 0 ? (
                      <KeyValuePairs columns={2} items={tags} />
                    ) : (
                      <div>No tags found</div>
                    )}
                  </Container>
                ),
              },
            ]}
          />
      </Container>
    </ContentLayout>
  );
};

export default WorkstationDetails;
