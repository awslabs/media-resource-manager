// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ThemeConfig } from 'antd';
import { theme } from 'antd';

/**
 * Catppuccin Theme for Ant Design
 * 
 * Adapted from the Catppuccin color palette (https://github.com/catppuccin/catppuccin)
 * and AnuPpuccin Obsidian theme (https://github.com/AnubisNekhet/AnuPpuccin)
 * 
 * Four flavors available:
 * - Latte: Light theme with warm tones
 * - Frappé: Medium-dark theme, softer contrast
 * - Macchiato: Dark theme, balanced
 * - Mocha: Darkest theme, high contrast
 */

// ============================================
// CATPPUCCIN COLOR PALETTES
// ============================================

export const catppuccin = {
  latte: {
    // Accent colors
    rosewater: '#dc8a78',
    flamingo: '#dd7878',
    pink: '#ea76cb',
    mauve: '#8839ef',
    red: '#d20f39',
    maroon: '#e64553',
    peach: '#fe640b',
    yellow: '#df8e1d',
    green: '#40a02b',
    teal: '#179299',
    sky: '#04a5e5',
    sapphire: '#209fb5',
    blue: '#1e66f5',
    lavender: '#7287fd',
    // Monochrome
    text: '#4c4f69',
    subtext1: '#5c5f77',
    subtext0: '#6c6f85',
    overlay2: '#7c7f93',
    overlay1: '#8c8fa1',
    overlay0: '#9ca0b0',
    surface2: '#acb0be',
    surface1: '#bcc0cc',
    surface0: '#ccd0da',
    base: '#eff1f5',
    mantle: '#e6e9ef',
    crust: '#dce0e8',
  },
  frappe: {
    // Accent colors
    rosewater: '#f2d5cf',
    flamingo: '#eebebe',
    pink: '#f4b8e4',
    mauve: '#ca9ee6',
    red: '#e78284',
    maroon: '#ea999c',
    peach: '#ef9f76',
    yellow: '#e5c890',
    green: '#a6d189',
    teal: '#81c8be',
    sky: '#99d1db',
    sapphire: '#85c1dc',
    blue: '#8caaee',
    lavender: '#babbf1',
    // Monochrome
    text: '#c6d0f5',
    subtext1: '#b5bfe2',
    subtext0: '#a5adce',
    overlay2: '#949cbb',
    overlay1: '#838ba7',
    overlay0: '#737994',
    surface2: '#626880',
    surface1: '#51576d',
    surface0: '#414559',
    base: '#303446',
    mantle: '#292c3c',
    crust: '#232634',
  },
  macchiato: {
    // Accent colors
    rosewater: '#f4dbd6',
    flamingo: '#f0c6c6',
    pink: '#f5bde6',
    mauve: '#c6a0f6',
    red: '#ed8796',
    maroon: '#ee99a0',
    peach: '#f5a97f',
    yellow: '#eed49f',
    green: '#a6da95',
    teal: '#8bd5ca',
    sky: '#91d7e3',
    sapphire: '#7dc4e4',
    blue: '#8aadf4',
    lavender: '#b7bdf8',
    // Monochrome
    text: '#cad3f5',
    subtext1: '#b8c0e0',
    subtext0: '#a5adcb',
    overlay2: '#939ab7',
    overlay1: '#8087a2',
    overlay0: '#6e738d',
    surface2: '#5b6078',
    surface1: '#494d64',
    surface0: '#363a4f',
    base: '#24273a',
    mantle: '#1e2030',
    crust: '#181926',
  },
  mocha: {
    // Accent colors
    rosewater: '#f5e0dc',
    flamingo: '#f2cdcd',
    pink: '#f5c2e7',
    mauve: '#cba6f7',
    red: '#f38ba8',
    maroon: '#eba0ac',
    peach: '#fab387',
    yellow: '#f9e2af',
    green: '#a6e3a1',
    teal: '#94e2d5',
    sky: '#89dceb',
    sapphire: '#74c7ec',
    blue: '#89b4fa',
    lavender: '#b4befe',
    // Monochrome
    text: '#cdd6f4',
    subtext1: '#bac2de',
    subtext0: '#a6adc8',
    overlay2: '#9399b2',
    overlay1: '#7f849c',
    overlay0: '#6c7086',
    surface2: '#585b70',
    surface1: '#45475a',
    surface0: '#313244',
    base: '#1e1e2e',
    mantle: '#181825',
    crust: '#11111b',
  },
} as const;

