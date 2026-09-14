import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const cafe='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',barista='00000000-0000-4000-8000-000000000003';
const claim='10000000-0000-4000-8000-000000000001',claim2='10000000-0000-4000-8000-000000000002',hash='a'.repeat(64);
let db,binding,otherBinding;
const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0];
before(async()=>{
 db=new PGlite(); await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create table public.profiles(id uuid primary key,role text,suspended_at timestamptz);insert into public.profiles values('${cafe}','cafe_owner_manager',null),('${other}','cafe_owner_manager',null),('${barista}','barista',null);`);
 await db.exec(readFileSync(new URL('../../review/native-billing-ledger.sql',import.meta.url),'utf8'));
 binding=await scalar('select public.native_billing_account($1)',[cafe]); otherBinding=await scalar('select public.native_billing_account($1)',[other]);
});
beforeEach(async()=>{await db.exec('reset role;truncate private.native_billing_subscriptions,private.native_billing_events;')});
after(async()=>db?.close());
async function apply(overrides={}){
 const p={user:cafe,binding,provider:'apple',environment:'Sandbox',id:'original',product:'test.monthly',transaction:'transaction-a',status:'active',end:'2099-01-01T00:00:00Z',grace:null,renews:true,revision:0,...overrides};
 return scalar('select public.native_billing_apply($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',Object.values(p));
}
const access=(user=cafe,environment='Sandbox')=>scalar('select public.native_billing_access($1,$2)',[user,environment]);
const event=(who=claim,eventHash=hash)=>scalar("select public.native_billing_claim_event('apple','Sandbox','event-a',$1,$2)",[eventHash,who]);
const finish=(who=claim,success=true)=>scalar("select public.native_billing_finish_event('apple','Sandbox','event-a',$1,$2)",[who,success]);
test('only saved active café accounts get stable opaque store bindings',async()=>{
 assert.equal(await scalar('select public.native_billing_account($1)',[cafe]),binding);assert.notEqual(binding,cafe);assert.notEqual(binding,otherBinding);
 await assert.rejects(scalar('select public.native_billing_account($1)',[barista]),/active cafe/);
});
test('anonymous and authenticated clients cannot grant entitlements or read financial ownership',async()=>{
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(access(),/permission denied/);await assert.rejects(db.query('select * from private.native_billing_accounts'),/permission denied/);await db.exec('reset role');}
});
test('sandbox entitlements cannot activate production access',async()=>{
 assert.equal(await apply(),'applied');assert.equal(await access(),true);assert.equal(await access(cafe,'Production'),false);assert.equal(await access(other),false);
});
test('receipt ownership cannot be transferred by restoration or account switching',async()=>{
 await apply();await assert.rejects(apply({user:other,binding:otherBinding,revision:1}),/another account/);await assert.rejects(apply({binding:otherBinding}),/ownership/);
});
test('duplicate effects are suppressed and stale verification must refetch',async()=>{
 await apply();assert.equal(await apply(),'retry');assert.equal(await apply({revision:1}),'duplicate');
 assert.equal(await apply({revision:1,status:'revoked'}),'applied');assert.equal(await apply({revision:1,status:'active'}),'retry');assert.equal(await access(),false);
});
test('expiration is enforced by time even before a notification arrives',async()=>{
 await apply({end:'2001-01-01T00:00:00Z'});assert.equal(await access(),false);
});
test('verified grace access is retained but expired grace is not',async()=>{
 await apply({status:'grace',end:'2001-01-01T00:00:00Z',grace:'2099-01-01T00:00:00Z'});assert.equal(await access(),true);
 await apply({status:'grace',end:'2001-01-01T00:00:00Z',grace:'2002-01-01T00:00:00Z',revision:1});assert.equal(await access(),false);
});
test('pending, billing failure, refund/revocation and expiry have no paid access',async()=>{
 for(const status of ['pending','payment_required','revoked','expired']){await apply({id:status,status});}assert.equal(await access(),false);
});
test('a processing event blocks concurrent delivery and completed events are idempotent',async()=>{
 assert.equal(await event(),'claimed');assert.equal(await event(claim2),'busy');assert.equal(await finish(claim2),false);assert.equal(await finish(),true);assert.equal(await event(claim2),'duplicate');
});
test('failed events are retryable without hiding errors as successful processing',async()=>{
 await event();assert.equal(await finish(claim,false),true);assert.equal(await event(claim2),'claimed');
});
test('expired event workers cannot finish after another worker acquires the claim',async()=>{
 await event();await db.exec("update private.native_billing_events set claim_expires_at=now()-interval '1 minute'");assert.equal(await event(claim2),'claimed');assert.equal(await finish(claim),false);assert.equal(await finish(claim2),true);
});
test('event identifiers cannot silently accept a different payload',async()=>{
 await event();await assert.rejects(event(claim2,'b'.repeat(64)),/identity conflict/);
});

test('service-only ownership lookup survives deletion without granting a new account ownership',async()=>{
 assert.equal(await scalar('select public.native_billing_owner($1)',[binding]),cafe);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(scalar('select public.native_billing_owner($1)',[binding]),/permission denied/);await db.exec('reset role');}
});
async function replaceToken({owner=cafe,accountBinding=binding,newToken='new-token',oldToken='old-token',revision=0,status='active'}={}){
 return scalar('select public.native_billing_apply($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[owner,accountBinding,'google','Sandbox',newToken,'test.monthly','order-new',status,'2099-01-01T00:00:00Z',null,true,revision,oldToken]);
}
test('Google replacement revokes only the same account’s old token and cannot be undone by a delayed receipt',async()=>{
 await apply({provider:'google',id:'old-token'});assert.equal(await replaceToken(),'applied');
 const old=await scalar("select public.native_billing_read('google','Sandbox','old-token')");
 assert.equal(old.status,'revoked');assert.ok(old.superseded_by);assert.equal(await apply({provider:'google',id:'old-token',revision:old.revision}),'superseded');
 assert.equal(await access(),true);assert.equal(await replaceToken({revision:1}),'duplicate');
});
test('Google replacement keeps a tombstone when the previous token arrived late',async()=>{
 await replaceToken();assert.equal(await apply({provider:'google',id:'old-token'}),'superseded');
});
test('Google replacement cannot revoke a different account’s subscription',async()=>{
 await apply({user:other,binding:otherBinding,provider:'google',id:'old-token'});
 await assert.rejects(replaceToken(),/another account/);assert.equal(await access(other),true);assert.equal(await access(),false);
 assert.equal(await scalar("select public.native_billing_read('google','Sandbox','new-token')"),null,'failed ownership check rolls back all effects');
});
test('a pending Google replacement does not revoke already paid access',async()=>{
 await apply({provider:'google',id:'old-token'});await replaceToken({status:'pending'});
 assert.equal((await scalar("select public.native_billing_read('google','Sandbox','old-token')")).status,'active');
});

test('native summary is account scoped, environment scoped and contains no financial credentials',async()=>{
 await apply();await apply({user:other,binding:otherBinding,id:'other-original'});
 const summary=await scalar("select public.native_billing_summary($1,'Sandbox')",[cafe]);
 assert.equal(summary.accountId,cafe);assert.equal(summary.subscriptions.length,1);
 assert.deepEqual(Object.keys(summary.subscriptions[0]).sort(),['autoRenews','currentPeriodEnd','gracePeriodEnd','provider','status']);
 assert.equal((await scalar("select public.native_billing_summary($1,'Production')",[cafe])).subscriptions.length,0);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(scalar("select public.native_billing_summary($1,'Sandbox')",[cafe]),/permission denied/);await db.exec('reset role');}
 await assert.rejects(scalar("select public.native_billing_summary($1,'Sandbox')",[barista]),/active cafe/);
});
test('native summary omits superseded Google purchases without hiding the current replacement',async()=>{
 await replaceToken();const summary=await scalar("select public.native_billing_summary($1,'Sandbox')",[cafe]);
 assert.equal(summary.subscriptions.length,1);assert.equal(summary.subscriptions[0].status,'active');
});
