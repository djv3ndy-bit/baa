import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Run against the current app to reproduce the failure, then the isolated
// proposal copy. No real service or credentials are used by these tests.
const root = process.env.BJM_TEST_APP_ROOT ? pathToFileURL(`${process.env.BJM_TEST_APP_ROOT}/`) : new URL('../../', import.meta.url);
const { authenticatedCafe } = await import(new URL('api/_billing.js', root));
const { default: billing } = await import(new URL('api/billing.js', root));
const request = { headers: { authorization: 'Bearer synthetic-session' } };

for (const status of [429, 500, 502, 503, 504]) {
  test(`provider HTTP ${status} is retryable and is not evidence of a signed-out account`, async t => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('Temporary failure', {status}); });
    await assert.rejects(authenticatedCafe(request), /temporarily unavailable/);
    assert.equal(requests, 1);
  });
}
for (const status of [401, 403]) {
  test(`invalid or denied session HTTP ${status} still denies access`, async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', {status}));
    assert.equal(await authenticatedCafe(request), null);
  });
}
test('missing session still denies access without a request', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('Unexpected network request'); });
  assert.equal(await authenticatedCafe({headers:{}}), null);
});
for (const role of ['barista','cafe_owner_manager']) {
  test(`successful verification preserves ${role} permissions`, async t => {
    t.mock.method(globalThis, 'fetch', async input => new Response(JSON.stringify(String(input).includes('/auth/v1/user')
      ? {id:'synthetic-user'} : [{role,cafe_name:'Synthetic test café',suspended_at:null}])));
    const account = await authenticatedCafe(request);
    assert.equal(account?.profile?.role ?? null, role==='barista'?null:role);
  });
}
for (const [action,method,expected] of [['status','GET',503],['checkout','POST',502]]) {
  test(`${action} uses its existing recovery response for a provider outage`, async t => {
    const prior = {BILLING_ENABLED:process.env.BILLING_ENABLED,STRIPE_MONTHLY_PRICE_ID:process.env.STRIPE_MONTHLY_PRICE_ID};
    process.env.BILLING_ENABLED='true';process.env.STRIPE_MONTHLY_PRICE_ID='price_synthetic';
    t.after(()=>{for(const [key,value] of Object.entries(prior)) value===undefined?delete process.env[key]:process.env[key]=value;});
    t.mock.method(globalThis,'fetch',async()=>new Response('Gateway timeout',{status:504}));
    t.mock.method(console,'error',()=>{});
    const response = {code:0,body:null,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await billing({...request,method,query:{action},body:{},async *[Symbol.asyncIterator](){yield Buffer.from('{}');}},response);
    assert.equal(response.code,expected);
    assert.doesNotMatch(response.body.error,/log in|Gateway|504/);
    assert.match(response.body.error,/temporarily unavailable|try again/);
  });
}
