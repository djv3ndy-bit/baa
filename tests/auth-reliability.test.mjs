import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiledModule = process.env.AUTH_CALLBACK_MODULE;
if (!compiledModule) throw new Error('AUTH_CALLBACK_MODULE is required');
const { MOBILE_AUTH_CALLBACK_PREFIX, MOBILE_AUTH_WEB_BRIDGE, parseMobileAuthCallback } = require(compiledModule);

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('accepts the canonical mobile callback and returns both session tokens', () => {
  const result = parseMobileAuthCallback(
    `${MOBILE_AUTH_CALLBACK_PREFIX}#access_token=access-value&refresh_token=refresh-value`,
  );
  assert.deepEqual(result, {
    ok: true,
    accessToken: 'access-value',
    refreshToken: 'refresh-value',
  });
});

test('rejects callback lookalikes and incomplete sessions', () => {
  assert.deepEqual(
    parseMobileAuthCallback('baristamatch://auth/callback.evil#access_token=a&refresh_token=b'),
    { ok: false, reason: 'invalid_callback' },
  );
  assert.deepEqual(
    parseMobileAuthCallback(`${MOBILE_AUTH_CALLBACK_PREFIX}#access_token=a`),
    { ok: false, reason: 'missing_session' },
  );
});

test('returns a generic provider error without exposing provider text', () => {
  const rawProviderMessage = 'private provider detail should not be displayed';
  const result = parseMobileAuthCallback(
    `${MOBILE_AUTH_CALLBACK_PREFIX}#error=access_denied&error_description=${encodeURIComponent(rawProviderMessage)}`,
  );
  assert.deepEqual(result, { ok: false, reason: 'provider_error' });
  assert.doesNotMatch(JSON.stringify(result), /private provider detail/);
});

test('mobile email signup uses the HTTPS bridge instead of an unhandled login deep link', () => {
  const signup = read('mobile/app/signup.tsx');
  assert.equal(MOBILE_AUTH_WEB_BRIDGE, 'https://www.baristajobmatch.com/mobile-auth-callback.html');
  assert.match(signup, /emailRedirectTo:\s*MOBILE_AUTH_WEB_BRIDGE/);
  assert.doesNotMatch(signup, /emailRedirectTo:\s*['"]baristamatch:\/\/login/);
});

test('the HTTPS bridge and cold-start route use the canonical callback contract', () => {
  const bridge = read('mobile-auth-callback.html');
  const callbackScreen = read('mobile/app/auth/callback.tsx');
  assert.match(bridge, /baristamatch:\/\/auth\/callback/);
  assert.match(callbackScreen, /parseMobileAuthCallback/);
  assert.match(callbackScreen, /Linking\.getInitialURL\(\)/);
  assert.match(callbackScreen, /Linking\.addEventListener\(['"]url['"]/);
  assert.match(callbackScreen, /supabase\.auth\.setSession/);
  assert.doesNotMatch(callbackScreen, /console\./);
  assert.doesNotMatch(callbackScreen, /error\.message/);
});

test('mobile session persistence and password recovery contracts remain enabled', () => {
  const client = read('mobile/lib/supabase.ts');
  const mobileReset = read('mobile/app/forgot-password.tsx');
  const webReset = read('reset-password.html');
  assert.match(client, /autoRefreshToken:\s*true/);
  assert.match(client, /persistSession:\s*true/);
  assert.match(client, /detectSessionInUrl:\s*false/);
  assert.match(mobileReset, /https:\/\/www\.baristajobmatch\.com\/reset-password/);
  assert.match(webReset, /PASSWORD_RECOVERY/);
  assert.match(webReset, /updateUser\(\{password/);
});

test('mobile callback code contains no server-side credential names', () => {
  const combined = [
    read('mobile/lib/authCallback.ts'),
    read('mobile/app/auth/callback.tsx'),
    read('mobile/app/signup.tsx'),
  ].join('\n');
  assert.doesNotMatch(combined, /service_role|SUPABASE_SECRET|STRIPE_SECRET|RESEND_API_KEY/i);
});
