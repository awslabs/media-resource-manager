// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { Form, Input, Button, Alert, Space, Typography, Divider, ConfigProvider } from 'antd';
import { UserOutlined, LockOutlined, KeyOutlined, SafetyCertificateOutlined, CloudServerOutlined } from '@ant-design/icons';
import { getTheme } from '../theme/antdTheme';
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

const { Title, Text } = Typography;

interface LoginProps {
  onSignIn: () => void;
  productName?: string;
}

const LoginAntd: React.FC<LoginProps> = ({ onSignIn, productName }) => {
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
    const savedMode = localStorage.getItem('darkMode');
    if (savedMode) {
      setDarkMode(JSON.parse(savedMode));
    }

    const initAuth = async () => {
      try {
        const cognitoMode = await shouldUseCognito();
        setUseCognito(cognitoMode);
        
        if (cognitoMode) {
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

  const handleCognitoDirectSignIn = async () => {
    setLoading(true);
    setError('');

    try {
      const result = await signInWithCognitoCredentials(username, password);
      
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

  const handleNewPasswordSubmit = async () => {
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

  const handleLDAPSignIn = async () => {
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

  const getProviderDisplayName = (provider: string): string => {
    const displayNames: Record<string, string> = {
      'Okta': 'Okta',
      'IdentityCenter': 'AWS IAM Identity Center',
      'COGNITO': 'Email and Password'
    };
    return displayNames[provider] || provider;
  };

  const getProviderIcon = (provider: string) => {
    if (provider === 'IdentityCenter') return <SafetyCertificateOutlined />;
    return <KeyOutlined />;
  };

  // Background gradient that adapts to dark/light mode
  const backgroundGradient = darkMode 
    ? 'linear-gradient(135deg, #060a0f 0%, #0a0e14 50%, #1a2230 100%)' // Deep Ocean colors
    : 'linear-gradient(135deg, #f8f9fc 0%, #e8f0f7 50%, #d8e8f2 100%)'; // Light blue gradient

  if (checkingCallback) {
    return (
      <div style={{ 
        minHeight: '100vh', 
        background: backgroundGradient,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Text style={{ color: darkMode ? '#c5c8c6' : '#2A4A6A', fontSize: '1.2rem' }}>
          Checking authentication...
        </Text>
      </div>
    );
  }

  // Deep Ocean theme colors for dark mode
  const cardStyle: React.CSSProperties = {
    background: darkMode ? 'rgba(26, 34, 48, 0.98)' : 'rgba(255, 255, 255, 0.95)', // #1a2230 with opacity
    backdropFilter: 'blur(10px)',
    borderRadius: '16px',
    boxShadow: darkMode ? '0 20px 40px rgba(0, 0, 0, 0.5)' : '0 20px 40px rgba(0, 0, 0, 0.1)',
    padding: '3rem',
    width: '100%',
    maxWidth: '480px',
    border: darkMode ? '1px solid rgba(61, 79, 95, 0.6)' : '1px solid rgba(255, 255, 255, 0.2)' // #3d4f5f border
  };

  const content = (
    <div style={{ 
      minHeight: '100vh', 
      background: backgroundGradient,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem'
    }}>
      <div style={cardStyle}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ 
            fontSize: '3rem', 
            marginBottom: '1rem',
            fontWeight: 'bold',
          }}>
            {!logoError && (
              <img 
                src="/logo.png" 
                alt="Logo"
                style={{ 
                  maxHeight: '64px',
                  maxWidth: '200px',
                  display: logoLoaded ? 'inline-block' : 'none',
                  filter: darkMode ? 'invert(1) brightness(2)' : 'none',
                }}
                onLoad={() => setLogoLoaded(true)}
                onError={() => setLogoError(true)}
              />
            )}
            {(logoError || !logoLoaded) && <CloudServerOutlined />}
          </div>
          <Title level={3} style={{ 
            marginBottom: 0,
            color: darkMode ? '#c5c8c6' : '#1f2937' // Deep Ocean text color
          }}>
            {productName || 'Media Resource Manager'}
          </Title>
        </div>

        {error && (
          <Alert
            message={error}
            type="error"
            closable
            onClose={() => setError('')}
            style={{ marginBottom: '1.5rem' }}
          />
        )}

        {useCognito ? (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            {passwordChallenge ? (
              <>
                <Alert
                  message="You must set a new password before continuing."
                  type="info"
                  showIcon
                />
                <Form layout="vertical" onFinish={handleNewPasswordSubmit}>
                  <Form.Item label="First Name" required>
                    <Input
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      placeholder="Enter your first name"
                    />
                  </Form.Item>
                  <Form.Item label="Last Name" required>
                    <Input
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      placeholder="Enter your last name"
                    />
                  </Form.Item>
                  <Form.Item 
                    label="New Password"
                    extra="At least 8 characters with uppercase, lowercase, numbers, and symbols"
                  >
                    <Input.Password
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Enter new password"
                    />
                  </Form.Item>
                  <Form.Item label="Confirm Password">
                    <Input.Password
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Confirm new password"
                    />
                  </Form.Item>
                  <Form.Item>
                    <Button type="primary" htmlType="submit" loading={loading} block>
                      Set New Password
                    </Button>
                  </Form.Item>
                </Form>
                <Button 
                  type="link" 
                  block
                  onClick={() => {
                    setPasswordChallenge(null);
                    setNewPassword('');
                    setConfirmPassword('');
                    setFirstName('');
                    setLastName('');
                    setError('');
                  }}
                >
                  ← Back to sign in
                </Button>
              </>
            ) : !showCognitoLogin && (identityProviders.length > 0) ? (
              <>
                {identityProviders.map((provider, index) => (
                  <Button 
                    key={provider}
                    type={index === 0 ? 'primary' : 'default'}
                    loading={loadingProvider === provider} 
                    onClick={() => handleProviderSignIn(provider)}
                    block
                    size="large"
                    icon={getProviderIcon(provider)}
                  >
                    Sign in with {getProviderDisplayName(provider)}
                  </Button>
                ))}
                
                <Divider plain style={{ color: darkMode ? '#64748b' : '#9ca3af' }}>
                  or
                </Divider>
                
                <Button type="link" onClick={() => setShowCognitoLogin(true)} block>
                  Sign in with email and password
                </Button>
              </>
            ) : (
              <>
                <Form layout="vertical" onFinish={handleCognitoDirectSignIn}>
                  <Form.Item label="Email">
                    <Input
                      prefix={<UserOutlined />}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="Enter your email"
                      type="email"
                      autoComplete="username"
                      size="large"
                    />
                  </Form.Item>
                  <Form.Item label="Password">
                    <Input.Password
                      prefix={<LockOutlined />}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password"
                      autoComplete="current-password"
                      size="large"
                    />
                  </Form.Item>
                  <Form.Item>
                    <Button type="primary" htmlType="submit" loading={loading} block size="large">
                      Sign In
                    </Button>
                  </Form.Item>
                </Form>
                
                {(identityProviders.length > 0) && (
                  <>
                    <Divider plain style={{ color: darkMode ? '#64748b' : '#9ca3af' }}>
                      or
                    </Divider>
                    <Button type="link" onClick={() => setShowCognitoLogin(false)} block>
                      ← Back to SSO options
                    </Button>
                  </>
                )}
              </>
            )}
          </Space>
        ) : (
          <Form layout="vertical" onFinish={handleLDAPSignIn}>
            <Alert
              message="Sign in with your Active Directory credentials."
              type="info"
              showIcon
              style={{ marginBottom: '1.5rem' }}
            />
            <Form.Item label="Username" required>
              <Input
                prefix={<UserOutlined />}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your AD username (without domain)"
                size="large"
              />
            </Form.Item>
            <Form.Item label="Active Directory Password" required>
              <Input.Password
                prefix={<LockOutlined />}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your AD password"
                size="large"
              />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block size="large">
                Sign In
              </Button>
            </Form.Item>
          </Form>
        )}
      </div>
    </div>
  );

  return (
    <ConfigProvider theme={getTheme(darkMode)}>
      {content}
    </ConfigProvider>
  );
};

export default LoginAntd;
