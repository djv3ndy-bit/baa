import {before,after,beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const source=p=>readFileSync(new URL(`../../${p}`,import.meta.url),'utf8');
const cafe='00000000-0000-4000-8000-000000000004',other='00000000-0000-4000-8000-000000000006';
const barista='00000000-0000-4000-8000-000000000001',stripeCafe='00000000-0000-4000-8000-000000000003';
const attempt='90000000-0000-4000-8000-000000000001',cid='env_fixture_android_review';
let db;
const query=(sql,params=[])=>db.query(sql,params);
const scalar=async(sql,params=[])=>Object.values((await query(sql,params)).rows[0])[0];
const root=()=>db.exec('reset role');
async function asUser(id){await root();await query("select set_config('request.jwt.claim.sub',$1,true)",[id]);await db.exec('set local role authenticated');}
async function denied(operation,pattern=/permission denied/){await db.exec('savepoint denied');try{await assert.rejects(operation(),pattern);}finally{await db.exec('rollback to savepoint denied;release savepoint denied');}}
async function grant(id=cafe){await root();await query("insert into private.android_reviewer_grants(user_id,created_at,expires_at) values($1,now()-interval '1 day',now()+interval '30 days')",[id]);}
async function enable(ids=[cafe]){await root();await query('update private.android_reviewer_configuration set enabled=true,custom_environment_id=$1,allowed_user_ids=$2',[cid,ids]);}
const review=(id=cafe,environment='Sandbox',custom=cid)=>scalar('select public.android_reviewer_access($1,$2,$3)',[id,environment,custom]);
const paid=(id=cafe)=>scalar('select private.cafe_has_paid_job_entitlement($1)',[id]);
const claim=()=>scalar("select public.native_checkout_claim($1,'google','Sandbox',$2)",[cafe,attempt]);
const job=n=>query("insert into public.jobs(id,owner_id,title,location) values($1,$2,'Reviewer role','Tampa, FL')",[`80000000-0000-4000-8000-${String(n).padStart(12,'0')}`,cafe]);

before(async()=>{
  db=new PGlite();await db.exec(source('tests/database/job-posting-entitlement-fixture.sql'));
  await db.exec(`create table auth.users(id uuid primary key);insert into auth.users select id from public.profiles;
    alter table public.cafe_subscriptions add column stripe_checkout_claim_id uuid,add column stripe_checkout_claim_expires_at timestamptz,
    add column stripe_checkout_claim_kind text,add column stripe_checkout_attempt_id uuid,add column stripe_checkout_channel text,add column stripe_checkout_ui_mode text;`);
  for(const path of ['supabase/migrations/20260908100000_enforce_cafe_job_posting_entitlements.sql',
    'supabase/migrations/20260908110000_consolidate_job_participant_visibility.sql','review/native-billing-ledger.sql',
    'review/native-checkout-coordination.sql','server/native-billing/sql/checkout_provider.sql','review/native-job-access.sql',
    'supabase/migrations/20260929011200_limit_free_job_to_30_days.sql'])await db.exec(source(path));
  await db.exec("update private.native_billing_configuration set environment='Sandbox'");
  await db.exec(source('server/native-billing/sql/android_reviewer_access.sql'));
});
beforeEach(()=>db.exec('begin'));afterEach(()=>db.exec('rollback'));after(()=>db?.close());

test('artifact starts disabled with empty grants/allowlist, preserves verified ledger and first free allowance',async()=>{
  assert.equal(await scalar('select enabled from private.android_reviewer_configuration'),false);
  assert.equal(await scalar('select cardinality(allowed_user_ids) from private.android_reviewer_configuration'),0);
  assert.equal(await scalar('select count(*)::int from private.android_reviewer_grants'),0);
  assert.equal(await review(),null);assert.equal(await paid(),false);
  assert.equal(await scalar('select count(*)::int from private.native_billing_subscriptions'),0);
  await asUser(cafe);await job(1);await denied(()=>job(2),/JOB_PRO_SUBSCRIPTION_REQUIRED/);
});
test('configured private grant enables three jobs through existing RLS while keeping the fourth blocked',async()=>{
  await grant();await enable();const result=await review();assert.equal(result.accountId,cafe);assert.equal(result.reviewAccess.active,true);
  await asUser(cafe);assert.equal(await scalar('select public.cafe_has_hiring_access($1)',[cafe]),true);
  assert.equal((await scalar('select public.cafe_job_access()')).has_paid_access,true);
  await job(1);await job(2);await job(3);await denied(()=>job(4),/JOB_ACTIVE_LIMIT|3 active|ACTIVE_JOB_LIMIT/);
  assert.equal(await scalar('select count(*)::int from public.jobs where owner_id=$1',[cafe]),3);
});
test('grant expiry immediately hides paid-only jobs and denies additional posts without deleting saved rows',async()=>{
  await grant();await enable();await asUser(cafe);await job(1);await job(2);
  await root();await query('update private.android_reviewer_grants set expires_at=now() where user_id=$1',[cafe]);
  assert.equal(await paid(),false);assert.equal(await review(),null);
  await asUser(barista);assert.equal(await scalar('select count(*)::int from public.jobs where owner_id=$1',[cafe]),1);
  await asUser(cafe);assert.equal(await scalar('select count(*)::int from public.jobs where owner_id=$1',[cafe]),2);
  await denied(()=>job(3),/JOB_PRO_SUBSCRIPTION_REQUIRED/);
});
test('revocation removes paid access even before expiry; no native billing/provider rows are fabricated',async()=>{
  await grant();await enable();await query('update private.android_reviewer_grants set revoked_at=now() where user_id=$1',[cafe]);
  assert.equal(await review(),null);assert.equal(await paid(),false);
  const summary=await scalar("select public.native_billing_summary($1,'Sandbox')",[cafe]);assert.deepEqual(summary.subscriptions,[]);
});
test('server-owned allowlist is required independently of a grant row and user cannot self-grant',async()=>{
  await grant();await grant(other);await enable([cafe]);assert.equal(await paid(other),false);assert.equal(await review(other),null);
  for(const role of ['anon','authenticated','service_role']){
    await root();await db.exec('set local role '+role);
    await denied(()=>query('select * from private.android_reviewer_grants'));
    await denied(()=>query('update private.android_reviewer_configuration set enabled=true'));
    await denied(()=>query("insert into private.android_reviewer_grants(user_id,expires_at) values($1,now()+interval '1 day')",[barista]));
    await denied(()=>query('select private.android_reviewer_expiry($1)',[cafe]));
    if(role!=='service_role')await denied(()=>review());
  }
  await root();await db.exec('set local role service_role');assert.equal((await review()).reviewAccess.active,true);
});
test('Sandbox, exact RPC CID, fixed Android scope and configured allowlist fail closed',async()=>{
  await grant();await enable();await denied(()=>review(cafe,'Production'),/configuration mismatch/);
  await denied(()=>review(cafe,'Sandbox','env_wrong'),/configuration mismatch/);
  for(const [column,value] of [['project_ref','other'],['api_base_url','https://testing.baristajobmatch.com/api'],['package_name','com.other.app'],['environment','Production']])
    await denied(()=>query(`update private.android_reviewer_configuration set ${column}=$1`,[value]),/check constraint/);
  await db.exec("update private.native_billing_configuration set environment='Production'");assert.equal(await paid(),false);
  await denied(()=>review(),/configuration mismatch/);assert.equal(await paid(stripeCafe),true);
});
test('deleted Auth identity cascades grant and cannot keep paid access through retained profile or stale JWT',async()=>{
  await grant();await enable();await query('delete from auth.users where id=$1',[cafe]);
  assert.equal(await scalar('select count(*)::int from private.android_reviewer_grants where user_id=$1',[cafe]),0);
  assert.equal(await paid(),false);assert.equal(await review(),null);
  await asUser(cafe);assert.equal((await scalar('select public.cafe_job_access()')).has_paid_access,false);
});
test('saved role, suspension, owner pause and existing hiring access remain authoritative',async()=>{
  await grant();await enable();
  for(const change of ["update public.profiles set suspended_at=now()", "update public.profiles set role='barista'",
    'update public.cafe_subscriptions set owner_paused_at=now()',"update public.cafe_subscriptions set complimentary_access=false,status='expired'"]){
    await db.exec('savepoint changed');await db.exec(change+(change.includes('public.profiles')?` where id='${cafe}'`:` where user_id='${cafe}'`));
    assert.equal(await paid(),false);assert.equal(await review(),null);await db.exec('rollback to savepoint changed;release savepoint changed');
  }
  await denied(()=>grant(barista),/active unpaused cafe/);
});
test('an ineligible/paused existing grant can always be revoked rather than being trapped by eligibility checks',async()=>{
  await grant();await enable();await query('update public.cafe_subscriptions set owner_paused_at=now() where user_id=$1',[cafe]);
  await query("update private.android_reviewer_grants set expires_at=now()+interval '1 day' where user_id=$1",[cafe]);
  await query('update private.android_reviewer_grants set revoked_at=now() where user_id=$1',[cafe]);assert.equal(await review(),null);
});
test('reviewer grant blocks native and Stripe claims and the final native write; cancellation/deletion lease remain available',async()=>{
  await grant();await enable();assert.equal(await claim(),null);
  assert.equal(await scalar("select public.claim_stripe_checkout($1,$2,$2,'web','embedded')",[cafe,attempt]),null);
  const binding=await scalar('select public.native_billing_account($1)',[cafe]);assert.ok(binding);
  await denied(()=>query("insert into private.native_checkout_attempts(id,user_id,provider,environment,state,reserved_until) values($1,$2,'google','Sandbox','started',now()+interval '5 minutes')",[attempt,cafe]),/Reviewer access blocks/);
  await query("update public.cafe_subscriptions set stripe_checkout_claim_kind='deletion',stripe_checkout_claim_id=$1 where user_id=$2",[attempt,cafe]);
  assert.equal((await review()).reviewAccess.active,true);
});
test('activation refuses an already reserved/started checkout under the same cafe lock; cancel enables safe activation',async()=>{
  await grant();assert.ok(await claim());await denied(()=>enable(),/checkout is still pending/);
  assert.equal(await scalar("select public.native_checkout_start($1,'Sandbox',$2)",[cafe,attempt]),true);
  await denied(()=>enable(),/checkout is still pending/);
  assert.equal(await scalar("select public.native_checkout_cancel($1,'Sandbox',$2,false)",[cafe,attempt]),true);
  await enable();assert.equal((await review()).reviewAccess.active,true);
});
test('grant creation over open checkout is denied if the configured account was already enabled',async()=>{
  await enable();assert.ok(await claim());await denied(()=>grant(),/checkout is still pending/);assert.equal(await review(),null);
});
test('finite nonempty expiry and config checks prevent indefinite or accidentally global access',async()=>{
  for(const date of ['infinity','-infinity'])await denied(()=>query('insert into private.android_reviewer_grants(user_id,expires_at) values($1,$2)',[cafe,date]),/check constraint/);
  await denied(()=>query("update private.android_reviewer_configuration set enabled=true,allowed_user_ids='{}',custom_environment_id=$1",[cid]),/check constraint/);
  await denied(()=>query('update private.android_reviewer_configuration set enabled=true,allowed_user_ids=$1,custom_environment_id=null',[[cafe]]),/check constraint/);
});
test('genuine Google/Stripe access and sanitized provider summary remain independent of review grant',async()=>{
  await grant();await enable();const before=await scalar("select public.native_billing_summary($1,'Sandbox')",[cafe]);
  const binding=await scalar('select public.native_billing_account($1)',[cafe]);
  assert.equal(await scalar("select public.native_billing_apply($1,$2,'google','Sandbox','synthetic-token','google.monthly','synthetic-order','active','2099-01-01',null,false,0)",[cafe,binding]),'applied');
  await query('update private.android_reviewer_grants set revoked_at=now() where user_id=$1',[cafe]);assert.equal(await paid(),true);
  const after=await scalar("select public.native_billing_summary($1,'Sandbox')",[cafe]);assert.equal(before.subscriptions.length,0);assert.equal(after.subscriptions.length,1);
  assert.equal(after.subscriptions[0].provider,'google');assert.equal(Object.hasOwn(after,'reviewAccess'),false);assert.equal(await paid(stripeCafe),true);
});
