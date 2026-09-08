import assert from 'node:assert/strict';
import test from 'node:test';
import { LOGIN_LAYOUT_METRICS, resolveLoginLayout } from './login-layout-module.mjs';

const screens = [
  { width: 320, height: 568, topInset: 20, bottomInset: 0, mode: 'short' },
  { width: 375, height: 667, topInset: 20, bottomInset: 0, mode: 'short' },
  { width: 375, height: 812, topInset: 50, bottomInset: 34, mode: 'compact' },
  { width: 390, height: 844, topInset: 59, bottomInset: 34, mode: 'regular' },
  { width: 393, height: 852, topInset: 59, bottomInset: 34, mode: 'regular' },
];

test('layout metrics expose the intended tier budgets', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(LOGIN_LAYOUT_METRICS).map(([mode, metrics]) => [mode, {
      sheetBaseHeight: metrics.sheetBaseHeight,
      overlap: metrics.overlap,
      ratio: metrics.ratio,
      heroCap: metrics.heroCap,
      heroBodyMinimum: metrics.heroBodyMinimum,
    }])),
    {
      regular: { sheetBaseHeight: 482, overlap: 26, ratio: 0.40, heroCap: 340, heroBodyMinimum: 145 },
      compact: { sheetBaseHeight: 451, overlap: 24, ratio: 0.39, heroCap: 322, heroBodyMinimum: 140 },
      short: { sheetBaseHeight: 424, overlap: 22, ratio: 0.36, heroCap: 250, heroBodyMinimum: 120 },
    },
  );
});

test('default login layout stays within representative phone heights', () => {
  for (const screen of screens) {
    const layout = resolveLoginLayout({ ...screen, keyboardVisible: false });
    const contentHeight = layout.heroHeight - layout.metrics.overlap + layout.sheetBudget;

    assert.equal(layout.mode, screen.mode);
    assert.equal(layout.requiresScroll, false, `${screen.width}x${screen.height} should not scroll`);
    assert.ok(contentHeight <= screen.height, `${screen.width}x${screen.height} exceeds the viewport`);
    assert.ok(screen.height - contentHeight >= 8, `${screen.width}x${screen.height} loses its fit reserve`);
  }
});

test('layout metrics preserve minimum field and action targets', () => {
  for (const [mode, metrics] of Object.entries(LOGIN_LAYOUT_METRICS)) {
    for (const key of ['inputHeight', 'primaryHeight', 'socialHeight', 'forgotHeight', 'createTapHeight']) {
      assert.ok(metrics[key] >= 44, `${mode}.${key} must remain at least 44pt`);
    }
  }
});

test('keyboard and an undersized viewport enable scrolling', () => {
  const base = { width: 393, height: 852, topInset: 59, bottomInset: 34 };
  const keyboard = resolveLoginLayout({ ...base, keyboardVisible: true });
  const undersized = resolveLoginLayout({ width: 320, height: 520, topInset: 20, bottomInset: 0, keyboardVisible: false });

  assert.equal(keyboard.requiresScroll, true);
  assert.equal(keyboard.heroHeight, base.topInset + 88);
  assert.equal(keyboard.reducedHeader, true);
  assert.equal(undersized.requiresScroll, true);
  assert.equal(undersized.reducedHeader, false);
  assert.ok(undersized.minimumHero > undersized.fitCap);
});
