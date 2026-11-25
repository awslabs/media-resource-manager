// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Authentication utility that handles both LDAP and Cognito auth modes

interface Config {
  useCognitoAuth: boolean;
  /** 'managed' (MRM owns AWS Managed Microsoft AD) or 'connector' (MRM is a
   *  read-only tenant of a customer-supplied AD via AD Connector). Only
   *  meaningful when useCognitoAuth === false. Defaults to 'managed' on
   *  older deployments that pre-date the /Identity/AdMode SSM parameter. */
  adMode?: 'managed' | 'connector';
  enableBedrockFeatures?: boolean;
  cognitoUserPoolId?: string;
  cognitoClientId?: string;
  cognitoDomain?: string;
  adminGroupName?: string;
  apiUrl: string;
  region?: string;
  identityProviders?: string[]; // List of configured SAML/OIDC providers (e.g., ['Okta', 'IdentityCenter'])
}

let config: Config | null = null;

const getConfig = async (): Promise<Config> => {
  if (!config) {
    const configFile = import.meta.env?.DEV ? '/config-dev.json' : '/config.json';
    const response = await fetch(configFile);
    config = await response.json();
  }
  return config!;
};

// Session keys. All live in sessionStorage (per tab), like the ID token has.
const ID_TOKEN_KEY = 'auth-token';
const USER_KEY = 'auth-user';
// Cognito refresh token, used only to get a new ID token (#85).
const REFRESH_TOKEN_KEY = 'auth-refresh-token';

/** Refresh the ID token this many seconds before it expires. */
export const REFRESH_MARGIN_SECONDS = 300;
/** Retry a background refresh that failed on the network after this many seconds. */
const REFRESH_RETRY_SECONDS = 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Decode a JWT payload. JWTs use base64url, which atob() rejects ('-', '_'). */
const decodePayload = (token: string) =>
  JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));

