// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ThemeConfig } from 'antd';
import { theme } from 'antd';
import { 
  createCatppuccinTheme, 
  catppuccinPresets,
  type CatppuccinFlavor,
  type CatppuccinAccent,
} from './catppuccinTheme';
import {
  createHarmonicTheme,
  harmonicPresets,
  type HarmonicPresetName,
} from './harmonicTheme';
import {
  createUnderwaterTheme,
  underwaterPresets,
  type UnderwaterPresetName,
} from './underwaterTheme';

// ============================================
// THEME SELECTION - Change this to try different themes
// 
// Standard presets: 'indigo' | 'ocean' | 'emerald' | 'violet' | 'slate' | 'rose' | 'amber' | 'cyan'
// 
// Catppuccin presets (from Obsidian themes):
//   Light: 'ctp-latte-mauve' | 'ctp-latte-blue' | 'ctp-latte-pink' | etc.
//   Dark:  'ctp-mocha-mauve' | 'ctp-mocha-blue' | 'ctp-frappe-teal' | etc.
//
// Harmonic presets (from Obsidian-Harmonic):
//   Dark:  'harmonic-tokyoNight' | 'harmonic-dracula' | 'harmonic-gotham' | 'harmonic-cobalt' | 'harmonic-deepOcean'
//   Light: 'harmonic-notion' | 'harmonic-solarized' | 'harmonic-mintPastel' | 'harmonic-writer' | etc.
//
// Underwater presets (from Underwater theme):
//   Dark:  'uw-rosePine' | 'uw-uwOcean' | 'uw-uwDeep' | 'uw-uwSeaweed' | 'uw-nordDark' | etc.
//   Light: 'uw-rosePineDawn' | 'uw-uwCoral' | 'uw-uwAqua' | 'uw-nordLight' | etc.
// ============================================
const ACTIVE_THEME: ThemePreset = 'harmonic-deepOcean';

// Catppuccin theme presets
type CatppuccinPreset = 
  | 'ctp-latte-mauve' | 'ctp-latte-blue' | 'ctp-latte-pink' | 'ctp-latte-teal' | 'ctp-latte-green' | 'ctp-latte-peach' | 'ctp-latte-sapphire' | 'ctp-latte-lavender'
  | 'ctp-frappe-mauve' | 'ctp-frappe-blue' | 'ctp-frappe-pink' | 'ctp-frappe-teal' | 'ctp-frappe-green' | 'ctp-frappe-peach' | 'ctp-frappe-sapphire' | 'ctp-frappe-lavender'
  | 'ctp-macchiato-mauve' | 'ctp-macchiato-blue' | 'ctp-macchiato-pink' | 'ctp-macchiato-teal' | 'ctp-macchiato-green' | 'ctp-macchiato-peach' | 'ctp-macchiato-sapphire' | 'ctp-macchiato-lavender'
  | 'ctp-mocha-mauve' | 'ctp-mocha-blue' | 'ctp-mocha-pink' | 'ctp-mocha-teal' | 'ctp-mocha-green' | 'ctp-mocha-peach' | 'ctp-mocha-sapphire' | 'ctp-mocha-lavender' | 'ctp-mocha-rosewater' | 'ctp-mocha-flamingo' | 'ctp-mocha-yellow' | 'ctp-mocha-sky' | 'ctp-mocha-maroon' | 'ctp-mocha-red';

// Harmonic theme presets
type HarmonicPreset = 
  | 'harmonic-tokyoNight' | 'harmonic-dracula' | 'harmonic-gotham' | 'harmonic-cobalt' | 'harmonic-deepOcean'
  | 'harmonic-notion' | 'harmonic-solarized' | 'harmonic-mintPastel' | 'harmonic-naturePastel' 
  | 'harmonic-violinePastel' | 'harmonic-zenPastel' | 'harmonic-creativeBluePastel' | 'harmonic-writer';

