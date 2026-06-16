// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { Modal, Box, ProgressBar, SpaceBetween, Button, Alert } from '@cloudscape-design/components';
import { apiCall } from '../utils/api';

interface ProgressEvent {
  timestamp: string;
  stage: string;
  status: 'starting' | 'in-progress' | 'completed' | 'failed';
  message: string;
  progress: number;
}

interface WorkstationStartModalProps {
  visible: boolean;
  instanceId: string;
  onDismiss: () => void;
  onComplete: () => void;
  authToken: string;
}

const WorkstationStartModal: React.FC<WorkstationStartModalProps> = ({
  visible,
  instanceId,
  onDismiss,
  onComplete,
  authToken
}) => {
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [currentProgress, setCurrentProgress] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !instanceId) return;

    let pollInterval: NodeJS.Timeout | null = null;

    const pollProgress = async () => {
      try {
        const response = await apiCall(`progress?instanceId=${instanceId}`, {
          headers: {
            'Authorization': `Bearer ${authToken}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          if (data.events && data.events.length > 0) {
            setEvents(data.events);
            
            // Calculate overall progress using the highest progress value from events
            const progressValues = data.events.map((e: ProgressEvent) => e.progress || 0);
            const progress = Math.max(...progressValues, 0);
            setCurrentProgress(progress);

            // Check if complete
            const lastEvent = data.events[data.events.length - 1];
            if (lastEvent?.stage === 'complete' && lastEvent?.status === 'completed') {
              setIsComplete(true);
              setTimeout(() => {
                onComplete();
              }, 2000);
            }
          }
        }
      } catch (err) {
        console.error('Error polling progress:', err);
        setError('Failed to fetch progress updates');
      }
    };

    // Poll every 2 seconds
    pollProgress();
    pollInterval = setInterval(pollProgress, 2000);

    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [visible, instanceId, authToken, onComplete]);

  // Separate effect to clear state only when instanceId changes
  useEffect(() => {
    if (visible && instanceId) {
      setEvents([]);
      setCurrentProgress(0);
      setIsComplete(false);
      setError(null);
    }
  }, [instanceId]);

  const getStageIcon = (status: string) => {
    switch (status) {
      case 'completed': return '✅';
      case 'in-progress': return '🔄';
      case 'failed': return '❌';
      default: return '⏳';
    }
  };

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header="Starting Workstation"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            {!isComplete && (
              <Button variant="link" onClick={onDismiss}>
                Close
              </Button>
            )}
            {isComplete && (
              <Button variant="primary" onClick={onComplete}>
                Continue
              </Button>
            )}
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

        <Box>
          <ProgressBar
            value={currentProgress}
            label="Overall Progress"
            description={`${currentProgress}% complete`}
          />
        </Box>

        <Box>
          <h4>Progress Details:</h4>
          {events.length === 0 ? (
            <Box>Initializing...</Box>
          ) : (
            <SpaceBetween size="s">
              {events.map((event, index) => (
                <Box key={index}>
                  <SpaceBetween direction="horizontal" size="xs">
                    <span>{getStageIcon(event.status)}</span>
                    <strong>{event.stage}</strong>
                    <span>-</span>
                    <span>{event.message}</span>
                  </SpaceBetween>
                </Box>
              ))}
            </SpaceBetween>
          )}
        </Box>
      </SpaceBetween>
    </Modal>
  );
};

export default WorkstationStartModal;
