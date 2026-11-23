// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Shared authorization helpers for API Gateway Lambda integrations.
//
// The JWT authorizer (lambda/jwt-authorizer) stamps `isAdmin` and `username`
// into event.requestContext.authorizer. API Gateway serialises authorizer
// context values to strings, so `isAdmin` arrives as the string 'true' /
// 'false' rather than a boolean. These helpers normalise that and return
// ready-to-use responses so handler call sites can stay minimal:
//
//   const denial = requireAdmin(event);
//   if (denial) return denial;
//
// Denial responses carry the same CORS headers the rest of the handlers use,
// so a rejected caller still sees a well-formed cross-origin response.
//
// Lambdas load it with require('../shared/authz'). Their CDK definition must
// use lambdaCodeWithShared('<dir>') (lib/lambda-code.ts), so that shared/ is
// in their package. Regional hub Lambdas can't use it: a hub builds each of
// them from its own folder.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

function getCallerIdentity(event) {
  const authorizer = (event && event.requestContext && event.requestContext.authorizer) || {};
  const isAdmin = authorizer.isAdmin === 'true' || authorizer.isAdmin === true;
  const username = authorizer.username || authorizer.userId || null;
  return {
    username,
    isAdmin,
    email: authorizer.email || null,
    tokenType: authorizer.tokenType || null
  };
}

function forbidden(reason) {
  return {
    statusCode: 403,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: JSON.stringify({ error: reason })
  };
}

function unauthorized(reason) {
  return {
    statusCode: 401,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: JSON.stringify({ error: reason })
  };
}

/**
 * Return a 403 response object when the caller is not an administrator;
 * otherwise return null. Handlers early-return the response:
 *
 *   const denial = requireAdmin(event);
 *   if (denial) return denial;
 */
function requireAdmin(event) {
  const { isAdmin } = getCallerIdentity(event);
  if (!isAdmin) {
    return forbidden('Access denied. Administrator privileges required.');
  }
  return null;
}

/**
 * Return a 403 response object when the caller is neither the target user
 * nor an administrator; otherwise return null. `targetUsername` is compared
 * to the caller's own authenticated username from the authorizer context;
 * the body-supplied username must NOT be trusted for this check.
 */
function requireSelfOrAdmin(event, targetUsername) {
  const { username, isAdmin } = getCallerIdentity(event);
  if (isAdmin) {
    return null;
  }
  if (!username) {
    return forbidden('Access denied.');
  }
  if (username !== targetUsername) {
    return forbidden('Access denied. You can only modify your own account.');
  }
  return null;
}

module.exports = {
  getCallerIdentity,
  requireAdmin,
  requireSelfOrAdmin,
  forbidden,
  unauthorized
};