// Underwater theme presets
type UnderwaterPreset =
  | 'uw-rosePine' | 'uw-rosePineMoon' | 'uw-uwDeep' | 'uw-uwOcean' | 'uw-uwSeaweed' | 'uw-uwSand'
  | 'uw-nordDark' | 'uw-everforestDark' | 'uw-biscuitDark'
  | 'uw-rosePineDawn' | 'uw-nordLight' | 'uw-everforestLight'
  | 'uw-uwCoral' | 'uw-uwAqua' | 'uw-uwOctopus' | 'uw-uwOyster';

type ThemePreset = 'indigo' | 'ocean' | 'emerald' | 'violet' | 'slate' | 'rose' | 'amber' | 'cyan' | 'sapphire' | 'teal' | 'coral' | 'midnight' | CatppuccinPreset | HarmonicPreset | UnderwaterPreset;

// Standard theme presets (non-Catppuccin, non-Harmonic)
type StandardPreset = 'indigo' | 'ocean' | 'emerald' | 'violet' | 'slate' | 'rose' | 'amber' | 'cyan' | 'sapphire' | 'teal' | 'coral' | 'midnight';

interface ThemeColors {
  primary: string;
  success: string;
  warning: string;
  error: string;
  info: string;
}

const themePresets: Record<StandardPreset, ThemeColors> = {
  indigo: {
    primary: '#6366f1',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#6366f1',
  },
  ocean: {
    primary: '#0ea5e9',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#0ea5e9',
  },
  emerald: {
    primary: '#10b981',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#06b6d4',
  },
  violet: {
    primary: '#8b5cf6',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#8b5cf6',
  },
  slate: {
    primary: '#475569',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#64748b',
  },
  rose: {
    primary: '#f43f5e',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#f43f5e',
  },
  amber: {
    primary: '#f59e0b',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#f59e0b',
  },
  cyan: {
    primary: '#06b6d4',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#06b6d4',
  },
  // New options
  sapphire: {
    primary: '#2563eb',  // Rich blue - classic, trustworthy
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#3b82f6',
  },
  teal: {
    primary: '#14b8a6',  // Blue-green - balanced, calming
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#14b8a6',
  },
  coral: {
    primary: '#f97316',  // Orange - energetic but not aggressive
    success: '#10b981',
    warning: '#eab308',
    error: '#ef4444',
    info: '#f97316',
  },
  midnight: {
    primary: '#3730a3',  // Deep indigo - sophisticated, premium
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#4f46e5',
  },
};

const colors = themePresets[ACTIVE_THEME as keyof typeof themePresets] || themePresets.indigo;

// Check if using Catppuccin theme
const isCatppuccinTheme = ACTIVE_THEME.startsWith('ctp-');

// Check if using Harmonic theme
const isHarmonicTheme = ACTIVE_THEME.startsWith('harmonic-');

// Check if using Underwater theme
const isUnderwaterTheme = ACTIVE_THEME.startsWith('uw-');

// Parse Catppuccin theme preset
function parseCatppuccinPreset(preset: string): { flavor: CatppuccinFlavor; accent: CatppuccinAccent } | null {
  if (!preset.startsWith('ctp-')) return null;
  const parts = preset.replace('ctp-', '').split('-');
  if (parts.length !== 2) return null;
  return {
    flavor: parts[0] as CatppuccinFlavor,
    accent: parts[1] as CatppuccinAccent,
  };
}

// Parse Harmonic theme preset
function parseHarmonicPreset(preset: string): HarmonicPresetName | null {
  if (!preset.startsWith('harmonic-')) return null;
  const name = preset.replace('harmonic-', '') as HarmonicPresetName;
  return harmonicPresets[name] ? name : null;
}

// Parse Underwater theme preset
function parseUnderwaterPreset(preset: string): UnderwaterPresetName | null {
  if (!preset.startsWith('uw-')) return null;
  const name = preset.replace('uw-', '') as UnderwaterPresetName;
  return underwaterPresets[name] ? name : null;
}