/** The `exp` claim of a JWT, or null when it can't be read. */
const tokenExpiry = (token: string | null): number | null => {
  if (!token || token.split('.').length !== 3) return null;
  try {
    const payload = decodePayload(token);
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
};

/** Tokens a refresh returns. */
export interface RefreshedTokens {
  idToken: string;
  /** A new refresh token, when the sign-in mode rotates it. */
  refreshToken?: string;
}

/**
 * How one sign-in mode renews its session. `canRefresh` says whether this
 * tab's session can be renewed; `refresh` returns new tokens, null when the
 * mode refuses (the session then ends), and rejects on a network error.
 */
export interface SessionRefresher {
  canRefresh(): boolean;
  refresh(): Promise<RefreshedTokens | null>;
}

/** Cognito: REFRESH_TOKEN_AUTH with the refresh token kept at sign-in. */
const cognitoRefresher: SessionRefresher = {
  canRefresh: () => !!sessionStorage.getItem(REFRESH_TOKEN_KEY),
  refresh: async () => {
    const refreshToken = sessionStorage.getItem(REFRESH_TOKEN_KEY);
    if (!refreshToken) return null;
    const config = await getConfig();
    if (!config.useCognitoAuth || !config.cognitoClientId) return null;

    // nosemgrep: gitlab.nodejs_scan.javascript-ssrf-rule-node_ssrf
    // URL is AWS Cognito endpoint derived from config.region, not user input
    const response = await fetch(`https://cognito-idp.${config.region || 'us-east-1'}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: config.cognitoClientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    });
    const data = await response.json().catch(() => ({}));
    const idToken = data?.AuthenticationResult?.IdToken;
    if (!response.ok || !idToken) {
      console.warn('Session refresh was refused:', data?.__type || response.status);
      return null;
    }
    // Cognito returns a new refresh token only when rotation is on.
    return { idToken, refreshToken: data.AuthenticationResult.RefreshToken };
  },
};

/**
 * The refresher for this tab's session. Only Cognito sessions can be renewed
 * today: AD sign-in (useCognitoAuth=false) issues a 1-hour token with no
 * refresh token, so it has no refresher and its sessions end as before.
 */
const activeRefresher = (): SessionRefresher | null =>
  cognitoRefresher.canRefresh() ? cognitoRefresher : null;

/** True when this tab's session can be renewed without signing in again. */
export const canRefreshSession = (): boolean => activeRefresher() !== null;


/** True when the stored ID token expires within the refresh margin (or is unreadable). */
export const idTokenNeedsRefresh = (): boolean => {
  const exp = tokenExpiry(sessionStorage.getItem(ID_TOKEN_KEY));
  return exp === null || exp - nowSeconds() <= REFRESH_MARGIN_SECONDS;
};

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

const stopTokenRefresh = () => {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
};

/** Remove every token and the user from this tab's session. */
export const clearSession = () => {
  stopTokenRefresh();
  sessionStorage.removeItem(ID_TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
  sessionStorage.removeItem(REFRESH_TOKEN_KEY);
};

/** After a refresh is refused: clear the session and reload, which shows sign-in. */
const signOutAfterRefreshFailure = () => {
  clearSession();
  window.location.reload();
};

const storeTokens = (idToken: string, refreshToken?: string) => {
  sessionStorage.setItem(ID_TOKEN_KEY, idToken);
  if (refreshToken) sessionStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  startTokenRefresh();
};

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Get a new ID token from the session's refresher (Cognito: the stored
 * refresh token). Concurrent callers share one request. Resolves to the new
 * ID token, or null when the session can't be renewed or the refresh is
 * refused (the caller then signs the user out). Rejects on a network error.
 * Tokens are never logged.
 */
export const refreshSession = (): Promise<string | null> => {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refresher = activeRefresher();
      if (!refresher) return null;
      const tokens = await refresher.refresh();
      if (!tokens) return null;
      storeTokens(tokens.idToken, tokens.refreshToken);
      return tokens.idToken;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
};

/**
 * Refresh the ID token in the background shortly before it expires, while a
 * refresh token is stored. A refused refresh signs the user out; a network
 * error is retried while the current ID token is still valid.
 */
export const startTokenRefresh = () => {
  stopTokenRefresh();
  if (!canRefreshSession()) return;
  const exp = tokenExpiry(sessionStorage.getItem(ID_TOKEN_KEY));
  const delaySeconds = exp === null ? 0 : Math.max(0, exp - REFRESH_MARGIN_SECONDS - nowSeconds());
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      if (!(await refreshSession())) signOutAfterRefreshFailure();
    } catch {
      const current = tokenExpiry(sessionStorage.getItem(ID_TOKEN_KEY));
      if (current !== null && current > nowSeconds() + REFRESH_RETRY_SECONDS) {
        console.warn('Session refresh failed on the network; retrying');
        refreshTimer = setTimeout(startTokenRefresh, REFRESH_RETRY_SECONDS * 1000);
      } else {
        signOutAfterRefreshFailure();
      }
    }
  }, delaySeconds * 1000);
};

/**
 * A usable ID token for an API call: the stored one, refreshed first when it
 * is about to expire and a refresh token is stored. Null when the session has
 * ended (and then the session is cleared).
 */
export const getFreshAuthToken = async (): Promise<string | null> => {
  const token = sessionStorage.getItem(ID_TOKEN_KEY);
  if (!idTokenNeedsRefresh()) return token;
  if (!canRefreshSession()) return getAuthToken();
  try {
    const refreshed = await refreshSession();
    if (!refreshed) clearSession();
    return refreshed;
  } catch {
    // Network error: keep using the current token while it is still valid.
    return getAuthToken();
  }
};

export const getAuthToken = (): string | null => {
  const token = sessionStorage.getItem(ID_TOKEN_KEY);
  
  // Validate token format before returning
  if (token && token.split('.').length === 3) {
    try {
      // Try to decode the payload to ensure it's valid
      const payload = decodePayload(token);
      if (payload.exp && payload.exp > nowSeconds()) {
        return token;
      }
      // Expired, but the session can still be refreshed: hand the token to
      // the caller, and apiCall refreshes it before the request is sent.
      if (payload.exp && canRefreshSession()) {
        return token;
      }
    } catch (error) {
      console.log('Invalid token detected, clearing session');
      clearSession();
    }
  }
  
  return null;
};

export const getAuthHeaders = () => {
  const token = getAuthToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
};

export const getCurrentUser = () => {
  const storedUser = sessionStorage.getItem('auth-user');
  return storedUser ? JSON.parse(storedUser) : null;
};

export const handleAuthError = (error: any) => {
  if (error.message === 'No current user' || error.message?.includes('No current user')) {
    // Clear session and redirect to login
    clearSession();
    window.location.reload();
    return true; // Indicates error was handled
  }
  return false; // Error not handled
};

// Cognito Authentication - redirects to hosted UI (shows all providers)
export const signInWithCognito = async () => {
  const config = await getConfig();
  
  // Don't specify identity_provider - let Cognito hosted UI show all configured providers
  // Users can choose between Okta, Identity Center, or any other configured SAML provider
  const params = new URLSearchParams({
    redirect_uri: window.location.origin,
    response_type: 'code',
    client_id: config.cognitoClientId!,
    scope: 'email openid profile',
  });
  
  window.location.href = `${config.cognitoDomain}/oauth2/authorize?${params}`;
};

// Sign in with a specific identity provider (Okta, IdentityCenter) - redirects to IdP
export const signInWithIdentityProvider = async (provider: string) => {
  const config = await getConfig();
  
  const params = new URLSearchParams({
    redirect_uri: window.location.origin,
    response_type: 'code',
    client_id: config.cognitoClientId!,
    scope: 'email openid profile',
    identity_provider: provider,
  });
  
  window.location.href = `${config.cognitoDomain}/oauth2/authorize?${params}`;
};

// Challenge response type for NEW_PASSWORD_REQUIRED
export interface PasswordChallengeResponse {
  challengeName: 'NEW_PASSWORD_REQUIRED';
  session: string;
  username: string;
  requiredAttributes?: string[];
}

// Sign in with native Cognito username/password (no redirect)
export const signInWithCognitoCredentials = async (username: string, password: string): Promise<{ idToken: string; accessToken: string } | PasswordChallengeResponse> => {
  const config = await getConfig();
  
  // nosemgrep: gitlab.nodejs_scan.javascript-ssrf-rule-node_ssrf
  // URL is AWS Cognito endpoint derived from config.region, not user input
  const response = await fetch(`https://cognito-idp.${config.region || 'us-east-1'}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: config.cognitoClientId,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
      },
    }),
  });
  
  const data = await response.json();
  
  if (data.__type) {
    // Error response from Cognito
    const errorMessage = data.message || 'Authentication failed';
    if (data.__type.includes('NotAuthorizedException')) {
      throw new Error('Incorrect username or password');
    } else if (data.__type.includes('UserNotFoundException')) {
      throw new Error('User not found');
    } else if (data.__type.includes('UserNotConfirmedException')) {
      throw new Error('Please verify your email before signing in');
    }
    throw new Error(errorMessage);
  }
  
  if (data.AuthenticationResult) {
    const { IdToken, AccessToken, RefreshToken } = data.AuthenticationResult;
    
    storeTokens(IdToken, RefreshToken);
    
    // Decode user info from ID token
    const payload = JSON.parse(atob(IdToken.split('.')[1]));
    
    // Check admin status from multiple sources
    const isAdminFromAttribute = payload['custom:isAdmin'] === 'true';
    const cognitoGroups = payload['cognito:groups'] || [];
    
    // Check group membership against adminGroupName config
    const adminGroupConfig = config.adminGroupName || 'MRM-Admins';
    const validAdminGroups = adminGroupConfig.split(',').map((g: string) => g.trim());
    const isAdminFromGroup = cognitoGroups.some((userGroup: string) => 
      validAdminGroups.some((adminGroup: string) => 
        userGroup.toLowerCase() === adminGroup.toLowerCase()
      )
    );
    
    // For native Cognito users, use email as userId
    const user = {
      userId: payload.email,
      email: payload.email,
      firstName: payload.given_name || payload.email?.split('@')[0],
      lastName: payload.family_name || '',
      isAdmin: isAdminFromAttribute || isAdminFromGroup,
      groups: cognitoGroups,
    };
    
    sessionStorage.setItem('auth-user', JSON.stringify(user));
    return { idToken: IdToken, accessToken: AccessToken };
  }
  
  // Handle NEW_PASSWORD_REQUIRED challenge - return challenge data for UI to handle
  if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    // Extract required attributes from the challenge parameters
    const requiredAttributes = data.ChallengeParameters?.requiredAttributes 
      ? JSON.parse(data.ChallengeParameters.requiredAttributes)
      : [];
    
    return {
      challengeName: 'NEW_PASSWORD_REQUIRED',
      session: data.Session,
      username: username,
      requiredAttributes: requiredAttributes,
    };
  }
  
  throw new Error('Authentication failed');
};

