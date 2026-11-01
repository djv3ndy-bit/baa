import { Platform, type ViewStyle } from 'react-native';

export const dashboardTheme = {
  background: '#fffdf9', surface: '#ffffff', ink: '#321708', muted: '#5d6166',
  accent: '#ac4b0c', soft: '#fbf2e7', border: '#e5e3e0', statBorder: '#edcfb2',
  success: '#257331', successBackground: '#e7f2e3', error: '#8c3424',
  headingFont: Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' }),
  interfaceFont: Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui' }),
} as const;

// A light material made from the existing palette. No blur layer or clipped
// container is needed, so content and accessibility text stay unobstructed.
export const softGlassSurface = {
  backgroundColor: `${dashboardTheme.surface}eb`,
  borderWidth: 1,
  borderColor: dashboardTheme.surface,
  borderRadius: 24,
  borderCurve: 'continuous',
  shadowColor: dashboardTheme.ink,
  shadowOffset: { width: 0, height: 5 },
  shadowOpacity: 0.07,
  shadowRadius: 12,
  elevation: 2,
} satisfies ViewStyle;
