// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { Layout, Switch, Dropdown, Avatar, Space, Typography, ConfigProvider, Alert, Button } from 'antd';
import { UserOutlined, LogoutOutlined, KeyOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import NavigationAntd from './NavigationAntd';
import { getTheme } from '../theme/antdTheme';
import { useHubsNeedingUpdate } from '../utils/regionalHubUpdates';

// The hubs listed when the admin dismissed the banner. It shows again in a
// new session, or when another hub needs an update.
const HUB_UPDATE_BANNER_DISMISSED_KEY = 'mrm-hub-update-banner-dismissed';

const { Header, Content, Sider } = Layout;
const { Text } = Typography;

interface AppLayoutAntdProps {
  children: React.ReactNode;
  isAdmin: boolean;
  user: any;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const AppLayoutAntd: React.FC<AppLayoutAntdProps> = ({
  children,
  isAdmin,
  user,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  // Initialize darkMode synchronously from localStorage to prevent flash
  const [darkMode, setDarkMode] = useState(() => {
    try {
      const savedMode = localStorage.getItem('darkMode');
      return savedMode ? JSON.parse(savedMode) : false;
    } catch {
      return false;
    }
  });

  const toggleDarkMode = (checked: boolean) => {
    setDarkMode(checked);
    localStorage.setItem('darkMode', JSON.stringify(checked));
  };

  const userEmail = user?.email || user?.attributes?.email || 'User';

  const navigate = useNavigate();
  const location = useLocation();
  const hubsNeedingUpdate = useHubsNeedingUpdate(isAdmin);
  const hubUpdateSignature = hubsNeedingUpdate.map((hub) => hub.region).sort().join(',');
  const [dismissedHubUpdates, setDismissedHubUpdates] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(HUB_UPDATE_BANNER_DISMISSED_KEY);
    } catch {
      return null;
    }
  });
  const showHubUpdateBanner = isAdmin && hubsNeedingUpdate.length > 0 && dismissedHubUpdates !== hubUpdateSignature;
  const dismissHubUpdateBanner = () => {
    try {
      sessionStorage.setItem(HUB_UPDATE_BANNER_DISMISSED_KEY, hubUpdateSignature);
    } catch {
      // Dismissed for this page only.
    }
    setDismissedHubUpdates(hubUpdateSignature);
  };
  const hubUpdateMessage = hubsNeedingUpdate.length === 1
    ? `Regional hub ${hubsNeedingUpdate[0].displayName} (${hubsNeedingUpdate[0].region}) needs an update`
    : `${hubsNeedingUpdate.length} regional hubs need an update: ${hubsNeedingUpdate.map((hub) => hub.region).join(', ')}`;

  // Change Password is only meaningful when MRM owns the directory. In
  // Cognito mode the IdP owns the password; in BYO-AD (AD Connector) mode
  // the customer's AD tools own it. Only Managed AD deployments expose
  // MRM's password-change flow.
  const isConnectorMode = !config?.useCognitoAuth && config?.adMode === 'connector';
  const showChangePassword = !config?.useCognitoAuth && !isConnectorMode;

  const userMenuItems: MenuProps['items'] = [
    ...(showChangePassword ? [
      {
        key: 'changepassword',
        icon: <KeyOutlined />,
        label: 'Change Password',
        onClick: onChangePassword,
      },
      { type: 'divider' as const },
    ] : []),
    {
      key: 'signout',
      icon: <LogoutOutlined />,
      label: 'Sign out',
      onClick: onSignOut,
    },
  ];

  const content = (
    <Layout style={{ minHeight: '100vh' }}>
      {/* Top Navigation Bar */}
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          background: darkMode ? '#141414' : '#001529',
          borderBottom: darkMode ? '1px solid #303030' : 'none',
          position: 'sticky',
          top: 0,
          zIndex: 100,
        }}
      >
        {/* Logo / Product Name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Text strong style={{ color: '#fff', fontSize: '16px' }}>
            {config?.productName || 'Media Resource Manager'}
          </Text>
        </div>

        {/* Right side utilities */}
        <Space size="large">
          {/* Dark Mode Toggle */}
          <Space>
            <SunOutlined style={{ color: darkMode ? '#666' : '#ffd666' }} />
            <Switch
              checked={darkMode}
              onChange={toggleDarkMode}
              size="small"
            />
            <MoonOutlined style={{ color: darkMode ? '#1890ff' : '#666' }} />
          </Space>

          {/* User Menu */}
          <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
            <Space style={{ cursor: 'pointer', color: '#fff' }}>
              <Avatar size="small" icon={<UserOutlined />} />
              <Text style={{ color: '#fff' }}>{userEmail}</Text>
            </Space>
          </Dropdown>
        </Space>
      </Header>

      <Layout>
        {/* Sidebar Navigation */}
        <Sider
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          width={240}
          collapsedWidth={80}
          theme={darkMode ? 'dark' : 'light'}
          trigger={null}
          style={{
            background: darkMode ? '#141414' : '#fff',
            borderRight: darkMode ? '1px solid #303030' : '1px solid #f0f0f0',
            overflow: 'auto',
            height: 'calc(100vh - 64px)',
            position: 'sticky',
            top: 64,
            left: 0,
          }}
        >
          <NavigationAntd
            isAdmin={isAdmin}
            productName={config?.productName}
            acronym={config?.acronym}
            collapsed={collapsed}
            onCollapse={setCollapsed}
            regionUpdateCount={isAdmin ? hubsNeedingUpdate.length : 0}
          />
        </Sider>

        {/* Main Content */}
        <Content
          style={{
            padding: '24px',
            background: darkMode ? '#000' : '#f5f5f5',
            minHeight: 'calc(100vh - 64px)',
          }}
        >
          {showHubUpdateBanner && (
            <Alert
              type="warning"
              showIcon
              closable
              onClose={dismissHubUpdateBanner}
              style={{ marginBottom: 16 }}
              message={hubUpdateMessage}
              description="Regional hubs run their own copy of MRM's regional code, which doesn't change when MRM is upgraded. Update each hub to install the current code, including security fixes. Workstations keep running during the update."
              action={location.pathname !== '/regions' ? (
                <Button size="small" type="primary" onClick={() => navigate('/regions')}>
                  Go to Regions
                </Button>
              ) : undefined}
            />
          )}
          {children}
        </Content>
      </Layout>
    </Layout>
  );

  return (
    <ConfigProvider theme={getTheme(darkMode)}>
      {content}
    </ConfigProvider>
  );
};

export default AppLayoutAntd;
