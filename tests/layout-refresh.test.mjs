import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('homepage delivers the approved café photographs from isolated homepage assets', () => {
  const homepage = read('index.html');
  const approvedHero = '/homepage/assets/boutique-coffee-bar.webp';
  const preload = homepage.match(/<link\b(?=[^>]*rel="preload")(?=[^>]*as="image")[^>]*href="([^"]+)"/);
  const initialHero = homepage.match(/<img\b(?=[^>]*class="hero-photo")[^>]*src="([^"]+)"/);
  assert.equal(preload?.[1], approvedHero, 'preload the photo rendered by the hero');
  assert.equal(initialHero?.[1], approvedHero);

  const photos = [
    approvedHero,
    '/homepage/assets/uploaded-community-cafe.webp',
    '/homepage/assets/uploaded-audience-baristas.webp',
    '/homepage/assets/uploaded-audience-cafes.webp',
  ];
  for (const photo of photos) {
    const data = fs.readFileSync(new URL(`..${photo}`, import.meta.url));
    assert.ok(data.length > 1000, `${photo}: photo content exists`);
    assert.equal(data.toString('ascii', 0, 4), 'RIFF', `${photo}: RIFF container`);
    assert.equal(data.toString('ascii', 8, 12), 'WEBP', `${photo}: WebP format`);
    assert.equal(data.readUInt32LE(4) + 8, data.length, `${photo}: complete container`);
    assert.ok(['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16)), `${photo}: image chunk`);
  }
  assert.match(homepage, /class="final-image"[^>]*>\s*<img\b[^>]*src="\/homepage\/assets\/uploaded-community-cafe\.webp"/);
  assert.match(homepage, /<article\b[^>]*id="baristas"[^>]*>\s*<img\b[^>]*src="\/homepage\/assets\/uploaded-audience-baristas\.webp"/);
  assert.match(homepage, /<article\b[^>]*id="cafes"[^>]*>\s*<img\b[^>]*src="\/homepage\/assets\/uploaded-audience-cafes\.webp"/);

  const stylesheets = [...homepage.matchAll(/<link\b(?=[^>]*rel="stylesheet")[^>]*href="([^"]+)"/g)].map(([, path]) => path);
  const localScripts = [...homepage.matchAll(/<script\b[^>]*src="(\/[^\"]+)"/g)].map(([, path]) => path);
  assert.ok(stylesheets.length > 0);
  assert.ok(localScripts.some(path => path.startsWith('/homepage/')), 'homepage has its own runtime');
  for (const path of [...stylesheets, ...localScripts]) {
    assert.ok(path.startsWith('/homepage/') || path === '/analytics.js', `${path}: shared page resources stay isolated`);
    assert.ok(fs.existsSync(new URL(`..${path}`, import.meta.url)), `${path}: referenced asset exists`);
  }
});

test('public homepage keeps real account and section navigation without preview controls or public café pricing', () => {
  const homepage = read('index.html');
  const pageScripts = [...homepage.matchAll(/<script\b[^>]*src="(\/homepage\/[^\"]+)"/g)]
    .map(([, path]) => read(path.slice(1))).join('\n');
  assert.doesNotMatch(homepage + pageScripts, /preview-toolbar|preview-attribution|Choose a style|Three Homepage Motion Previews/);
  assert.doesNotMatch(homepage, /<meta\b(?=[^>]*name="robots")(?=[^>]*content="[^\"]*noindex)[^>]*>/i);
  assert.doesNotMatch(homepage, /href="\/(?:pricing|cafe-trial)(?:\.html)?/);
  assert.doesNotMatch(homepage, /Your first job and first hire are free\.|\$9\.99/);

  for (const id of ['how', 'baristas', 'cafes']) {
    assert.ok(homepage.includes(`href="#${id}"`), `${id}: section link exists`);
    assert.ok(homepage.includes(`id="${id}"`), `${id}: target section exists`);
  }
  for (const route of ['/login.html', '/dashboard.html', '/signup.html?role=barista', '/signup.html?role=cafe_owner_manager', '/support.html', '/privacy.html', '/terms.html']) {
    assert.ok(homepage.includes(`href="${route}"`), `${route}: real relative destination`);
    assert.ok(fs.existsSync(new URL(`..${route.split('?')[0]}`, import.meta.url)), `${route}: destination exists`);
  }
  for (const [, anchor] of homepage.matchAll(/(<a\b[^>]*href="[^\"]*(?:signup|login|dashboard|support|privacy|terms)\.html[^\"]*"[^>]*>)/g)) {
    assert.doesNotMatch(anchor, /target="_blank"|href="https?:/, 'account and support journeys remain in the current tab');
  }
  assert.match(homepage, /<a\b(?=[^>]*data-role="barista")(?=[^>]*href="\/signup\.html\?role=barista")[^>]*>/);
  assert.match(homepage, /<a\b(?=[^>]*data-role="cafe_owner_manager")(?=[^>]*href="\/signup\.html\?role=cafe_owner_manager")[^>]*>/);
  assert.match(homepage, /<button\b[^>]*data-open-role/);
  assert.match(homepage, /<dialog\b[^>]*id="role-dialog"/);
  assert.match(homepage, /<button\b(?=[^>]*id="mobile-menu")(?=[^>]*aria-controls="nav-links")[^>]*>/);
  assert.match(homepage, /<button\b(?=[^>]*data-pause-motion)(?=[^>]*aria-pressed=)[^>]*>/);
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
  assert.match(home, /Your first job, matches, and interview messaging are included\./);
  for (const route of ['/subscription', '/discover', '/profile', '/matches', '/messages']) {
    assert.ok(quietHome.includes(`router.push('${route}')`), `Missing native route ${route}`);
  }
  for (const copy of ['Good morning', 'Good afternoon', 'Good evening', 'Welcome back']) {
    assert.ok(greeting.includes(copy), `Missing greeting ${copy}`);
  }
  assert.ok(fs.existsSync(new URL('../mobile/assets/warm-editorial-cafe-v2.jpg', import.meta.url)));
});