export type CatppuccinFlavor = keyof typeof catppuccin;
export type CatppuccinAccent = 'rosewater' | 'flamingo' | 'pink' | 'mauve' | 'red' | 'maroon' | 'peach' | 'yellow' | 'green' | 'teal' | 'sky' | 'sapphire' | 'blue' | 'lavender';

// ============================================
// THEME CONFIGURATION
// ============================================

export interface CatppuccinThemeConfig {
  flavor: CatppuccinFlavor;
  accent: CatppuccinAccent;
}

// Default configuration
export const defaultCatppuccinConfig: CatppuccinThemeConfig = {
  flavor: 'mocha',
  accent: 'mauve',
};


// ============================================
// THEME GENERATOR FUNCTIONS
// ============================================

/**
 * Creates an Ant Design theme configuration from Catppuccin colors
 */
export function createCatppuccinTheme(config: CatppuccinThemeConfig = defaultCatppuccinConfig): ThemeConfig {
  const { flavor, accent } = config;
  const colors = catppuccin[flavor];
  const isDark = flavor !== 'latte';

  const baseTokens = {
    // Primary accent color
    colorPrimary: colors[accent],
    colorInfo: colors[accent],
    
    // Semantic colors
    colorSuccess: colors.green,
    colorWarning: colors.yellow,
    colorError: colors.red,
    
    // Text colors
    colorText: colors.text,
    colorTextSecondary: colors.subtext1,
    colorTextTertiary: colors.subtext0,
    colorTextQuaternary: colors.overlay2,
    
    // Background colors
    colorBgContainer: colors.base,
    colorBgElevated: colors.mantle,
    colorBgLayout: colors.crust,
    colorBgSpotlight: colors.surface0,
    
    // Border colors
    colorBorder: colors.surface1,
    colorBorderSecondary: colors.surface0,
    
    // Fill colors
    colorFill: colors.surface0,
    colorFillSecondary: colors.surface1,
    colorFillTertiary: colors.surface2,
    colorFillQuaternary: colors.overlay0,
    
    // Link color
    colorLink: colors[accent],
    colorLinkHover: colors.sky,
    colorLinkActive: colors.sapphire,
    
    // Typography
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    
    // Border radius (matching AnuPpuccin's rounded aesthetic)
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
    borderRadiusXS: 4,
  };

  const componentTokens = {
    Button: {
      borderRadius: 6,
      controlHeight: 36,
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
    },
    Input: {
      borderRadius: 6,
      controlHeight: 36,
      activeBorderColor: colors[accent],
      hoverBorderColor: colors.overlay1,
      colorTextPlaceholder: colors.overlay1,
    },
    Select: {
      borderRadius: 6,
      controlHeight: 36,
      optionSelectedBg: colors.surface0,
      colorTextPlaceholder: colors.overlay1,
    },
    Table: {
      headerBg: colors.mantle,
      headerColor: colors.text,
      headerSortActiveBg: colors.surface0,
      headerSortHoverBg: colors.surface0,
      rowHoverBg: colors.surface0,
      borderColor: colors.surface1,
      headerSplitColor: colors.surface1,
      bodySortBg: 'transparent', // Don't highlight entire sorted column
      fixedHeaderSortActiveBg: colors.surface0,
    },
    Card: {
      borderRadiusLG: 12,
      colorBgContainer: colors.base,
      colorBorderSecondary: colors.surface1,
    },
    Modal: {
      borderRadiusLG: 12,
      contentBg: colors.base,
      headerBg: colors.base,
      footerBg: colors.base,
    },
    Menu: {
      itemBorderRadius: 6,
      itemMarginInline: 8,
      itemSelectedBg: colors.surface0,
      itemSelectedColor: colors[accent],
      itemHoverBg: colors.surface0,
      itemActiveBg: colors.surface1,
      subMenuItemBg: colors.mantle,
    },
    Dropdown: {
      borderRadiusLG: 8,
      controlItemBgHover: colors.surface0,
      controlItemBgActive: colors.surface1,
    },
    Tag: {
      borderRadiusSM: 4,
    },
    Alert: {
      borderRadiusLG: 8,
    },
    Tooltip: {
      borderRadius: 6,
      colorBgSpotlight: isDark ? colors.surface1 : '#1f1f1f',
      colorTextLightSolid: isDark ? colors.text : '#ffffff',
    },
    Popover: {
      borderRadiusLG: 8,
    },
    Tabs: {
      itemSelectedColor: colors[accent],
      itemHoverColor: colors.subtext0,
      inkBarColor: colors[accent],
    },
    Switch: {
      colorPrimary: colors[accent],
      colorPrimaryHover: colors.lavender,
    },
    Checkbox: {
      colorPrimary: colors[accent],
      colorPrimaryHover: colors.lavender,
      colorBorder: colors.overlay1, // More visible border
      colorBgContainer: colors.base,
      borderRadiusSM: 4,
    },
    Radio: {
      colorPrimary: colors[accent],
      colorPrimaryHover: colors.lavender,
    },
    Slider: {
      trackBg: colors.surface2,
      trackHoverBg: colors.overlay0,
      handleColor: colors[accent],
      handleActiveColor: colors.lavender,
      dotActiveBorderColor: colors[accent],
    },
    Progress: {
      defaultColor: colors[accent],
    },
    Spin: {
      colorPrimary: colors[accent],
    },
    Badge: {
      colorBgContainer: colors.red,
    },
    Breadcrumb: {
      itemColor: colors.subtext0,
      lastItemColor: colors.text,
      linkColor: colors.subtext1,
      linkHoverColor: colors[accent],
      separatorColor: colors.overlay0,
    },
    Pagination: {
      itemActiveBg: colors.surface0,
      itemBg: 'transparent',
    },
    Steps: {
      colorPrimary: colors[accent],
    },
    Timeline: {
      dotBg: colors[accent],
    },
    Tree: {
      nodeSelectedBg: colors.surface0,
      nodeHoverBg: colors.surface0,
    },
    Collapse: {
      headerBg: colors.mantle,
      contentBg: colors.base,
    },
    Descriptions: {
      labelBg: colors.mantle,
    },
    Divider: {
      colorSplit: colors.surface1,
    },
    Drawer: {
      colorBgElevated: colors.base,
    },
    Form: {
      labelColor: colors.text,
    },
    Layout: {
      bodyBg: colors.crust,
      headerBg: colors.mantle,
      siderBg: colors.mantle,
      triggerBg: colors.surface0,
    },
    List: {
      colorSplit: colors.surface1,
    },
    Message: {
      contentBg: colors.surface0,
    },
    Notification: {
      colorBgElevated: colors.base,
    },
    Result: {
      colorSuccess: colors.green,
      colorError: colors.red,
      colorWarning: colors.yellow,
      colorInfo: colors[accent],
    },
    Skeleton: {
      color: colors.surface1,
      colorGradientEnd: colors.surface2,
    },
    Statistic: {
      contentFontSize: 24,
    },
  };

  return {
    algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: baseTokens,
    components: componentTokens,
  };
}


