import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const mobileRoot = fileURLToPath(new URL('../mobile/', import.meta.url));
const requireMobile = createRequire(new URL('../mobile/package.json', import.meta.url));
const bounded = source => {
  const child = spawnSync(process.execPath, ['-e', source], { cwd: mobileRoot, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr || child.stdout);
};

test('developer-tool shell quoting rejects the advisory token sequence without executing a shell', () => {
  const quote = requireMobile('shell-quote');
  assert.equal(quote.quote(['editor', 'a b']), "editor 'a b'");
  for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(() => quote.quote(['echo', { comment: 'x' }, `a${terminator}id;#`]), TypeError);
  }
});

test('all installed brace-expansion majors preserve normal globs and bound nested/rewrite patterns', () => {
  bounded(`const assert=require('node:assert/strict');
    for(const name of ['brace-expansion','expo/node_modules/brace-expansion','@react-native/codegen/node_modules/brace-expansion','react-native/node_modules/brace-expansion','rimraf/node_modules/brace-expansion','test-exclude/node_modules/brace-expansion']) {
      const mod=require(require('node:path').resolve('node_modules',name)), expand=typeof mod==='function'?mod:mod.expand;
      assert.deepEqual(expand('file{a,b}.{js,ts}'),['filea.js','filea.ts','fileb.js','fileb.ts']);
      const nested='{'.repeat(3000)+'a,b'+'}'.repeat(3000);
      assert.ok(Array.isArray(expand(nested,{maxDepth:20,max:10,maxLength:100000})));
      const rewritten=expand('{a}'+'}'.repeat(10000)+',z}',{maxRewrites:2,max:10,maxLength:100000});
      assert.ok(rewritten.length<=10);
      assert.ok(rewritten.every(value=>value.length<=100000));
    }`);
});

for (const parent of ['@expo/xcpretty', '@istanbuljs/load-nyc-config']) {
  test(`${parent} YAML loader counts empty merge sources while preserving ordinary configuration`, () => {
    const fromParent = createRequire(requireMobile.resolve(`${parent}/package.json`));
    const yaml = fromParent('js-yaml');
    assert.deepEqual(yaml.load('name: cafe\nroles: [barista, owner]'), { name: 'cafe', roles: ['barista', 'owner'] });
    assert.throws(() => yaml.load('empty: &empty [{}, {}, {}, {}]\nmerged: { <<: *empty }', { maxTotalMergeKeys: 2 }), /maxTotalMergeKeys/);
  });
}

test('PostCSS source-map consumer rejects unbounded indexed offsets before iterating source lines', () => {
  const fromPostcss = createRequire(requireMobile.resolve('postcss/package.json'));
  const { SourceMapConsumer } = fromPostcss('source-map-js');
  const map = offset => ({ version: 3, sections: [{ offset: { line: offset, column: 0 }, map: { version: 3, sources: ['input.js'], names: [], mappings: 'AAAA' } }] });
  assert.throws(() => new SourceMapConsumer(map(100000001)), /offset line/);
  assert.throws(() => new SourceMapConsumer(map(-1)), /non-negative integers/);
  const mappings = []; new SourceMapConsumer(map(0)).eachMapping(mapping => mappings.push(mapping));
  assert.equal(mappings[0].originalLine, 1);
});

test('CLI compression releases the actual zlib stream on an aborted response without opening a listener', async () => {
  const zlib = requireMobile('node:zlib');
  const { EventEmitter } = requireMobile('node:events');
  const descriptor = Object.getOwnPropertyDescriptor(zlib, 'createGzip');
  const created = [];
  Object.defineProperty(zlib, 'createGzip', { ...descriptor, value: (...args) => { const stream = descriptor.value(...args); created.push(stream); return stream; } });
  try {
    const response = new EventEmitter();
    const headers = new Map([['content-type', 'text/plain']]);
    Object.assign(response, { statusCode: 200, headersSent: false, getHeader: name => headers.get(name.toLowerCase()), setHeader: (name, value) => headers.set(name.toLowerCase(), value), removeHeader: name => headers.delete(name.toLowerCase()), writeHead() { this.headersSent = true; }, write() { return true; }, end() {} });
    requireMobile('compression')({ threshold: 0 })({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, response, () => {});
    response.write('ordinary build-server response');
    assert.equal(created.length, 1);
    response.emit('close');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(created[0].destroyed, true);
  } finally { Object.defineProperty(zlib, 'createGzip', descriptor); for (const stream of created) stream.destroy(); }
});

test('patched tool graph still starts Expo CLI offline and initializes Metro without fetching anything', () => {
  const cli = requireMobile.resolve('expo/bin/cli');
  const child = spawnSync(process.execPath, [cli, '--version'], { cwd: mobileRoot, encoding: 'utf8', timeout: 5000, env: { ...process.env, EXPO_OFFLINE: '1', EXPO_NO_DOTENV: '1', CI: '1' } });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout.trim(), /^54\./);
  bounded(`const assert=require('node:assert/strict'); const {getDefaultConfig}=require('expo/metro-config');
    const config=getDefaultConfig(process.cwd()); assert.ok(config.resolver.assetExts.includes('png'));
    assert.equal(typeof require('undici').fetch,'function');`);
});
