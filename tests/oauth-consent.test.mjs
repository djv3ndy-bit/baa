import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const consent=fs.readFileSync(new URL('../oauth/consent.html',import.meta.url),'utf8');
const login=fs.readFileSync(new URL('../login.html',import.meta.url),'utf8');

test('OAuth consent page uses Supabase authorization APIs',()=>{
  assert.match(consent,/getAuthorizationDetails\(authorizationId\)/);
  assert.match(consent,/approveAuthorization/);
  assert.match(consent,/denyAuthorization/);
  assert.match(consent,/authorization_id/);
});

test('OAuth consent page requires an authenticated user',()=>{
  assert.match(consent,/client\.auth\.getUser\(\)/);
  assert.match(consent,/location\.replace\(safeLoginRedirect\(\)\)/);
});

test('OAuth consent page does not embed privileged credentials',()=>{
  assert.doesNotMatch(consent,/service_role/i);
  assert.doesNotMatch(consent,/sb_secret_/i);
  assert.doesNotMatch(consent,/SUPABASE_SECRET_KEY/);
});

test('login only honors local OAuth consent return targets',()=>{
  assert.match(login,/requestedReturnTo\.startsWith\('\/oauth\/consent\?authorization_id='\)/);
  assert.match(login,/location\.replace\(returnTo\)/);
  assert.doesNotMatch(login,/location\.replace\(requestedReturnTo\)/);
});

test('login, dashboard and OAuth consent share the same Supabase auth storage key',()=>{
  const dashboard=fs.readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
  const pages=[login,dashboard,consent];
  for(const page of pages){
    assert.match(page,/hostname\.split\('\.'\)\[0\]\}-auth-token/);
    assert.match(page,/createClient\(config\.supabaseUrl,\s*config\.supabasePublishableKey,\s*\{\s*auth:\s*\{\s*storageKey:\s*authStorageKey\s*\}\s*\}\)/);
  }
});

test('OAuth consent still enforces owner gate before reading authorization details',()=>{
  const ownerGate=consent.indexOf("fetch('/api/oauth-owner'");
  const authDetails=consent.indexOf('getAuthorizationDetails(authorizationId)');
  assert.ok(ownerGate>0 && authDetails>ownerGate);
});
