// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Removes credentials from a value before it is logged.
 *
 * API Gateway events carry the caller's sign-in token in the Authorization
 * header, and request bodies can carry other secrets. Log
 * redactForLog(event) instead of the event itself.
 *
 * This file is copied byte-identical into every Lambda that uses it, the same
 * way as authz.js. test/log-redact.test.ts checks that the copies match.
 */

const REDACTED = '[REDACTED]';

// Field names whose values are credentials: headers such as Authorization,
// Cookie, X-Api-Key, and X-Amz-Security-Token, and fields such as password,
// idToken, TaskToken, or clientSecret.
const SENSITIVE_KEY = /authorization|cookie|token|passw(or)?d|secret|credential|private.?key|api.?key|signature/i;

// Field names that contain one of those words but only name or describe a
// credential, such as secretArn, secretName, or tokenType. Their values are
// kept.
const DESCRIPTIVE_KEY = /(arn|name|id|type)$/i;

// Credentials that can appear inside any string, such as a URL: JSON Web
// Tokens, DCV authToken parameters, and pre-signed URL signatures.
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const URL_CREDENTIAL = /((?:authToken|X-Amz-Signature|X-Amz-Security-Token|X-Amz-Credential)=)[^&#\s"']+/gi;

const MAX_DEPTH = 20;

function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(key) && !DESCRIPTIVE_KEY.test(key);
}

function redactString(value) {
  return value.replace(JWT, REDACTED).replace(URL_CREDENTIAL, `$1${REDACTED}`);
}

// API Gateway passes the request body as a string. Redact inside it when it
// is JSON, and replace it otherwise, since it can't be inspected.
function redactBody(body, isBase64Encoded) {
  if (body === '') return body;
  if (isBase64Encoded) return `[REDACTED: base64 body, ${body.length} characters]`;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return `[REDACTED: non-JSON body, ${body.length} characters]`;
  }
  return JSON.stringify(redactValue(parsed, 0));
}

function redactValue(value, depth) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[REDACTED: nested too deeply]';
  if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1));

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      result[key] = item === null || item === undefined || item === '' ? item : REDACTED;
    } else if (key === 'body' && typeof item === 'string') {
      result[key] = redactBody(item, value.isBase64Encoded === true);
    } else {
      result[key] = redactValue(item, depth + 1);
    }
  }
  return result;
}

/**
 * A copy of value with credentials replaced by '[REDACTED]'. The value
 * itself is not changed.
 */
function redactForLog(value) {
  return redactValue(value, 0);
}

module.exports = { REDACTED, redactForLog };
