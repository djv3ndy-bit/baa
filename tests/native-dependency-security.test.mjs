import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const mobileRoot = fileURLToPath(new URL('../mobile/', import.meta.url));
const requireMobile = createRequire(new URL('../mobile/package.json', import.meta.url));
const queryString = requireMobile('query-string');
const isolated = source => {
  const child = spawnSync(process.execPath, ['-e', source], { cwd: mobileRoot, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return child.stdout;
};

test('navigation resolves the fixed callable CJS decoder and keeps query-string 7 compatibility', () => {
  const consumerRequire = createRequire(requireMobile.resolve('query-string'));
  assert.equal(consumerRequire.resolve('decode-uri-component'), requireMobile.resolve('decode-uri-component'));
  assert.equal(typeof consumerRequire('decode-uri-component'), 'function');
  assert.equal(requireMobile('decode-uri-component/package.json').version, '0.5.0');
  assert.deepEqual({ ...queryString.parse('name=caf%C3%A9+team&literal=a%2Bb&bad=%FE%FF') }, { bad: '\uFFFD\uFFFD', literal: 'a+b', name: 'café team' });
  const values = { token: 'a+b/c=', city: 'St. Petersburg', list: ['a', 'b'] };
  assert.deepEqual({ ...queryString.parse(queryString.stringify(values)) }, values);
});

test('malformed deep-link input completes within a bounded subprocess instead of exponential decoding', () => {
  isolated(`const assert=require('node:assert/strict'); const q=require('query-string');
    const input='%C0%AE'.repeat(20000)+'%41'; const decoded=q.parse('bad='+input);
    assert.equal(decoded.bad,'%C0%AE'.repeat(20000)+'A');
    assert.equal(q.parse('other=%F0%9F%92%A9').other,'💩');`);
});

test('published UUID security fix preserves Xcode project ID generation', () => {
  assert.equal(requireMobile('uuid/package.json').version, '11.1.1');
  const project = requireMobile('xcode').project('/tmp/synthetic-project.pbxproj');
  project.hash = { project: { objects: {} } };
  const generated = new Set(Array.from({ length: 100 }, () => project.generateUuid()));
  assert.equal(generated.size, 100);
  for (const id of generated) assert.match(id, /^[0-9A-F]{24}$/);
});

test('PostCSS remains callable through the Expo default API and no longer auto-loads a map without from', async () => {
  const postcss = requireMobile('postcss');
  assert.equal(requireMobile('postcss/package.json').version, '8.5.23');
  const result = await postcss.default([{ postcssPlugin: 'compatibility-test', Declaration(declaration) { if (declaration.prop === 'color') declaration.value = 'brown'; } }]).process('a { color: red; }', { from: 'synthetic.css', map: false });
  assert.equal(result.css, 'a { color: brown; }');
  const parsed = postcss.parse('a { color: red; }\n/*# sourceMappingURL=/tmp/should-not-be-read.map */');
  assert.equal(parsed.source.input.map, undefined);
});

for (const entry of ['./metro.config.js', './scripts/safe-metro-transformer.cjs']) {
  test(`${entry} blocks affected build formats in its own process while preserving normal asset Buffer and path APIs`, () => {
    isolated(`const assert=require('node:assert/strict'); const fs=require('node:fs');
      const entry=require(${JSON.stringify(entry)}); if (${JSON.stringify(entry)}.includes('transformer')) assert.equal(typeof entry.transform,'function');
      const imageSize=require('image-size'); const asset=require('node:path').resolve('assets/website-favicon.png');
      const bytes=fs.readFileSync(asset); const fromBytes=imageSize(bytes), fromPath=imageSize(asset);
      assert.equal(fromBytes.width,fromPath.width); assert.equal(fromBytes.height,fromPath.height);
      assert.ok(fromBytes.width>0 && fromBytes.height>0);
      const icns=Buffer.alloc(16); icns.write('icns'); icns.writeUInt32BE(16,4); icns.write('icp4',8);
      const heif=Buffer.alloc(16); heif.write('ftyp',4); heif.write('heic',8);
      const jxl=Buffer.alloc(40); jxl.writeUInt32BE(12,0); jxl.write('JXL ',4); jxl.writeUInt32BE(20,12); jxl.write('ftyp',16); jxl.write('jxl ',20); jxl.write('jxlp',36);
      for(const crafted of [icns,heif,jxl]) assert.throws(()=>imageSize(crafted),/disabled file type/);
      const {getAssetSize,getAssetData}=require('metro/private/Assets');
      assert.deepEqual(getAssetSize('png',bytes,asset),{width:fromBytes.width,height:fromBytes.height});
      getAssetData(asset,'website-favicon.png',[],'ios','/assets').then(data=>{
        assert.equal(data.width,fromBytes.width); assert.equal(data.height,fromBytes.height);
      }).catch(error=>{console.error(error);process.exitCode=1});`);
  });
}

test('Expo and React Native versions stay on the existing supported release line', () => {
  const lock = JSON.parse(readFileSync(new URL('../mobile/package-lock.json', import.meta.url), 'utf8'));
  assert.match(lock.packages['node_modules/expo'].version, /^54\./);
  assert.equal(lock.packages['node_modules/react-native'].version, '0.81.5');
  assert.match(lock.packages['node_modules/expo-router'].version, /^6\./);
});
