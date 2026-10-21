import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const excluded = read('.vercelignore').split(/\r?\n/)
  .filter((line) => line.startsWith('/')).map((line) => line.slice(1));
const ignored = (path) => excluded.some((entry) => entry.endsWith('/')
  ? path.startsWith(entry) : path === entry);
const walk = (path) => readdirSync(resolve(root, path), { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? walk(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);

test('browser policy blocks base injection, plugins and framing without restricting OAuth or Stripe loading', () => {
  const config = JSON.parse(read('vercel.json'));
  const headers = config.headers.find(({ source }) => source === '/(.*)').headers;
  const policy = headers.find(({ key }) => key.toLowerCase() === 'content-security-policy')?.value;
  assert.ok(policy, 'policy applies to all website routes');
  const directives = new Map(policy.split(';').map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
  assert.deepEqual(directives.get('base-uri'), ["'self'"]);
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
  assert.ok(directives.has('upgrade-insecure-requests'));
  // A restrictive script/connect/frame policy requires a separate full payment
  // and native bridge validation. This baseline does not claim XSS prevention.
  for (const directive of ['default-src', 'script-src', 'connect-src', 'frame-src']) {
    assert.equal(directives.has(directive), false, directive);
  }
  assert.equal(headers.find(({ key }) => key === 'Cross-Origin-Opener-Policy').value,
    'same-origin-allow-popups');
  assert.equal(config.headers.find(({ source }) => source === '/api/(.*)').headers
    .find(({ key }) => key === 'Cache-Control').value, 'no-store');
});

test('operational fixtures are excluded while every local server import remains deployable', () => {
  for (const path of ['tests/database/harness.mjs', 'ops/runbook.md',
    'scripts/native-release/prepare-test-storage.mjs', 'supabase/migrations/example.sql',
    '.github/workflows/website-security.yml', 'docs/seo/baseline.md']) {
    assert.equal(ignored(path), true, path);
  }
  for (const path of [...walk('api'), ...walk('server')].filter((path) => /\.[cm]?js$/.test(path))) {
    assert.equal(ignored(path), false, path);
    for (const [, specifier] of read(path).matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) {
      if (!specifier.startsWith('.')) continue;
      const target = relative(root, resolve(root, dirname(path), specifier));
      assert.equal(ignored(target), false, `${path} imports excluded ${target}`);
      assert.ok(existsSync(resolve(root, target)), `${path} imports missing ${target}`);
    }
  }
});

test('root page assets and Office build inputs remain included in the deployment context', () => {
  for (const path of readdirSync(root).filter((name) => name.endsWith('.html'))) {
    for (const [, value] of read(path).matchAll(/(?:src|href)\s*=\s*['"]([^'"]+)['"]/g)) {
      if (!value.startsWith('/') || value.startsWith('//')) continue;
      const asset = value.slice(1).split(/[?#]/)[0];
      if (!asset || asset.startsWith('api/')) continue;
      assert.equal(ignored(asset), false, `${path}: ${asset}`);
    }
  }
  for (const path of ['homepage/homepage.js', 'homepage/app-download.js',
    'bjm-ai-office/package.json', 'bjm-ai-office/package-lock.json',
    'server/native-billing/repository.mjs', 'api/support.js']) {
    assert.equal(ignored(path), false, path);
    assert.ok(existsSync(resolve(root, path)), path);
  }
});
