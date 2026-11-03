import test from 'node:test';
import assert from 'node:assert/strict';
import { createModerationNoticesHandler, OWNER_EMAIL, validateNoticeBatch } from '../server/moderation/noticeDelivery.mjs';
import { moderationNoticeRpc } from '../api/moderation-notices.js';

const CLAIM = '11111111-1111-4111-8111-111111111111';
const DELIVERY = '22222222-2222-4222-8222-222222222222';
const NOTICE1 = '33333333-3333-4333-8333-333333333333';
const NOTICE2 = '44444444-4444-4444-8444-444444444444';
const SECRET = 'offline_fixture_cron_secret_only_000000';
const NOW = Date.parse('2026-11-03T07:00:00Z');
const ENV = { VERCEL_ENV: 'production', CRON_SECRET: SECRET };
function batch() {
  return { claimId: CLAIM, deliveryId: DELIVERY, firstAttemptAt: '2026-11-03T06:00:00+00:00', items: [
    { noticeId: NOTICE2, eventType: 'media_pending', createdAt: '2026-11-03T05:30:00+00:00', dueAt: '2026-11-04T05:30:00+00:00' },
    { noticeId: NOTICE1, eventType: 'safety_report', createdAt: '2026-11-03T05:00:00+00:00', dueAt: '2026-11-04T05:00:00+00:00' },
  ] };
}
function response() {
  return { headers: {}, code: null, body: null, setHeader(k,v) { this.headers[k] = v; },
    status(n) { this.code = n; return this; }, json(v) { this.body = v; return this; } };
}
function harness(overrides = {}) {
  const events = [], emails = [], logs = [];
  const handler = createModerationNoticesHandler({
    env: ENV, clock: () => NOW, uuid: () => CLAIM,
    rpc: async (name,args) => { events.push({ name,args }); return name === 'claim_moderation_notices' ? batch() : args.p_delivered ? args.p_notice_ids.length : 0; },
    sendEmail: async (payload,key) => { emails.push({ payload,key }); return true; },
    log: (...args) => logs.push(args),
    ...overrides,
  });
  return { events, emails, logs, async run(req = {}) {
    const res = response();
    await handler({ method: 'GET', headers: { authorization: 'Bearer ' + SECRET }, ...req }, res);
    return res;
  } };
}

