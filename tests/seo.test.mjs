import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const origin = 'https://www.baristajobmatch.com';
const publicPages = new Map([
  ['index.html', '/'], ['support.html', '/support'], ['privacy.html', '/privacy'],
  ['terms.html', '/terms'], ['delete-account.html', '/delete-account'],
]);
const utilityPages = [
  'account-deleted', 'cafe-trial', 'checkout', 'dashboard', 'login',
  'mobile-auth-callback', 'mobile-auth-start', 'mobile-billing-return',
  'owner-accounts', 'owner-audience', 'owner-dashboard', 'owner-growth',
  'owner-marketplace', 'owner-subscriptions', 'pricing', 'reset-password',
  'signup', 'support-admin', 'verify-email',
].map((name) => `${name}.html`);
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))]
  .map(([tag]) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)]
    .map(([, key, value]) => [key.toLowerCase(), value])));
const head = (html) => html.slice(0, html.indexOf('</head>'));
const meta = (html, name) => tags(head(html), 'meta').filter((tag) => (tag.name || tag.property) === name);
const canonicals = (html) => tags(head(html), 'link').filter((tag) => tag.rel === 'canonical');

test('every root HTML page has an explicit indexing classification', () => {
  const actual = readdirSync(root).filter((name) => name.endsWith('.html')).sort();
  assert.deepEqual(actual, [...publicPages.keys(), ...utilityPages].sort());
  for (const file of utilityPages) {
    const robots = meta(read(file), 'robots');
    assert.equal(robots.length, 1, `${file}: exactly one robots rule`);
    assert.ok(robots[0].content.split(',').map((s) => s.trim()).includes('noindex'), file);
  }
});

test('sitemap resolves only to canonical, indexable, existing public documents', () => {
  const xml = read('sitemap.xml');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  assert.match(xml, /<\/urlset>\s*$/);
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, url]) => url);
  assert.equal(new Set(urls).size, urls.length, 'no duplicate URLs');
  assert.deepEqual([...urls].sort(), [...publicPages.values()].map((route) => origin + route).sort());
  const config = JSON.parse(read('vercel.json'));
  assert.equal(config.cleanUrls, true);
  assert.equal(config.trailingSlash, false);
  for (const [file, route] of publicPages) {
    const html = read(file);
    assert.deepEqual(canonicals(html).map((tag) => tag.href), [origin + route], file);
    assert.ok(!meta(html, 'robots').some((tag) => /noindex|none/.test(tag.content)), file);
    assert.ok(!config.redirects.some((rule) => rule.source === route), `${route}: not a redirect`);
    assert.equal((head(html).match(/<title>[^<]+<\/title>/g) || []).length, 1, file);
    assert.equal(meta(html, 'description').length, 1, file);
    assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1, file);
  }
  assert.doesNotMatch(xml, /<lastmod>|<priority>|<changefreq>/, 'no invented freshness or priority');
});

test('robots advertises the canonical sitemap while allowing page noindex directives to be read', () => {
  const robots = read('robots.txt');
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Allow: \/\s/);
  assert.match(robots, new RegExp(`Sitemap: ${origin.replaceAll('.', '\\.')}/sitemap\\.xml`));
  const disallows = [...robots.matchAll(/^Disallow:\s*(.+)$/gm)].map(([, rule]) => rule.trim());
  assert.deepEqual(disallows, ['/api/']);
  assert.doesNotMatch(robots, /^Noindex:/im);
});

test('social metadata uses the canonical homepage and an existing approved image', () => {
  const html = read('index.html');
  assert.equal(meta(html, 'og:url')[0]?.content, canonicals(html)[0]?.href);
  assert.equal(meta(html, 'og:type')[0]?.content, 'website');
  assert.equal(meta(html, 'twitter:card')[0]?.content, 'summary_large_image');
  for (const name of ['og:title', 'og:description', 'og:image', 'og:image:alt',
    'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt']) {
    assert.equal(meta(html, name).length, 1, name);
    assert.ok(meta(html, name)[0].content.length, name);
  }
  const image = new URL(meta(html, 'og:image')[0].content);
  assert.equal(image.origin, origin);
  assert.ok(existsSync(fileURLToPath(new URL(image.pathname.slice(1), root))));
  assert.equal(meta(html, 'twitter:image')[0].content, image.href);
});

test('example cards and utility pages do not advertise fabricated JobPosting schema', () => {
  for (const file of [...publicPages.keys(), ...utilityPages]) {
    const html = read(file);
    assert.doesNotMatch(html, /["']@type["']\s*:\s*["']JobPosting["']/, file);
    assert.doesNotMatch(html, /itemtype=["']https?:\/\/schema.org\/JobPosting["']/, file);
  }
  for (const route of ['barista-jobs/miami-fl.html', 'barista-jobs/fort-lauderdale-fl.html']) {
    assert.ok(!existsSync(new URL(route, root)), 'city pages require the separate content/data gate');
  }
});

test('baseline evidence and audit runner are excluded from website deployment', () => {
  const ignored = read('.vercelignore').split(/\r?\n/);
  for (const path of ['/docs/seo/', '/scripts/seo-baseline.py', '/tests/seo.test.mjs']) {
    assert.ok(ignored.includes(path), path);
  }
});
