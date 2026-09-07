import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function validateStoreConfiguration(app, pkg, eas) {
  const errors = [];
  for (const platform of ['ios', 'android']) {
    const node = eas?.build?.production?.[platform]?.node ?? eas?.build?.production?.node;
    if (!/^\d+\.\d+\.\d+$/.test(node || '') || Number(node.split('.')[0]) < 22) errors.push(`Pin the ${platform} production Node.js builder to version 22+ for the installed Supabase client.`);
  }
  if (app?.ios?.bundleIdentifier !== 'com.baristajobmatch.app' || app?.android?.package !== 'com.baristajobmatch.app') errors.push('Store identifiers must match the registered BaristaMatch app.');
  if (app?.version !== pkg?.version) errors.push('Expo and package release versions differ.');
  const expoMajor = Number(/\d+/.exec(pkg?.dependencies?.expo || '')?.[0]);
  if (!Number.isInteger(expoMajor) || expoMajor < 54) errors.push('This Android release requires an Expo baseline targeting API 36 or later.');
  if (eas?.build?.production?.android?.buildType !== 'app-bundle') errors.push('Google Play production builds must use an Android App Bundle.');
  const image = eas?.build?.production?.ios?.image || '';
  const xcode = Number(/xcode-(\d+)/.exec(image)?.[1]);
  if (!Number.isInteger(xcode) || xcode < 26) errors.push('Pin the production iOS builder to a reviewed Xcode 26+ image.');
  for (const entry of app?.plugins || []) {
    if (Array.isArray(entry) && entry[0] === 'expo-build-properties') {
      const target = entry[1]?.android?.targetSdkVersion;
      if (target !== undefined && (!Number.isInteger(target) || target < 36)) errors.push('Android targetSdkVersion override is below API 36.');
    }
  }
  return errors;
}

export function verifyAppleToolchain(run = execFileSync) {
  const xcode = String(run('xcodebuild', ['-version'], { encoding: 'utf8', timeout: 15000 }));
  const sdk = String(run('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version'], { encoding: 'utf8', timeout: 15000 })).trim();
  const major = Number(/Xcode\s+(\d+)/.exec(xcode)?.[1]);
  if (!Number.isInteger(major) || major < 26 || !/^\d+(\.\d+)*$/.test(sdk) || Number(sdk.split('.')[0]) < 26) {
    throw new Error('App Store upload requires Xcode 26+ and the iPhoneOS 26+ SDK.');
  }
  return { xcodeMajor: major, iphoneosSdk: sdk };
}

export function main(environment = process.env) {
  const root = new URL('../', import.meta.url);
  const app = JSON.parse(readFileSync(new URL('app.json', root), 'utf8')).expo;
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const eas = JSON.parse(readFileSync(new URL('eas.json', root), 'utf8'));
  const errors = validateStoreConfiguration(app, pkg, eas);
  if (errors.length) throw new Error(errors.join('\n'));
  if (environment.EAS_BUILD_PROFILE === 'production' && environment.EAS_BUILD_PLATFORM === 'ios') {
    console.log('Verified Apple build tools:', verifyAppleToolchain());
  }
  console.log('Store configuration checks passed. Signed-binary validation, device tests, seller verification and store declarations are still required.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
