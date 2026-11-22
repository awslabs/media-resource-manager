// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cognito CustomMessage trigger.
 *
 * Builds the invite email that Cognito sends when an administrator creates a
 * user (AdminCreateUser), with the login URL read from SSM at send time. The
 * User Pool is created before the CloudFront distribution exists, so the URL
 * can't be baked into the pool's own invite template (issue #8).
 *
 * Other messages (verification codes, forgotten passwords) keep the pool's
 * defaults. If the URL can't be read, or still holds the install-time
 * placeholder, the pool's template is used instead, so an invite is never
 * blocked by this trigger.
 *
 * The event holds the new user's email address, so it is never logged.
 */

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ssm = new SSMClient();

// Initial value of the Frontend/Url parameter until the Frontend stack writes
// the real URL (lib/constructs/database-construct.ts).
const PLACEHOLDER_HOST = 'placeholder.cloudfront.net';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The login URL, or null when it isn't set to a usable https URL yet.
async function getLoginUrl() {
  const result = await ssm.send(new GetParameterCommand({ Name: process.env.FRONTEND_URL_PARAM_NAME }));
  const value = (result.Parameter && result.Parameter.Value || '').trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === PLACEHOLDER_HOST) return null;
  return value;
}

function inviteMessage(displayName, loginUrl, usernameParameter, codeParameter) {
  const name = escapeHtml(displayName);
  const url = escapeHtml(loginUrl);
  return `<p>Hello,</p>
<p>You have been granted access to <strong>${name}</strong>.</p>
<p><strong>Login URL:</strong> <a href="${url}">${url}</a><br/>
<strong>Username:</strong> ${usernameParameter}<br/>
<strong>Temporary Password:</strong> ${codeParameter}</p>
<p>You will be prompted to set a new password on first login.</p>`;
}

exports.handler = async (event) => {
  if (event.triggerSource !== 'CustomMessage_AdminCreateUser') {
    return event;
  }

  let loginUrl = null;
  try {
    loginUrl = await getLoginUrl();
  } catch (error) {
    console.error('Could not read the login URL, using the User Pool invite template:', error.name);
    return event;
  }
  if (!loginUrl) {
    console.warn('Login URL not set yet, using the User Pool invite template');
    return event;
  }

  const displayName = process.env.PRODUCT_NAME || 'Media Resource Manager';
  event.response.emailSubject = `You're invited to ${displayName}`;
  event.response.emailMessage = inviteMessage(
    displayName,
    loginUrl,
    event.request.usernameParameter,
    event.request.codeParameter,
  );
  console.log('Built invite email with the login URL');
  return event;
};