// Complete the NEW_PASSWORD_REQUIRED challenge with a new password
export const completeNewPasswordChallenge = async (
  username: string,
  newPassword: string,
  session: string,
  userAttributes?: { givenName?: string; familyName?: string }
): Promise<{ idToken: string; accessToken: string }> => {
  const config = await getConfig();
  
  // Build challenge responses with required user attributes
  const challengeResponses: Record<string, string> = {
    USERNAME: username,
    NEW_PASSWORD: newPassword,
  };
  
  // Add required attributes if provided
  if (userAttributes?.givenName) {
    challengeResponses['userAttributes.given_name'] = userAttributes.givenName;
  }
  if (userAttributes?.familyName) {
    challengeResponses['userAttributes.family_name'] = userAttributes.familyName;
  }
  
  // nosemgrep: gitlab.nodejs_scan.javascript-ssrf-rule-node_ssrf
  // URL is AWS Cognito endpoint derived from config.region, not user input
  const response = await fetch(`https://cognito-idp.${config.region || 'us-east-1'}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.RespondToAuthChallenge',
    },
    body: JSON.stringify({
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      ClientId: config.cognitoClientId,
      ChallengeResponses: challengeResponses,
      Session: session,
    }),
  });
  
  const data = await response.json();
  
  if (data.__type) {
    const errorMessage = data.message || 'Password change failed';
    if (data.__type.includes('InvalidPasswordException')) {
      throw new Error('Password does not meet requirements. Use at least 8 characters with uppercase, lowercase, numbers, and symbols.');
    }
    throw new Error(errorMessage);
  }
  
  if (data.AuthenticationResult) {
    const { IdToken, AccessToken, RefreshToken } = data.AuthenticationResult;
    
    storeTokens(IdToken, RefreshToken);
    
    // Decode user info from ID token
    const payload = JSON.parse(atob(IdToken.split('.')[1]));
    
    // Check admin status from multiple sources
    const isAdminFromAttribute = payload['custom:isAdmin'] === 'true';
    const cognitoGroups = payload['cognito:groups'] || [];
    
    // Check group membership against adminGroupName config
    const adminGroupConfig = config.adminGroupName || 'MRM-Admins';
    const validAdminGroups = adminGroupConfig.split(',').map((g: string) => g.trim());
    const isAdminFromGroup = cognitoGroups.some((userGroup: string) => 
      validAdminGroups.some((adminGroup: string) => 
        userGroup.toLowerCase() === adminGroup.toLowerCase()
      )
    );
    
    const user = {
      userId: payload.email,
      email: payload.email,
      firstName: payload.given_name || payload.email?.split('@')[0],
      lastName: payload.family_name || '',
      isAdmin: isAdminFromAttribute || isAdminFromGroup,
      groups: cognitoGroups,
    };
    
    sessionStorage.setItem('auth-user', JSON.stringify(user));
    return { idToken: IdToken, accessToken: AccessToken };
  }
  
  throw new Error('Password change failed');
};

// Get list of configured identity providers from config
export const getIdentityProviders = async (): Promise<string[]> => {
  const config = await getConfig();
  // Return configured providers, default to empty array if not set
  return config.identityProviders || [];
};

export const isBedrockEnabled = async (): Promise<boolean> => {
  const config = await getConfig();
  return config.enableBedrockFeatures ?? true; // defaults to true
};

// LDAP Authentication
export const signInWithLDAP = async (username: string, password: string) => {
  const config = await getConfig();

  // Normalise UPN and NetBIOS forms into a bare sAMAccountName before we
  // POST to /auth/ldap. AD administrators routinely type any of:
  //   - "MRMServiceAccount"                    (sAMAccountName; canonical)
  //   - "MRMServiceAccount@customer.internal"  (UPN)
  //   - "CUSTOMER\\MRMServiceAccount"          (down-level / NetBIOS)
  // and the LDAP search filter binds on sAMAccountName only, so the
  // non-canonical forms silently fail against the emulator despite being
  // valid AD identifiers. Backend also normalises defensively; doing it
  // here first means the login form succeeds on the first attempt instead
  // of the user having to re-type without the domain suffix.
  const normalisedUsername = username
    .trim()
    .replace(/^[^\\]+\\/, '') // strip DOMAIN\ prefix if present
    .replace(/@.+$/, '');     // strip @domain.suffix if present

  const response = await fetch(`${config.apiUrl}auth/ldap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: normalisedUsername, password }),
  });
  
  if (!response.ok) {
    throw new Error('Authentication failed');
  }
  
  const data = await response.json();
  
  sessionStorage.setItem('auth-token', data.token);
  
  // Create user object from token payload for LDAP auth
  const tokenPayload = JSON.parse(atob(data.token.split('.')[1]));
  const user = {
    username: tokenPayload.username,
    attributes: {
      email: tokenPayload.email,
      given_name: tokenPayload.given_name,
      family_name: tokenPayload.family_name,
      'custom:isAdmin': tokenPayload.isAdmin ? 'true' : 'false'
    }
  };
  
  sessionStorage.setItem('auth-user', JSON.stringify(user));
  
  return data;
};

