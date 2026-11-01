import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, basename, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = [
  'app.json', 'app.config.js', 'package.json', 'package-lock.json',
  'scripts/verify-store-toolchain.mjs', 'scripts/verify-ios-cng-archive.mjs',
  'scripts/fix-android-screen-removal.mjs',
  'plugins/with-android-font-layout.cjs', 'plugins/android-font-layout/backport.json',
  'plugins/with-ios-scene-lifecycle.cjs',
  'plugins/with-ios-deployment-target-floor.cjs',
  'plugins/scene-lifecycle/BaristaMatchSceneDelegate.swift',
  'plugins/with-ios-bundled-code.cjs',
  'plugins/ios-bundled-code/patches.json',
  'modules/baristamatch-storefront/ios/BaristaMatchStorefrontModule.swift',
];

const privateDirectories = new Set(['node_modules', '.git', '.expo', '.vercel', '.auth', '.sessions', '.aws', '.ssh', '.gnupg', '.codex', '.gradle', 'xcuserdata']);
const privateRootDirectories = ['review', 'artifacts', 'outputs', 'build-tools', 'ios-derived-data'];
function privateFilename(name) {
  return /^(?:credentials\.json|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i.test(name)
    || /^\.env(?:\..*)?$/i.test(name)
    || /\.(?:p12|pfx|p8|key|jks|keystore|mobileprovision|provisionprofile|keychain|keychain-db|xcuserstate)$/i.test(name)
    || /service[-_]?account.*\.json$/i.test(name)
    || /^(?:storage[-_]state|playwright-auth).*\.json$/i.test(name)
    || /^reviewer-.+-private-form\./i.test(name);
}
function assertNoPrivateArchivePaths(root, project) {
  const boundary = realpathSync(root);
  const privateParents = new Set([root, project]);
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const name = entry.name.toLowerCase();
      const privateRoot = privateParents.has(directory) && privateRootDirectories.includes(name);
      const projectState = ['.temp', '.branches'].includes(name) && basename(dirname(file)).toLowerCase() === 'supabase';
      if (privateRoot || privateDirectories.has(name) || projectState || privateFilename(entry.name)) {
        throw new Error(`Archive contains a private/local-state path: ${relative(root, file)}. No file contents were inspected.`);
      }
      if (entry.isSymbolicLink()) {
        let target;
        try { target = realpathSync(file); } catch { throw new Error(`Archive contains a broken symbolic link: ${relative(root, file)}.`); }
        const outside = relative(boundary, target);
        if (outside === '..' || outside.startsWith('../') || isAbsolute(outside)) throw new Error(`Archive symbolic link escapes its root: ${relative(root, file)}.`);
      } else if (entry.isDirectory()) visit(file);
    }
  }
  visit(root);
}

/** Read-only check of the ACTUAL source archive, before CNG generates ios/. */
export function verifyIosCngArchive(archiveRoot) {
  const root = realpathSync(resolve(archiveRoot));
  const rootProject = existsSync(join(root, 'app.json'));
  const mobileProject = existsSync(join(root, 'mobile/app.json'));
  if (rootProject && mobileProject) throw new Error('Archive has ambiguous root and mobile Expo projects; provide one reviewed app source root.');
  const selected = rootProject ? root : join(root, 'mobile');
  const project = existsSync(selected) ? realpathSync(selected) : selected;
  const projectRelative = relative(root, project);
  if (projectRelative === '..' || projectRelative.startsWith('../') || isAbsolute(projectRelative)) throw new Error('Archive project symbolic link escapes its root.');
  assertNoPrivateArchivePaths(root, project);
  if (existsSync(join(project, 'ios'))) throw new Error('Archive contains generated ios/. Regenerate through reviewed CNG; do not build this stale native tree.');
  for (const file of required) {
    if (!existsSync(join(project, file))) throw new Error(`iOS CNG archive is missing ${file}.`);
  }
  const app = JSON.parse(readFileSync(join(project, 'app.json'), 'utf8')).expo;
  for (const plugin of ['./plugins/with-ios-scene-lifecycle.cjs', './plugins/with-ios-bundled-code.cjs', './plugins/with-ios-deployment-target-floor.cjs']) {
    if (app.plugins.filter(value => value === plugin).length !== 1) throw new Error(`iOS archive must register ${plugin} exactly once.`);
  }
  const policy = JSON.parse(readFileSync(join(project, 'plugins/ios-bundled-code/patches.json'), 'utf8'));
  for (const pkg of policy.packages) {
    for (const file of pkg.files) {
      if (file.asset && !existsSync(join(project, 'plugins/ios-bundled-code', file.asset))) throw new Error(`iOS archive is missing policy asset ${file.asset}.`);
    }
  }
  return { passed: true, nativeIosExcluded: true, sceneAndBundlePolicyPresent: true, privateArchivePathsAbsent: true,
    version: app.version, proposedLocalBuildNumber: app.ios.buildNumber };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error('Usage: node scripts/verify-ios-cng-archive.mjs /path/to/actual/source-archive');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(verifyIosCngArchive(process.argv[2]), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
