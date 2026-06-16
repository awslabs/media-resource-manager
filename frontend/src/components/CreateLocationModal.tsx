// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import {
  Modal,
  Box,
  SpaceBetween,
  Button,
  FormField,
  Input,
  Select,
  Tiles,
  Alert,
  ExpandableSection,
  CodeEditor
} from '@cloudscape-design/components';
import {
  S3Bucket,
  CreateLocationRequest,
  createDataSyncLocation
} from '../utils/datasyncApi';

interface StorageResource {
  storageId: string;
  name: string;
  type: string;
  status: string;
}

interface CreateLocationModalProps {
  visible: boolean;
  onDismiss: () => void;
  onSuccess: () => void;
  storageResources: StorageResource[];
  s3Buckets: S3Bucket[];
}

const CreateLocationModal: React.FC<CreateLocationModalProps> = ({
  visible,
  onDismiss,
  onSuccess,
  storageResources,
  s3Buckets
}) => {
  const [locationType, setLocationType] = useState<'S3' | 'FSX_ONTAP' | 'FSX_WINDOWS'>('S3');
  const [name, setName] = useState('');
  const [s3Source, setS3Source] = useState<'same-account' | 'cross-account'>('same-account');
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const [crossAccountBucketArn, setCrossAccountBucketArn] = useState('');
  const [selectedStorage, setSelectedStorage] = useState<string | null>(null);
  const [subdirectory, setSubdirectory] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter storage resources by type
  const fsxOntapResources = storageResources.filter(r => r.type === 'fsx-ontap' && r.status === 'available');
  const fsxWindowsResources = storageResources.filter(r => r.type === 'fsx-windows' && r.status === 'available');

  // Generate bucket policy for cross-account access
  const generateBucketPolicy = () => {
    if (!crossAccountBucketArn) return '';
    const bucketName = crossAccountBucketArn.split(':').pop() || 'your-bucket';
    return JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DataSyncBucketAccess',
          Effect: 'Allow',
          Principal: {
            AWS: 'arn:aws:iam::YOUR_ACCOUNT_ID:role/YOUR_DATASYNC_ROLE'
          },
          Action: [
            's3:GetBucketLocation',
            's3:ListBucket',
            's3:ListBucketMultipartUploads'
          ],
          Resource: `arn:aws:s3:::${bucketName}`
        },
        {
          Sid: 'DataSyncObjectAccess',
          Effect: 'Allow',
          Principal: {
            AWS: 'arn:aws:iam::YOUR_ACCOUNT_ID:role/YOUR_DATASYNC_ROLE'
          },
          Action: [
            's3:GetObject',
            's3:GetObjectTagging',
            's3:GetObjectVersion',
            's3:GetObjectVersionTagging',
            's3:ListMultipartUploadParts'
          ],
          Resource: `arn:aws:s3:::${bucketName}/*`
        }
      ]
    }, null, 2);
  };

  const resetForm = () => {
    setLocationType('S3');
    setName('');
    setS3Source('same-account');
    setSelectedBucket(null);
    setCrossAccountBucketArn('');
    setSelectedStorage(null);
    setSubdirectory('');
    setError(null);
  };

  useEffect(() => {
    if (visible) {
      resetForm();
    }
  }, [visible]);

  const handleSubmit = async () => {
    setError(null);
    
    // Validation
    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    let request: CreateLocationRequest;

    if (locationType === 'S3') {
      let bucketArn: string;
      if (s3Source === 'same-account') {
        if (!selectedBucket) {
          setError('Please select an S3 bucket');
          return;
        }
        bucketArn = `arn:aws:s3:::${selectedBucket}`;
      } else {
        if (!crossAccountBucketArn.trim()) {
          setError('Please enter the S3 bucket ARN');
          return;
        }
        if (!crossAccountBucketArn.startsWith('arn:aws:s3:::')) {
          setError('Invalid bucket ARN format. Expected: arn:aws:s3:::bucket-name');
          return;
        }
        bucketArn = crossAccountBucketArn;
      }

      request = {
        name: name.trim(),
        type: 'S3',
        s3Config: {
          bucketArn,
          subdirectory: subdirectory.trim() || undefined,
          isCrossAccount: s3Source === 'cross-account'
        }
      };
    } else {
      if (!selectedStorage) {
        setError('Please select a storage resource');
        return;
      }

      request = {
        name: name.trim(),
        type: locationType,
        fsxConfig: {
          storageId: selectedStorage,
          subdirectory: subdirectory.trim() || undefined
        }
      };
    }

    try {
      setSubmitting(true);
      await createDataSyncLocation(request);
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Failed to create location');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header="Create DataSync Location"
      size="large"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit} loading={submitting}>
              Create location
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}

        <FormField label="Location name" description="A friendly name for this location">
          <Input
            value={name}
            onChange={({ detail }) => setName(detail.value)}
            placeholder="e.g., Production S3 Bucket"
          />
        </FormField>

        <FormField label="Location type">
          <Tiles
            value={locationType}
            onChange={({ detail }) => setLocationType(detail.value as any)}
            items={[
              {
                value: 'S3',
                label: 'Amazon S3',
                description: 'S3 bucket in this or another account'
              },
              {
                value: 'FSX_ONTAP',
                label: 'FSx for ONTAP',
                description: 'FSx for NetApp ONTAP file system'
              },
              {
                value: 'FSX_WINDOWS',
                label: 'FSx for Windows',
                description: 'FSx for Windows File Server'
              }
            ]}
          />
        </FormField>

        {locationType === 'S3' && (
          <>
            <FormField label="S3 bucket source">
              <Tiles
                value={s3Source}
                onChange={({ detail }) => setS3Source(detail.value as any)}
                items={[
                  {
                    value: 'same-account',
                    label: 'Same account',
                    description: 'Select from buckets in this account'
                  },
                  {
                    value: 'cross-account',
                    label: 'Cross-account',
                    description: 'Enter bucket ARN from another account'
                  }
                ]}
              />
            </FormField>

            {s3Source === 'same-account' ? (
              <FormField label="S3 bucket">
                <Select
                  selectedOption={selectedBucket ? { value: selectedBucket, label: selectedBucket } : null}
                  onChange={({ detail }) => setSelectedBucket(detail.selectedOption?.value || null)}
                  options={s3Buckets.map(b => ({ value: b.name, label: b.name }))}
                  placeholder="Select a bucket"
                  filteringType="auto"
                  empty="No buckets found"
                />
              </FormField>
            ) : (
              <>
                <FormField
                  label="S3 bucket ARN"
                  description="Format: arn:aws:s3:::bucket-name"
                >
                  <Input
                    value={crossAccountBucketArn}
                    onChange={({ detail }) => setCrossAccountBucketArn(detail.value)}
                    placeholder="arn:aws:s3:::my-bucket"
                  />
                </FormField>

                {crossAccountBucketArn && (
                  <ExpandableSection headerText="Required bucket policy">
                    <Alert type="info">
                      Add this policy to the S3 bucket to allow DataSync access. Replace YOUR_ACCOUNT_ID and YOUR_DATASYNC_ROLE with your actual values.
                    </Alert>
                    <Box margin={{ top: 's' }}>
                      <pre style={{ 
                        backgroundColor: '#f1f3f5', 
                        padding: '12px', 
                        borderRadius: '4px',
                        overflow: 'auto',
                        fontSize: '12px'
                      }}>
                        {generateBucketPolicy()}
                      </pre>
                    </Box>
                  </ExpandableSection>
                )}
              </>
            )}
          </>
        )}

        {locationType === 'FSX_ONTAP' && (
          <FormField label="FSx for ONTAP file system">
            <Select
              selectedOption={selectedStorage ? 
                { value: selectedStorage, label: fsxOntapResources.find(r => r.storageId === selectedStorage)?.name || selectedStorage } 
                : null
              }
              onChange={({ detail }) => setSelectedStorage(detail.selectedOption?.value || null)}
              options={fsxOntapResources.map(r => ({ value: r.storageId, label: r.name }))}
              placeholder="Select an FSx for ONTAP file system"
              empty="No FSx for ONTAP file systems available"
            />
          </FormField>
        )}

        {locationType === 'FSX_WINDOWS' && (
          <FormField label="FSx for Windows file system">
            <Select
              selectedOption={selectedStorage ? 
                { value: selectedStorage, label: fsxWindowsResources.find(r => r.storageId === selectedStorage)?.name || selectedStorage } 
                : null
              }
              onChange={({ detail }) => setSelectedStorage(detail.selectedOption?.value || null)}
              options={fsxWindowsResources.map(r => ({ value: r.storageId, label: r.name }))}
              placeholder="Select an FSx for Windows file system"
              empty="No FSx for Windows file systems available"
            />
          </FormField>
        )}

        <FormField
          label="Subdirectory (optional)"
          description="Path within the location to use as the root"
        >
          <Input
            value={subdirectory}
            onChange={({ detail }) => setSubdirectory(detail.value)}
            placeholder={locationType === 'S3' ? '/prefix/path/' : '/share/path/'}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
};

export default CreateLocationModal;