// Handle Cognito callback
export const handleCognitoCallback = async (code: string) => {
  const config = await getConfig();
  
  // nosemgrep: gitlab.nodejs_scan.javascript-ssrf-rule-node_ssrf
  // URL is Cognito token endpoint from deployment config, not user input
  const response = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.cognitoClientId!,
      code,
      redirect_uri: window.location.origin,
    }),
  });
  
  const tokens = await response.json();
  
  if (tokens.access_token && tokens.id_token) {
    storeTokens(tokens.id_token, tokens.refresh_token);
    
    // Decode user info from ID token
    const payload = JSON.parse(atob(tokens.id_token.split('.')[1]));
    
    // Check admin status from multiple sources:
    // 1. custom:isAdmin attribute (Okta)
    // 2. Group membership (Identity Center or Okta groups)
    const isAdminFromAttribute = payload['custom:isAdmin'] === 'true';
    
    // Collect groups from all possible sources
    const customGroups = payload['custom:groups'] || '';
    const cognitoGroups = payload['cognito:groups'] || [];
    const directGroups = payload['groups'] || [];
    
    // Normalize groups to an array (handle string or array formats)
    const normalizeGroups = (groups: string | string[]): string[] => {
      if (Array.isArray(groups)) {
        // Clean any brackets from individual group IDs (edge case from IdP)
        return groups.map(g => g.replace(/^\[|\]$/g, '').trim());
      }
      if (typeof groups === 'string' && groups) {
        // Remove surrounding brackets if present (e.g., "[guid1,guid2]" -> "guid1,guid2")
        const cleaned = groups.replace(/^\[|\]$/g, '').trim();
        return cleaned.split(',').map(g => g.trim());
      }
      return [];
    };
    
    const allGroups = [
      ...normalizeGroups(customGroups),
      ...normalizeGroups(cognitoGroups),
      ...normalizeGroups(directGroups)
    ];
    
    // AdminGroupName can be a group name (e.g., "MRM-Admins") or 
    // a group ID (e.g., "14b814d8-0051-70ce-abfc-e94bf1852946") for Identity Center
    // Support comma-separated list for multiple valid admin groups/IDs
    const adminGroupConfig = config.adminGroupName || 'MRM-Admins';
    const validAdminGroups = adminGroupConfig.split(',').map(g => g.trim());
    
    // Check if user is in any of the valid admin groups (case-insensitive)
    const isAdminFromGroup = allGroups.some(userGroup => 
      validAdminGroups.some(adminGroup => 
        userGroup.toLowerCase() === adminGroup.toLowerCase()
      )
    );
    
    // Determine userId based on user type:
    // - Federated users (Okta, IdentityCenter): use cognito:username (e.g., "IdentityCenter_user@example.com")
    // - Native Cognito users: use email (cognito:username is a UUID for native users)
    const cognitoUsername = payload['cognito:username'] || '';
    const isFederatedUser = cognitoUsername.includes('_') && !cognitoUsername.match(/^[0-9a-f-]{36}$/i);
    const userId = isFederatedUser ? cognitoUsername : payload.email;
    
    const user = {
      userId: userId,
      email: payload.email,
      firstName: payload.given_name,
      lastName: payload.family_name,
      isAdmin: isAdminFromAttribute || isAdminFromGroup,
      groups: allGroups,
    };
    
    sessionStorage.setItem('auth-user', JSON.stringify(user));
    return tokens;
  }
  
  throw new Error('Authentication failed');
};