const baseTokens = {
  colorPrimary: colors.primary,
  colorSuccess: colors.success,
  colorWarning: colors.warning,
  colorError: colors.error,
  colorInfo: colors.info,
  borderRadius: 8,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};

export const lightTheme: ThemeConfig = {
  token: {
    ...baseTokens,
    colorBgContainer: '#ffffff',
    colorBgLayout: '#f8fafc',
  },
  components: {
    Button: {
      borderRadius: 6,
      controlHeight: 36,
    },
    Input: {
      borderRadius: 6,
      controlHeight: 36,
      colorTextPlaceholder: '#9ca3af',
    },
    Select: {
      borderRadius: 6,
      controlHeight: 36,
      colorTextPlaceholder: '#9ca3af',
    },
    Table: {
      headerBg: '#f8fafc',
      headerColor: '#475569',
      rowHoverBg: '#f1f5f9',
    },
    Card: {
      borderRadiusLG: 12,
    },
    Modal: {
      borderRadiusLG: 12,
    },
    Menu: {
      itemBorderRadius: 6,
      itemMarginInline: 8,
    },
    Tooltip: {
      colorBgSpotlight: '#1f1f1f',
      colorTextLightSolid: '#ffffff',
    },
  },
};

export const darkTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    ...baseTokens,
    colorBgContainer: '#1e1e2e',
    colorBgLayout: '#11111b',
  },
  components: {
    Button: {
      borderRadius: 6,
      controlHeight: 36,
    },
    Input: {
      borderRadius: 6,
      controlHeight: 36,
      colorTextPlaceholder: '#6c7086',
    },
    Select: {
      borderRadius: 6,
      controlHeight: 36,
      colorTextPlaceholder: '#6c7086',
    },
    Table: {
      headerBg: '#1e1e2e',
      rowHoverBg: '#313244',
    },
    Card: {
      borderRadiusLG: 12,
    },
    Modal: {
      borderRadiusLG: 12,
    },
    Menu: {
      itemBorderRadius: 6,
      itemMarginInline: 8,
    },
    Tooltip: {
      colorBgSpotlight: '#45475a',
      colorTextLightSolid: '#ffffff',
    },
  },
};

export const getTheme = (isDark: boolean): ThemeConfig => {
  // If using Underwater theme
  if (isUnderwaterTheme) {
    const presetName = parseUnderwaterPreset(ACTIVE_THEME);
    if (presetName) {
      const preset = underwaterPresets[presetName];
      const isPresetDark = preset.mode === 'dark';
      
      if (isDark === isPresetDark) {
        return createUnderwaterTheme(presetName);
      } else {
        // Switch to a similar preset in the opposite mode
        const fallback: UnderwaterPresetName = isDark ? 'rosePine' : 'rosePineDawn';
        return createUnderwaterTheme(fallback);
      }
    }
  }
  
  // If using Harmonic theme
  if (isHarmonicTheme) {
    const presetName = parseHarmonicPreset(ACTIVE_THEME);
    if (presetName) {
      const preset = harmonicPresets[presetName];
      const isPresetDark = preset.mode === 'dark';
      
      // If user preference matches preset's mode, use as-is
      if (isDark === isPresetDark) {
        return createHarmonicTheme(presetName);
      } else {
        // Switch to a similar preset in the opposite mode
        // Default fallbacks: notion for light, tokyoNight for dark
        const fallback: HarmonicPresetName = isDark ? 'tokyoNight' : 'notion';
        return createHarmonicTheme(fallback);
      }
    }
  }
  
  // If using Catppuccin theme, use the Catppuccin theme generator
  if (isCatppuccinTheme) {
    const parsed = parseCatppuccinPreset(ACTIVE_THEME);
    if (parsed) {
      // For Catppuccin, we respect the flavor's inherent light/dark nature
      // but allow override if user explicitly wants light/dark
      const flavor = parsed.flavor;
      const isFlavorDark = flavor !== 'latte';
      
      // If user preference matches flavor's nature, use as-is
      // Otherwise, switch to appropriate flavor
      if (isDark === isFlavorDark) {
        return createCatppuccinTheme(parsed);
      } else {
        // User wants opposite mode - switch flavor but keep accent
        const newFlavor: CatppuccinFlavor = isDark ? 'mocha' : 'latte';
        return createCatppuccinTheme({ flavor: newFlavor, accent: parsed.accent });
      }
    }
  }
  
  return isDark ? darkTheme : lightTheme;
};

