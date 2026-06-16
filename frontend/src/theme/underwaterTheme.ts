// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ThemeConfig } from 'antd';
import { theme } from 'antd';

/**
 * Underwater Theme for Ant Design
 * 
 * Adapted from Underwater Obsidian theme (https://github.com/Seniblue/Underwater)
 * 
 * Features multiple color variants including:
 * - Rosé Pine (default dark/light)
 * - Nord, Catppuccin, Everforest, Gruvbox
 * - Custom underwater variants: Deep, Ocean, Seaweed, Sand, Coral, Aqua
 */

// Helper to convert RGB string to hex
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

export interface UnderwaterPreset {
  name: string;
  mode: 'light' | 'dark';
  colors: {
    // Accent colors (semantic)
    love: string;    // red/error
    gold: string;    // yellow/warning
    rose: string;    // orange/accent
    pine: string;    // blue/info
    foam: string;    // cyan/link
    iris: string;    // purple
    // Base colors
    base: string;
    surface: string;
    overlay: string;
    // Text colors
    text: string;
    subtle: string;
    muted: string;
    // Highlights
    highlightLow: string;
    highlightMed: string;
    highlightHigh: string;
  };
}

export const underwaterPresets: Record<string, UnderwaterPreset> = {
  // ===== DARK THEMES =====
  rosePine: {
    name: 'Rosé Pine',
    mode: 'dark',
    colors: {
      love: rgbToHex(235, 111, 146),
      gold: rgbToHex(246, 193, 119),
      rose: rgbToHex(235, 188, 186),
      pine: rgbToHex(49, 116, 143),
      foam: rgbToHex(156, 207, 216),
      iris: rgbToHex(196, 167, 231),
      base: '#191724',
      surface: rgbToHex(31, 29, 46),
      overlay: '#26233a',
      text: '#e0def4',
      subtle: '#908caa',
      muted: '#6e6a86',
      highlightLow: '#21202e',
      highlightMed: rgbToHex(64, 61, 82),
      highlightHigh: '#524f67',
    },
  },
  rosePineMoon: {
    name: 'Rosé Pine Moon',
    mode: 'dark',
    colors: {
      love: rgbToHex(235, 111, 146),
      gold: rgbToHex(246, 193, 119),
      rose: rgbToHex(234, 154, 151),
      pine: rgbToHex(62, 143, 176),
      foam: rgbToHex(156, 207, 216),
      iris: rgbToHex(196, 167, 231),
      base: '#232136',
      surface: rgbToHex(42, 39, 63),
      overlay: '#393552',
      text: '#e0def4',
      subtle: '#908caa',
      muted: '#6e6a86',
      highlightLow: '#2a283e',
      highlightMed: rgbToHex(68, 65, 90),
      highlightHigh: '#56526e',
    },
  },
  uwDeep: {
    name: 'Deep',
    mode: 'dark',
    colors: {
      love: rgbToHex(215, 97, 76),
      gold: rgbToHex(217, 209, 89),
      rose: rgbToHex(229, 156, 88),
      pine: rgbToHex(105, 147, 194),
      foam: rgbToHex(159, 195, 135),
      iris: rgbToHex(146, 135, 194),
      base: '#11121a',
      surface: rgbToHex(21, 23, 29),
      overlay: '#22252F',
      text: '#D5E1E5',
      subtle: '#7C8185',
      muted: '#57626B',
      highlightLow: '#272B2F',
      highlightMed: rgbToHex(49, 60, 66),
      highlightHigh: '#334852',
    },
  },
  uwOcean: {
    name: 'Ocean',
    mode: 'dark',
    colors: {
      love: rgbToHex(254, 114, 143),
      gold: rgbToHex(255, 225, 97),
      rose: rgbToHex(232, 177, 146),
      pine: rgbToHex(235, 98, 59),
      foam: rgbToHex(70, 201, 199),
      iris: rgbToHex(115, 104, 182),
      base: '#081020',
      surface: rgbToHex(8, 18, 43),
      overlay: '#06334D',
      text: '#E1E3FF',
      subtle: '#97A4C9',
      muted: '#7585B2',
      highlightLow: '#28344B',
      highlightMed: rgbToHex(40, 56, 82),
      highlightHigh: '#19263B',
    },
  },
  uwSeaweed: {
    name: 'Seaweed',
    mode: 'dark',
    colors: {
      love: rgbToHex(255, 123, 123),
      gold: rgbToHex(242, 225, 95),
      rose: rgbToHex(216, 237, 141),
      pine: rgbToHex(109, 196, 120),
      foam: rgbToHex(191, 229, 222),
      iris: rgbToHex(95, 163, 162),
      base: '#193233',
      surface: rgbToHex(25, 57, 58),
      overlay: '#214B4C',
      text: '#dee2b9',
      subtle: '#A7C9C9',
      muted: '#7CAB9B',
      highlightLow: '#1F3533',
      highlightMed: rgbToHex(63, 99, 96),
      highlightHigh: '#5D817E',
    },
  },
  uwSand: {
    name: 'Sand',
    mode: 'dark',
    colors: {
      love: rgbToHex(232, 157, 149),
      gold: rgbToHex(246, 173, 119),
      rose: rgbToHex(187, 163, 121),
      pine: rgbToHex(121, 166, 222),
      foam: rgbToHex(195, 230, 148),
      iris: rgbToHex(145, 145, 188),
      base: '#151527',
      surface: rgbToHex(25, 25, 46),
      overlay: '#212037',
      text: '#CED9BF',
      subtle: '#b8b28e',
      muted: '#a09a79',
      highlightLow: '#1A2230',
      highlightMed: rgbToHex(48, 62, 85),
      highlightHigh: '#37465F',
    },
  },
  nordDark: {
    name: 'Nord Dark',
    mode: 'dark',
    colors: {
      love: rgbToHex(191, 97, 106),
      gold: rgbToHex(235, 203, 139),
      rose: rgbToHex(208, 135, 112),
      pine: rgbToHex(129, 161, 193),
      foam: rgbToHex(143, 188, 187),
      iris: rgbToHex(180, 142, 173),
      base: '#3B4252',
      surface: rgbToHex(46, 52, 64),
      overlay: '#434C5E',
      text: '#ECEFF4',
      subtle: '#E5E9F0',
      muted: '#D8DEE9',
      highlightLow: '#3b4252',
      highlightMed: rgbToHex(67, 76, 94),
      highlightHigh: '#4c566a',
    },
  },
  everforestDark: {
    name: 'Everforest Dark',
    mode: 'dark',
    colors: {
      love: rgbToHex(230, 126, 128),
      gold: rgbToHex(219, 188, 127),
      rose: rgbToHex(230, 152, 117),
      pine: rgbToHex(131, 192, 146),
      foam: rgbToHex(127, 187, 179),
      iris: rgbToHex(214, 153, 182),
      base: '#1E2326',
      surface: rgbToHex(39, 46, 51),
      overlay: '#384B55',
      text: '#d3C6AA',
      subtle: '#9DA9A0',
      muted: '#859289',
      highlightLow: '#374145',
      highlightMed: rgbToHex(65, 75, 80),
      highlightHigh: '#495156',
    },
  },
  biscuitDark: {
    name: 'Biscuit',
    mode: 'dark',
    colors: {
      love: rgbToHex(202, 63, 63),
      gold: rgbToHex(227, 156, 69),
      rose: rgbToHex(228, 106, 58),
      pine: rgbToHex(81, 120, 148),
      foam: rgbToHex(98, 147, 134),
      iris: rgbToHex(159, 86, 154),
      base: '#181515',
      surface: rgbToHex(34, 30, 30),
      overlay: '#423939',
      text: '#F4E6D2',
      subtle: '#B6A8A5',
      muted: '#978787',
      highlightLow: '#423939',
      highlightMed: rgbToHex(109, 95, 95),
      highlightHigh: '#978787',
    },
  },

  // ===== LIGHT THEMES =====
  rosePineDawn: {
    name: 'Rosé Pine Dawn',
    mode: 'light',
    colors: {
      love: rgbToHex(180, 99, 122),
      gold: rgbToHex(234, 157, 52),
      rose: rgbToHex(215, 130, 126),
      pine: rgbToHex(40, 105, 131),
      foam: rgbToHex(86, 148, 159),
      iris: rgbToHex(144, 122, 169),
      base: '#faf4ed',
      surface: rgbToHex(255, 250, 243),
      overlay: '#f2e9e1',
      text: '#575279',
      subtle: '#797593',
      muted: '#9893a5',
      highlightLow: '#f4ede8',
      highlightMed: rgbToHex(223, 218, 217),
      highlightHigh: '#cecacd',
    },
  },
  nordLight: {
    name: 'Nord Light',
    mode: 'light',
    colors: {
      love: rgbToHex(191, 97, 106),
      gold: rgbToHex(208, 135, 112),
      rose: rgbToHex(180, 142, 173),
      pine: rgbToHex(129, 161, 193),
      foam: rgbToHex(136, 192, 208),
      iris: rgbToHex(94, 129, 172),
      base: '#E5E9F0',
      surface: rgbToHex(236, 239, 244),
      overlay: '#D8DEE9',
      text: '#434C5E',
      subtle: '#4C566A',
      muted: '#4C566A',
      highlightLow: '#E5E9F0',
      highlightMed: rgbToHex(216, 222, 233),
      highlightHigh: '#d8dee9',
    },
  },
  everforestLight: {
    name: 'Everforest Light',
    mode: 'light',
    colors: {
      love: rgbToHex(248, 85, 82),
      gold: rgbToHex(223, 160, 0),
      rose: rgbToHex(245, 125, 38),
      pine: rgbToHex(53, 167, 124),
      foam: rgbToHex(58, 148, 197),
      iris: rgbToHex(223, 105, 186),
      base: '#efebd4',
      surface: rgbToHex(253, 246, 227),
      overlay: '#eaedc8',
      text: '#5c6a72',
      subtle: '#829181',
      muted: '#939f91',
      highlightLow: '#efebd4',
      highlightMed: rgbToHex(230, 226, 204),
      highlightHigh: '#e0dcc7',
    },
  },
  uwCoral: {
    name: 'Coral',
    mode: 'light',
    colors: {
      love: rgbToHex(145, 121, 123),
      gold: rgbToHex(242, 154, 99),
      rose: rgbToHex(145, 166, 204),
      pine: rgbToHex(119, 166, 155),
      foam: rgbToHex(138, 182, 189),
      iris: rgbToHex(222, 152, 137),
      base: '#F3E9E2',
      surface: rgbToHex(255, 244, 237),
      overlay: '#FBE1DB',
      text: '#6C6156',
      subtle: '#928577',
      muted: '#A79A8C',
      highlightLow: '#EDE2DA',
      highlightMed: rgbToHex(231, 214, 196),
      highlightHigh: '#D9C6B9',
    },
  },
  uwAqua: {
    name: 'Aqua',
    mode: 'light',
    colors: {
      love: rgbToHex(194, 105, 128),
      gold: rgbToHex(183, 195, 121),
      rose: rgbToHex(215, 131, 116),
      pine: rgbToHex(123, 168, 149),
      foam: rgbToHex(96, 161, 169),
      iris: rgbToHex(128, 127, 152),
      base: '#f0efec',
      surface: rgbToHex(255, 251, 245),
      overlay: '#e6eeec',
      text: '#4e4c49',
      subtle: '#7c726b',
      muted: '#80766f',
      highlightLow: '#e9eef0',
      highlightMed: rgbToHex(220, 227, 230),
      highlightHigh: '#cfdadf',
    },
  },
  uwOctopus: {
    name: 'Octopus',
    mode: 'light',
    colors: {
      love: rgbToHex(205, 106, 94),
      gold: rgbToHex(230, 161, 73),
      rose: rgbToHex(127, 111, 134),
      pine: rgbToHex(86, 139, 187),
      foam: rgbToHex(106, 168, 149),
      iris: rgbToHex(204, 135, 90),
      base: '#F2EDF4',
      surface: rgbToHex(252, 251, 250),
      overlay: '#eee9f0',
      text: '#475669',
      subtle: '#616980',
      muted: '#798094',
      highlightLow: '#e3e9eb',
      highlightMed: rgbToHex(206, 222, 227),
      highlightHigh: '#B4C3C8',
    },
  },
  uwOyster: {
    name: 'Oyster',
    mode: 'light',
    colors: {
      love: rgbToHex(64, 45, 48),
      gold: rgbToHex(255, 150, 0),
      rose: rgbToHex(140, 35, 51),
      pine: rgbToHex(50, 111, 144),
      foam: rgbToHex(70, 102, 67),
      iris: rgbToHex(103, 67, 100),
      base: '#EEE6E5',
      surface: rgbToHex(245, 239, 238),
      overlay: '#E6DAD7',
      text: '#2C2E2F',
      subtle: '#545557',
      muted: '#7F8284',
      highlightLow: '#EAE5E0',
      highlightMed: rgbToHex(209, 201, 193),
      highlightHigh: '#B8B3AD',
    },
  },
};

