import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const consent=fs.readFileSync(new URL('../oauth/consent.html',import.meta.url),'utf8');
const gate=fs.readFileSync(new URL('../api/oauth-owner.js',import.meta.url),'utf8');

test('OAuth consent checks the owner gate before loading authorization details',()=>{
  const ownerIndex=consent.indexOf("fetch('/api/oauth-owner'");
  const detailsIndex=consent.indexOf('getAuthorizationDetails(authorizationId)');
  assert.ok(ownerIndex>=0);
  assert.ok(detailsIndex>ownerIndex);
  assert.match(consent,/restricted to the BaristaMatch owner/);
});

test('owner gate fails closed when the allowlisted owner is not configured',()=>{
  assert.match(gate,/BJM_AI_OFFICE_OWNER_USER_ID/);
  assert.match(gate,/status\(503\)/);
});

test('owner gate validates the Supabase session and exact user id',()=>{
  assert.match(gate,/\/auth\/v1\/user/);
  assert.match(gate,/SUPABASE_PUBLISHABLE_KEY/);
  assert.match(gate,/clean\(user\.id\) !== ownerUserId/);
  assert.match(gate,/status\(401\)/);
  assert.match(gate,/status\(403\)/);
});

test('owner gate contains no privileged Supabase key',()=>{
  assert.doesNotMatch(gate,/SUPABASE_SECRET_KEY/);
  assert.doesNotMatch(gate,/service_role/i);
  assert.doesNotMatch(gate,/sb_secret_/i);
});