for (const header of [undefined, '', 'Bearer wrong', 'bearer ' + SECRET, ['Bearer ' + SECRET], 'Bearer ' + SECRET + '\n']) {
  test('unauthorized input never reaches database or mail: ' + String(header).slice(0,18), async () => {
    const h = harness(), r = await h.run({ headers: { authorization: header } });
    assert.equal(r.code,401); assert.equal(h.events.length,0); assert.equal(h.emails.length,0);
    assert.equal(r.headers['Cache-Control'],'private, no-store');
  });
}
test('preview and local execution cannot send even with a valid cron credential', async () => {
  for (const VERCEL_ENV of ['preview','development',undefined]) {
    const h=harness({ env:{...ENV,VERCEL_ENV} }),r=await h.run();
    assert.equal(r.code,404); assert.equal(h.events.length,0); assert.equal(h.emails.length,0);
  }
});
test('missing/short/malformed configured secret fails closed', async () => {
  for (const CRON_SECRET of [undefined,'short','x'.repeat(32)+'\n']) {
    const h=harness({env:{...ENV,CRON_SECRET}}),r=await h.run();
    assert.equal(r.code,401);assert.equal(h.events.length,0);
  }
});
test('only authenticated GET is accepted', async () => {
  const h=harness(),r=await h.run({method:'POST'});
  assert.equal(r.code,405);assert.equal(r.headers.Allow,'GET');assert.equal(h.events.length,0);
});
test('empty durable queue does not send or acknowledge anything', async () => {
  const calls=[],h=harness({rpc:async(name,args)=>{calls.push({name,args});return {claimId:CLAIM,deliveryId:null,firstAttemptAt:null,items:[]};}});
  const r=await h.run();assert.equal(r.code,200);assert.equal(r.body.notifiedItems,0);
  assert.equal(h.emails.length,0);assert.equal(calls.length,1);assert.equal(calls[0].args.p_limit,25);
});
test('one digest has fixed owner recipient and acknowledges the exact immutable items', async () => {
  const h=harness(),r=await h.run({query:{to:'attacker@example.invalid',limit:9999,from:'attacker@example.invalid'}});
  assert.equal(r.code,200);assert.equal(r.body.notifiedItems,2);assert.equal(h.emails.length,1);
  const e=h.emails[0];assert.deepEqual(e.payload.to,[OWNER_EMAIL]);assert.equal(e.key,'bjm/moderation/'+DELIVERY);
  assert.match(e.payload.text,/Safety reports: 1/);assert.match(e.payload.text,/Photos or videos: 1/);
  assert.match(e.payload.text,/Nov 4, 2026.*EST/);assert.match(e.payload.html,/<html lang="en">/);
  assert.doesNotMatch(JSON.stringify(e),/attacker/);
  assert.deepEqual(h.events[1],{name:'ack_moderation_notices',args:{p_claim_id:CLAIM,p_notice_ids:[NOTICE1,NOTICE2],p_delivered:true}});
});
test('untrusted report/member fields cannot enter the email or response', async () => {
  const claimed=batch();claimed.reportText='<script>private_customer_secret</script>';
  claimed.items[0].url='https://attacker.invalid/private';claimed.items[0].email='private@example.invalid';
  const h=harness({rpc:async(name,args)=>name==='claim_moderation_notices'?claimed:args.p_notice_ids.length}),r=await h.run();
  assert.equal(r.code,200);assert.doesNotMatch(JSON.stringify([h.emails,r.body]),/private_customer_secret|attacker|private@example/);
});
test('ambiguous send releases the lease without marking delivery', async () => {
  const calls=[],h=harness({rpc:async(name,args)=>{calls.push({name,args});return name==='claim_moderation_notices'?batch():0;},sendEmail:async()=>{throw new Error('private provider response');}});
  const r=await h.run();assert.equal(r.code,503);
  assert.equal(calls[1].args.p_delivered,false);assert.equal(h.logs.length,1);assert.deepEqual(h.logs[0],[]);
  assert.doesNotMatch(JSON.stringify(r.body),/private provider/);
});
test('retry after ambiguous send preserves identical provider key and payload across lease IDs', async () => {
  const sent=[];
  for (let n=0;n<2;n++) {
    const claim=n===0?CLAIM:'55555555-5555-4555-8555-555555555555';
    const x=batch();x.claimId=claim;if(n)x.items.reverse();
    const h=harness({uuid:()=>claim,clock:()=>NOW+n*3600000,rpc:async(name,args)=>name==='claim_moderation_notices'?x:args.p_notice_ids.length,
      sendEmail:async(payload,key)=>{sent.push({payload,key});return n===1;}});
    assert.equal((await h.run()).code,n===0?503:200);
  }
  assert.deepEqual(sent[0],sent[1]);
});
test('accepted send plus missing database acknowledgement is not reported as success', async () => {
  const h=harness({rpc:async(name)=>name==='claim_moderation_notices'?batch():0}),r=await h.run();
  assert.equal(h.emails.length,1);assert.equal(r.code,503);assert.equal(h.logs.length,1);
});
test('old uncertain batches cannot be sent beyond the idempotency horizon', async () => {
  const h=harness({clock:()=>Date.parse('2026-11-04T05:00:00Z')}),r=await h.run();
  assert.equal(r.code,503);assert.equal(h.emails.length,0);
});
test('malformed groups are never sent', async () => {
  const bad=[
    null,{...batch(),claimId:DELIVERY},{...batch(),deliveryId:'invalid'},
    {...batch(),items:[...batch().items,batch().items[0]]},
    {...batch(),items:[{...batch().items[0],eventType:'execute_instruction'}]},
    {...batch(),items:[{...batch().items[0],createdAt:'not a date'}]},
    {...batch(),items:[{...batch().items[0],dueAt:'2026-11-01T00:00:00Z'}]},
    {...batch(),items:Array(26).fill(batch().items[0])},
  ];
  for(const value of bad) {
    const h=harness({rpc:async()=>value}),r=await h.run();
    assert.equal(r.code,503);assert.equal(h.emails.length,0);
  }
});
test('database adapter rejects unknown destination and RPC before network access', async () => {
  const previous={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SECRET_KEY,fetch:globalThis.fetch};
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Unexpected network');};
  try {
    process.env.SUPABASE_URL='https://attacker.invalid';process.env.SUPABASE_SECRET_KEY='sb_secret_offline_fixture';
    await assert.rejects(moderationNoticeRpc('claim_moderation_notices',{}));
    process.env.SUPABASE_URL='https://lmwqrxoitraofaftpwhe.supabase.co';
    await assert.rejects(moderationNoticeRpc('delete_everything',{}));assert.equal(calls,0);
  } finally {
    if(previous.url===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previous.url;
    if(previous.key===undefined)delete process.env.SUPABASE_SECRET_KEY;else process.env.SUPABASE_SECRET_KEY=previous.key;
    globalThis.fetch=previous.fetch;
  }
});
test('new-format service key stays server-side and is not used as a JWT bearer', async () => {
  const previous={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SECRET_KEY,fetch:globalThis.fetch};
  const requests=[];globalThis.fetch=async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({claimId:CLAIM,items:[]}),{status:200});};
  try {
    process.env.SUPABASE_URL='https://lmwqrxoitraofaftpwhe.supabase.co';process.env.SUPABASE_SECRET_KEY='sb_secret_offline_fixture';
    const x=await moderationNoticeRpc('claim_moderation_notices',{p_claim_id:CLAIM,p_limit:25});
    assert.equal(x.claimId,CLAIM);assert.equal(requests.length,1);
    assert.equal(requests[0].options.headers.apikey,'sb_secret_offline_fixture');
    assert.equal(requests[0].options.headers.Authorization,undefined);
    assert.equal(requests[0].options.method,'POST');assert.equal(requests[0].options.redirect,'error');
    assert.match(requests[0].url,/\/rpc\/claim_moderation_notices$/);
  } finally {
    if(previous.url===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previous.url;
    if(previous.key===undefined)delete process.env.SUPABASE_SECRET_KEY;else process.env.SUPABASE_SECRET_KEY=previous.key;
    globalThis.fetch=previous.fetch;
  }
});
test('batch normalizer keeps output confined to the reviewed contract', () => {
  const clean=validateNoticeBatch(batch(),CLAIM,NOW);
  assert.deepEqual(Object.keys(clean),['claimId','deliveryId','firstAttemptAt','items','needsAttentionCount']);
  assert.deepEqual(Object.keys(clean.items[0]),['noticeId','eventType','createdAt','dueAt']);
});
test('a stalled delivery cannot become a silent empty-queue success', async () => {
  const h=harness({rpc:async()=>({claimId:CLAIM,items:[],needsAttentionCount:2})}),r=await h.run();
  assert.equal(r.code,503);assert.equal(r.body.needsAttentionCount,2);assert.equal(h.emails.length,0);
});
test('new notices still reach the owner when an older delivery needs manual attention', async () => {
  const x={...batch(),needsAttentionCount:1},h=harness({rpc:async(name,args)=>name==='claim_moderation_notices'?x:args.p_notice_ids.length}),r=await h.run();
  assert.equal(h.emails.length,1);assert.equal(r.body.notifiedItems,2);assert.equal(r.code,503);
});
test('maintenance failure never prevents notice delivery or claims a clean run', async () => {
  const h=harness({cleanup:async()=>{throw new Error('private_storage_path');}}),r=await h.run();
  assert.equal(h.emails.length,1);assert.equal(h.events[1].args.p_delivered,true);
  assert.equal(r.code,503);assert.equal(r.body.notifiedItems,2);assert.doesNotMatch(JSON.stringify(r.body),/private_storage_path/);
});
test('authenticated maintenance completes with bounded public counts only', async () => {
  const h=harness({cleanup:async()=>({ok:true,claimed:3,deleted:3})}),r=await h.run();
  assert.equal(r.code,200);assert.equal(r.body.cleanedStagingItems,3);assert.equal(r.body.notifiedItems,2);
});
test('unauthorized requests cannot trigger staging cleanup', async () => {
  let calls=0;const h=harness({cleanup:async()=>{calls++;return {ok:true,claimed:0,deleted:0};}});
  await h.run({headers:{authorization:'Bearer wrong'}});assert.equal(calls,0);
});
test('malformed cleanup results fail without leaking helper details', async () => {
  const h=harness({cleanup:async()=>({ok:true,claimed:1,deleted:999,path:'private'})}),r=await h.run();
  assert.equal(h.emails.length,1);assert.equal(r.code,503);assert.doesNotMatch(JSON.stringify(r.body),/path/);
});