// ============================================
// PRE-BUILT THEME PRESETS
// ============================================

/**
 * Pre-configured theme presets for quick use
 */
export const catppuccinPresets = {
  // Light themes
  latteMauve: createCatppuccinTheme({ flavor: 'latte', accent: 'mauve' }),
  latteBlue: createCatppuccinTheme({ flavor: 'latte', accent: 'blue' }),
  lattePink: createCatppuccinTheme({ flavor: 'latte', accent: 'pink' }),
  latteTeal: createCatppuccinTheme({ flavor: 'latte', accent: 'teal' }),
  latteGreen: createCatppuccinTheme({ flavor: 'latte', accent: 'green' }),
  lattePeach: createCatppuccinTheme({ flavor: 'latte', accent: 'peach' }),
  latteSapphire: createCatppuccinTheme({ flavor: 'latte', accent: 'sapphire' }),
  latteLavender: createCatppuccinTheme({ flavor: 'latte', accent: 'lavender' }),
  
  // Frappé themes (medium dark)
  frappeMauve: createCatppuccinTheme({ flavor: 'frappe', accent: 'mauve' }),
  frappeBlue: createCatppuccinTheme({ flavor: 'frappe', accent: 'blue' }),
  frappePink: createCatppuccinTheme({ flavor: 'frappe', accent: 'pink' }),
  frappeTeal: createCatppuccinTheme({ flavor: 'frappe', accent: 'teal' }),
  frappeGreen: createCatppuccinTheme({ flavor: 'frappe', accent: 'green' }),
  frappePeach: createCatppuccinTheme({ flavor: 'frappe', accent: 'peach' }),
  frappeSapphire: createCatppuccinTheme({ flavor: 'frappe', accent: 'sapphire' }),
  frappeLavender: createCatppuccinTheme({ flavor: 'frappe', accent: 'lavender' }),
  
  // Macchiato themes (dark)
  macchiatoMauve: createCatppuccinTheme({ flavor: 'macchiato', accent: 'mauve' }),
  macchiatoBlue: createCatppuccinTheme({ flavor: 'macchiato', accent: 'blue' }),
  macchiatoPink: createCatppuccinTheme({ flavor: 'macchiato', accent: 'pink' }),
  macchiatoTeal: createCatppuccinTheme({ flavor: 'macchiato', accent: 'teal' }),
  macchiatoGreen: createCatppuccinTheme({ flavor: 'macchiato', accent: 'green' }),
  macchiatoPeach: createCatppuccinTheme({ flavor: 'macchiato', accent: 'peach' }),
  macchiatoSapphire: createCatppuccinTheme({ flavor: 'macchiato', accent: 'sapphire' }),
  macchiatoLavender: createCatppuccinTheme({ flavor: 'macchiato', accent: 'lavender' }),
  
  // Mocha themes (darkest)
  mochaMauve: createCatppuccinTheme({ flavor: 'mocha', accent: 'mauve' }),
  mochaBlue: createCatppuccinTheme({ flavor: 'mocha', accent: 'blue' }),
  mochaPink: createCatppuccinTheme({ flavor: 'mocha', accent: 'pink' }),
  mochaTeal: createCatppuccinTheme({ flavor: 'mocha', accent: 'teal' }),
  mochaGreen: createCatppuccinTheme({ flavor: 'mocha', accent: 'green' }),
  mochaPeach: createCatppuccinTheme({ flavor: 'mocha', accent: 'peach' }),
  mochaSapphire: createCatppuccinTheme({ flavor: 'mocha', accent: 'sapphire' }),
  mochaLavender: createCatppuccinTheme({ flavor: 'mocha', accent: 'lavender' }),
  mochaRosewater: createCatppuccinTheme({ flavor: 'mocha', accent: 'rosewater' }),
  mochaFlamingo: createCatppuccinTheme({ flavor: 'mocha', accent: 'flamingo' }),
  mochaYellow: createCatppuccinTheme({ flavor: 'mocha', accent: 'yellow' }),
  mochaSky: createCatppuccinTheme({ flavor: 'mocha', accent: 'sky' }),
  mochaMaroon: createCatppuccinTheme({ flavor: 'mocha', accent: 'maroon' }),
  mochaRed: createCatppuccinTheme({ flavor: 'mocha', accent: 'red' }),
} as const;

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get a theme based on system preference (light/dark) with specified accent
 */
