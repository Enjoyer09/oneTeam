/**
 * Platform values for the semantic design tokens defined in web/src/index.css.
 * Keep names and meaning aligned across clients; native values follow iOS
 * contrast and Dynamic Type behavior rather than copying web pixel sizes.
 */
export const palette = {
  background: '#FFFFFF',
  surface: '#F7F8FA',
  text: '#111827',
  textSecondary: '#4B5563',
  border: '#D1D5DB',
  focus: '#0055AA',
  brand: '#D2000A',
  success: '#046B45',
  warning: '#7F4803',
  danger: '#9B0D31',
  info: '#322C9E',
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

export const typography = {
  body: 16,
  secondary: 14,
  title: 22,
  lineHeight: 22,
} as const;
