import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('public homepage loads the Warm Editorial layout without removing pricing', () => {
  const homepage = read('index.html');
  assert.match(homepage, /href="\/warm-editorial\.css"/);
  assert.match(homepage, /src="\/warm-editorial\.js"/);
  assert.match(homepage, /href="\/pricing\.html">Pricing<\/a>/);
  assert.ok(fs.existsSync(new URL('../assets/warm-editorial-cafe-v2.jpg', import.meta.url)));
});

test('web dashboard loads Quiet Focus and keeps protected account controls', () => {
  const dashboard = read('dashboard.html');
  assert.match(dashboard, /href="\/dashboard-quiet-focus\.css"/);
  assert.match(dashboard, /src="\/dashboard-quiet-focus\.js"/);
  assert.match(dashboard, /<h3>Subscription<\/h3>/);
  assert.match(dashboard, /data-account-logout/);
  assert.match(dashboard, /data-delete-account/);
  assert.match(dashboard, /\/api\/delete-account/);
});

test('web greeting follows local time boundaries', () => {
  const context = { window: {} };
  vm.runInNewContext(read('dashboard-quiet-focus.js'), context);
  const greeting = context.window.BaristaMatchQuietFocus.timeGreeting;

  assert.equal(greeting(new Date(2026, 0, 1, 4, 59)), 'Welcome back');
  assert.equal(greeting(new Date(2026, 0, 1, 5, 0)), 'Good morning');
  assert.equal(greeting(new Date(2026, 0, 1, 12, 0)), 'Good afternoon');
  assert.equal(greeting(new Date(2026, 0, 1, 17, 0)), 'Good evening');
  assert.equal(greeting(new Date(2026, 0, 1, 23, 59)), 'Good evening');
});

test('native dashboard keeps settings, pricing, and real account activity routes', () => {
  const home = read('mobile/app/home.tsx');
  const quietHome = read('mobile/components/QuietFocusHome.tsx');
  const greeting = read('mobile/lib/timeGreeting.ts');

  assert.match(home, /router\.push\('\/settings'\)/);
  assert.match(home, /supabase\.auth\.getSession\(\)/);
  assert.match(home, /Your first job and first hire are included\./);
  for (const route of ['/subscription', '/discover', '/profile', '/matches', '/messages']) {
    assert.ok(quietHome.includes(`router.push('${route}')`), `Missing native route ${route}`);
  }
  for (const copy of ['Good morning', 'Good afternoon', 'Good evening', 'Welcome back']) {
    assert.ok(greeting.includes(copy), `Missing greeting ${copy}`);
  }
  assert.ok(fs.existsSync(new URL('../mobile/assets/warm-editorial-cafe-v2.jpg', import.meta.url)));
});
