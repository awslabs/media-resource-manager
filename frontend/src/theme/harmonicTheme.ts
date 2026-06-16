// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ThemeConfig } from 'antd';
import { theme } from 'antd';

/**
 * Harmonic Theme for Ant Design
 * 
 * Adapted from Obsidian-Harmonic theme (https://github.com/Thiews/Obsidian-Harmonic)
 * 
 * Features curated color presets including:
 * - Tokyo Night, Dracula, Gotham, Cobalt (dark)
 * - Notion, Solarized, Mint Pastel (light)
 * - Deep Ocean, Blue Lagoon (dark)
 */

// ============================================
// HARMONIC COLOR PRESETS
// ============================================

export interface HarmonicPreset {
  name: string;
  mode: 'light' | 'dark';
  accent: string;
  colors: {
    base: string;
    mantle: string;
    surface: string;
    text: string;
    textMuted: string;
    textFaint: string;
    // Optional overrides
    heading?: string;
    link?: string;
    tag?: string;
    tagBg?: string;
    success?: string;
    warning?: string;
    error?: string;
    border?: string;
  };
}

export const harmonicPresets: Record<string, HarmonicPreset> = {
  // Dark themes
  tokyoNight: {
    name: 'Tokyo Night',
    mode: 'dark',
    accent: '#62AD70',
    colors: {
      base: '#1D2139',
      mantle: '#131627',
      surface: '#252942',
      text: '#CDCDCD',
      textMuted: '#9A9A9A',
      textFaint: '#6A6A6A',
      heading: '#DF9215',
      link: '#62AD70',
      tag: '#62AD70',
    },
  },

  dracula: {
    name: 'Dracula',
    mode: 'dark',
    accent: '#46C5E2',
    colors: {
      base: '#282a36',
      mantle: '#1e1f29',
      surface: '#343746',
      text: '#f8f8f2',
      textMuted: '#bfbfbf',
      textFaint: '#6272a4',
      heading: '#07DF90',
      link: '#46C5E2',
      success: '#50fa7b',
      warning: '#f1fa8c',
      error: '#ff5555',
    },
  },
  gotham: {
    name: 'Gotham',
    mode: 'dark',
    accent: '#2DB08C',
    colors: {
      base: '#11161C',
      mantle: '#0E141A',
      surface: '#1a2129',
      text: '#67A5A4',
      textMuted: '#4d8584',
      textFaint: '#3a6565',
      heading: '#ABABAB',
      link: '#FF9546',
      tag: '#FF9546',
    },
  },
  cobalt: {
    name: 'Cobalt',
    mode: 'dark',
    accent: '#0BA577',
    colors: {
      base: '#0C1E30',
      mantle: '#0B1C2D',
      surface: '#143050',
      text: '#FFFFFF',
      textMuted: '#B0C4DE',
      textFaint: '#6B8BA8',
      heading: '#EBCB17',
      link: '#0BA577',
      tag: '#FFFFFF',
      tagBg: '#2367AE',
    },
  },
  deepOcean: {
    name: 'Deep Ocean',
    mode: 'dark',
    accent: '#5CCFE6',
    colors: {
      base: '#0a0e14',
      mantle: '#060a0f',
      surface: '#1a2230',
      text: '#c5c8c6',
      textMuted: '#9a9d9b',
      textFaint: '#7a7d7b',
      link: '#5CCFE6',
      border: '#3d4f5f',
    },
  },

  // Light themes
  notion: {
    name: 'Notion',
    mode: 'light',
    accent: '#2383E2',
    colors: {
      base: '#FFFFFF',
      mantle: '#FAFAFA',
      surface: '#F5F5F5',
      text: '#37352F',
      textMuted: '#747474',
      textFaint: '#9B9A97',
      heading: '#37352F',
      link: '#2383E2',
      border: '#d1d5db',
    },
  },
  solarized: {
    name: 'Solarized',
    mode: 'light',
    accent: '#D2A83F',
    colors: {
      base: '#FDF6E3',
      mantle: '#EEE8D5',
      surface: '#E4DDCA',
      text: '#657B83',
      textMuted: '#839496',
      textFaint: '#93A1A1',
      heading: '#B58900',
      link: '#268BD2',
      success: '#859900',
      warning: '#B58900',
      error: '#DC322F',
      border: '#c9c2b0',
    },
  },
  mintPastel: {
    name: 'Mint Pastel',
    mode: 'light',
    accent: '#48B380',
    colors: {
      base: '#F5FAF7',
      mantle: '#E8F4EC',
      surface: '#DCF0E3',
      text: '#2D4A3E',
      textMuted: '#5A7A6A',
      textFaint: '#8AAA9A',
      link: '#48B380',
      border: '#b8d4c5',
    },
  },
  naturePastel: {
    name: 'Nature Pastel',
    mode: 'light',
    accent: '#7BA05B',
    colors: {
      base: '#FAFAF5',
      mantle: '#F0F0E8',
      surface: '#E5E5D8',
      text: '#4A4A3A',
      textMuted: '#7A7A6A',
      textFaint: '#9A9A8A',
      link: '#7BA05B',
      border: '#c5c5b5',
    },
  },

  violinePastel: {
    name: 'Violine Pastel',
    mode: 'light',
    accent: '#9B7BB8',
    colors: {
      base: '#FAF8FC',
      mantle: '#F2EEF6',
      surface: '#E8E2F0',
      text: '#4A3A5A',
      textMuted: '#7A6A8A',
      textFaint: '#9A8AAA',
      link: '#9B7BB8',
      border: '#cdc5d8',
    },
  },
  zenPastel: {
    name: 'Zen Pastel',
    mode: 'light',
    accent: '#8B9DC3',
    colors: {
      base: '#F8F9FC',
      mantle: '#EEF1F7',
      surface: '#E2E7F0',
      text: '#3A4A5A',
      textMuted: '#6A7A8A',
      textFaint: '#9AAABA',
      link: '#8B9DC3',
      border: '#c5cdd8',
    },
  },
  creativeBluePastel: {
    name: 'Creative Blue',
    mode: 'light',
    accent: '#4A90D9',
    colors: {
      base: '#F5F9FC',
      mantle: '#E8F0F7',
      surface: '#D8E8F2',
      text: '#2A4A6A',
      textMuted: '#5A7A9A',
      textFaint: '#8AAABA',
      link: '#4A90D9',
      border: '#b8cce0',
    },
  },
  writer: {
    name: 'Writer',
    mode: 'light',
    accent: '#333333',
    colors: {
      base: '#FFFFFF',
      mantle: '#F8F8F8',
      surface: '#F0F0F0',
      text: '#1A1A1A',
      textMuted: '#666666',
      textFaint: '#999999',
      border: '#d0d0d0',
    },
  },
};

