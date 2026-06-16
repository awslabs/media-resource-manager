// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AppLayout, TopNavigation, Toggle, Modal, Form, FormField, Input, Button, SpaceBetween, Alert, ContentLayout, Header, Box, Grid, BreadcrumbGroup } from '@cloudscape-design/components';
import { applyMode, Mode } from '@cloudscape-design/global-styles';
import '@cloudscape-design/global-styles/index.css';

import Dashboard from './pages/Dashboard';
import DashboardAntd from './pages/DashboardAntd';
import Login from './pages/Login';
import LoginAntd from './pages/LoginAntd';

// Toggle this to switch between Cloudscape and Ant Design
const USE_ANTD_LOGIN = true;
const USE_ANTD_SOFTWARE = true;
const USE_ANTD_DASHBOARD = true;
const USE_ANTD_SETTINGS = true;
const USE_ANTD_REGIONS = true;
const USE_ANTD_IMAGES = true;
const USE_ANTD_PIPELINES = true;
const USE_ANTD_WORKSTATIONS = true;
const USE_ANTD_USERS = true;
const USE_ANTD_FILESYSTEMS = true;
const USE_ANTD_DATATRANSFER = true;
const USE_ANTD_DCV = true;
const USE_ANTD_WORKSTATION_DETAILS = true;
const USE_ANTD_USER_DETAILS = true;
const USE_ANTD_STORAGE_DETAILS = true;
const USE_ANTD_TASK_DETAILS = true;
const USE_ANTD_IMAGE_CREATION = true;
const USE_ANTD_BUCKETS = true;
const USE_ANTD_SOFTWARE_DETAILS = true;
import WorkstationManagement from './pages/WorkstationManagement';
import WorkstationDetails from './pages/WorkstationDetails';
import UserManagement from './pages/UserManagement';
import UserManagementAntd from './pages/UserManagementAntd';
import FilesystemsAntd from './pages/FilesystemsAntd';
import DataTransferAntd from './pages/DataTransferAntd';
import DcvSessionsAntd from './pages/DcvSessionsAntd';
import WorkstationDetailsAntd from './pages/WorkstationDetailsAntd';
import UserDetailsAntd from './pages/UserDetailsAntd';
import StorageDetailsAntd from './pages/StorageDetailsAntd';
import TaskDetailsAntd from './pages/TaskDetailsAntd';
import ImageCreationAntd from './pages/ImageCreationAntd';
import BucketsAntd from './pages/BucketsAntd';
import UserDetails from './pages/UserDetails';
import GroupDetails from './pages/GroupDetails';
import GroupDetailsAntd from './pages/GroupDetailsAntd';
import ImageManagement from './pages/ImageManagement';
import ImageCreation from './pages/ImageCreation';
import SoftwareManagement from './pages/SoftwareManagement';
import SoftwareManagementAntd from './pages/SoftwareManagementAntd';
import SoftwareDetails from './pages/SoftwareDetails';
import SoftwareDetailsAntd from './pages/SoftwareDetailsAntd';
import SettingsAntd from './pages/SettingsAntd';
import RegionManagementAntd from './pages/RegionManagementAntd';
import ImageManagementAntd from './pages/ImageManagementAntd';
import PipelinesAntd from './pages/PipelinesAntd';
import WorkstationManagementAntd from './pages/WorkstationManagementAntd';
import StorageManagement from './pages/StorageManagement';
import StorageDetails from './pages/StorageDetails';
import TaskDetails from './pages/TaskDetails';
import RegionManagement from './pages/RegionManagement';
import Settings from './pages/Settings';
import DcvSessions from './pages/DcvSessions';
import Navigation from './components/Navigation';
import { setApiUrl } from './utils/api';
import { apiCall } from './utils/api';
import { signOut as cognitoSignOut } from './utils/auth';