// Check for Cognito callback on page load
export const checkCognitoCallback = async () => {
  const config = await getConfig();
  
  if (config.useCognitoAuth) {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    
    if (code) {
      try {
        await handleCognitoCallback(code);
        // Clear URL parameters
        window.history.replaceState({}, document.title, window.location.pathname);
        return true;
      } catch (error) {
        console.error('Cognito callback failed:', error);
        return false;
      }
    }
  }
  
  return false;
};

// Check if user should use Cognito auth
export const shouldUseCognito = async (): Promise<boolean> => {
  const config = await getConfig();
  return config.useCognitoAuth;
};

/** Revoke a Cognito refresh token (best effort, bounded wait). */
const revokeRefreshToken = async (config: Config, refreshToken: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    // nosemgrep: gitlab.nodejs_scan.javascript-ssrf-rule-node_ssrf
    // URL is AWS Cognito endpoint derived from config.region, not user input
    await fetch(`https://cognito-idp.${config.region || 'us-east-1'}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.RevokeToken',
      },
      body: JSON.stringify({ Token: refreshToken, ClientId: config.cognitoClientId }),
      signal: controller.signal,
    });
  } catch {
    console.warn('Could not revoke the refresh token at sign-out');
  } finally {
    clearTimeout(timer);
  }
};

// Sign out - clears local session and redirects to Cognito logout
export const signOut = async (fullLogout: boolean = true) => {
  const refreshToken = sessionStorage.getItem(REFRESH_TOKEN_KEY);

  // Clear local session
  clearSession();
  
  const config = await getConfig();

  if (config.useCognitoAuth && refreshToken && config.cognitoClientId) {
    await revokeRefreshToken(config, refreshToken);
  }
  
  if (config.useCognitoAuth && fullLogout) {
    // Redirect to Cognito logout endpoint
    // This will clear the Cognito session AND redirect to the IdP logout
    const logoutUrl = new URL(`${config.cognitoDomain}/logout`);
    logoutUrl.searchParams.set('client_id', config.cognitoClientId!);
    logoutUrl.searchParams.set('logout_uri', window.location.origin);
    
    window.location.href = logoutUrl.toString();
    return true; // Indicates redirect will happen
  }
  
  return false; // No redirect, just local logout
};