export function getCatppuccinThemeByPreference(
  prefersDark: boolean,
  accent: CatppuccinAccent = 'mauve',
  darkFlavor: 'frappe' | 'macchiato' | 'mocha' = 'mocha'
): ThemeConfig {
  return createCatppuccinTheme({
    flavor: prefersDark ? darkFlavor : 'latte',
    accent,
  });
}

/**
 * Get CSS custom properties for a Catppuccin flavor
 * Useful for styling non-Ant Design components
 */
export function getCatppuccinCSSVariables(flavor: CatppuccinFlavor): Record<string, string> {
  const colors = catppuccin[flavor];
  const vars: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(colors)) {
    vars[`--ctp-${key}`] = value;
  }
  
  return vars;
}

/**
 * Apply Catppuccin CSS variables to document root
 */
export function applyCatppuccinCSSVariables(flavor: CatppuccinFlavor): void {
  const vars = getCatppuccinCSSVariables(flavor);
  const root = document.documentElement;
  
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
}

// ============================================
// SEMANTIC COLOR HELPERS
// ============================================

/**
 * Get semantic status colors for a flavor
 */
export function getStatusColors(flavor: CatppuccinFlavor) {
  const colors = catppuccin[flavor];
  return {
    success: colors.green,
    warning: colors.yellow,
    error: colors.red,
    info: colors.blue,
    pending: colors.peach,
    running: colors.green,
    stopped: colors.overlay1,
    terminated: colors.red,
    starting: colors.yellow,
    stopping: colors.peach,
  };
}

