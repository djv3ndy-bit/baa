import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTypescript } from './approved-update/load-typescript.mjs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const jsx = (type, props) => ({ type, props });
function signupCopy(role) {
  const { default: SignupScreen } = loadTypescript('mobile/app/signup.tsx', {
    react: { useCallback: fn => fn, useRef: value => ({ current: value }), useState: value => [value, () => {}] },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'react-native': { Alert: {}, KeyboardAvoidingView: 'keyboard', Linking: {}, Platform: { OS: 'android' }, Pressable: 'button',
      SafeAreaView: 'safe', ScrollView: 'scroll', Text: 'text', TextInput: 'input', View: 'view', StyleSheet: { create: value => value } },
    'expo-router': { router: {}, useFocusEffect: () => {}, useLocalSearchParams: () => ({ role }) },
    '@/lib/supabase': { supabase: {} }, '@/lib/authCallback': {},
    '@/lib/session': { savedAppRole: value => ['barista', 'cafe_owner_manager'].includes(value) ? value : null },
    '@/lib/floridaLocation': {}, '@/lib/productEvents': {},
  });
  const parts = [];
  function walk(value) {
    if (typeof value === 'string' || typeof value === 'number') { parts.push(String(value)); return; }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    walk(value.props?.children);
  }
  walk(SignupScreen()); return parts.join(' ');
}
test('native signup shows free barista terms and paid monthly café terms for the selected role', () => {
  const barista = signupCopy('barista'), cafe = signupCopy('cafe_owner_manager'), unselected = signupCopy(undefined);
  assert.match(barista, /Baristas stay free/); assert.match(barista, /without a subscription/);
  assert.doesNotMatch(barista, /\$9\.99|Founder Pro/);
  assert.match(cafe, /Post your first job free/); assert.match(cafe, /A second job requires Founder Pro at \$9\.99\/month/);
  assert.match(cafe, /No annual plan/); assert.match(unselected, /Baristas stay free/); assert.match(unselected, /Cafés can post their first job free/);
  for(const text of [barista,cafe,unselected]) assert.doesNotMatch(text,/\$0.*forever/i);
});
test('preserved café plan describes the first free job without a forever pricing promise', () => {
  const source = read('mobile/app/subscription.tsx');
  assert.match(source, /for your first job/); assert.doesNotMatch(source, /forever/);
});
test('Android catalog and Apple-only review safety remain fail-closed', () => {
  const { approvedStorePlan } = loadTypescript('mobile/features/native-subscription/storeCatalog.ts');
  assert.equal(approvedStorePlan('android'), null); assert.equal(approvedStorePlan('ios').prices.USD, 9.99);
  const guard = read('mobile/features/review-mode/reviewPurchaseGuard.ts');
  assert.match(guard, /transaction\?\.environment !== 'Sandbox'/);
  assert.match(guard, /transaction\.bundleId !== 'com\.baristajobmatch\.app'/);
  const config = read('server/native-billing/google-play.env.example');
  assert.match(config, /^NATIVE_GOOGLE_PURCHASES_ENABLED=false$/m);
  for (const key of ['GOOGLE_PLAY_PRODUCT_ID','GOOGLE_PLAY_BASE_PLAN_ID','GOOGLE_PLAY_SERVICE_ACCOUNT_JSON']) assert.match(config, new RegExp(`^${key}=$`, 'm'));
});
test('both Vercel projects disable Git deployments for only the billing preparation branch', () => {
  for (const file of ['vercel.json', 'bjm-ai-office/vercel.json']) {
    const config = JSON.parse(read(file));
    assert.equal(config.git.deploymentEnabled['fix/android-billing-release-prep'], false);
    assert.equal(config.git.deploymentEnabled.main, undefined);
    assert.equal(config.git.deploymentEnabled['*'], undefined);
    assert.ok(!Object.hasOwn(config.git, 'deploymentDisabled'));
  }
});
