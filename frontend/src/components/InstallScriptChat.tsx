// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * InstallScriptChat Component
 * 
 * A chat interface for interacting with the AI Install Script Agent.
 * Uses Cloudscape Chat Bubble layout with SSE progress streaming.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box,
  Button,
  Container,
  Header,
  Input,
  SpaceBetween,
  StatusIndicator,
  Alert,
  ProgressBar,
  ExpandableSection,
} from '@cloudscape-design/components';
import { apiCall } from '../utils/api';
import { getAuthToken } from '../utils/auth';

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
  timestamp: string;
}

interface InstallScriptChatProps {
  softwareId: string;
  softwareName: string;
  platform: 'Windows' | 'Linux';
  mediaS3Uri?: string;
  existingScript?: string;
  onScriptGenerated?: (script: string, componentArn?: string) => void;
  onClose?: () => void;
}

const InstallScriptChat: React.FC<InstallScriptChatProps> = ({
  softwareId,
  softwareName,
  platform,
  mediaS3Uri,
  existingScript,
  onScriptGenerated,
  onClose,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [generatedScript, setGeneratedScript] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Cleanup event source on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Add initial greeting message
  useEffect(() => {
    const greeting = existingScript
      ? `I see you have an existing script for ${softwareName}. Would you like me to help refine it, or would you prefer to generate a new one from scratch?`
      : `Hi! I'm ready to help you create an installation script for ${softwareName} on ${platform}. I'll research the best installation methods, generate a script, and test it on a real instance. Just say "generate" to start, or tell me any specific requirements you have.`;

    setMessages([
      {
        id: '1',
        role: 'agent',
        content: greeting,
        timestamp: new Date(),
      },
    ]);
  }, [softwareName, platform, existingScript]);

  const addMessage = useCallback((role: 'user' | 'agent', content: string, extras?: Partial<ChatMessage>) => {
    setMessages((prev) => [
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

  const startGeneration = async (userMessage?: string) => {
    setIsGenerating(true);
    setError(null);
    setProgress(null);

    if (userMessage) {
      addMessage('user', userMessage);
    }

    addMessage('agent', 'Starting script generation...', { phase: 'starting' });

    try {
      const token = getAuthToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const response = await apiCall(`/images/software/${softwareId}/generate-script`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          softwareName,
          platform,
          mediaS3Uri,
          testAutomatically: true,
          maxAttempts: 3,
          timeoutMinutes: 15,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to start generation');
      }

      const data = await response.json();
      setExecutionId(data.executionId);

      // Start polling for progress
      pollProgress(data.executionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      addMessage('agent', `Sorry, I encountered an error: ${err instanceof Error ? err.message : 'Unknown error'}. Please try again.`);
      setIsGenerating(false);
    }
  };

  const pollProgress = async (execId: string) => {
    const token = getAuthToken();
    if (!token) return;

    let lastEventId: string | undefined;

    const poll = async () => {
      try {
        const url = `/images/software/${softwareId}/generation-progress?executionId=${execId}${lastEventId ? `&lastEventId=${lastEventId}` : ''}`;
        const response = await apiCall(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to get progress');
        }

        const text = await response.text();
        const events = parseSSEEvents(text);

        for (const event of events) {
          handleProgressEvent(event);
          if (event.eventId) {
            lastEventId = event.eventId;
          }
        }

        // Check if complete
        const completeEvent = events.find((e) => e.type === 'complete');
        if (completeEvent) {
          handleCompletion(completeEvent.data);
          return;
        }

        // Continue polling
        setTimeout(poll, 2000);
      } catch (err) {
        console.error('Progress polling error:', err);
        setTimeout(poll, 5000); // Retry with longer delay on error
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

  const handleProgressEvent = (event: { type: string; data: any }) => {
    if (event.type === 'progress') {
      const { phase, message, percent } = event.data;
      setProgress({ phase, message, percent, timestamp: new Date().toISOString() });

      // Add phase transition messages
      const phaseMessages: Record<string, string> = {
        research: '🔍 Researching installation methods...',
        generate: '📝 Generating installation script...',
        test: '🖥️ Launching test instance...',
        execute: '⚙️ Running installation script...',
        verify: '✅ Verifying installation...',
        save: '💾 Saving to library...',
      };

      if (phaseMessages[phase] && !messages.some((m) => m.phase === phase)) {
        addMessage('agent', phaseMessages[phase], { phase });
      }
    } else if (event.type === 'state') {
      // Handle state updates
      const { status, currentAttempt, maxAttempts } = event.data;
      if (currentAttempt > 1) {
        addMessage('agent', `Attempt ${currentAttempt} of ${maxAttempts}...`);
      }
    }
  };

  const handleCompletion = (data: any) => {
    setIsGenerating(false);
    setProgress(null);

    if (data.status === 'completed' || data.status === 'success') {
      const script = data.script;
      setGeneratedScript(script);

      addMessage('agent', '🎉 Script generated and verified successfully!', { codeBlock: script });

      if (data.componentArn) {
        addMessage('agent', `The script has been saved to your software library. Component ARN: ${data.componentArn}`);
      }

      if (onScriptGenerated && script) {
        onScriptGenerated(script, data.componentArn);
      }
    } else {
      const errorMsg = data.error || 'Generation failed after all attempts';
      setError(errorMsg);
      addMessage('agent', `❌ ${errorMsg}`);

      if (data.logs && data.logs.length > 0) {
        addMessage('agent', 'Here are the execution logs for debugging:', {
          codeBlock: data.logs.join('\n'),
        });
      }
    }
  };

  const cancelGeneration = async () => {
    if (!executionId) return;

    try {
      const token = getAuthToken();
      if (!token) return;

      await apiCall(`/images/software/${softwareId}/cancel-generation`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ executionId }),
      });

      addMessage('agent', 'Generation cancelled.');
      setIsGenerating(false);
      setProgress(null);
    } catch (err) {
      console.error('Failed to cancel:', err);
    }
  };

  const handleSend = () => {
    if (!inputValue.trim()) return;

    const message = inputValue.trim().toLowerCase();
    setInputValue('');

    if (message === 'generate' || message === 'start' || message === 'go') {
      startGeneration(inputValue.trim());
    } else if (message === 'cancel' || message === 'stop') {
      cancelGeneration();
    } else {
      addMessage('user', inputValue.trim());
      // For now, just acknowledge the message
      addMessage('agent', `I understand you want: "${inputValue.trim()}". Say "generate" when you're ready to start, and I'll incorporate your requirements.`);
    }
  };

  return (
    <Container
      header={
        <Header
          variant="h2"
          actions={
            onClose && (
              <Button variant="icon" iconName="close" onClick={onClose} ariaLabel="Close chat" />
            )
          }
        >
          AI Script Generator
        </Header>
      }
    >
      <SpaceBetween direction="vertical" size="m">
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}

        {/* Chat Messages */}
        <Box
          padding="s"
          className="chat-messages"
        >
          <SpaceBetween direction="vertical" size="s">
            {messages.map((msg) => (
              <Box
                key={msg.id}
                padding="s"
                variant={msg.role === 'user' ? 'awsui-key-label' : undefined}
              >
                <SpaceBetween direction="vertical" size="xs">
                  <Box variant="small" color="text-body-secondary">
                    {msg.role === 'user' ? 'You' : 'AI Agent'} • {msg.timestamp.toLocaleTimeString()}
                  </Box>
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
              </Box>
            ))}
            <div ref={messagesEndRef} />
          </SpaceBetween>
        </Box>

        {/* Progress Bar */}
        {isGenerating && progress && (
          <ProgressBar
            value={progress.percent}
            label={progress.message}
            description={`Phase: ${progress.phase}`}
          />
        )}

        {/* Input Area */}
        <SpaceBetween direction="horizontal" size="xs">
          <div style={{ flex: 1 }}>
            <Input
              value={inputValue}
              onChange={({ detail }) => setInputValue(detail.value)}
              onKeyDown={({ detail }) => {
                if (detail.key === 'Enter') {
                  handleSend();
                }
              }}
              placeholder={isGenerating ? 'Type "cancel" to stop...' : 'Type "generate" to start or ask a question...'}
              disabled={false}
            />
          </div>
          <Button
            variant="primary"
            onClick={handleSend}
            disabled={!inputValue.trim()}
            iconName={isGenerating ? 'status-in-progress' : 'send'}
          >
            {isGenerating ? 'Generating...' : 'Send'}
          </Button>
          {isGenerating && (
            <Button variant="normal" onClick={cancelGeneration}>
              Cancel
            </Button>
          )}
        </SpaceBetween>

        {/* Generated Script Preview */}
        {generatedScript && !isGenerating && (
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
        )}
      </SpaceBetween>
    </Container>
  );
};

export default InstallScriptChat;
