export type LoginLayoutMode = 'regular' | 'compact' | 'short';

export type LoginLayoutMetric = {
  sheetBaseHeight: number;
  overlap: number;
  ratio: number;
  heroCap: number;
  heroBodyMinimum: number;
  inputHeight: number;
  primaryHeight: number;
  socialHeight: number;
  forgotHeight: number;
  createTapHeight: number;
};

export const LOGIN_LAYOUT_METRICS = {
  regular: {
    sheetBaseHeight: 482,
    overlap: 26,
    ratio: 0.40,
    heroCap: 340,
    heroBodyMinimum: 145,
    inputHeight: 48,
    primaryHeight: 50,
    socialHeight: 48,
    forgotHeight: 44,
    createTapHeight: 44,
  },
  compact: {
    sheetBaseHeight: 451,
    overlap: 24,
    ratio: 0.39,
    heroCap: 322,
    heroBodyMinimum: 140,
    inputHeight: 46,
    primaryHeight: 48,
    socialHeight: 46,
    forgotHeight: 44,
    createTapHeight: 44,
  },
  short: {
    sheetBaseHeight: 424,
    overlap: 22,
    ratio: 0.36,
    heroCap: 250,
    heroBodyMinimum: 120,
    inputHeight: 44,
    primaryHeight: 46,
    socialHeight: 44,
    forgotHeight: 44,
    createTapHeight: 44,
  },
} as const satisfies Record<LoginLayoutMode, LoginLayoutMetric>;

export type ResolveLoginLayoutInput = {
  width: number;
  height: number;
  fontScale: number;
  topInset: number;
  bottomInset: number;
  keyboardVisible: boolean;
};

export type ResolvedLoginLayout = {
  mode: LoginLayoutMode;
  metrics: LoginLayoutMetric;
  bottomPadding: number;
  sheetBudget: number;
  fitCap: number;
  naturalHero: number;
  minimumHero: number;
  heroHeight: number;
  reducedHeader: boolean;
  requiresScroll: boolean;
};

export function resolveLoginLayout({
  width,
  height,
  fontScale,
  topInset,
  bottomInset,
  keyboardVisible,
}: ResolveLoginLayoutInput): ResolvedLoginLayout {
  const mode: LoginLayoutMode = height < 740
    ? 'short'
    : height < 830 || width <= 375
      ? 'compact'
      : 'regular';
  const metrics = LOGIN_LAYOUT_METRICS[mode];
  const bottomPadding = Math.max(bottomInset, 16);
  const sheetBudget = metrics.sheetBaseHeight + bottomPadding;
  const fitCap = height - sheetBudget + metrics.overlap - 8;
  const naturalHero = Math.min(metrics.heroCap, height * metrics.ratio);
  const minimumHero = topInset + metrics.heroBodyMinimum;
  const largeText = fontScale > 1.15;
  const reducedHeader = keyboardVisible || largeText;
  const requiresScroll = keyboardVisible || largeText || minimumHero > fitCap;

  const heroHeight = keyboardVisible
    ? topInset + 88
    : largeText
      ? topInset + 112
      : Math.max(minimumHero, Math.min(naturalHero, fitCap));

  return {
    mode,
    metrics,
    bottomPadding,
    sheetBudget,
    fitCap,
    naturalHero,
    minimumHero,
    heroHeight,
    reducedHeader,
    requiresScroll,
  };
}
