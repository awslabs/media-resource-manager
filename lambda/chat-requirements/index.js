// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Chat Requirements Lambda
 * 
 * A lightweight conversational chatbot that uses Bedrock to gather
 * installation script requirements from users before triggering the
 * full agent workflow.
 */

const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-haiku-20241022-v1:0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

const SYSTEM_PROMPT = `You are a helpful assistant that gathers requirements for generating software installation scripts. Your job is to have a natural conversation to understand what the user needs.

Context:
- Software Name: {softwareName}
- Platform: {platform}
- Media File: {mediaInfo}

Your goals:
1. Understand the user's specific installation requirements
2. Ask clarifying questions when needed
3. Extract structured requirements from the conversation
4. Determine when you have enough information to generate a script

Common requirements to ask about (only if relevant):
- Silent/unattended installation preferences
- Custom installation path
- License key or serial number handling
- Prerequisites that need to be installed first
- Desktop shortcuts or start menu entries
- Post-installation configuration
- Environment variables to set
- Services to start/stop

Guidelines:
- Be conversational and friendly
- Don't ask about ALL requirements - only what's relevant
- If the user says "just generate it" or similar, respect that
- Keep responses concise (2-3 sentences max unless explaining something)
- After gathering requirements, summarize what you understood

CRITICAL: You must respond with ONLY valid JSON - no text before or after. Use this exact format:
{
  "message": "Your conversational response to the user goes here",
  "requirements": {
    "silentInstall": true,
    "customPath": null,
    "licenseKey": null,
    "prerequisites": [],
    "desktopShortcut": null,
    "postInstallConfig": null,
    "environmentVariables": {},
    "additionalNotes": null
  },
  "readyToGenerate": false,
  "confidence": "medium"
}

Rules for the JSON response:
- "message": Your friendly conversational response (this is what the user sees)
- "requirements": Update fields based on what user mentioned (use null if not discussed)
- "readyToGenerate": Set to true only when user says generate/start/go
- "confidence": high/medium/low based on clarity of requirements
- DO NOT include any text outside the JSON object

Set readyToGenerate to true when:
- User explicitly says to generate/start/go
- You have gathered sufficient requirements
- User indicates they're done adding requirements

Set confidence based on how well you understand what the user needs.`;

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Handle OPTIONS preflight
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    const body = JSON.parse(event.body || '{}');
    const { 
      message, 
      conversationHistory = [], 
      softwareName = 'Unknown Software',
      platform = 'Windows',
      mediaS3Uri = ''
    } = body;

    if (!message) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'message is required' })
      };
    }

    // Build the system prompt with context
    const mediaInfo = mediaS3Uri ? `Uploaded (${mediaS3Uri.split('/').pop()})` : 'Not provided';
    const systemPrompt = SYSTEM_PROMPT
      .replace('{softwareName}', softwareName)
      .replace('{platform}', platform)
      .replace('{mediaInfo}', mediaInfo);

    // Build messages array for Bedrock Converse API
    const messages = [];
    
    // Add conversation history
    for (const msg of conversationHistory) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: [{ text: msg.content }]
      });
    }
    
    // Add current user message
    messages.push({
      role: 'user',
      content: [{ text: message }]
    });

    console.log('Calling Bedrock with', messages.length, 'messages');

    // Call Bedrock Converse API
    const response = await bedrockClient.send(new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt }],
      messages,
      inferenceConfig: {
        maxTokens: 1024,
        temperature: 0.7,
        topP: 0.9
      }
    }));

    // Extract response text
    const responseText = response.output?.message?.content?.[0]?.text || '';
    console.log('Bedrock response:', responseText);

    // Parse the JSON response
    let parsedResponse;
    try {
      // Try to extract JSON from the response - handle text before/after JSON
      // Look for the outermost { } pair that contains "message"
      const jsonStart = responseText.indexOf('{"message"');
      if (jsonStart !== -1) {
        // Find the matching closing brace
        let braceCount = 0;
        let jsonEnd = -1;
        for (let i = jsonStart; i < responseText.length; i++) {
          if (responseText[i] === '{') braceCount++;
          if (responseText[i] === '}') braceCount--;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
        if (jsonEnd > jsonStart) {
          const jsonStr = responseText.substring(jsonStart, jsonEnd);
          parsedResponse = JSON.parse(jsonStr);
        } else {
          throw new Error('Could not find complete JSON object');
        }
      } else {
        // Fallback: try to find any JSON object
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedResponse = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('No JSON found in response');
        }
      }
    } catch (parseError) {
      console.warn('Failed to parse JSON response:', parseError.message);
      console.warn('Raw response:', responseText);
      // Fallback: treat the whole response as a message
      parsedResponse = {
        message: responseText.replace(/\{[\s\S]*\}/, '').trim() || responseText,
        requirements: {},
        readyToGenerate: false,
        confidence: 'low'
      };
    }

    // Ensure all required fields exist
    const result = {
      message: parsedResponse.message || responseText,
      requirements: {
        silentInstall: parsedResponse.requirements?.silentInstall ?? null,
        customPath: parsedResponse.requirements?.customPath ?? null,
        licenseKey: parsedResponse.requirements?.licenseKey ?? null,
        prerequisites: parsedResponse.requirements?.prerequisites ?? [],
        desktopShortcut: parsedResponse.requirements?.desktopShortcut ?? null,
        postInstallConfig: parsedResponse.requirements?.postInstallConfig ?? null,
        environmentVariables: parsedResponse.requirements?.environmentVariables ?? {},
        additionalNotes: parsedResponse.requirements?.additionalNotes ?? null
      },
      readyToGenerate: parsedResponse.readyToGenerate ?? false,
      confidence: parsedResponse.confidence ?? 'medium'
    };

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(result)
    };

  } catch (error) {
    console.error('Error:', error);
    
    // Handle specific Bedrock errors
    if (error.name === 'AccessDeniedException') {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ 
          error: 'Bedrock access denied. Please check IAM permissions.',
          details: error.message 
        })
      };
    }
    
    if (error.name === 'ThrottlingException') {
      return {
        statusCode: 429,
        headers: corsHeaders,
        body: JSON.stringify({ 
          error: 'Too many requests. Please try again.',
          details: error.message 
        })
      };
    }

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message })
    };
  }
};