/**
 * Get tag colors for different states/categories
 */
export function getTagColors(flavor: CatppuccinFlavor) {
  const colors = catppuccin[flavor];
  return {
    default: { bg: colors.surface0, text: colors.text, border: colors.surface1 },
    primary: { bg: colors.blue, text: colors.crust, border: colors.blue },
    success: { bg: colors.green, text: colors.crust, border: colors.green },
    warning: { bg: colors.yellow, text: colors.crust, border: colors.yellow },
    error: { bg: colors.red, text: colors.crust, border: colors.red },
    info: { bg: colors.sapphire, text: colors.crust, border: colors.sapphire },
    purple: { bg: colors.mauve, text: colors.crust, border: colors.mauve },
    pink: { bg: colors.pink, text: colors.crust, border: colors.pink },
    cyan: { bg: colors.teal, text: colors.crust, border: colors.teal },
    orange: { bg: colors.peach, text: colors.crust, border: colors.peach },
  };
}

// ============================================
// EXPORTS
// ============================================

// Default export for convenience
export default createCatppuccinTheme;

// Export all accent options for UI selectors
export const accentOptions: CatppuccinAccent[] = [
  'rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon',
  'peach', 'yellow', 'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender'
];

// Export all flavor options for UI selectors
export const flavorOptions: CatppuccinFlavor[] = ['latte', 'frappe', 'macchiato', 'mocha'];

// Human-readable labels
export const flavorLabels: Record<CatppuccinFlavor, string> = {
  latte: 'Latte (Light)',
  frappe: 'Frappé (Medium)',
  macchiato: 'Macchiato (Dark)',
  mocha: 'Mocha (Darkest)',
};

export const accentLabels: Record<CatppuccinAccent, string> = {
  rosewater: 'Rosewater',
  flamingo: 'Flamingo',
  pink: 'Pink',
  mauve: 'Mauve',
  red: 'Red',
  maroon: 'Maroon',
  peach: 'Peach',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  sky: 'Sky',
  sapphire: 'Sapphire',
  blue: 'Blue',
  lavender: 'Lavender',
};