export type UnderwaterPresetName = keyof typeof underwaterPresets;


// ============================================
// THEME GENERATOR
// ============================================

export function createUnderwaterTheme(presetName: UnderwaterPresetName): ThemeConfig {
  const preset = underwaterPresets[presetName];
  const { mode, colors } = preset;
  const isDark = mode === 'dark';

  const baseTokens = {
    colorPrimary: colors.foam,
    colorInfo: colors.pine,
    colorSuccess: colors.pine,
    colorWarning: colors.gold,
    colorError: colors.love,
    
    colorText: colors.text,
    colorTextSecondary: colors.subtle,
    colorTextTertiary: colors.muted,
    
    colorBgContainer: colors.surface,
    colorBgElevated: colors.base,
    colorBgLayout: colors.base,
    colorBgSpotlight: colors.overlay,
    
    colorBorder: colors.highlightMed,
    colorBorderSecondary: colors.highlightLow,
    
    colorFill: colors.highlightLow,
    colorFillSecondary: colors.highlightMed,
    
    colorLink: colors.foam,
    colorLinkHover: colors.pine,
    
    fontFamily: '"Lexend", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
  };

  const componentTokens = {
    Button: {
      borderRadius: 7,
      controlHeight: 36,
      primaryShadow: 'none',
      defaultShadow: 'none',
    },
    Input: {
      borderRadius: 30,
      controlHeight: 36,
      activeBorderColor: colors.foam,
      hoverBorderColor: colors.highlightHigh,
      colorTextPlaceholder: colors.muted,
    },
    Select: {
      borderRadius: 8,
      controlHeight: 36,
      optionSelectedBg: colors.highlightLow,
      colorTextPlaceholder: colors.muted,
    },
    Table: {
      headerBg: colors.iris,
      headerColor: colors.surface,
      headerSortActiveBg: colors.highlightMed,
      headerSortHoverBg: colors.highlightMed,
      rowHoverBg: colors.highlightLow,
      borderColor: colors.highlightHigh,
      bodySortBg: 'transparent',
    },
    Checkbox: {
      colorPrimary: colors.pine,
      colorBorder: colors.rose,
      borderRadiusSM: 5,
    },
    Card: {
      borderRadiusLG: 12,
      colorBgContainer: colors.surface,
      colorBorderSecondary: colors.highlightMed,
    },
    Modal: {
      borderRadiusLG: 12,
      contentBg: colors.surface,
      headerBg: colors.surface,
    },
    Menu: {
      itemBorderRadius: 8,
      itemSelectedBg: colors.foam,
      itemSelectedColor: colors.surface,
      itemHoverBg: colors.highlightLow,
      subMenuItemBg: colors.base,
    },
    Tag: {
      borderRadiusSM: 7,
      defaultBg: `${colors.rose}1a`,
      defaultColor: colors.rose,
    },
    Tabs: {
      itemSelectedColor: colors.foam,
      inkBarColor: colors.foam,
    },
    Breadcrumb: {
      itemColor: colors.muted,
      lastItemColor: colors.text,
      linkColor: colors.subtle,
      linkHoverColor: colors.foam,
    },
    Layout: {
      bodyBg: colors.base,
      headerBg: colors.overlay,
      siderBg: colors.overlay,
    },
    Tooltip: {
      colorBgSpotlight: isDark ? colors.highlightMed : '#1f1f1f',
      colorTextLightSolid: '#ffffff',
    },
    Divider: {
      colorSplit: colors.highlightMed,
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

export const underwaterPresetNames = Object.keys(underwaterPresets) as UnderwaterPresetName[];

export const underwaterDarkPresets = underwaterPresetNames.filter(
  name => underwaterPresets[name].mode === 'dark'
);

export const underwaterLightPresets = underwaterPresetNames.filter(
  name => underwaterPresets[name].mode === 'light'
);

export const underwaterLabels: Record<UnderwaterPresetName, string> = {
  rosePine: 'Rosé Pine',
  rosePineMoon: 'Rosé Pine Moon',
  uwDeep: 'Deep',
  uwOcean: 'Ocean',
  uwSeaweed: 'Seaweed',
  uwSand: 'Sand',
  nordDark: 'Nord Dark',
  everforestDark: 'Everforest Dark',
  biscuitDark: 'Biscuit',
  rosePineDawn: 'Rosé Pine Dawn',
  nordLight: 'Nord Light',
  everforestLight: 'Everforest Light',
  uwCoral: 'Coral',
  uwAqua: 'Aqua',
  uwOctopus: 'Octopus',
  uwOyster: 'Oyster',
};

export default createUnderwaterTheme;