export type HarmonicPresetName = keyof typeof harmonicPresets;


// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Determines if a hex color is "light" (would need dark text for contrast)
 * Uses relative luminance calculation
 */
function isLightAccent(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  
  // Calculate relative luminance
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  
  // If luminance > 0.5, it's a light color
  return luminance > 0.5;
}


// ============================================
// THEME GENERATOR
// ============================================

export function createHarmonicTheme(presetName: HarmonicPresetName): ThemeConfig {
  const preset = harmonicPresets[presetName];
  const { mode, accent, colors } = preset;
  const isDark = mode === 'dark';

  // Default semantic colors
  const success = colors.success || (isDark ? '#52c41a' : '#389e0d');
  const warning = colors.warning || (isDark ? '#faad14' : '#d48806');
  const error = colors.error || (isDark ? '#ff4d4f' : '#cf1322');

  const baseTokens = {
    colorPrimary: accent,
    colorInfo: accent,
    colorSuccess: success,
    colorWarning: warning,
    colorError: error,
    
    colorText: colors.text,
    colorTextSecondary: colors.textMuted,
    colorTextTertiary: colors.textFaint,
    
    colorBgContainer: colors.base,
    colorBgElevated: colors.mantle,
    colorBgLayout: isDark ? colors.mantle : colors.base,
    colorBgSpotlight: colors.surface,
    
    colorBorder: colors.border || colors.surface,
    colorBorderSecondary: colors.border 
      ? `${colors.border}cc`
      : isDark 
        ? `${colors.surface}80` 
        : `${colors.textFaint}40`,
    
    colorFill: colors.surface,
    colorFillSecondary: isDark 
      ? `${colors.surface}80` 
      : `${colors.surface}`,
    
    colorLink: colors.link || accent,
    colorLinkHover: accent,
    
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
  };


  const componentTokens = {
    Button: {
      borderRadius: 6,
      controlHeight: 36,
      primaryShadow: 'none',
      defaultShadow: 'none',
      // Ensure readable text on primary buttons - use dark text for light accent colors
      primaryColor: isDark && isLightAccent(accent) ? '#0a0e14' : '#ffffff',
    },
    Input: {
      borderRadius: 6,
      controlHeight: 36,
      colorBorder: colors.border || colors.surface,
      activeBorderColor: accent,
      hoverBorderColor: colors.textFaint,
      colorTextPlaceholder: colors.textFaint,
    },
    Select: {
      borderRadius: 6,
      controlHeight: 36,
      optionSelectedBg: colors.surface,
      colorBorder: colors.border || colors.surface,
      colorTextPlaceholder: colors.textFaint,
    },
    Table: {
      headerBg: colors.mantle,
      headerColor: colors.text,
      headerSortActiveBg: colors.surface, // Only darken header when sorted
      headerSortHoverBg: colors.surface,
      rowHoverBg: colors.surface,
      borderColor: colors.border || colors.surface,
      bodySortBg: 'transparent', // Don't highlight entire sorted column
      fixedHeaderSortActiveBg: colors.surface,
      cellPaddingBlock: 12,
      cellPaddingInline: 16,
    },
    Checkbox: {
      colorBorder: colors.textMuted, // More visible border
      colorBgContainer: colors.base,
      borderRadiusSM: 4,
    },
    Card: {
      borderRadiusLG: 12,
      colorBgContainer: colors.base, // Keep original base color for cards
      colorBorderSecondary: colors.border || colors.surface,
      boxShadowTertiary: isDark 
        ? '0 2px 8px 0 rgba(0, 0, 0, 0.3)' // Subtle shadow in dark mode
        : '0 1px 2px 0 rgba(0, 0, 0, 0.06)',
      actionsLiMargin: '8px 0',
      extraColor: colors.textMuted,
    },
    Modal: {
      borderRadiusLG: 12,
      contentBg: colors.base,
      headerBg: colors.base,
    },
    Menu: {
      itemBorderRadius: 6,
      itemSelectedBg: colors.surface,
      itemSelectedColor: accent,
      itemHoverBg: colors.surface,
      subMenuItemBg: colors.mantle,
    },
    Tag: {
      borderRadiusSM: 4,
      defaultBg: colors.tagBg || (isDark ? 'rgba(255, 255, 255, 0.08)' : colors.surface), // Subtle light overlay in dark mode
      defaultColor: colors.tag || colors.text,
      colorBorder: isDark ? colors.border || colors.surface : 'transparent', // Visible border in dark mode
      // Colored tag backgrounds - softer pastels for light mode, semi-transparent for dark mode
      colorSuccessBg: isDark ? 'rgba(82, 196, 26, 0.2)' : '#e6f7e6',
      colorSuccessBorder: isDark ? 'rgba(82, 196, 26, 0.4)' : '#b7eb8f',
      colorWarningBg: isDark ? 'rgba(250, 173, 20, 0.2)' : '#fff7e6',
      colorWarningBorder: isDark ? 'rgba(250, 173, 20, 0.4)' : '#ffd591',
      colorErrorBg: isDark ? 'rgba(255, 77, 79, 0.2)' : '#fff1f0',
      colorErrorBorder: isDark ? 'rgba(255, 77, 79, 0.4)' : '#ffa39e',
      colorInfoBg: isDark ? 'rgba(92, 207, 230, 0.2)' : '#e6f7ff',
      colorInfoBorder: isDark ? 'rgba(92, 207, 230, 0.4)' : '#91d5ff',
    },
    Tabs: {
      itemSelectedColor: accent,
      inkBarColor: accent,
    },
    Breadcrumb: {
      itemColor: colors.textFaint,
      lastItemColor: colors.text,
      linkColor: colors.textMuted,
      linkHoverColor: accent,
    },
    Layout: {
      bodyBg: isDark ? colors.mantle : colors.base,
      headerBg: colors.mantle,
      siderBg: colors.mantle,
    },
    Tooltip: {
      colorBgSpotlight: isDark ? '#3d4f5f' : '#1f1f1f',
      colorTextLightSolid: isDark ? '#ffffff' : '#ffffff',
    },
  };

  return {
    algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: baseTokens,
    components: componentTokens,
  };
}


// ============================================
// EXPORTS
// ============================================

export const harmonicPresetNames = Object.keys(harmonicPresets) as HarmonicPresetName[];

export const harmonicDarkPresets = harmonicPresetNames.filter(
  name => harmonicPresets[name].mode === 'dark'
);

export const harmonicLightPresets = harmonicPresetNames.filter(
  name => harmonicPresets[name].mode === 'light'
);

// Human-readable labels
export const harmonicLabels: Record<HarmonicPresetName, string> = {
  tokyoNight: 'Tokyo Night',
  dracula: 'Dracula',
  gotham: 'Gotham',
  cobalt: 'Cobalt',
  deepOcean: 'Deep Ocean',
  notion: 'Notion',
  solarized: 'Solarized',
  mintPastel: 'Mint Pastel',
  naturePastel: 'Nature Pastel',
  violinePastel: 'Violine Pastel',
  zenPastel: 'Zen Pastel',
  creativeBluePastel: 'Creative Blue',
  writer: 'Writer',
};

export default createHarmonicTheme;