function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<any>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [changePasswordForm, setChangePasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);
  const [changePasswordError, setChangePasswordError] = useState('');
  const [dashboardNavOpen, setDashboardNavOpen] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  useEffect(() => {
    if (configLoaded) {
      checkAuthState();
    }
  }, [configLoaded]);

  // Re-validate auth whenever the page is restored from the browser's
  // back/forward cache (bfcache). Without this, hitting Back after sign-out
  // restores the frozen React tree — including any previously-fetched data —
  // until the user interacts. event.persisted === true means bfcache restore.
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        const storedToken = sessionStorage.getItem('auth-token');
        if (!storedToken) {
          // Session was cleared while we were backgrounded (e.g., user signed
          // out in another tab, or this is a back-nav after sign-out).
          // Force a fresh navigation so React state and all child page state
          // are thrown away, not just user=null on the stale tree.
          window.location.reload();
        } else {
          // Still authenticated — just re-run the auth check to re-validate
          // token expiry and pick up any remote changes.
          checkAuthState();
        }
      }
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, []);

  // Update document title when config loads
  useEffect(() => {
    if (config?.productName) {
      document.title = `AWS ${config.productName}`;
    }
  }, [config?.productName]);

  useEffect(() => {
    // Load dark mode preference from localStorage
    const savedMode = localStorage.getItem('darkMode');
    if (savedMode) {
      const isDark = JSON.parse(savedMode);
      setDarkMode(isDark);
      applyMode(isDark ? Mode.Dark : Mode.Light);
    }

    // Intercept console.error to catch authentication errors
    const originalConsoleError = console.error;
    console.error = (...args) => {
      const message = args.join(' ');
      if (message.includes('No current user')) {
        sessionStorage.removeItem('auth-user');
        sessionStorage.removeItem('auth-token');
        setUser(null);
      }
      originalConsoleError.apply(console, args);
    };

    return () => {
      console.error = originalConsoleError;
    };
  }, []);

  const toggleDarkMode = () => {
    const newMode = !darkMode;
    setDarkMode(newMode);
    applyMode(newMode ? Mode.Dark : Mode.Light);
    localStorage.setItem('darkMode', JSON.stringify(newMode));
  };

  const loadConfig = async () => {
    try {
      // Use dev config in development mode, production config otherwise
      const configFile = import.meta.env?.DEV ? '/config-dev.json' : '/config.json';
      console.log('Loading config from:', configFile);
      
      const response = await fetch(configFile);
      const configData = await response.json();
      
      console.log('Loaded config:', configData);
      
      // Set API URL for the application
      setApiUrl(configData.apiUrl);
      setConfig(configData);
      
      setConfigLoaded(true);
    } catch (error) {
      console.error('Failed to load configuration:', error);
      setLoading(false);
    }
  };

  const checkAuthState = async () => {
    try {
      // Check for stored user and token in sessionStorage
      const storedUser = sessionStorage.getItem('auth-user');
      const storedToken = sessionStorage.getItem('auth-token');
      
      if (storedUser && storedToken) {
        // Verify token is still valid by checking expiry
        try {
          const tokenPayload = JSON.parse(atob(storedToken.split('.')[1]));
          if (tokenPayload.exp > Math.floor(Date.now() / 1000)) {
            const user = JSON.parse(storedUser);
            console.log('Found valid session token:', user);
            setUser(user);
            setLoading(false);
            return;
          } else {
            console.log('Token expired, clearing session');
            sessionStorage.removeItem('auth-user');
            sessionStorage.removeItem('auth-token');
          }
        } catch (error) {
          console.log('Invalid token format, clearing session');
          sessionStorage.removeItem('auth-user');
          sessionStorage.removeItem('auth-token');
        }
      }
      
      console.log('No valid session found');
      setUser(null);
    } catch (error) {
      console.log('Auth check failed:', error);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      if (config?.useCognitoAuth) {
        // Use Cognito logout which redirects to IdP logout
        const willRedirect = await cognitoSignOut(true);
        if (!willRedirect) {
          setUser(null);
        }
        // If willRedirect is true, page will redirect so no need to update state
      } else {
        // LDAP mode - just clear local session
        sessionStorage.removeItem('auth-user');
        sessionStorage.removeItem('auth-token');
        setUser(null);
      }
    } catch (error) {
      console.error('Error signing out:', error);
      // Even if signout fails, clear our state
      sessionStorage.removeItem('auth-user');
      sessionStorage.removeItem('auth-token');
      setUser(null);
    }
  };

  const handleChangePassword = async () => {
    setChangePasswordError('');
    
    // Validate passwords match
    if (changePasswordForm.newPassword !== changePasswordForm.confirmPassword) {
      setChangePasswordError('New passwords do not match');
      return;
    }
    
    // Validate password strength
    if (changePasswordForm.newPassword.length < 8) {
      setChangePasswordError('New password must be at least 8 characters long');
      return;
    }
    
    setChangePasswordLoading(true);
    
    try {
      console.log('User object for change password:', user);
      console.log('User attributes:', user.attributes);
      
      // Call backend API to change password
      const response = await apiCall('/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionStorage.getItem('auth-token')}`
        },
        body: JSON.stringify({
          username: user.username,
          currentPassword: changePasswordForm.currentPassword,
          newPassword: changePasswordForm.newPassword
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to change password');
      }
      
      // Reset form and close modal
      setChangePasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setShowChangePasswordModal(false);
      
    } catch (error) {
      console.error('Error changing password:', error);
      setChangePasswordError(error.message || 'Failed to change password');
    } finally {
      setChangePasswordLoading(false);
    }
  };

  // Check if user is admin based on JWT token
  const isAdmin = () => {
    // Handle both Cognito and LDAP user structures
    if (user?.isAdmin !== undefined) return user.isAdmin; // Cognito structure
    if (user?.attributes) return user.attributes['custom:isAdmin'] === 'true'; // LDAP structure
    return false;
  };

  if (loading || !configLoaded) {
    return <div>Loading...</div>;
  }

  if (!user) {
    const LoginComponent = USE_ANTD_LOGIN ? LoginAntd : Login;
    return <LoginComponent onSignIn={checkAuthState} productName={config?.productName} />;
  }

  const userIsAdmin = isAdmin();

  // Check if current path should use Ant Design layout
  const isAntdRoute = (USE_ANTD_DASHBOARD && (window.location.pathname === '/' || window.location.pathname === '/dashboard')) ||
                      (USE_ANTD_SOFTWARE && window.location.pathname === '/software') ||
                      (USE_ANTD_SETTINGS && window.location.pathname === '/settings') ||
                      (USE_ANTD_REGIONS && window.location.pathname === '/regions') ||
                      (USE_ANTD_IMAGES && window.location.pathname === '/images') ||
                      (USE_ANTD_PIPELINES && window.location.pathname === '/pipelines') ||
                      (USE_ANTD_WORKSTATIONS && window.location.pathname === '/workstations') ||
                      (USE_ANTD_USERS && window.location.pathname === '/users') ||
                      (USE_ANTD_FILESYSTEMS && window.location.pathname === '/filesystems') ||
                      (USE_ANTD_DATATRANSFER && window.location.pathname === '/data-transfer') ||
                      (USE_ANTD_DCV && window.location.pathname === '/dcv') ||
                      (USE_ANTD_WORKSTATION_DETAILS && window.location.pathname.startsWith('/workstations/')) ||
                      (USE_ANTD_USER_DETAILS && window.location.pathname.startsWith('/users/')) ||
                      (USE_ANTD_USER_DETAILS && window.location.pathname.startsWith('/groups/')) ||
                      (USE_ANTD_STORAGE_DETAILS && window.location.pathname.startsWith('/storage/')) ||
                      (USE_ANTD_TASK_DETAILS && window.location.pathname.startsWith('/datasync/tasks/')) ||
                      (USE_ANTD_IMAGE_CREATION && window.location.pathname === '/images/create') ||
                      (USE_ANTD_BUCKETS && window.location.pathname === '/buckets') ||
                      (USE_ANTD_SOFTWARE_DETAILS && window.location.pathname.startsWith('/software/'));

  // Render Ant Design pages without Cloudscape wrapper
  if (isAntdRoute) {
    return (
      <Router>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/software" element={
            <SoftwareManagementAntd 
              config={config} 
              user={user} 
              isAdmin={userIsAdmin} 
              onSignOut={handleSignOut} 
              onChangePassword={() => setShowChangePasswordModal(true)} 
            />
          } />
          <Route path="/dashboard" element={
            <DashboardAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/settings" element={
            <SettingsAntd 
              config={config}
              user={user}
              isAdmin={userIsAdmin}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/regions" element={
            <RegionManagementAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/images" element={
            <ImageManagementAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/pipelines" element={
            <PipelinesAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/workstations" element={
            <WorkstationManagementAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/users" element={
            <UserManagementAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/filesystems" element={
            <FilesystemsAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/data-transfer" element={
            <DataTransferAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/dcv" element={
            <DcvSessionsAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/workstations/:instanceId" element={
            <WorkstationDetailsAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/users/:userId" element={
            <UserDetailsAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/groups/:groupId" element={
            <GroupDetailsAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/storage/:storageId" element={
            <StorageDetailsAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/datasync/tasks/:taskId" element={
            <TaskDetailsAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/images/create" element={
            <ImageCreationAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/buckets" element={
            <BucketsAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
          <Route path="/software/:softwareId" element={
            <SoftwareDetailsAntd 
              user={user}
              isAdmin={userIsAdmin}
              config={config}
              onSignOut={handleSignOut}
              onChangePassword={() => setShowChangePasswordModal(true)}
            />
          } />
        </Routes>
      </Router>
    );
  }

  return (
    <Router>
      <TopNavigation
        identity={{
          href: '/',
          title: config?.productName || 'Media Resource Manager',
        }}
        utilities={[
          {
            type: 'button',
            text: (
              <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                <span>Dark Mode</span>
                <Toggle
                  checked={darkMode}
                  onChange={toggleDarkMode}
                />
              </SpaceBetween>
            ),
            ariaLabel: `Switch to ${darkMode ? 'light' : 'dark'} mode`,
          },
          {
            type: 'button',
            iconName: 'settings',
            onClick: () => window.location.href = '/settings',
            ariaLabel: 'Settings',
          },
          {
            type: 'menu-dropdown',
            text: user.email || user.attributes?.email || 'User',
            items: config?.useCognitoAuth 
              ? [{ id: 'signout', text: 'Sign out' }]
              : [
                  { id: 'changepassword', text: 'Change Password' },
                  { id: 'signout', text: 'Sign out' },
                ],
            onItemClick: ({ detail }) => {
              if (detail.id === 'signout') {
                handleSignOut();
              } else if (detail.id === 'changepassword') {
                setShowChangePasswordModal(true);
              }
            },
          },
        ]}
      />
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route 
          path="/dashboard" 
          element={
            <AppLayout
              navigation={<Navigation isAdmin={userIsAdmin} productName={config?.productName} acronym={config?.acronym} />}
              disableContentPaddings={true}
              toolsHide={true}
              navigationOpen={dashboardNavOpen}
              onNavigationChange={({ detail }) => setDashboardNavOpen(detail.open)}
              content={
                <ContentLayout
                  defaultPadding
                  headerVariant="high-contrast"
                  maxContentWidth={1200}
                  header={
                    <Box padding={{ vertical: "l" }}>
                      <Grid
                        gridDefinition={[
                          { colspan: { default: 12, xs: 8, s: 9 } },
                          { colspan: { default: 12, xs: 4, s: 3 } }
                        ]}
                      >
                        <div>
                          <Box variant="h1" fontSize="display-l">
                            Workstation Dashboard
                          </Box>
                          <Box
                            variant="p"
                            color="text-body-secondary"
                            margin={{ top: "xxs", bottom: "s" }}
                          >
                            {userIsAdmin 
                              ? 'Manage virtual workstations across your organization with enterprise-grade controls and real-time monitoring.' 
                              : `Welcome back, ${user.attributes?.given_name || user.firstName || user.username}. Access and control your virtual workstations with enterprise security.`}
                          </Box>
                        </div>

                        {userIsAdmin && (
                          <Box margin={{ top: "l" }}>
                            <SpaceBetween size="s">
                              <Button
                                variant="primary"
                                fullWidth={true}
                                iconName="add-plus"
                                href="/workstations?create=true"
                              >
                                Create workstation
                              </Button>
                              <Button 
                                fullWidth={true}
                                iconName="user-profile"
                                href="/users"
                              >
                                Manage users
                              </Button>
                            </SpaceBetween>
                          </Box>
                        )}
                      </Grid>
                    </Box>
                  }
                >
                  <Dashboard user={user} />
                </ContentLayout>
              }
            />
          } 
        />
        <Route path="/workstations" element={<WorkstationManagement user={user} isAdmin={userIsAdmin} config={config} />} />
        <Route path="/dcv" element={<DcvSessions user={user} isAdmin={userIsAdmin} config={config} />} />
        {userIsAdmin && (
          <Route path="/images" element={<ImageManagement config={config} />} />
        )}
        {userIsAdmin && (
          <Route path="/images/create" element={<ImageCreation />} />
        )}
        {userIsAdmin && !USE_ANTD_SOFTWARE && (
          <Route path="/software" element={<SoftwareManagement config={config} />} />
        )}
        {userIsAdmin && (
          <Route path="/users" element={<UserManagement config={config} />} />
        )}
        {userIsAdmin && (
          <Route path="/storage" element={<StorageManagement user={user} isAdmin={userIsAdmin} config={config} />} />
        )}
        {userIsAdmin && (
          <Route path="/regions" element={<RegionManagement user={user} isAdmin={userIsAdmin} config={config} />} />
        )}
        <Route 
          path="/*" 
          element={
            <AppLayout
              navigation={<Navigation isAdmin={userIsAdmin} productName={config?.productName} acronym={config?.acronym} />}
              disableContentPaddings={true}
              toolsHide={true}
              content={
                <Routes>
                  <Route path="/workstations/:instanceId" element={<WorkstationDetails />} />
                  <Route path="/users/:userId" element={<UserDetails />} />
                  <Route path="/groups/:groupId" element={<GroupDetails />} />
                  <Route path="/storage/:storageId" element={<StorageDetails />} />
                  <Route path="/datasync/tasks/:taskId" element={<TaskDetails user={user} isAdmin={userIsAdmin} />} />
                  <Route path="/software/:softwareId" element={<SoftwareDetails />} />
                </Routes>
              }
              navigationHide={false}
            />
          } 
        />
        {userIsAdmin && (
          <Route path="/settings" element={<Settings config={config} />} />
        )}
      </Routes>
      
      <Modal
        visible={showChangePasswordModal}
        onDismiss={() => {
          setShowChangePasswordModal(false);
          setChangePasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
          setChangePasswordError('');
        }}
        header="Change Password"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="link"
              onClick={() => {
                setShowChangePasswordModal(false);
                setChangePasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
                setChangePasswordError('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={changePasswordLoading}
              onClick={handleChangePassword}
              disabled={
                !changePasswordForm.currentPassword ||
                !changePasswordForm.newPassword ||
                !changePasswordForm.confirmPassword
              }
            >
              Change Password
            </Button>
          </SpaceBetween>
        }
      >
        <Form>
          <SpaceBetween size="l">
            {changePasswordError && (
              <Alert type="error" dismissible onDismiss={() => setChangePasswordError('')}>
                {changePasswordError}
              </Alert>
            )}
            
            <FormField label="Current Password">
              <Input
                type="password"
                value={changePasswordForm.currentPassword}
                onChange={({ detail }) =>
                  setChangePasswordForm(prev => ({ ...prev, currentPassword: detail.value }))
                }
                placeholder="Enter your current password"
              />
            </FormField>
            
            <FormField label="New Password">
              <Input
                type="password"
                value={changePasswordForm.newPassword}
                onChange={({ detail }) =>
                  setChangePasswordForm(prev => ({ ...prev, newPassword: detail.value }))
                }
                placeholder="Enter your new password"
              />
            </FormField>
            
            <FormField label="Confirm New Password">
              <Input
                type="password"
                value={changePasswordForm.confirmPassword}
                onChange={({ detail }) =>
                  setChangePasswordForm(prev => ({ ...prev, confirmPassword: detail.value }))
                }
                placeholder="Confirm your new password"
                invalid={
                  changePasswordForm.confirmPassword &&
                  changePasswordForm.newPassword !== changePasswordForm.confirmPassword
                }
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Modal>
    </Router>
  );
}

export default App;
