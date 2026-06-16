// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { SideNavigation, Box } from '@cloudscape-design/components';
import { useNavigate, useLocation } from 'react-router-dom';

declare const __APP_VERSION__: string;

interface NavigationProps {
  isAdmin: boolean;
  productName?: string;
  acronym?: string;
}

const Navigation: React.FC<NavigationProps> = ({ isAdmin, productName, acronym }) => {
  const navigate = useNavigate();
  const location = useLocation();

  const items = [
    {
      type: 'link' as const,
      text: 'Dashboard',
      href: '/dashboard',
    },
    {
      type: 'divider' as const,
    },
    {
      type: 'link' as const,
      text: 'Workstations',
      href: '/workstations',
    },
  ];

  if (isAdmin) {
    items.push({
      type: 'link' as const,
      text: 'Users / Groups',
      href: '/users',
    });
    items.push({
      type: 'link-group' as const,
      text: 'Images',
      href: '/images',
      items: [
        {
          type: 'link' as const,
          text: 'Software',
          href: '/software',
        },
      ],
    });
    items.push({
      type: 'link' as const,
      text: 'Storage',
      href: '/storage',
    });
    items.push({
      type: 'link' as const,
      text: 'Regions',
      href: '/regions',
    });
    items.push({
      type: 'divider' as const,
    });
    items.push({
      type: 'link' as const,
      text: 'DCV',
      href: '/dcv',
    });
    items.push({
      type: 'link' as const,
      text: 'Settings',
      href: '/settings',
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
        <SideNavigation
          activeHref={location.pathname}
          header={{ text: acronym ? `AWS ${acronym}` : (productName || 'Media Resource Manager'), href: '/' }}
          items={items}
          onFollow={(event) => {
            if (!event.detail.external) {
              event.preventDefault();
              navigate(event.detail.href);
            }
          }}
        />
      </div>
      <Box
        padding={{ horizontal: 'l', vertical: 's' }}
        fontSize="body-s"
        className="awsui-util-font-size-body-s"
      >
        <span style={{ color: 'var(--color-text-status-inactive)' }}>v{__APP_VERSION__}</span>
      </Box>
    </div>
  );
};

export default Navigation;
