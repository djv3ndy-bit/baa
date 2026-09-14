import { Platform } from 'react-native';

export const dashboardTheme = {
  background: '#fffdf9', surface: '#ffffff', ink: '#321708', muted: '#5d6166',
  accent: '#ac4b0c', soft: '#fbf2e7', border: '#e5e3e0', statBorder: '#edcfb2',
  success: '#257331', successBackground: '#e7f2e3', error: '#8c3424',
  headingFont: Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' }),
} as const;
