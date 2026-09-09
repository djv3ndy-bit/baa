// Shared presentation for signed-in dashboard destinations.
export const dashboardPrism = {
  background: '#ffffff',
  surface: '#ffffff',
  soft: '#f7f7f7',
  ink: '#292521',
  muted: '#706b66',
  line: '#e9e7e5',
  accent: '#a94716',
} as const;

export const prismPanel = {
  backgroundColor: dashboardPrism.surface,
  borderWidth: 1,
  borderColor: dashboardPrism.line,
  shadowColor: '#25211d',
  shadowOffset: { width: 0, height: 6 },
  shadowOpacity: 0.035,
  shadowRadius: 12,
  elevation: 1,
} as const;
