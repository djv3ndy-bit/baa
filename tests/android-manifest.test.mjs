import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../mobile/scripts/verify-android-manifest.py', import.meta.url));
const manifest = (target='36', extra='', pkg='com.baristajobmatch.app') => `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${pkg}"><uses-sdk android:minSdkVersion="24" android:targetSdkVersion="${target}"/><uses-permission android:name="android.permission.INTERNET"/>${extra}<application/></manifest>`;
function run(xml) {
  const dir=mkdtempSync(join(tmpdir(),'bjm-manifest-'));
  try {const file=join(dir,'AndroidManifest.xml');writeFileSync(file,xml);return spawnSync('python3',[script,file],{encoding:'utf8'});}
  finally {rmSync(dir,{recursive:true,force:true});}
}
test('merged Android manifest passes required target/package without claiming signed or device verification',()=>{
  const r=run(manifest());assert.equal(r.status,0,r.stderr);const report=JSON.parse(r.stdout);
  assert.equal(report.target_sdk,36);assert.equal(report.signed_binary_checked,false);assert.equal(report.physical_device_tested,false);
});
for(const target of ['35','unknown',''])test(`rejects invalid target ${target}`,()=>assert.notEqual(run(manifest(target)).status,0));
for(const name of ['READ_MEDIA_IMAGES','READ_MEDIA_VIDEO','READ_MEDIA_AUDIO','READ_EXTERNAL_STORAGE','WRITE_EXTERNAL_STORAGE','CAMERA','RECORD_AUDIO'])test(`rejects merged ${name}`,()=>{
  assert.notEqual(run(manifest('36',`<uses-permission android:name="android.permission.${name}"/>`)).status,0);
});
test('rejects wrong app and malformed manifests',()=>{
  assert.notEqual(run(manifest('36','','com.example.other')).status,0);
  assert.notEqual(run('<manifest>').status,0);
});
