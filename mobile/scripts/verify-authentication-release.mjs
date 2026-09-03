import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  check(fs.existsSync(absolutePath), `Missing required file: ${relativePath}`);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function readJson(relativePath) {
  const source = read(relativePath);
  try {
    return JSON.parse(source);
  } catch {
    failures.push(`Invalid JSON: ${relativePath}`);
    return {};
  }
}

function includes(source, expected, label) {
  check(source.includes(expected), `${label} must include: ${expected}`);
}

function excludes(source, forbidden, label) {
  check(!source.includes(forbidden), `${label} must not include: ${forbidden}`);
}

function sourceFiles(directory) {
  const absoluteDirectory = path.join(root, directory);
  if (!fs.existsSync(absoluteDirectory)) return [];
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) ? [relative] : [];
  });
}

const app = readJson('app.json');
const eas = readJson('eas.json');
const packageJson = readJson('package.json');
const authCallback = read('lib/authCallback.ts');
const callbackScreen = read('app/auth/callback.tsx');
const signupScreen = read('app/signup.tsx');
const releaseWorkflow = read('.eas/workflows/authentication-ios-testflight.yml');

check(app.expo?.scheme === 'baristamatch', 'The registered mobile scheme must remain baristamatch.');
check(app.expo?.ios?.bundleIdentifier === 'com.baristajobmatch.app', 'The iOS bundle identifier must remain com.baristajobmatch.app.');
check(app.expo?.extra?.eas?.projectId === 'faef8923-6780-4373-bb0b-c789e3eb1bcc', 'The release must target the existing BaristaMatch EAS project.');
check(app.expo?.updates?.url === 'https://u.expo.dev/faef8923-6780-4373-bb0b-c789e3eb1bcc', 'The Expo Updates URL must target the existing BaristaMatch EAS project.');
check(app.expo?.runtimeVersion?.policy === 'appVersion', 'The runtime version policy must remain appVersion.');
check(app.expo?.ios?.infoPlist?.ITSAppUsesNonExemptEncryption === false, 'The existing iOS export-compliance declaration must remain explicit.');
check(app.expo?.version === packageJson.version, 'app.json and package.json must use the same public app version.');

check(eas.cli?.appVersionSource === 'remote', 'EAS must manage the iOS build number remotely.');
check(eas.build?.production?.autoIncrement === true, 'The production build must auto-increment its build number.');
check(eas.build?.production?.channel === 'production', 'The production build must remain on the production update channel.');
check(eas.build?.production?.environment === 'production', 'The production build must use the production EAS environment.');
check(eas.submit?.production?.ios?.ascAppId === '6807117736', 'The TestFlight submission must target the existing App Store Connect app.');

includes(authCallback, "MOBILE_AUTH_CALLBACK_PREFIX = 'baristamatch://auth/callback'", 'Authentication callback parser');
includes(authCallback, "MOBILE_AUTH_WEB_BRIDGE = 'https://www.baristajobmatch.com/mobile-auth-callback.html'", 'Authentication callback parser');
includes(authCallback, 'export function parseMobileAuthCallback', 'Authentication callback parser');
includes(authCallback, "reason: 'invalid_callback' | 'provider_error' | 'missing_session'", 'Authentication callback parser');

includes(callbackScreen, 'parseMobileAuthCallback', 'Authentication callback screen');
includes(callbackScreen, 'supabase.auth.setSession', 'Authentication callback screen');
includes(callbackScreen, "router.replace('/home')", 'Authentication callback screen');
includes(callbackScreen, "supabase.auth.signOut({ scope: 'local' })", 'Authentication callback screen');
excludes(callbackScreen, 'console.log', 'Authentication callback screen');
excludes(callbackScreen, 'error_description', 'Authentication callback screen');

includes(signupScreen, 'emailRedirectTo: MOBILE_AUTH_WEB_BRIDGE', 'Mobile signup');
includes(signupScreen, "email.trim().toLowerCase()", 'Mobile signup');
excludes(signupScreen, "emailRedirectTo:'baristamatch://login'", 'Mobile signup');

includes(releaseWorkflow, 'workflow_dispatch:', 'TestFlight workflow');
includes(releaseWorkflow, 'default: HOLD', 'TestFlight workflow');
includes(releaseWorkflow, "github.ref_name == 'main'", 'TestFlight workflow');
includes(releaseWorkflow, 'github.sha == inputs.release_sha', 'TestFlight workflow');
includes(releaseWorkflow, 'type: require-approval', 'TestFlight workflow');
includes(releaseWorkflow, 'type: build', 'TestFlight workflow');
includes(releaseWorkflow, 'type: testflight', 'TestFlight workflow');
includes(releaseWorkflow, 'submit_beta_review: false', 'TestFlight workflow');
excludes(releaseWorkflow, '\n  push:', 'TestFlight workflow');
excludes(releaseWorkflow, 'external_groups:', 'TestFlight workflow');

const forbiddenRuntimeSecrets = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_RESTRICTED_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'EXPO_TOKEN',
];

for (const relativePath of [...sourceFiles('app'), ...sourceFiles('lib')]) {
  const source = read(relativePath);
  for (const forbidden of forbiddenRuntimeSecrets) {
    excludes(source, forbidden, `Mobile runtime source ${relativePath}`);
  }
}

if (failures.length) {
  console.error(`Authentication release verification failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):`);
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Authentication release verification passed: ${checks} guarded checks.`);
console.log(`App version ${app.expo.version}; iOS build number will auto-increment remotely for TestFlight.`);
