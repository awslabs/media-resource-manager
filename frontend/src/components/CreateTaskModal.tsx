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
  Alert,
  ExpandableSection,
  RadioGroup,
  Toggle
} from '@cloudscape-design/components';
import {
  DataSyncLocation,
  DataSyncTask,
  TaskOptions,
  CreateTaskRequest,
  UpdateTaskRequest,
  createDataSyncTask,
  updateDataSyncTask
} from '../utils/datasyncApi';

interface CreateTaskModalProps {
  visible: boolean;
  onDismiss: () => void;
  onSuccess: () => void;
  locations: DataSyncLocation[];
  editingTask: DataSyncTask | null;
}

const DEFAULT_OPTIONS: TaskOptions = {
  transferMode: 'CHANGED',
  verifyMode: 'ONLY_FILES_TRANSFERRED',
  overwriteMode: 'ALWAYS',
  preserveDeletedFiles: 'PRESERVE',
  logLevel: 'BASIC'
};

const CreateTaskModal: React.FC<CreateTaskModalProps> = ({
  visible,
  onDismiss,
  onSuccess,
  locations,
  editingTask
}) => {
  const [name, setName] = useState('');
  const [sourceLocationId, setSourceLocationId] = useState<string | null>(null);
  const [destinationLocationId, setDestinationLocationId] = useState<string | null>(null);
  const [options, setOptions] = useState<TaskOptions>(DEFAULT_OPTIONS);
  const [bandwidthLimit, setBandwidthLimit] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = !!editingTask;

  // Filter locations by type for source/destination compatibility
  const s3Locations = locations.filter(l => l.locationType === 'S3' && l.status === 'available');
  const fsxLocations = locations.filter(l => 
    (l.locationType === 'FSX_ONTAP' || l.locationType === 'FSX_WINDOWS') && l.status === 'available'
  );

  // Get compatible destination locations based on source selection
  const getDestinationOptions = () => {
    if (!sourceLocationId) return [];
    const sourceLocation = locations.find(l => l.locationId === sourceLocationId);
    if (!sourceLocation) return [];
    
    // S3 source -> FSx destination, FSx source -> S3 destination
    if (sourceLocation.locationType === 'S3') {
      return fsxLocations;
    } else {
      return s3Locations;
    }
  };

  const resetForm = () => {
    setName('');
    setSourceLocationId(null);
    setDestinationLocationId(null);
    setOptions(DEFAULT_OPTIONS);
    setBandwidthLimit('');
    setError(null);
  };

  useEffect(() => {
    if (visible) {
      if (editingTask) {
        setName(editingTask.name);
        setSourceLocationId(editingTask.sourceLocationId);
        setDestinationLocationId(editingTask.destinationLocationId);
        setOptions(editingTask.options || DEFAULT_OPTIONS);
        // Convert bytes/sec to MB/s for display
        const mbps = editingTask.options?.bytesPerSecond 
          ? (editingTask.options.bytesPerSecond / (1024 * 1024)).toString() 
          : '';
        setBandwidthLimit(mbps);
      } else {
        resetForm();
      }
    }
  }, [visible, editingTask]);

  // Reset destination when source changes
  useEffect(() => {
    if (!isEditing) {
      setDestinationLocationId(null);
    }
  }, [sourceLocationId, isEditing]);

  const handleSubmit = async () => {
    setError(null);

    // Validation
    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    if (!isEditing) {
      if (!sourceLocationId) {
        setError('Please select a source location');
        return;
      }
      if (!destinationLocationId) {
        setError('Please select a destination location');
        return;
      }
    }

    // Validate bandwidth limit if provided (user enters MB/s, we convert to bytes/sec)
    let bytesPerSecond: number | undefined;
    if (bandwidthLimit.trim()) {
      const mbps = parseFloat(bandwidthLimit);
      if (isNaN(mbps) || mbps <= 0) {
        setError('Bandwidth limit must be a positive number');
        return;
      }
      // Convert MB/s to bytes/sec
      bytesPerSecond = Math.round(mbps * 1024 * 1024);
    }

    const taskOptions: TaskOptions = {
      ...options,
      bytesPerSecond
    };

    try {
      setSubmitting(true);

      if (isEditing) {
        const updateRequest: UpdateTaskRequest = {
          name: name.trim(),
          options: taskOptions
        };
        await updateDataSyncTask(editingTask.taskId, updateRequest);
      } else {
        const createRequest: CreateTaskRequest = {
          name: name.trim(),
          sourceLocationId: sourceLocationId!,
          destinationLocationId: destinationLocationId!,
          options: taskOptions
        };
        await createDataSyncTask(createRequest);
      }

      onSuccess();
    } catch (err: any) {
      setError(err.message || `Failed to ${isEditing ? 'update' : 'create'} task`);
    } finally {
      setSubmitting(false);
    }
  };

  const getLocationLabel = (locationId: string) => {
    const location = locations.find(l => l.locationId === locationId);
    if (!location) return locationId;
    const typeLabel = location.locationType === 'S3' ? 'S3' : 
      location.locationType === 'FSX_ONTAP' ? 'FSx ONTAP' : 'FSx Windows';
    return `${location.name} (${typeLabel})`;
  };

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={isEditing ? 'Edit DataSync Task' : 'Create DataSync Task'}
      size="large"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit} loading={submitting}>
              {isEditing ? 'Save changes' : 'Create task'}
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

        <FormField label="Task name" description="A friendly name for this task">
          <Input
            value={name}
            onChange={({ detail }) => setName(detail.value)}
            placeholder="e.g., Daily S3 to FSx Sync"
          />
        </FormField>

        {/* Source and Destination - disabled when editing */}
        <FormField 
          label="Source location"
          description={isEditing ? 'Source cannot be changed after task creation' : 'Select the source for data transfer'}
        >
          <Select
            selectedOption={sourceLocationId ? 
              { value: sourceLocationId, label: getLocationLabel(sourceLocationId) } 
              : null
            }
            onChange={({ detail }) => setSourceLocationId(detail.selectedOption?.value || null)}
            options={[...s3Locations, ...fsxLocations].map(l => ({
              value: l.locationId,
              label: getLocationLabel(l.locationId)
            }))}
            placeholder="Select source location"
            disabled={isEditing}
            empty="No locations available"
          />
        </FormField>

        <FormField 
          label="Destination location"
          description={isEditing ? 'Destination cannot be changed after task creation' : 
            sourceLocationId ? 'Select a compatible destination (S3↔FSx)' : 'Select a source first'}
        >
          <Select
            selectedOption={destinationLocationId ? 
              { value: destinationLocationId, label: getLocationLabel(destinationLocationId) } 
              : null
            }
            onChange={({ detail }) => setDestinationLocationId(detail.selectedOption?.value || null)}
            options={getDestinationOptions().map(l => ({
              value: l.locationId,
              label: getLocationLabel(l.locationId)
            }))}
            placeholder="Select destination location"
            disabled={isEditing || !sourceLocationId}
            empty={sourceLocationId ? 'No compatible destinations' : 'Select a source first'}
          />
        </FormField>

        {/* Transfer Options */}
        <ExpandableSection headerText="Transfer options" defaultExpanded={isEditing}>
          <SpaceBetween size="m">
            <FormField label="Transfer mode" description="Which files to transfer">
              <RadioGroup
                value={options.transferMode}
                onChange={({ detail }) => setOptions({ ...options, transferMode: detail.value as any })}
                items={[
                  { value: 'CHANGED', label: 'Changed files only', description: 'Transfer only files that have changed' },
                  { value: 'ALL', label: 'All files', description: 'Transfer all files regardless of changes' }
                ]}
              />
            </FormField>

            <FormField label="Verification mode" description="How to verify transferred data">
              <RadioGroup
                value={options.verifyMode}
                onChange={({ detail }) => setOptions({ ...options, verifyMode: detail.value as any })}
                items={[
                  { value: 'ONLY_FILES_TRANSFERRED', label: 'Verify transferred files', description: 'Verify only files that were transferred' },
                  { value: 'POINT_IN_TIME_CONSISTENT', label: 'Full verification', description: 'Verify all files at destination match source' },
                  { value: 'NONE', label: 'No verification', description: 'Skip verification (faster but less safe)' }
                ]}
              />
            </FormField>

            <FormField label="Overwrite mode" description="How to handle existing files at destination">
              <RadioGroup
                value={options.overwriteMode}
                onChange={({ detail }) => setOptions({ ...options, overwriteMode: detail.value as any })}
                items={[
                  { value: 'ALWAYS', label: 'Always overwrite', description: 'Replace existing files at destination' },
                  { value: 'NEVER', label: 'Never overwrite', description: 'Skip files that already exist at destination' }
                ]}
              />
            </FormField>

            <FormField label="Deleted files" description="How to handle files deleted from source">
              <RadioGroup
                value={options.preserveDeletedFiles}
                onChange={({ detail }) => setOptions({ ...options, preserveDeletedFiles: detail.value as any })}
                items={[
                  { value: 'PRESERVE', label: 'Preserve at destination', description: 'Keep files at destination even if deleted from source' },
                  { value: 'REMOVE', label: 'Remove from destination', description: 'Delete files from destination when deleted from source' }
                ]}
              />
            </FormField>

            <FormField label="Log level" description="Amount of detail in CloudWatch logs">
              <RadioGroup
                value={options.logLevel}
                onChange={({ detail }) => setOptions({ ...options, logLevel: detail.value as any })}
                items={[
                  { value: 'OFF', label: 'Off', description: 'No logging' },
                  { value: 'BASIC', label: 'Basic', description: 'Log errors and warnings' },
                  { value: 'TRANSFER', label: 'Transfer', description: 'Log all transferred files' }
                ]}
              />
            </FormField>

            <FormField 
              label="Bandwidth limit (optional)" 
              description="Maximum transfer speed in MB/s (leave empty for unlimited)"
            >
              <Input
                value={bandwidthLimit}
                onChange={({ detail }) => setBandwidthLimit(detail.value)}
                placeholder="e.g., 100"
                type="number"
              />
            </FormField>
          </SpaceBetween>
        </ExpandableSection>
      </SpaceBetween>
    </Modal>
  );
};

export default CreateTaskModal;
