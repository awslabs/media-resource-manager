// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Menu, Typography, Button } from 'antd';
import {
  DashboardOutlined,
  DesktopOutlined,
  TeamOutlined,
  PictureOutlined,
  DatabaseOutlined,
  GlobalOutlined,
  VideoCameraOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  HddOutlined,
  SwapOutlined,
  BuildOutlined,
  CodeOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import type { MenuProps } from 'antd';

const { Text } = Typography;

declare const __APP_VERSION__: string;

interface NavigationProps {
  isAdmin: boolean;
  productName?: string;
  acronym?: string;
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
}

type MenuItem = Required<MenuProps>['items'][number];

const NavigationAntd: React.FC<NavigationProps> = ({ isAdmin, productName, acronym, collapsed, onCollapse }) => {
  const navigate = useNavigate();
  const location = useLocation();

  const items: MenuItem[] = [
    {
      key: '/dashboard',
      icon: <DashboardOutlined />,
      label: 'Dashboard',
    },
    {
      key: '/workstations',
      icon: <DesktopOutlined />,
      label: 'Workstations',
    },
  ];

  if (isAdmin) {
    items.push(
      {
        key: '/users',
        icon: <TeamOutlined />,
        label: 'Users / Groups',
      },
      {
        key: 'image-builder',
        icon: <PictureOutlined />,
        label: 'Image Builder',
        children: [
          {
            key: '/images',
            icon: <PictureOutlined />,
            label: 'Images',
          },
          {
            key: '/pipelines',
            icon: <BuildOutlined />,
            label: 'Pipelines',
          },
          {
            key: '/software',
            icon: <CodeOutlined />,
            label: 'Software',
          },
        ],
      },
      {
        key: 'storage',
        icon: <DatabaseOutlined />,
        label: 'Storage',
        children: [
          {
            key: '/buckets',
            icon: <InboxOutlined />,
            label: 'Buckets',
          },
          {
            key: '/filesystems',
            icon: <HddOutlined />,
            label: 'Filesystems',
          },
          {
            key: '/data-transfer',
            icon: <SwapOutlined />,
            label: 'Data Transfer',
          },
        ],
      },
      { type: 'divider' },
      {
        key: '/regions',
        icon: <GlobalOutlined />,
        label: 'Regions',
      },
      {
        key: '/dcv',
        icon: <VideoCameraOutlined />,
        label: 'DCV',
      },
      {
        key: '/settings',
        icon: <SettingOutlined />,
        label: 'Settings',
      }
    );
  }

  const handleClick: MenuProps['onClick'] = (e) => {
    navigate(e.key);
  };

  // Determine selected key based on current path
  const selectedKey = location.pathname;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Logo/Title */}
      <div style={{ 
        padding: collapsed ? '16px 8px' : '16px', 
        textAlign: collapsed ? 'center' : 'left',
        borderBottom: '1px solid rgba(0,0,0,0.06)'
      }}>
        <Text strong style={{ fontSize: collapsed ? '12px' : '14px' }}>
          {collapsed ? (acronym || 'MRM') : (acronym ? `AWS ${acronym}` : (productName || 'Media Resource Manager'))}
        </Text>
      </div>

      {/* Menu */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          defaultOpenKeys={isAdmin ? ['image-builder', 'storage'] : []}
          items={items}
          onClick={handleClick}
          style={{ borderRight: 0 }}
          inlineCollapsed={collapsed}
        />
      </div>

      {/* Footer with version and collapse button */}
      <div style={{ 
        padding: '12px', 
        borderTop: '1px solid rgba(0,0,0,0.06)',
        display: 'flex',
        justifyContent: collapsed ? 'center' : 'space-between',
        alignItems: 'center'
      }}>
        {!collapsed && (
          <Text type="secondary" style={{ fontSize: '12px' }}>
            v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'}
          </Text>
        )}
        {onCollapse && (
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => onCollapse(!collapsed)}
            style={{ fontSize: '16px' }}
          />
        )}
      </div>
    </div>
  );
};

export default NavigationAntd;
