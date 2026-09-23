/**
 * StarCore's dark/space palette, carried over from Mission Control's own
 * `:root` custom properties (mission_control/style.css) so the mobile app
 * reads as the same product rather than a re-skin. Keep these two files in
 * sync by hand when the web palette changes - there's no shared build step
 * between a CSS file and React Native, and introducing one just for color
 * tokens would be more machinery than five constants are worth.
 */
export const colors = {
  void: '#04060d',
  deep: '#070b16',
  surface: '#0a0f1e',
  raised: '#0e1428',
  line: '#161d33',
  lineBright: '#202a47',

  klein: '#002fa7',
  sapphire: '#0f52ba',
  royal: '#2b5bd7',
  azure: '#6c9bf0',
  ice: '#a8c4f5',

  text: '#e7ecf8',
  textDim: '#98a3be',
  textFaint: '#6e7b99',

  ok: '#3ecf8e',
  alert: '#e4606d',
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 16,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;
