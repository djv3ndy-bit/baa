import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('homepage preloads and keeps the approved hero after its layout helper runs', () => {
  const homepage = read('index.html');
  const approvedHero = '/assets/editorial-hero-v4.png';
  const previousHero = '/assets/editorial-hero-v3.jpg';
  const preload = homepage.match(/<link\b(?=[^>]*rel="preload")(?=[^>]*as="image")[^>]*href="([^"]+)"/);
  const initialHero = homepage.match(/<img\b[^>]*class="hero-photo"[^>]*src="([^"]+)"/);
  assert.equal(preload?.[1], approvedHero);
  assert.equal(initialHero?.[1], approvedHero);
  assert.equal(homepage.split(`src="${previousHero}"`).length - 1, 3);

  const asset = fs.readFileSync(new URL(`..${approvedHero}`, import.meta.url));
  assert.deepEqual([...asset.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(asset.readUInt32BE(16), 1536);
  assert.equal(asset.readUInt32BE(20), 1024);

  const attributes = {};
  const hero = { src: initialHero[1], setAttribute: (key, value) => { attributes[key] = value; } };
  const finalImage = {};
  const audienceImages = [{}, {}];
  let onReady;
  const document = {
    addEventListener: (event, handler) => {
      assert.equal(event, 'DOMContentLoaded');
      onReady = handler;
    },
    querySelector: (selector) => ({
      '.hero-photo': hero,
      '.final-image img': finalImage,
    }[selector] ?? null),
    querySelectorAll: (selector) => selector === '.audience-card img' ? audienceImages : [],
  };
  vm.runInNewContext(read('warm-editorial.js'), { document });
  assert.equal(typeof onReady, 'function');
  onReady();
  assert.equal(hero.src, approvedHero);
  assert.equal(hero.loading, 'eager');
  assert.equal(attributes.fetchpriority, 'high');
  assert.equal(finalImage.src, previousHero);
  assert.ok(audienceImages.every((image) => image.src === previousHero));
});

test('public homepage keeps the Warm Editorial layout without public café pricing', () => {
  const homepage = read('index.html');
  assert.match(homepage, /href="\/warm-editorial\.css"/);
  assert.match(homepage, /src="\/warm-editorial\.js"/);
  assert.doesNotMatch(homepage, /href="\/(?:pricing|cafe-trial)(?:\.html)?/);
  assert.doesNotMatch(homepage, /Your first job and first hire are free\.|\$9\.99/);
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
  assert.match(home, /getCurrentContext/);
  assert.match(home, /Your first job and first hire are included\./);
  for (const route of ['/subscription', '/discover', '/profile', '/matches', '/messages']) {
    assert.ok(quietHome.includes(`router.push('${route}')`), `Missing native route ${route}`);
  }
  for (const copy of ['Good morning', 'Good afternoon', 'Good evening', 'Welcome back']) {
    assert.ok(greeting.includes(copy), `Missing greeting ${copy}`);
  }
  assert.ok(fs.existsSync(new URL('../mobile/assets/warm-editorial-cafe-v2.jpg', import.meta.url)));
});
