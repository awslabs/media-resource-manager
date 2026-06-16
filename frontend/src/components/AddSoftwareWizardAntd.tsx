// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AddSoftwareWizardAntd Component
 * 
 * A multi-step wizard for adding software to the library (Ant Design version).
 * Steps:
 * 1. Software Details - Name, version, category, description, platform
 * 2. Installation Media - Optional file upload
 * 3. Installation Script - Manual entry or AI generation
 * 4. Review & Create
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { InputRef } from 'antd';
import {
  Steps,
  Form,
  Input,
  Select,
  Radio,
  Checkbox,
  Button,
  Alert,
  Progress,
  Row,
  Col,
  Typography,
  Space,
  Tabs,
  Divider,
  Descriptions,
  Collapse,
  Spin,
  Card,
  Modal,
  theme,
} from 'antd';
import {
  UploadOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  RobotOutlined,
  SendOutlined,
  CopyOutlined,
  BulbOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { apiCall } from '../utils/api';
import { getAuthToken, isBedrockEnabled } from '../utils/auth';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

interface AddSoftwareWizardAntdProps {
  onComplete: () => void;
  onCancel: () => void;
  onGeneratingChange?: (isGenerating: boolean) => void;
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

const AddSoftwareWizardAntd: React.FC<AddSoftwareWizardAntdProps> = ({
  onComplete,
  onCancel,
  onGeneratingChange,
}) => {
  const { token } = theme.useToken();
  const [currentStep, setCurrentStep] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

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
  const nameInputRef = useRef<InputRef>(null);

  // Focus the name input when component mounts (modal opens)
  useEffect(() => {
    // Small delay to ensure modal animation completes and focus isn't stolen
    const timer = setTimeout(() => {
      nameInputRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  // Check if Bedrock features are enabled
  useEffect(() => {
    isBedrockEnabled().then(setBedrockEnabled);
  }, []);

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
  const [isChatLoading, setIsChatLoading] = useState(false); // Loading state for chat responses
  const [aiProgress, setAiProgress] = useState<ProgressEvent | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [generatedScript, setGeneratedScript] = useState<string | null>(null);
  const [draftExecutionId, setDraftExecutionId] = useState<string | null>(null);
  const [testOnEc2, setTestOnEc2] = useState(true);
  const [collectedRequirements, setCollectedRequirements] = useState<Record<string, any>>({}); // Structured requirements from chat
  const [readyToGenerate, setReadyToGenerate] = useState(false); // Flag from chatbot when ready
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const seenPhasesRef = useRef<Set<string>>(new Set());
  const conversationHistoryRef = useRef<Array<{ role: string; content: string }>>([]); // Track conversation for API

  // Scroll to bottom when AI messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [aiMessages]);

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
      { id: Date.now().toString(), role, content, timestamp: new Date(), ...extras },
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

    const tempId = crypto.randomUUID();

    try {
      const urlResponse = await apiCall('/images/software/upload-url', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          softwareId: tempId,
          fileName: selectedFile.name,
          contentType: selectedFile.type || 'application/octet-stream',
        }),
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
  const startAiGeneration = async () => {
    setIsGenerating(true);
    setAiError(null);
    setAiProgress(null);
    seenPhasesRef.current.clear();

    addAiMessage('agent', '🚀 Starting script generation...', { phase: 'starting' });

    try {
      const token = getAuthToken();
      if (!token) throw new Error('Not authenticated');

      // Build requirements text from collected structured requirements
      const reqParts: string[] = [];
      if (collectedRequirements.silentInstall) reqParts.push('Silent/unattended installation required');
      if (collectedRequirements.customPath) reqParts.push(`Custom install path: ${collectedRequirements.customPath}`);
      if (collectedRequirements.licenseKey) reqParts.push(`License handling: ${collectedRequirements.licenseKey}`);
      if (collectedRequirements.prerequisites?.length > 0) reqParts.push(`Prerequisites: ${collectedRequirements.prerequisites.join(', ')}`);
      if (collectedRequirements.desktopShortcut) reqParts.push('Create desktop shortcut');
      if (collectedRequirements.postInstallConfig) reqParts.push(`Post-install config: ${collectedRequirements.postInstallConfig}`);
      if (collectedRequirements.additionalNotes) reqParts.push(collectedRequirements.additionalNotes);
      
      // Also include conversation context
      const conversationContext = conversationHistoryRef.current
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join('\n');
      
      const requirementsText = reqParts.length > 0 
        ? reqParts.join('\n- ') + (conversationContext ? `\n\nConversation context:\n${conversationContext}` : '')
        : conversationContext || undefined;

      const response = await apiCall('/images/software/generate-script-draft', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          softwareName: name,
          platform,
          mediaS3Uri: mediaS3Uri || undefined,
          testAutomatically: testOnEc2,
          maxAttempts: 3,
          timeoutMinutes: testOnEc2 ? 25 : 5,
          userRequirements: requirementsText,
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
          headers: { Authorization: `Bearer ${token}` },
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
    if (event.type === 'progress' || event.type === 'state') {
      const phase = event.data.phase || event.data.currentPhase;
      const percent = event.data.percent ?? event.data.progressPercent ?? 0;
      const message = event.data.message || event.data.progressMessage || `Phase: ${phase}`;

      if (phase) {
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

        if (phaseMessages[phase] && !seenPhasesRef.current.has(phase)) {
          seenPhasesRef.current.add(phase);
          addAiMessage('agent', phaseMessages[phase], { phase });
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
      setScript(scriptResult);

      if (data.suggestedCategory && !category) setCategory(data.suggestedCategory);
      if (data.suggestedDescription && !description) setDescription(data.suggestedDescription);

      const verifiedText = data.verified ? '✅ Verified on EC2' : '⚠️ Not tested on EC2';
      addAiMessage('agent', `🎉 Script generated successfully! ${verifiedText}`, { codeBlock: scriptResult });

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

  const handleAiSend = async () => {
    if (!aiInputValue.trim() || isChatLoading) return;
    const message = aiInputValue.trim();
    setAiInputValue('');
    setAiError(null);

    // Add user message to UI
    addAiMessage('user', message);
    
    // Add to conversation history
    conversationHistoryRef.current.push({ role: 'user', content: message });

    // Check if user wants to generate now
    const lowerMessage = message.toLowerCase();
    if (lowerMessage === 'generate' || lowerMessage === 'start' || lowerMessage === 'go' || 
        lowerMessage.includes('generate script') || lowerMessage.includes('generate now')) {
      startAiGeneration();
      return;
    }
    
    if (lowerMessage === 'cancel' || lowerMessage === 'stop') {
      cancelGeneration();
      return;
    }

    // Call the chat API for conversational response
    setIsChatLoading(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('Not authenticated');

      const response = await apiCall('/images/software/chat', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          conversationHistory: conversationHistoryRef.current.slice(0, -1), // Exclude current message (already in API)
          softwareName: name,
          platform,
          mediaS3Uri: mediaS3Uri || undefined,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Chat request failed');
      }

      const data = await response.json();
      
      // Add assistant response to UI and history
      addAiMessage('agent', data.message);
      conversationHistoryRef.current.push({ role: 'assistant', content: data.message });
      
      // Update collected requirements
      if (data.requirements) {
        setCollectedRequirements(prev => ({ ...prev, ...data.requirements }));
      }
      
      // Check if ready to generate
      if (data.readyToGenerate) {
        setReadyToGenerate(true);
      }

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to get response';
      setAiError(errorMsg);
      addAiMessage('agent', `Sorry, I encountered an error: ${errorMsg}. Please try again.`);
    } finally {
      setIsChatLoading(false);
    }
  };

  // Handle prompt suggestion clicks
  const handlePromptClick = async (prompt: string) => {
    if (prompt === 'generate') {
      startAiGeneration();
      return;
    }
    
    // Use the chat API for prompt suggestions too
    setAiInputValue('');
    setAiError(null);
    addAiMessage('user', prompt);
    conversationHistoryRef.current.push({ role: 'user', content: prompt });

    setIsChatLoading(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('Not authenticated');

      const response = await apiCall('/images/software/chat', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: prompt,
          conversationHistory: conversationHistoryRef.current.slice(0, -1),
          softwareName: name,
          platform,
          mediaS3Uri: mediaS3Uri || undefined,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Chat request failed');
      }

      const data = await response.json();
      addAiMessage('agent', data.message);
      conversationHistoryRef.current.push({ role: 'assistant', content: data.message });
      
      if (data.requirements) {
        setCollectedRequirements(prev => ({ ...prev, ...data.requirements }));
      }
      if (data.readyToGenerate) {
        setReadyToGenerate(true);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to get response';
      setAiError(errorMsg);
      addAiMessage('agent', `Sorry, I encountered an error: ${errorMsg}`);
    } finally {
      setIsChatLoading(false);
    }
  };

  const useGeneratedScript = () => {
    if (generatedScript) {
      setScript(generatedScript);
      setScriptSource('manual');
    }
  };

  const cancelGeneration = async () => {
    if (!draftExecutionId) {
      setIsGenerating(false);
      return;
    }

    try {
      const token = getAuthToken();
      if (token) {
        await apiCall(`/images/software/cancel-generation?executionId=${draftExecutionId}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
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

  const handleCancelClick = () => {
    if (isGenerating) {
      setShowCancelConfirm(true);
    } else {
      onCancel();
    }
  };

  const confirmCancel = async () => {
    setShowCancelConfirm(false);
    await cancelGeneration();
    onCancel();
  };

  const validateStep = (stepIndex: number): boolean => {
    switch (stepIndex) {
      case 0:
        if (!name.trim()) {
          setError('Software name is required');
          return false;
        }
        return true;
      case 1:
        return true;
      case 2:
        if (sourceType === 'arn' && !componentArn.trim()) {
          setError('Component ARN is required');
          return false;
        }
        if (sourceType === 'script' && !script.trim()) {
          setError('Installation script is required');
          return false;
        }
        return true;
      case 3:
        return true;
      default:
        return true;
    }
  };

  const handleNext = async () => {
    setError(null);
    if (!validateStep(currentStep)) return;

    // Upload media file when leaving step 1 if file selected but not uploaded
    if (currentStep === 1 && selectedFile && !mediaS3Uri) {
      const result = await uploadMediaFile();
      if (!result) {
        setError('Failed to upload media file');
        return;
      }
    }

    setCurrentStep(currentStep + 1);
  };

  const handlePrev = () => {
    setCurrentStep(currentStep - 1);
  };

  const handleSubmit = async () => {
    if (!validateStep(currentStep)) return;

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
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  // Render AI Chat Interface
  const renderAiChat = () => (
    <div>
      {aiError && (
        <Alert type="error" message={aiError} closable onClose={() => setAiError(null)} style={{ marginBottom: 16 }} />
      )}

      <div
        style={{
          maxHeight: 350,
          overflowY: 'auto',
          padding: 12,
          background: token.colorBgContainer,
          borderRadius: 6,
          marginBottom: 16,
          border: `1px solid ${token.colorBorder}`,
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {aiMessages.map((msg) => (
            <div
              key={msg.id}
              style={{
                display: 'flex',
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              <div
                style={{
                  maxWidth: '80%',
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: msg.role === 'user' ? token.colorPrimary : token.colorBgSpotlight,
                  color: msg.role === 'user' ? '#fff' : token.colorText,
                  border: msg.role === 'agent' ? `1px solid ${token.colorBorder}` : 'none',
                }}
              >
                {msg.role === 'agent' && (
                  <div style={{ marginBottom: 4 }}>
                    <RobotOutlined style={{ marginRight: 6, color: '#6366f1' }} />
                    <Text type="secondary" style={{ fontSize: 12 }}>AI Assistant</Text>
                  </div>
                )}
                <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                {msg.codeBlock && (
                  <Collapse
                    size="small"
                    style={{ marginTop: 8 }}
                    items={[
                      {
                        key: '1',
                        label: 'View Script',
                        extra: (
                          <Button
                            type="text"
                            size="small"
                            icon={<CopyOutlined />}
                            onClick={(e) => {
                              e.stopPropagation();
                              copyToClipboard(msg.codeBlock!);
                            }}
                          />
                        ),
                        children: (
                          <pre
                            style={{
                              background: '#1e1e1e',
                              color: '#d4d4d4',
                              padding: 12,
                              borderRadius: 4,
                              fontSize: 12,
                              maxHeight: 250,
                              overflow: 'auto',
                              margin: 0,
                            }}
                          >
                            {msg.codeBlock}
                          </pre>
                        ),
                      },
                    ]}
                  />
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </Space>
      </div>

      {isGenerating && aiProgress && (
        <div style={{ marginBottom: 16 }}>
          <Progress percent={aiProgress.percent} status="active" />
          <Text type="secondary">{aiProgress.message}</Text>
        </div>
      )}

      {/* Prompt Suggestions - shown when not generating and no script yet */}
      {!isGenerating && !generatedScript && !isChatLoading && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 8 }}>
            <BulbOutlined style={{ marginRight: 6, color: '#faad14' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>Quick actions:</Text>
          </div>
          <Space wrap size={[8, 8]}>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={() => handlePromptClick('generate')}
              style={{ background: '#6366f1', borderColor: '#6366f1' }}
              disabled={isChatLoading}
            >
              Generate Script
            </Button>
            <Button
              size="small"
              onClick={() => handlePromptClick('I need a silent installation without user prompts')}
              disabled={isChatLoading}
            >
              Silent install
            </Button>
            <Button
              size="small"
              onClick={() => handlePromptClick('Install to a custom directory path')}
              disabled={isChatLoading}
            >
              Custom path
            </Button>
            <Button
              size="small"
              onClick={() => handlePromptClick('Include license key activation')}
              disabled={isChatLoading}
            >
              License key
            </Button>
            <Button
              size="small"
              onClick={() => handlePromptClick('Check and install prerequisites first')}
              disabled={isChatLoading}
            >
              Prerequisites
            </Button>
          </Space>
          <div style={{ marginTop: 12 }}>
            <Checkbox checked={testOnEc2} onChange={(e) => setTestOnEc2(e.target.checked)}>
              Test script on EC2 instance (takes ~10-15 minutes)
            </Checkbox>
          </div>
        </div>
      )}

      {/* Loading indicator for chat */}
      {isChatLoading && (
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spin size="small" />
          <Text type="secondary">Thinking...</Text>
        </div>
      )}

      {/* Cancel button during generation */}
      {isGenerating && (
        <div style={{ marginBottom: 16 }}>
          <Button danger onClick={cancelGeneration}>
            Cancel Generation
          </Button>
        </div>
      )}

      <Space.Compact style={{ width: '100%' }}>
        <Input
          value={aiInputValue}
          onChange={(e) => setAiInputValue(e.target.value)}
          onPressEnter={handleAiSend}
          placeholder={
            isGenerating 
              ? 'Generation in progress...' 
              : isChatLoading 
                ? 'Waiting for response...'
                : 'Tell me about your installation requirements...'
          }
          disabled={isGenerating || isChatLoading}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={handleAiSend}
          disabled={!aiInputValue.trim() || isGenerating || isChatLoading}
          loading={isChatLoading}
        >
          Send
        </Button>
      </Space.Compact>

      {generatedScript && !isGenerating && (
        <div style={{ marginTop: 16 }}>
          <Collapse
            defaultActiveKey={['1']}
            items={[
              {
                key: '1',
                label: 'Generated Script',
                children: (
                  <pre
                    style={{
                      background: '#1e1e1e',
                      color: '#d4d4d4',
                      padding: 12,
                      borderRadius: 4,
                      fontSize: 12,
                      maxHeight: 300,
                      overflow: 'auto',
                      margin: 0,
                    }}
                  >
                    {generatedScript}
                  </pre>
                ),
              },
            ]}
          />
          <Button type="primary" onClick={useGeneratedScript} style={{ marginTop: 12 }}>
            Use This Script
          </Button>
        </div>
      )}
    </div>
  );

  // Step 1: Software Details
  const renderStep1 = () => (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error && currentStep === 0 && (
        <Alert type="error" message={error} closable onClose={() => setError(null)} />
      )}

      <Row gutter={16}>
        <Col span={16}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>Software Name *</Text>
            <Input
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Adobe Creative Suite"
            />
          </div>
        </Col>
        <Col span={8}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>Version</Text>
            <Input
              value={versionNumber}
              onChange={(e) => setVersionNumber(e.target.value)}
              placeholder="e.g., 2024 (or leave empty)"
            />
          </div>
        </Col>
      </Row>

      <div>
        <Text strong style={{ display: 'block', marginBottom: 4 }}>Category</Text>
        <Select
          value={category}
          onChange={setCategory}
          placeholder="Choose a category"
          style={{ width: '100%' }}
          allowClear
          options={[
            { label: 'Development', value: 'development' },
            { label: 'Media', value: 'media' },
            { label: 'System', value: 'system' },
            { label: 'Utilities', value: 'utilities' },
          ]}
        />
      </div>

      <div>
        <Text strong style={{ display: 'block', marginBottom: 4 }}>Description</Text>
        <TextArea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Brief description of the software..."
          rows={2}
        />
      </div>

      <div>
        <Text strong style={{ display: 'block', marginBottom: 4 }}>Target Platform</Text>
        <Radio.Group value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <Radio value="Windows">Windows</Radio>
          <Radio value="Linux">Linux (Ubuntu/Amazon Linux)</Radio>
          <Radio value="macOS">macOS</Radio>
        </Radio.Group>
      </div>

      <Row gutter={16}>
        <Col span={12}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>Estimated Install Time</Text>
            <Input
              value={estimatedInstallTime}
              onChange={(e) => setEstimatedInstallTime(e.target.value)}
              placeholder="e.g., 5 minutes"
            />
          </div>
        </Col>
        <Col span={12}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>Disk Space Required</Text>
            <Input
              value={diskSpaceRequired}
              onChange={(e) => setDiskSpaceRequired(e.target.value)}
              placeholder="e.g., 2 GB"
            />
          </div>
        </Col>
      </Row>

      <Checkbox checked={gpuRequired} onChange={(e) => setGpuRequired(e.target.checked)}>
        This software requires GPU
      </Checkbox>
    </Space>
  );

  // Step 2: Installation Media
  const renderStep2 = () => (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error && currentStep === 1 && (
        <Alert type="error" message={error} closable onClose={() => setError(null)} />
      )}

      <Alert
        type="info"
        message="Upload installer files (exe, msi, zip, pkg, dmg) that your installation script will use."
      />

      <div>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>Installation Media</Text>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          style={{ display: 'none' }}
          accept=".exe,.msi,.zip,.iso,.pkg,.dmg,.sh,.tar.gz"
        />
        <Space>
          <Button icon={<UploadOutlined />} onClick={() => fileInputRef.current?.click()}>
            {selectedFile ? 'Change File' : 'Select File'}
          </Button>
          {selectedFile && (
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => {
                setSelectedFile(null);
                setMediaFileName('');
                setMediaS3Uri('');
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            >
              Clear
            </Button>
          )}
        </Space>

        {selectedFile && (
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">
              Selected: {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
            </Text>
          </div>
        )}

        {uploading && <Progress percent={uploadProgress} status="active" style={{ marginTop: 8 }} />}

        {mediaS3Uri && !uploading && (
          <div style={{ marginTop: 8 }}>
            <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 8 }} />
            <Text type="success">File uploaded successfully</Text>
          </div>
        )}
      </div>

      {selectedFile && (
        <Alert
          type="info"
          message={
            <>
              Your script can access the uploaded file using{' '}
              <code>{platform === 'Windows' ? '$env:MEDIA_PATH' : '$MEDIA_PATH'}</code> which will contain the
              full path to the downloaded installer.
            </>
          }
        />
      )}
    </Space>
  );

  // Step 3: Installation Script
  const renderStep3 = () => (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error && currentStep === 2 && (
        <Alert type="error" message={error} closable onClose={() => setError(null)} />
      )}

      <div>
        <Text strong style={{ display: 'block', marginBottom: 4 }}>Component Source</Text>
        <Radio.Group value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
          <Radio value="script">
            {platform === 'Windows' ? 'Custom PowerShell Script' : 'Custom Bash Script'}
          </Radio>
          <Radio value="arn">Existing Component ARN</Radio>
        </Radio.Group>
      </div>

      {sourceType === 'arn' ? (
        <div>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>Component ARN *</Text>
          <Input
            value={componentArn}
            onChange={(e) => setComponentArn(e.target.value)}
            placeholder="arn:aws:imagebuilder:us-east-1:123456789012:component/..."
          />
        </div>
      ) : (
        <Tabs
          activeKey={scriptSource}
          onChange={(key) => setScriptSource(key as 'manual' | 'ai')}
          items={[
            {
              key: 'manual',
              label: 'Write Script',
              children: (
                <div>
                  <Text strong style={{ display: 'block', marginBottom: 4 }}>
                    {platform === 'Windows' ? 'PowerShell Script' : 'Bash Script'} *
                  </Text>
                  <TextArea
                    value={script}
                    onChange={(e) => setScript(e.target.value)}
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
                    style={{ fontFamily: 'monospace' }}
                  />
                </div>
              ),
            },
            {
              key: 'ai',
              label: (
                <span>
                  <RobotOutlined style={{ marginRight: 4 }} />
                  Generate with AI ✨
                </span>
              ),
              children: renderAiChat(),
            },
          ].filter(tab => bedrockEnabled || tab.key !== 'ai')}
        />
      )}

      {script && scriptSource === 'ai' && (
        <Alert type="success" message="Script is ready! You can review it in the 'Write Script' tab or proceed to the next step." />
      )}
    </Space>
  );

  // Step 4: Review
  const renderStep4 = () => (
    <Space direction="vertical" size={24} style={{ width: '100%' }}>
      {error && currentStep === 3 && (
        <Alert type="error" message={error} closable onClose={() => setError(null)} />
      )}

      <div>
        <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Software Details</Text>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="Name">{name}</Descriptions.Item>
          <Descriptions.Item label="Version">{versionNumber || 'Latest'}</Descriptions.Item>
          <Descriptions.Item label="Category">
            {category ? category.charAt(0).toUpperCase() + category.slice(1) : 'Not specified'}
          </Descriptions.Item>
          <Descriptions.Item label="Platform">{platform}</Descriptions.Item>
          <Descriptions.Item label="GPU Required">{gpuRequired ? 'Yes' : 'No'}</Descriptions.Item>
          {estimatedInstallTime && (
            <Descriptions.Item label="Install Time">{estimatedInstallTime}</Descriptions.Item>
          )}
          {diskSpaceRequired && (
            <Descriptions.Item label="Disk Space">{diskSpaceRequired}</Descriptions.Item>
          )}
        </Descriptions>
        {description && (
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">Description: {description}</Text>
          </div>
        )}
      </div>

      {mediaFileName && (
        <>
          <Divider style={{ margin: 0 }} />
          <div>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Installation Media</Text>
            <Text>File: {mediaFileName}</Text>
          </div>
        </>
      )}

      <Divider style={{ margin: 0 }} />

      <div>
        <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>Installation Script</Text>
        {sourceType === 'arn' ? (
          <Text>Component ARN: {componentArn}</Text>
        ) : (
          <Collapse
            items={[
              {
                key: '1',
                label: 'View Script',
                children: (
                  <pre
                    style={{
                      background: '#1e1e1e',
                      color: '#d4d4d4',
                      padding: 12,
                      borderRadius: 4,
                      fontSize: 12,
                      maxHeight: 250,
                      overflow: 'auto',
                      margin: 0,
                    }}
                  >
                    {script}
                  </pre>
                ),
              },
            ]}
          />
        )}
      </div>
    </Space>
  );

  const renderStepContent = () => {
    switch (currentStep) {
      case 0:
        return renderStep1();
      case 1:
        return renderStep2();
      case 2:
        return renderStep3();
      case 3:
        return renderStep4();
      default:
        return null;
    }
  };

  const steps = [
    { title: 'Details' },
    { title: 'Media' },
    { title: 'Script' },
    { title: 'Review' },
  ];

  return (
    <>
      {/* Cancel Confirmation Modal */}
      <Modal
        title="Cancel Script Generation?"
        open={showCancelConfirm}
        onCancel={() => setShowCancelConfirm(false)}
        footer={
          <Space>
            <Button onClick={() => setShowCancelConfirm(false)}>Continue Generating</Button>
            <Button type="primary" danger onClick={confirmCancel}>
              Yes, Cancel
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12}>
          <Text>AI script generation is currently in progress. If you cancel now:</Text>
          <Alert
            type="warning"
            message={
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                <li>The generation process will be stopped</li>
                <li>Any test EC2 instances will be terminated</li>
                <li>Progress will be lost</li>
              </ul>
            }
          />
          <Text>Are you sure you want to cancel?</Text>
        </Space>
      </Modal>

      <div>
        <Steps current={currentStep} items={steps} size="small" style={{ marginBottom: 24 }} />

        <div style={{ minHeight: 350 }}>{renderStepContent()}</div>

        <Divider />

        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={handleCancelClick}>Cancel</Button>
          <Space>
            {currentStep > 0 && <Button onClick={handlePrev}>Previous</Button>}
            {currentStep < steps.length - 1 && (
              <Button type="primary" onClick={handleNext} loading={uploading}>
                Next
              </Button>
            )}
            {currentStep === steps.length - 1 && (
              <Button type="primary" onClick={handleSubmit} loading={isSubmitting}>
                Create Software
              </Button>
            )}
          </Space>
        </div>
      </div>
    </>
  );
};

export default AddSoftwareWizardAntd;
