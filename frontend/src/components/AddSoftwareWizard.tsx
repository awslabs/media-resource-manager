// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AddSoftwareWizard Component
 * 
 * A multi-step wizard for adding software to the library.
 * Steps:
 * 1. Software Details - Name, version, category, description, platform
 * 2. Installation Media - Optional file upload
 * 3. Installation Script - Manual entry or AI generation
 * 4. Review & Create
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  Wizard,
  FormField,
  Input,
  Textarea,
  Select,
  RadioGroup,
  Checkbox,
  SpaceBetween,
  Box,
  Button,
  Alert,
  ProgressBar,
  Grid,
  Container,
  Header,
  ExpandableSection,
  StatusIndicator,
  Tabs,
  ButtonGroup,
  Modal,
} from '@cloudscape-design/components';
import ChatBubble from '@cloudscape-design/chat-components/chat-bubble';
import Avatar from '@cloudscape-design/chat-components/avatar';
import { apiCall } from '../utils/api';
import { getAuthToken, isBedrockEnabled } from '../utils/auth';

interface AddSoftwareWizardProps {
  onComplete: () => void;
  onCancel: () => void;
  onGeneratingChange?: (isGenerating: boolean) => void; // Notify parent when generation state changes
}

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
  phase?: string;
  codeBlock?: string;
}

interface ProgressEvent {
  phase: string;
  message: string;
  percent: number;
}

