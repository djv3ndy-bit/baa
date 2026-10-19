import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root));

test('the Android callback and every same-origin dependency are in the default public output', () => {
  const callback = read('public/mobile-auth-callback.html');
  assert.deepEqual(callback, read('mobile-auth-callback.html'));
  const html = callback.toString();
  const dependencies = [...html.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)].map(match => match[1]);
  assert.deepEqual(dependencies.sort(), ['/analytics.js', '/assets/favicon-transparent-v2.png']);
  for (const dependency of dependencies) {
    assert.deepEqual(read(`public${dependency}`), read(dependency.slice(1)));
  }
  assert.match(html, /baristamatch:\/\/auth\/callback/);
  assert.doesNotMatch(html, /lmwqrxoitraofaftpwhe|SUPABASE|service_role|outputDirectory/);
});