// Export for reference
export const activeThemeName = ACTIVE_THEME;
export const availableThemes = [
  ...Object.keys(themePresets),
  // Catppuccin themes
  'ctp-latte-mauve', 'ctp-latte-blue', 'ctp-latte-pink', 'ctp-latte-teal', 'ctp-latte-green', 'ctp-latte-peach', 'ctp-latte-sapphire', 'ctp-latte-lavender',
  'ctp-frappe-mauve', 'ctp-frappe-blue', 'ctp-frappe-pink', 'ctp-frappe-teal', 'ctp-frappe-green', 'ctp-frappe-peach', 'ctp-frappe-sapphire', 'ctp-frappe-lavender',
  'ctp-macchiato-mauve', 'ctp-macchiato-blue', 'ctp-macchiato-pink', 'ctp-macchiato-teal', 'ctp-macchiato-green', 'ctp-macchiato-peach', 'ctp-macchiato-sapphire', 'ctp-macchiato-lavender',
  'ctp-mocha-mauve', 'ctp-mocha-blue', 'ctp-mocha-pink', 'ctp-mocha-teal', 'ctp-mocha-green', 'ctp-mocha-peach', 'ctp-mocha-sapphire', 'ctp-mocha-lavender', 'ctp-mocha-rosewater', 'ctp-mocha-flamingo', 'ctp-mocha-yellow', 'ctp-mocha-sky', 'ctp-mocha-maroon', 'ctp-mocha-red',
  // Harmonic themes
  'harmonic-tokyoNight', 'harmonic-dracula', 'harmonic-gotham', 'harmonic-cobalt', 'harmonic-deepOcean',
  'harmonic-notion', 'harmonic-solarized', 'harmonic-mintPastel', 'harmonic-naturePastel', 
  'harmonic-violinePastel', 'harmonic-zenPastel', 'harmonic-creativeBluePastel', 'harmonic-writer',
  // Underwater themes
  'uw-rosePine', 'uw-rosePineMoon', 'uw-uwDeep', 'uw-uwOcean', 'uw-uwSeaweed', 'uw-uwSand',
  'uw-nordDark', 'uw-everforestDark', 'uw-biscuitDark',
  'uw-rosePineDawn', 'uw-nordLight', 'uw-everforestLight',
  'uw-uwCoral', 'uw-uwAqua', 'uw-uwOctopus', 'uw-uwOyster',
] as const;

// Re-export Catppuccin utilities for direct use
export { 
  createCatppuccinTheme, 
  catppuccin, 
  catppuccinPresets,
  getStatusColors,
  getTagColors,
  getCatppuccinCSSVariables,
  applyCatppuccinCSSVariables,
  flavorOptions,
  accentOptions,
  flavorLabels,
  accentLabels,
} from './catppuccinTheme';
export type { CatppuccinFlavor, CatppuccinAccent, CatppuccinThemeConfig } from './catppuccinTheme';

// Re-export Harmonic utilities
export {
  createHarmonicTheme,
  harmonicPresets,
  harmonicPresetNames,
  harmonicDarkPresets,
  harmonicLightPresets,
  harmonicLabels,
} from './harmonicTheme';
export type { HarmonicPresetName, HarmonicPreset } from './harmonicTheme';

// Re-export Underwater utilities
export {
  createUnderwaterTheme,
  underwaterPresets,
  underwaterPresetNames,
  underwaterDarkPresets,
  underwaterLightPresets,
  underwaterLabels,
} from './underwaterTheme';
export type { UnderwaterPresetName, UnderwaterPreset } from './underwaterTheme';
