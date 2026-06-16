// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { CloudServerOutlined } from '@ant-design/icons';
import {
  Container,
  Header,
  Form,
  FormField,
  Input,
  Button,
  SpaceBetween,
  Alert,
  Box,
  Link,
} from '@cloudscape-design/components';
import { applyMode, Mode } from '@cloudscape-design/global-styles';
import { 
  signInWithCognito, 
  signInWithIdentityProvider,
  signInWithCognitoCredentials,
  completeNewPasswordChallenge,
  signInWithLDAP, 
  shouldUseCognito, 
  checkCognitoCallback,
  getIdentityProviders,
  PasswordChallengeResponse
} from '../utils/auth';

interface LoginProps {
  onSignIn: () => void;
  productName?: string;
}

const Login: React.FC<LoginProps> = ({ onSignIn, productName }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [darkMode, setDarkMode] = useState(false);
  const [useCognito, setUseCognito] = useState(false);
  const [checkingCallback, setCheckingCallback] = useState(true);
  const [identityProviders, setIdentityProviders] = useState<string[]>([]);
  const [showCognitoLogin, setShowCognitoLogin] = useState(false);
  const [passwordChallenge, setPasswordChallenge] = useState<PasswordChallengeResponse | null>(null);
  const [logoLoaded, setLogoLoaded] = useState(false);
  const [logoError, setLogoError] = useState(false);

  useEffect(() => {
    // Load and apply dark mode preference
    const savedMode = localStorage.getItem('darkMode');
    if (savedMode) {
      const isDark = JSON.parse(savedMode);
      setDarkMode(isDark);
      applyMode(isDark ? Mode.Dark : Mode.Light);
    }

    // Check auth mode and handle Cognito callback
    const initAuth = async () => {
      try {
        const cognitoMode = await shouldUseCognito();
        setUseCognito(cognitoMode);
        
        if (cognitoMode) {
          // Get configured identity providers
          const providers = await getIdentityProviders();
          setIdentityProviders(providers);
          
          const callbackHandled = await checkCognitoCallback();
          if (callbackHandled) {
            onSignIn();
            return;
          }
        }
      } catch (error) {
        console.error('Auth initialization error:', error);
      } finally {
        setCheckingCallback(false);
      }
    };

    initAuth();
  }, [onSignIn]);

  const handleProviderSignIn = async (provider: string) => {
    setLoadingProvider(provider);
    setError('');
    
    try {
      await signInWithIdentityProvider(provider);
    } catch (error: any) {
      setError(error.message || 'Authentication failed');
      setLoadingProvider(null);
    }
  };

  const handleCognitoDirectSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      // Authenticate directly with Cognito using username/password
      const result = await signInWithCognitoCredentials(username, password);
      
      // Check if this is a password challenge
      if ('challengeName' in result && result.challengeName === 'NEW_PASSWORD_REQUIRED') {
        setPasswordChallenge(result);
        setLoading(false);
        return;
      }
      
      onSignIn();
    } catch (error: any) {
      setError(error.message || 'Authentication failed. Please check your credentials.');
      setLoading(false);
    }
  };

  const handleNewPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      setLoading(false);
      return;
    }

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      setLoading(false);
      return;
    }

    if (!firstName.trim() || !lastName.trim()) {
      setError('First name and last name are required');
      setLoading(false);
      return;
    }

    try {
      await completeNewPasswordChallenge(
        passwordChallenge!.username,
        newPassword,
        passwordChallenge!.session,
        { givenName: firstName.trim(), familyName: lastName.trim() }
      );
      onSignIn();
    } catch (error: any) {
      setError(error.message || 'Failed to set new password');
      setLoading(false);
    }
  };

  const handleLDAPSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await signInWithLDAP(username, password);
      onSignIn();
    } catch (error: any) {
      setError(error.message || 'Authentication failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  // Get display name for identity provider
  const getProviderDisplayName = (provider: string): string => {
    const displayNames: Record<string, string> = {
      'Okta': 'Okta',
      'IdentityCenter': 'AWS IAM Identity Center',
      'COGNITO': 'Email and Password'
    };
    return displayNames[provider] || provider;
  };

  if (checkingCallback) {
    return (
      <div style={{ 
        minHeight: '100vh', 
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #334155 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem'
      }}>
        <div style={{ color: '#f8fafc', fontSize: '1.2rem' }}>
          Checking authentication...
        </div>
      </div>
    );
  }

  return (
    <div style={{ 
      minHeight: '100vh', 
      background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #334155 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem'
    }}>
      <div style={{
        background: darkMode 
          ? 'rgba(30, 41, 59, 0.95)' 
          : 'rgba(255, 255, 255, 0.95)',
        backdropFilter: 'blur(10px)',
        borderRadius: '16px',
        boxShadow: darkMode 
          ? '0 20px 40px rgba(0, 0, 0, 0.3)'
          : '0 20px 40px rgba(0, 0, 0, 0.1)',
        padding: '3rem',
        width: '100%',
        maxWidth: '480px',
        border: darkMode 
          ? '1px solid rgba(255, 255, 255, 0.1)'
          : '1px solid rgba(255, 255, 255, 0.2)'
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ 
            fontSize: '3rem', 
            marginBottom: '1rem',
            fontWeight: 'bold',
            filter: darkMode 
              ? 'drop-shadow(0 0 8px #60a5fa)' 
              : 'drop-shadow(0 0 8px #1e3a8a)',
            textShadow: darkMode
              ? '0 0 10px #60a5fa, 0 0 20px #60a5fa'
              : '0 0 10px #1e3a8a, 0 0 20px #1e3a8a'
          }}>
            {!logoError && (
              <img 
                src="/logo.png" 
                alt="Logo"
                style={{ 
                  maxHeight: '64px',
                  maxWidth: '200px',
                  display: logoLoaded ? 'inline-block' : 'none'
                }}
                onLoad={() => setLogoLoaded(true)}
                onError={() => setLogoError(true)}
              />
            )}
            {(logoError || !logoLoaded) && <CloudServerOutlined />}
          </div>
          <h1 style={{ 
            fontSize: '1.75rem', 
            fontWeight: '600', 
            marginBottom: '0.5rem',
            color: darkMode ? '#f8fafc' : '#1f2937'
          }}>
            {productName || 'Media Resource Manager'}
          </h1>
          <p style={{ 
            color: darkMode ? '#94a3b8' : '#6b7280',
            fontSize: '0.95rem'
          }}>
            Sign in to access your virtual workstations
          </p>
        </div>

        {useCognito ? (
          // Cognito/SAML Authentication
          <div>
            <SpaceBetween direction="vertical" size="l">
              {error && (
                <Alert type="error" dismissible onDismiss={() => setError('')}>
                  {error}
                </Alert>
              )}
              
              {passwordChallenge ? (
                // Show password change form
                <>
                  <Alert type="info">
                    You must set a new password before continuing.
                  </Alert>
                  <form onSubmit={handleNewPasswordSubmit}>
                    <SpaceBetween direction="vertical" size="m">
                      <FormField label="First Name">
                        <Input
                          value={firstName}
                          onChange={({ detail }) => setFirstName(detail.value)}
                          placeholder="Enter your first name"
                        />
                      </FormField>

                      <FormField label="Last Name">
                        <Input
                          value={lastName}
                          onChange={({ detail }) => setLastName(detail.value)}
                          placeholder="Enter your last name"
                        />
                      </FormField>

                      <FormField 
                        label="New Password"
                        description="At least 8 characters with uppercase, lowercase, numbers, and symbols"
                      >
                        <Input
                          value={newPassword}
                          onChange={({ detail }) => setNewPassword(detail.value)}
                          placeholder="Enter new password"
                          type="password"
                          autoComplete="new-password"
                        />
                      </FormField>

                      <FormField label="Confirm Password">
                        <Input
                          value={confirmPassword}
                          onChange={({ detail }) => setConfirmPassword(detail.value)}
                          placeholder="Confirm new password"
                          type="password"
                          autoComplete="new-password"
                        />
                      </FormField>
                      
                      <Button 
                        variant="primary" 
                        loading={loading} 
                        formAction="submit"
                        fullWidth
                      >
                        Set New Password
                      </Button>
                    </SpaceBetween>
                  </form>
                  
                  <Button 
                    variant="link"
                    onClick={() => {
                      setPasswordChallenge(null);
                      setNewPassword('');
                      setConfirmPassword('');
                      setFirstName('');
                      setLastName('');
                      setError('');
                    }}
                    fullWidth
                  >
                    ← Back to sign in
                  </Button>
                </>
              ) : !showCognitoLogin && (identityProviders.length > 0) ? (
                // Show SSO provider buttons
                <>
                  {identityProviders.map((provider, index) => (
                    <Button 
                      key={provider}
                      variant={index === 0 ? 'primary' : 'normal'}
                      loading={loadingProvider === provider} 
                      onClick={() => handleProviderSignIn(provider)}
                      fullWidth
                      iconName={provider === 'IdentityCenter' ? 'status-positive' : 'key'}
                    >
                      Sign in with {getProviderDisplayName(provider)}
                    </Button>
                  ))}
                  
                  {/* Divider */}
                  <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    margin: '0.5rem 0',
                    color: darkMode ? '#64748b' : '#9ca3af'
                  }}>
                    <div style={{ flex: 1, height: '1px', background: darkMode ? '#475569' : '#d1d5db' }} />
                    <span style={{ padding: '0 1rem', fontSize: '0.875rem' }}>or</span>
                    <div style={{ flex: 1, height: '1px', background: darkMode ? '#475569' : '#d1d5db' }} />
                  </div>
                  
                  <Button 
                    variant="link"
                    onClick={() => setShowCognitoLogin(true)}
                    fullWidth
                  >
                    Sign in with email and password
                  </Button>
                </>
              ) : (
                // Show Cognito username/password form
                <>
                  <form onSubmit={handleCognitoDirectSignIn}>
                    <SpaceBetween direction="vertical" size="m">
                      <FormField label="Email">
                        <Input
                          value={username}
                          onChange={({ detail }) => setUsername(detail.value)}
                          placeholder="Enter your email"
                          type="email"
                          autoComplete="username"
                        />
                      </FormField>

                      <FormField label="Password">
                        <Input
                          value={password}
                          onChange={({ detail }) => setPassword(detail.value)}
                          placeholder="Enter your password"
                          type="password"
                          autoComplete="current-password"
                        />
                      </FormField>
                      
                      <Button 
                        variant="primary" 
                        loading={loading} 
                        formAction="submit"
                        fullWidth
                      >
                        Sign In
                      </Button>
                    </SpaceBetween>
                  </form>
                  
                  {(identityProviders.length > 0) && (
                    <>
                      {/* Divider */}
                      <div style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        margin: '0.5rem 0',
                        color: darkMode ? '#64748b' : '#9ca3af'
                      }}>
                        <div style={{ flex: 1, height: '1px', background: darkMode ? '#475569' : '#d1d5db' }} />
                        <span style={{ padding: '0 1rem', fontSize: '0.875rem' }}>or</span>
                        <div style={{ flex: 1, height: '1px', background: darkMode ? '#475569' : '#d1d5db' }} />
                      </div>
                      
                      <Button 
                        variant="link"
                        onClick={() => setShowCognitoLogin(false)}
                        fullWidth
                      >
                        ← Back to SSO options
                      </Button>
                    </>
                  )}
                </>
              )}
            </SpaceBetween>
          </div>
        ) : (
          // LDAP Authentication
          <form onSubmit={handleLDAPSignIn}>
            <Form
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button variant="primary" loading={loading} formAction="submit" fullWidth>
                    Sign In
                  </Button>
                </SpaceBetween>
              }
            >
              <SpaceBetween direction="vertical" size="l">
                {error && (
                  <Alert type="error" dismissible onDismiss={() => setError('')}>
                    {error}
                  </Alert>
                )}
                
                <Alert type="info">
                  Sign in with your Active Directory credentials.
                </Alert>
                
                <FormField label="Username">
                  <Input
                    value={username}
                    onChange={({ detail }) => setUsername(detail.value)}
                    placeholder="Enter your AD username (without domain)"
                    required
                  />
                </FormField>

                <FormField label="Active Directory Password">
                  <Input
                    value={password}
                    onChange={({ detail }) => setPassword(detail.value)}
                    placeholder="Enter your AD password"
                    type="password"
                    required
                  />
                </FormField>
              </SpaceBetween>
            </Form>
          </form>
        )}
      </div>
    </div>
  );
};

export default Login;
