// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { Layout, Switch, Dropdown, Avatar, Space, Typography, ConfigProvider } from 'antd';
import { UserOutlined, LogoutOutlined, KeyOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import NavigationAntd from './NavigationAntd';
import { getTheme } from '../theme/antdTheme';

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

  const userMenuItems: MenuProps['items'] = [
    ...(config?.useCognitoAuth ? [] : [
      {
        key: 'changepassword',
        icon: <KeyOutlined />,
        label: 'Change Password',
        onClick: onChangePassword,
      },
      { type: 'divider' as const },
    ]),
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
