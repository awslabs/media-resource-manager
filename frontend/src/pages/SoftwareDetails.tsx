// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ContentLayout,
  Header,
  SpaceBetween,
  Container,
  KeyValuePairs,
  Button,
  Alert,
  Spinner,
  BreadcrumbGroup,
  Box,
  Grid,
  Badge,
  Table,
  ColumnLayout,
} from '@cloudscape-design/components';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';

interface ParameterDefinition {
  name: string;
  description?: string;
  required?: boolean;
}

interface SoftwareItem {
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
  parameters?: ParameterDefinition[];
  createdAt?: string;
  updatedAt?: string;
}

const SoftwareDetails: React.FC = () => {
  const { softwareId } = useParams<{ softwareId: string }>();
  const navigate = useNavigate();
  const [software, setSoftware] = useState<SoftwareItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (softwareId) {
      fetchSoftwareDetails();
    }
  }, [softwareId]);

  const fetchSoftwareDetails = async () => {
    try {
      const token = getAuthToken();
      if (!token) {
        setError('Not authenticated');
        setLoading(false);
        return;
      }

      const response = await apiCall(`/images/software/${softwareId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        setSoftware(data);
      } else if (response.status === 404) {
        setError('Software not found');
      } else {
        setError('Failed to load software details');
      }
    } catch (err) {
      console.error('Error fetching software details:', err);
      setError('Failed to load software details');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <ContentLayout header={<Header>Loading...</Header>}>
        <Container>
          <Box textAlign="center" padding="xxl">
            <Spinner size="large" />
          </Box>
        </Container>
      </ContentLayout>
    );
  }

  if (error || !software) {
    return (
      <ContentLayout
        header={
          <Header
            actions={
              <Button onClick={() => navigate('/software')}>
                Back to Software
              </Button>
            }
          >
            Software Details
          </Header>
        }
      >
        <Alert type="error">{error || 'Software not found'}</Alert>
      </ContentLayout>
    );
  }

  const platformColor = software.platform === 'Linux' ? 'green' : software.platform === 'macOS' ? 'grey' : 'blue';

  return (
    <ContentLayout
      defaultPadding
      headerVariant="high-contrast"
      maxContentWidth={1200}
      breadcrumbs={
        <BreadcrumbGroup
          items={[
            { text: 'Dashboard', href: '/dashboard' },
            { text: 'Software', href: '/software' },
            { text: software.name || softwareId || 'Details' },
          ]}
          ariaLabel="Breadcrumbs"
        />
      }
      header={
        <Box padding={{ vertical: 'l' }}>
          <Grid
            gridDefinition={[
              { colspan: { default: 12, xs: 8, s: 9 } },
              { colspan: { default: 12, xs: 4, s: 3 } },
            ]}
          >
            <div>
              <Box variant="h1" fontSize="display-l">
                {software.name}
              </Box>
              <Box variant="p" color="text-body-secondary" margin={{ top: 'xxs', bottom: 's' }}>
                Version {software.versionNumber || 'Latest'}
                {software.description && ` — ${software.description}`}
              </Box>
            </div>
            <Box margin={{ top: 'l' }}>
              <Button onClick={() => navigate('/software')} iconName="arrow-left">
                Back to Software
              </Button>
            </Box>
          </Grid>
        </Box>
      }
    >
      <SpaceBetween direction="vertical" size="l">
        {/* Metadata */}
        <Container header={<Header variant="h2">Software Information</Header>}>
          <KeyValuePairs
            columns={3}
            items={[
              {
                type: 'group',
                title: 'General',
                items: [
                  { label: 'Platform', value: <Badge color={platformColor}>{software.platform || 'Windows'}</Badge> },
                  { label: 'Category', value: <Badge color="grey">{software.category ? software.category.charAt(0).toUpperCase() + software.category.slice(1) : 'N/A'}</Badge> },
                  { label: 'Version', value: software.versionNumber || 'Latest' },
                ],
              },
              {
                type: 'group',
                title: 'Requirements',
                items: [
                  { label: 'Estimated Install Time', value: software.estimatedInstallTime || 'N/A' },
                  { label: 'Disk Space Required', value: software.diskSpaceRequired || 'N/A' },
                  { label: 'GPU Required', value: software.gpuRequired ? <Badge color="red">Yes</Badge> : <Badge>No</Badge> },
                ],
              },
              {
                type: 'group',
                title: 'Component',
                items: [
                  { label: 'Component ARN', value: software.componentArn || 'N/A' },
                ],
              },
            ]}
          />
        </Container>

        {/* Parameters */}
        {software.parameters && software.parameters.length > 0 && (
          <Container header={<Header variant="h2" counter={`(${software.parameters.length})`}>Parameters</Header>}>
            <Table
              columnDefinitions={[
                {
                  id: 'name',
                  header: 'Name',
                  cell: (item: ParameterDefinition) => item.name,
                  isRowHeader: true,
                },
                {
                  id: 'description',
                  header: 'Description',
                  cell: (item: ParameterDefinition) => item.description || '—',
                },
                {
                  id: 'required',
                  header: 'Required',
                  cell: (item: ParameterDefinition) =>
                    item.required ? <Badge color="red">Required</Badge> : <Badge>Optional</Badge>,
                },
              ]}
              items={software.parameters}
              trackBy="name"
              empty={<Box textAlign="center">No parameters defined</Box>}
            />
          </Container>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
};

export default SoftwareDetails;