const AddSoftwareWizard: React.FC<AddSoftwareWizardProps> = ({ onComplete, onCancel, onGeneratingChange }) => {
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false); // Confirmation dialog for cancel during generation

  // Step 1: Software Details
  const [name, setName] = useState('');
  const [versionNumber, setVersionNumber] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [platform, setPlatform] = useState('Windows');
  const [estimatedInstallTime, setEstimatedInstallTime] = useState('');
  const [diskSpaceRequired, setDiskSpaceRequired] = useState('');
  const [gpuRequired, setGpuRequired] = useState(false);

  // Step 2: Installation Media
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [mediaS3Uri, setMediaS3Uri] = useState('');
  const [mediaFileName, setMediaFileName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 3: Installation Script
  const [scriptSource, setScriptSource] = useState<'manual' | 'ai'>('manual');
  const [script, setScript] = useState('');
  const [sourceType, setSourceType] = useState<'script' | 'arn'>('script');
  const [componentArn, setComponentArn] = useState('');

  // AI Script Generator state
  const [bedrockEnabled, setBedrockEnabled] = useState(true);
  const [aiMessages, setAiMessages] = useState<ChatMessage[]>([]);
  const [aiInputValue, setAiInputValue] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiProgress, setAiProgress] = useState<ProgressEvent | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [generatedScript, setGeneratedScript] = useState<string | null>(null);
  const [draftExecutionId, setDraftExecutionId] = useState<string | null>(null);
  const [testOnEc2, setTestOnEc2] = useState(true); // Whether to test script on EC2 instance
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const seenPhasesRef = useRef<Set<string>>(new Set()); // Track phases we've shown messages for

  // Scroll to bottom when AI messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [aiMessages]);

  // Check if Bedrock features are enabled
  useEffect(() => {
    isBedrockEnabled().then(setBedrockEnabled);
  }, []);

  // Notify parent when generation state changes
  useEffect(() => {
    onGeneratingChange?.(isGenerating);
  }, [isGenerating, onGeneratingChange]);

  // Initialize AI chat when switching to AI mode
  useEffect(() => {
    if (scriptSource === 'ai' && aiMessages.length === 0) {
      const greeting = `Hi! I'm ready to help you create an installation script for ${name || 'your software'} on ${platform}. I'll research the best installation methods, generate a script, and can test it on a real instance. Just say "generate" to start, or tell me any specific requirements you have.`;
      setAiMessages([{
        id: '1',
        role: 'agent',
        content: greeting,
        timestamp: new Date(),
      }]);
    }
  }, [scriptSource, name, platform]);

  const addAiMessage = useCallback((role: 'user' | 'agent', content: string, extras?: Partial<ChatMessage>) => {
    setAiMessages((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        role,
        content,
        timestamp: new Date(),
        ...extras,
      },
    ]);
  }, []);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setMediaFileName(file.name);
    }
  };

  const uploadMediaFile = async (): Promise<{ s3Uri: string; fileName: string } | null> => {
    if (!selectedFile) return null;
    
    const token = getAuthToken();
    if (!token) return null;

    // Use a temporary ID for the upload path
    const tempId = crypto.randomUUID();

    try {
      const urlResponse = await apiCall('/images/software/upload-url', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          softwareId: tempId,
          fileName: selectedFile.name,
          contentType: selectedFile.type || 'application/octet-stream'
        })
      });

      if (!urlResponse.ok) throw new Error('Failed to get upload URL');
      const { uploadUrl, s3Uri } = await urlResponse.json();

      setUploading(true);
      setUploadProgress(0);

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed with status ${xhr.status}`));
        });
        xhr.addEventListener('error', () => reject(new Error('Upload failed')));
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', selectedFile.type || 'application/octet-stream');
        xhr.send(selectedFile);
      });

      setMediaS3Uri(s3Uri);
      return { s3Uri, fileName: selectedFile.name };
    } catch (error) {
      console.error('Failed to upload media file:', error);
      return null;
    } finally {
      setUploading(false);
    }
  };

  // AI Script Generation functions
  const startAiGeneration = async (userMessage?: string) => {
    setIsGenerating(true);
    setAiError(null);
    setAiProgress(null);
    seenPhasesRef.current.clear(); // Reset seen phases for new generation

    if (userMessage) {
      addAiMessage('user', userMessage);
    }

    addAiMessage('agent', 'Starting script generation...', { phase: 'starting' });

    try {
      const token = getAuthToken();
      if (!token) throw new Error('Not authenticated');

      // Use the draft generation endpoint (doesn't require existing softwareId)
      const response = await apiCall('/images/software/generate-script-draft', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          softwareName: name,
          platform,
          mediaS3Uri: mediaS3Uri || undefined,
          testAutomatically: testOnEc2,
          maxAttempts: 3,
          timeoutMinutes: testOnEc2 ? 25 : 5, // Longer timeout if testing on EC2
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to start generation');
      }

      const data = await response.json();
      setDraftExecutionId(data.executionId);
      pollAiProgress(data.executionId);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'An error occurred');
      addAiMessage('agent', `Sorry, I encountered an error: ${err instanceof Error ? err.message : 'Unknown error'}. Please try again.`);
      setIsGenerating(false);
    }
  };

  const pollAiProgress = async (execId: string) => {
    const token = getAuthToken();
    if (!token) return;

    let lastEventId: string | undefined;

    const poll = async () => {
      try {
        const url = `/images/software/generation-progress-draft?executionId=${execId}${lastEventId ? `&lastEventId=${lastEventId}` : ''}`;
        const response = await apiCall(url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` },
        });

        if (!response.ok) throw new Error('Failed to get progress');

        const text = await response.text();
        const events = parseSSEEvents(text);

        for (const event of events) {
          handleAiProgressEvent(event);
          if (event.eventId) lastEventId = event.eventId;
        }

        const completeEvent = events.find((e) => e.type === 'complete');
        if (completeEvent) {
          handleAiCompletion(completeEvent.data);
          return;
        }

        setTimeout(poll, 2000);
      } catch (err) {
        console.error('Progress polling error:', err);
        setTimeout(poll, 5000);
      }
    };

    poll();
  };

  const parseSSEEvents = (text: string): Array<{ type: string; data: any; eventId?: string }> => {
    const events: Array<{ type: string; data: any; eventId?: string }> = [];
    const lines = text.split('\n');
    let currentEvent: { type?: string; data?: string } = {};

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent.type = line.substring(7);
      } else if (line.startsWith('data: ')) {
        currentEvent.data = line.substring(6);
      } else if (line === '' && currentEvent.type && currentEvent.data) {
        try {
          const data = JSON.parse(currentEvent.data);
          events.push({ type: currentEvent.type, data, eventId: data.eventId });
        } catch (e) {
          console.warn('Failed to parse SSE event:', currentEvent);
        }
        currentEvent = {};
      }
    }
    return events;
  };

  const handleAiProgressEvent = (event: { type: string; data: any }) => {
    if (event.type === 'progress') {
      const { phase, message, percent } = event.data;
      setAiProgress({ phase, message, percent });

      const phaseMessages: Record<string, string> = {
        research: '🔍 Researching installation methods...',
        generate: '📝 Generating installation script...',
        test: '🖥️ Launching test instance...',
        execute: '⚙️ Running installation script...',
        verify: '✅ Verifying installation...',
        complete: '💾 Script ready!',
        save: '💾 Script ready!',
      };

      // Use ref to track seen phases (avoids stale closure issues)
      if (phaseMessages[phase] && !seenPhasesRef.current.has(phase)) {
        seenPhasesRef.current.add(phase);
        addAiMessage('agent', phaseMessages[phase], { phase });
      }
    } else if (event.type === 'state') {
      // Handle state event which includes progress from execution state table
      const { currentPhase, progressPercent, progressMessage } = event.data;
      if (currentPhase && progressPercent !== undefined) {
        setAiProgress({ 
          phase: currentPhase, 
          message: progressMessage || `Phase: ${currentPhase}`, 
          percent: progressPercent 
        });

        const phaseMessages: Record<string, string> = {
          research: '🔍 Researching installation methods...',
          generate: '📝 Generating installation script...',
          test: '🖥️ Launching test instance...',
          execute: '⚙️ Running installation script...',
          verify: '✅ Verifying installation...',
          complete: '💾 Script ready!',
          save: '💾 Script ready!',
        };

        // Use ref to track seen phases (avoids stale closure issues)
        if (phaseMessages[currentPhase] && !seenPhasesRef.current.has(currentPhase)) {
          seenPhasesRef.current.add(currentPhase);
          addAiMessage('agent', progressMessage || phaseMessages[currentPhase], { phase: currentPhase });
        }
      }
    }
  };

  const handleAiCompletion = (data: any) => {
    setIsGenerating(false);
    setAiProgress(null);

    if (data.status === 'completed' || data.status === 'success') {
      const scriptResult = data.script;
      setGeneratedScript(scriptResult);
      setScript(scriptResult); // Set the main script state
      
      // Set suggested category and description from agent
      if (data.suggestedCategory && !category) {
        setCategory(data.suggestedCategory);
      }
      if (data.suggestedDescription && !description) {
        setDescription(data.suggestedDescription);
      }
      
      const verifiedText = data.verified ? '✅ Verified on EC2' : '⚠️ Not tested on EC2';
      addAiMessage('agent', `🎉 Script generated successfully! ${verifiedText}`, { codeBlock: scriptResult });
      
      // Show suggested metadata
      if (data.suggestedCategory || data.suggestedDescription) {
        const suggestions = [];
        if (data.suggestedCategory) suggestions.push(`Category: ${data.suggestedCategory}`);
        if (data.suggestedDescription) suggestions.push(`Description: ${data.suggestedDescription}`);
        addAiMessage('agent', `📋 Suggested metadata:\n${suggestions.join('\n')}`);
      }
    } else {
      const errorMsg = data.error || 'Generation failed after all attempts';
      setAiError(errorMsg);
      addAiMessage('agent', `❌ ${errorMsg}`);
    }
  };

  const handleAiSend = () => {
    if (!aiInputValue.trim()) return;

    const message = aiInputValue.trim().toLowerCase();
    setAiInputValue('');

    if (message === 'generate' || message === 'start' || message === 'go') {
      startAiGeneration(aiInputValue.trim());
    } else {
      addAiMessage('user', aiInputValue.trim());
      addAiMessage('agent', `I understand you want: "${aiInputValue.trim()}". Say "generate" when you're ready to start, and I'll incorporate your requirements.`);
    }
  };

  const useGeneratedScript = () => {
    if (generatedScript) {
      setScript(generatedScript);
      setScriptSource('manual'); // Switch to manual view to show the script
    }
  };

  // Cancel generation and stop the state machine
  const cancelGeneration = async () => {
    if (!draftExecutionId) {
      setIsGenerating(false);
      return;
    }

    try {
      const token = getAuthToken();
      if (token) {
        // Call API to stop the state machine execution
        await apiCall(`/images/software/cancel-generation?executionId=${draftExecutionId}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
        });
      }
    } catch (err) {
      console.error('Failed to cancel generation:', err);
    } finally {
      setIsGenerating(false);
      setAiProgress(null);
      addAiMessage('agent', '⚠️ Generation cancelled by user.');
    }
  };

  // Handle cancel button click - show confirmation if generating
  const handleCancelClick = () => {
    if (isGenerating) {
      setShowCancelConfirm(true);
    } else {
      onCancel();
    }
  };

  // Confirm cancel - stop generation and close wizard
  const confirmCancel = async () => {
    setShowCancelConfirm(false);
    await cancelGeneration();
    onCancel();
  };

  const validateStep = (stepIndex: number): boolean => {
    switch (stepIndex) {
      case 0: // Software Details
        if (!name.trim()) {
          setError('Software name is required');
          return false;
        }
        return true;
      case 1: // Installation Media - optional
        return true;
      case 2: // Installation Script
        if (sourceType === 'arn' && !componentArn.trim()) {
          setError('Component ARN is required');
          return false;
        }
        if (sourceType === 'script' && !script.trim()) {
          setError('Installation script is required');
          return false;
        }
        return true;
      case 3: // Review
        return true;
      default:
        return true;
    }
  };

  const handleNavigate = async ({ detail }: { detail: { requestedStepIndex: number } }) => {
    setError(null);

    // Validate current step before moving forward
    if (detail.requestedStepIndex > activeStepIndex) {
      if (!validateStep(activeStepIndex)) {
        return;
      }

      // Upload media file when leaving step 2 if file selected but not uploaded
      if (activeStepIndex === 1 && selectedFile && !mediaS3Uri) {
        const result = await uploadMediaFile();
        if (!result) {
          setError('Failed to upload media file');
          return;
        }
      }
    }

    setActiveStepIndex(detail.requestedStepIndex);
  };

  const handleSubmit = async () => {
    if (!validateStep(activeStepIndex)) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const token = getAuthToken();
      if (!token) throw new Error('Not authenticated');

      const payload: Record<string, any> = {
        name,
        versionNumber: versionNumber || '',
        category: category || '',
        description,
        platform,
        estimatedInstallTime,
        diskSpaceRequired,
        gpuRequired,
        sourceType,
      };

      if (sourceType === 'arn') {
        payload.componentArn = componentArn;
      } else {
        payload.script = script;
        if (mediaS3Uri) {
          payload.mediaS3Uri = mediaS3Uri;
          payload.mediaFileName = mediaFileName;
        }
      }

      const response = await apiCall('/images/software', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to create software');
      }

      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create software');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Render AI Chat Interface
  const renderAiChat = () => (
    <Container header={<Header variant="h3">AI Script Generator</Header>}>
      <SpaceBetween direction="vertical" size="m">
        {aiError && (
          <Alert type="error" dismissible onDismiss={() => setAiError(null)}>
            {aiError}
          </Alert>
        )}

        <Box padding="s" className="chat-messages" style={{ maxHeight: '400px', overflowY: 'auto' }}>
          <SpaceBetween direction="vertical" size="s">
            {aiMessages.map((msg) => (
              <ChatBubble
                key={msg.id}
                ariaLabel={`${msg.role === 'user' ? 'You' : 'AI Script Generator'} at ${msg.timestamp.toLocaleTimeString()}`}
                type={msg.role === 'user' ? 'outgoing' : 'incoming'}
                avatar={
                  msg.role === 'agent' ? (
                    <Avatar
                      color="gen-ai"
                      iconName="gen-ai"
                      ariaLabel="AI Script Generator"
                      tooltipText="AI Script Generator"
                    />
                  ) : undefined
                }
                actions={
                  msg.codeBlock ? (
                    <ButtonGroup
                      ariaLabel="Chat bubble actions"
                      variant="icon"
                      items={[
                        {
                          type: 'icon-button',
                          id: 'copy',
                          iconName: 'copy',
                          text: 'Copy script',
                          popoverFeedback: <StatusIndicator type="success">Script copied</StatusIndicator>,
                        },
                      ]}
                      onItemClick={({ detail }) => {
                        if (detail.id === 'copy' && msg.codeBlock) {
                          navigator.clipboard.writeText(msg.codeBlock);
                        }
                      }}
                    />
                  ) : undefined
                }
              >
                <SpaceBetween direction="vertical" size="xs">
                  <Box>{msg.content}</Box>
                  {msg.codeBlock && (
                    <ExpandableSection headerText="View Script" variant="footer">
                      <Box padding="s">
                        <pre style={{
                          backgroundColor: '#1e1e1e',
                          color: '#d4d4d4',
                          fontFamily: 'monospace',
                          fontSize: '12px',
                          borderRadius: '4px',
                          whiteSpace: 'pre-wrap',
                          overflowX: 'auto',
                          maxHeight: '300px',
                          padding: '12px',
                          margin: 0,
                        }}>
                          {msg.codeBlock}
                        </pre>
                      </Box>
                    </ExpandableSection>
                  )}
                </SpaceBetween>
              </ChatBubble>
            ))}
            <div ref={messagesEndRef} />
          </SpaceBetween>
        </Box>

        {isGenerating && aiProgress && (
          <ProgressBar value={aiProgress.percent} label={aiProgress.message} description={`Phase: ${aiProgress.phase}`} />
        )}

        {!isGenerating && !generatedScript && (
          <Checkbox
            checked={testOnEc2}
            onChange={({ detail }) => setTestOnEc2(detail.checked)}
            description="Launch a real EC2 instance to verify the script works (takes ~10-15 minutes)"
          >
            Test script on EC2 instance
          </Checkbox>
        )}

        <SpaceBetween direction="horizontal" size="xs">
          <div style={{ flex: 1 }}>
            <Input
              value={aiInputValue}
              onChange={({ detail }) => setAiInputValue(detail.value)}
              onKeyDown={({ detail }) => { if (detail.key === 'Enter') handleAiSend(); }}
              placeholder={isGenerating ? 'Generating...' : 'Type "generate" to start...'}
              disabled={isGenerating}
            />
          </div>
          <Button variant="primary" onClick={handleAiSend} disabled={!aiInputValue.trim() || isGenerating}>
            {isGenerating ? 'Generating...' : 'Send'}
          </Button>
        </SpaceBetween>

        {generatedScript && !isGenerating && (
          <SpaceBetween direction="vertical" size="s">
            <ExpandableSection headerText="Generated Script" defaultExpanded>
              <Box padding="s">
                <pre style={{
                  backgroundColor: '#1e1e1e',
                  color: '#d4d4d4',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  borderRadius: '4px',
                  whiteSpace: 'pre-wrap',
                  overflowX: 'auto',
                  maxHeight: '400px',
                  padding: '12px',
                  margin: 0,
                }}>
                  {generatedScript}
                </pre>
              </Box>
            </ExpandableSection>
            <Button variant="primary" onClick={useGeneratedScript}>
              Use This Script
            </Button>
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Container>
  );

  return (
    <>
      {/* Cancel Confirmation Modal */}
      <Modal
        visible={showCancelConfirm}
        onDismiss={() => setShowCancelConfirm(false)}
        header="Cancel Script Generation?"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowCancelConfirm(false)}>
                Continue Generating
              </Button>
              <Button variant="primary" onClick={confirmCancel}>
                Yes, Cancel
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box>
            AI script generation is currently in progress. If you cancel now:
          </Box>
          <Alert type="warning">
            <ul style={{ margin: 0, paddingLeft: '20px' }}>
              <li>The generation process will be stopped</li>
              <li>Any test EC2 instances will be terminated</li>
              <li>Progress will be lost</li>
            </ul>
          </Alert>
          <Box>Are you sure you want to cancel?</Box>
        </SpaceBetween>
      </Modal>

      <Wizard
      i18nStrings={{
        stepNumberLabel: (stepNumber) => `Step ${stepNumber}`,
        collapsedStepsLabel: (stepNumber, stepsCount) => `Step ${stepNumber} of ${stepsCount}`,
        skipToButtonLabel: (step) => `Skip to ${step.title}`,
        navigationAriaLabel: 'Steps',
        cancelButton: 'Cancel',
        previousButton: 'Previous',
        nextButton: 'Next',
        submitButton: 'Create Software',
        optional: 'optional',
      }}
      onNavigate={handleNavigate}
      activeStepIndex={activeStepIndex}
      onCancel={handleCancelClick}
      onSubmit={handleSubmit}
      isLoadingNextStep={isSubmitting || uploading}
      steps={[
        {
          title: 'Software Details',
          description: 'Enter basic information about the software',
          content: (
            <SpaceBetween direction="vertical" size="m">
              {error && activeStepIndex === 0 && (
                <Alert type="error" dismissible onDismiss={() => setError(null)}>{error}</Alert>
              )}
              <Grid gridDefinition={[{ colspan: 8 }, { colspan: 4 }]}>
                <FormField label="Software Name" constraintText="Required">
                  <Input
                    value={name}
                    onChange={({ detail }) => setName(detail.value)}
                    placeholder="e.g., Adobe Creative Suite"
                  />
                </FormField>
                <FormField label="Version Number" constraintText="Optional - leave empty for 'Latest'">
                  <Input
                    value={versionNumber}
                    onChange={({ detail }) => setVersionNumber(detail.value)}
                    placeholder="e.g., 2024"
                  />
                </FormField>
              </Grid>
              <FormField label="Category">
                <Select
                  selectedOption={category ? { label: category.charAt(0).toUpperCase() + category.slice(1), value: category } : null}
                  onChange={({ detail }) => setCategory(detail.selectedOption.value!)}
                  options={[
                    { label: 'Development', value: 'development' },
                    { label: 'Media', value: 'media' },
                    { label: 'System', value: 'system' },
                    { label: 'Utilities', value: 'utilities' },
                  ]}
                  placeholder="Choose a category"
                />
              </FormField>
              <FormField label="Description">
                <Textarea
                  value={description}
                  onChange={({ detail }) => setDescription(detail.value)}
                  placeholder="Brief description of the software..."
                  rows={2}
                />
              </FormField>
              <FormField label="Target Platform" description="Select the OS this software is for">
                <RadioGroup
                  value={platform}
                  onChange={({ detail }) => setPlatform(detail.value)}
                  items={[
                    { value: 'Windows', label: 'Windows' },
                    { value: 'Linux', label: 'Linux (Ubuntu/Amazon Linux)' },
                    { value: 'macOS', label: 'macOS' },
                  ]}
                />
              </FormField>
              <Grid gridDefinition={[{ colspan: 6 }, { colspan: 6 }]}>
                <FormField label="Estimated Install Time">
                  <Input
                    value={estimatedInstallTime}
                    onChange={({ detail }) => setEstimatedInstallTime(detail.value)}
                    placeholder="e.g., 5 minutes"
                  />
                </FormField>
                <FormField label="Disk Space Required">
                  <Input
                    value={diskSpaceRequired}
                    onChange={({ detail }) => setDiskSpaceRequired(detail.value)}
                    placeholder="e.g., 2 GB"
                  />
                </FormField>
              </Grid>
              <Checkbox checked={gpuRequired} onChange={({ detail }) => setGpuRequired(detail.checked)}>
                This software requires GPU
              </Checkbox>
            </SpaceBetween>
          ),
        },

        {
          title: 'Installation Media',
          description: 'Upload installer files (optional)',
          isOptional: true,
          content: (
            <SpaceBetween direction="vertical" size="m">
              {error && activeStepIndex === 1 && (
                <Alert type="error" dismissible onDismiss={() => setError(null)}>{error}</Alert>
              )}
              <Alert type="info">
                Upload installer files (exe, msi, zip, pkg, dmg) that your installation script will use.
                This is optional - your script can also download software from the internet.
              </Alert>
              <FormField label="Installation Media" description="Upload installer files that your script will use">
                <SpaceBetween direction="vertical" size="xs">
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    style={{ display: 'none' }}
                    accept=".exe,.msi,.zip,.iso,.pkg,.dmg,.sh,.tar.gz"
                  />
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button onClick={() => fileInputRef.current?.click()}>
                      {selectedFile ? 'Change File' : 'Select File'}
                    </Button>
                    {selectedFile && (
                      <Button variant="link" onClick={() => {
                        setSelectedFile(null);
                        setMediaFileName('');
                        setMediaS3Uri('');
                        if (fileInputRef.current) fileInputRef.current.value = '';
                      }}>
                        Clear
                      </Button>
                    )}
                  </SpaceBetween>
                  {selectedFile && (
                    <Box color="text-body-secondary">
                      Selected: {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
                    </Box>
                  )}
                  {uploading && <ProgressBar value={uploadProgress} label="Uploading..." />}
                  {mediaS3Uri && !uploading && (
                    <StatusIndicator type="success">File uploaded successfully</StatusIndicator>
                  )}
                </SpaceBetween>
              </FormField>
              {selectedFile && (
                <Alert type="info">
                  Your script can access the uploaded file using{' '}
                  {platform === 'Windows' ? <code>$env:MEDIA_PATH</code> : <code>$MEDIA_PATH</code>}{' '}
                  which will contain the full path to the downloaded installer.
                </Alert>
              )}
            </SpaceBetween>
          ),
        },

        {
          title: 'Installation Script',
          description: 'Create or generate the installation script',
          content: (
            <SpaceBetween direction="vertical" size="m">
              {error && activeStepIndex === 2 && (
                <Alert type="error" dismissible onDismiss={() => setError(null)}>{error}</Alert>
              )}
              <FormField label="Component Source">
                <RadioGroup
                  value={sourceType}
                  onChange={({ detail }) => setSourceType(detail.value as 'script' | 'arn')}
                  items={[
                    { value: 'script', label: platform === 'Windows' ? 'Custom PowerShell Script' : 'Custom Bash Script' },
                    { value: 'arn', label: 'Existing Component ARN' },
                  ]}
                />
              </FormField>

              {sourceType === 'arn' ? (
                <FormField label="Component ARN" constraintText="Required">
                  <Input
                    value={componentArn}
                    onChange={({ detail }) => setComponentArn(detail.value)}
                    placeholder="arn:aws:imagebuilder:us-east-1:123456789012:component/..."
                  />
                </FormField>
              ) : (
                <SpaceBetween direction="vertical" size="m">
                  <Tabs
                    activeTabId={scriptSource}
                    onChange={({ detail }) => setScriptSource(detail.activeTabId as 'manual' | 'ai')}
                    tabs={[
                      {
                        id: 'manual',
                        label: 'Write Script',
                        content: (
                          <FormField
                            label={platform === 'Windows' ? 'PowerShell Script' : 'Bash Script'}
                            constraintText="Required"
                          >
                            <Textarea
                              value={script}
                              onChange={({ detail }) => setScript(detail.value)}
                              placeholder={
                                mediaS3Uri
                                  ? platform === 'Windows'
                                    ? '# Example with uploaded media:\nStart-Process -FilePath $env:MEDIA_PATH -ArgumentList "/S" -Wait'
                                    : '# Example with uploaded media:\nchmod +x "$MEDIA_PATH"\n"$MEDIA_PATH" --silent'
                                  : platform === 'Windows'
                                    ? '# Enter your PowerShell installation script here...'
                                    : '# Enter your Bash installation script here...\nsudo apt-get update\nsudo apt-get install -y <package>'
                              }
                              rows={12}
                            />
                          </FormField>
                        ),
                      },
                      {
                        id: 'ai',
                        label: (
                          <SpaceBetween direction="horizontal" size="xs">
                            <span>Generate with AI</span>
                            <Box variant="small" color="text-status-info">✨</Box>
                          </SpaceBetween>
                        ),
                        content: renderAiChat(),
                      },
                    ].filter(tab => bedrockEnabled || tab.id !== 'ai')}
                  />
                  {script && scriptSource === 'ai' && (
                    <Alert type="success">
                      Script is ready! You can review it in the "Write Script" tab or proceed to the next step.
                    </Alert>
                  )}
                </SpaceBetween>
              )}
            </SpaceBetween>
          ),
        },

        {
          title: 'Review & Create',
          description: 'Review your software configuration',
          content: (
            <SpaceBetween direction="vertical" size="l">
              {error && activeStepIndex === 3 && (
                <Alert type="error" dismissible onDismiss={() => setError(null)}>{error}</Alert>
              )}
              <Container header={<Header variant="h3">Software Details</Header>}>
                <SpaceBetween direction="vertical" size="s">
                  <Box><strong>Name:</strong> {name}</Box>
                  <Box><strong>Version:</strong> {versionNumber || 'Latest'}</Box>
                  <Box><strong>Category:</strong> {category ? category.charAt(0).toUpperCase() + category.slice(1) : 'Not specified'}</Box>
                  <Box><strong>Platform:</strong> {platform}</Box>
                  <Box><strong>Description:</strong> {description || 'None'}</Box>
                  <Box><strong>GPU Required:</strong> {gpuRequired ? 'Yes' : 'No'}</Box>
                  {estimatedInstallTime && <Box><strong>Install Time:</strong> {estimatedInstallTime}</Box>}
                  {diskSpaceRequired && <Box><strong>Disk Space:</strong> {diskSpaceRequired}</Box>}
                </SpaceBetween>
              </Container>

              {mediaFileName && (
                <Container header={<Header variant="h3">Installation Media</Header>}>
                  <Box><strong>File:</strong> {mediaFileName}</Box>
                </Container>
              )}

              <Container header={<Header variant="h3">Installation Script</Header>}>
                {sourceType === 'arn' ? (
                  <Box><strong>Component ARN:</strong> {componentArn}</Box>
                ) : (
                  <ExpandableSection headerText="View Script" defaultExpanded={false}>
                    <Box padding="s">
                      <pre style={{
                        backgroundColor: '#1e1e1e',
                        color: '#d4d4d4',
                        fontFamily: 'monospace',
                        fontSize: '12px',
                        borderRadius: '4px',
                        whiteSpace: 'pre-wrap',
                        overflowX: 'auto',
                        maxHeight: '300px',
                        padding: '12px',
                        margin: 0,
                      }}>
                        {script}
                      </pre>
                    </Box>
                  </ExpandableSection>
                )}
              </Container>
            </SpaceBetween>
          ),
        },
      ]}
    />
    </>
  );
};

export default AddSoftwareWizard;
