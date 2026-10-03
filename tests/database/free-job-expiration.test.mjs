import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const source = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const migration = source('supabase/migrations/20260929011200_limit_free_job_to_30_days.sql');
const cafe = '00000000-0000-4000-8000-000000000002', fresh = '00000000-0000-4000-8000-000000000004';
const barista = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000009';
const first = '10000000-0000-4000-8000-000000000001';
let db;
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
const root = () => db.exec('reset role');
async function user(id) { await root(); await db.query("select set_config('request.jwt.claim.sub', $1, true)", [id]); await db.exec('set local role authenticated'); }
async function deadline(offset = "- interval '1 second'") { await root(); await db.exec(`update private.cafe_job_entitlements set free_job_expires_at = now() ${offset} where cafe_id = '${cafe}'`); }
async function denied(sql, args, code) { await db.exec('savepoint deny'); try { await assert.rejects(db.query(sql, args), e => e.code === code); } finally { await db.exec('rollback to savepoint deny; release savepoint deny'); } }
async function native(status='active', revision=0) { await root(); const binding=await scalar('select public.native_billing_account($1)',[cafe]); await scalar("select public.native_billing_apply($1,$2,'apple','Production','free-job-expiry-original','test.monthly','free-job-expiry-transaction',$3,$4,null,false,$5)",[cafe,binding,status,status==='active'?'2099-01-01T00:00:00Z':'2000-01-01T00:00:00Z',revision]); }
before(async () => {
 db = new PGlite();
 await db.exec(source('tests/database/job-posting-entitlement-fixture.sql'));
 await db.exec(source('supabase/migrations/20260908100000_enforce_cafe_job_posting_entitlements.sql'));
 await db.exec(source('supabase/migrations/20260908110000_consolidate_job_participant_visibility.sql'));
 await db.exec(source('review/native-billing-ledger.sql'));
 await db.exec(source('review/native-checkout-coordination.sql').split('create table private.native_checkout_attempts')[0]);
 await db.exec(source('review/native-job-access.sql'));
 await db.exec('begin'); await db.exec(migration); await db.exec('commit');
});
beforeEach(async()=>db.exec('begin')); afterEach(async()=>db.exec('rollback')); after(async()=>db?.close());
test('existing posts get the full 30 days from rollout, regardless of original age',async()=>{
 assert.equal(await scalar("select extract(epoch from (free_job_expires_at-created_at))>0 from private.cafe_job_entitlements where cafe_id=$1",[cafe]),true);
 const remaining=await scalar("select extract(epoch from (free_job_expires_at-now()))::float from private.cafe_job_entitlements where cafe_id=$1",[cafe]);
 assert.ok(remaining<=2592000 && remaining>2591990);
 assert.equal(await scalar('select active from public.jobs where id=$1',[first]),true);
});
test('new first post starts exactly one server-owned 30-day allowance',async()=>{
 await user(fresh); await db.query("insert into public.jobs(owner_id,title,location,created_at) values($1,'Synthetic first','New York, NY','2099-01-01')",[fresh]);
 await root(); assert.equal(await scalar("select extract(epoch from(free_job_expires_at-now()))::int from private.cafe_job_entitlements where cafe_id=$1",[fresh]),2592000);
 await user(fresh); assert.equal((await scalar('select public.cafe_job_access()')).can_create,false);
 await denied("insert into public.jobs(owner_id,title,location,active) values($1,'Second','New York, NY',false)",[fresh],'PJB01');
});
for(const offset of ["- interval '1 second'",'']) test(`deadline is enforced at ${offset || 'exact boundary'} even before the scheduler runs`,async()=>{
 await deadline(offset); await user(other);
 assert.equal(await scalar('select count(*)::int from public.jobs where id=$1',[first]),0);
 await denied("insert into public.applications(job_id,barista_id,status) values($1,$2,'interested')",[first,other],'42501');
 await user(cafe); assert.equal(await scalar('select count(*)::int from public.jobs where id=$1',[first]),1);
 assert.equal((await scalar('select public.cafe_job_access()')).can_create,false);
});
test('before expiry, pause/reopen/edit preserve the original deadline and first-job access',async()=>{
 const before=await scalar('select free_job_expires_at from private.cafe_job_entitlements where cafe_id=$1',[cafe]);
 await user(cafe); await db.query("update public.jobs set active=false, title='Edited', created_at='2099-01-01' where id=$1",[first]);
 await db.query('update public.jobs set active=true where id=$1',[first]);
 await root(); assert.equal(String(await scalar('select free_job_expires_at from private.cafe_job_entitlements where cafe_id=$1',[cafe])),String(before));
});
test('expired post can be edited and paused, but cannot be reopened free',async()=>{
 await deadline(); await user(cafe);
 const result=await db.query("update public.jobs set title='Saved expired edit',active=true where id=$1 returning active,title",[first]);
 assert.deepEqual(result.rows,[{active:false,title:'Saved expired edit'}]);
 await denied('update public.jobs set active=true where id=$1',[first],'PJB05');
 await db.query("update public.jobs set title='Saved paused edit' where id=$1",[first]);
});
test('deleting the expired first post never restores the free allowance or permits UUID reuse',async()=>{
 await deadline(); await user(cafe); await db.query('delete from public.jobs where id=$1',[first]);
 assert.equal(await scalar('select public.cafe_can_create_job()'),false);
 await denied("insert into public.jobs(id,owner_id,title,location) values($1,$2,'Reuse','Miami, FL')",[first,cafe],'PJB01');
 await denied("insert into public.jobs(owner_id,title,location) values($1,'Different','Miami, FL')",[cafe],'PJB01');
});
test('expiry sweep is idempotent and retains applicant history and matched conversations',async()=>{
 await user(barista); const id=await scalar("insert into public.applications(job_id,barista_id,status) values($1,$2,'interested') returning id",[first,barista]);
 await user(cafe); await db.query("update public.applications set status='matched' where id=$1",[id]);
 await deadline(); assert.equal(await scalar('select private.expire_free_job_posts()'),1);
 assert.equal(await scalar('select private.expire_free_job_posts()'),0);
 await user(barista); assert.equal(await scalar('select count(*)::int from public.jobs where id=$1',[first]),1);
 await db.query("insert into public.messages(application_id,sender_id,body) values($1,$2,'Existing conversation remains')",[id,barista]);
 await user(cafe); await db.query("insert into public.messages(application_id,sender_id,body) values($1,$2,'Existing owner reply')",[id,cafe]);
 assert.equal(await scalar('select count(*)::int from public.messages where application_id=$1',[id]),2);
 assert.equal(await scalar('select active from public.jobs where id=$1',[first]),false);
});
test('publication history exception does not let an existing applicant insert another interest after expiry',async()=>{
 // Seed the existing withdrawn relationship as server, so the SELECT exception applies.
 await root(); await db.query("insert into public.applications(job_id,barista_id,status) values($1,$2,'withdrawn')",[first,barista]);
 await deadline(); await user(barista);
 assert.equal(await scalar('select count(*)::int from public.jobs where id=$1',[first]),1);
 await denied("insert into public.applications(job_id,barista_id,status) values($1,$2,'interested')",[first,barista],'42501');
});
test('verified Apple Pro preserves publication past the free deadline, and revocation removes it',async()=>{
 await deadline(); await native();
 assert.equal(await scalar('select private.expire_free_job_posts()'),0);
 await user(cafe); const access=await scalar('select public.cafe_job_access()');assert.equal(access.has_paid_access,true);assert.equal(access.can_create,true);
 await db.query('update public.jobs set active=false where id=$1',[first]);await db.query('update public.jobs set active=true where id=$1',[first]);
 await native('revoked',1); await user(other);assert.equal(await scalar('select count(*)::int from public.jobs where id=$1',[first]),0);
 await root();assert.equal(await scalar('select private.expire_free_job_posts()'),1);
});
test('Stripe Pro preserves publication until paid access ends without resetting the free clock',async()=>{
 await deadline(); const before=await scalar('select free_job_expires_at from private.cafe_job_entitlements where cafe_id=$1',[cafe]);
 await db.query("update public.cafe_subscriptions set status='active',stripe_customer_id='cus_testExpiry',stripe_subscription_id='sub_testExpiry' where user_id=$1",[cafe]);
 assert.equal(await scalar('select private.expire_free_job_posts()'),0);
 await db.query("update public.cafe_subscriptions set status='canceled' where user_id=$1",[cafe]);
 assert.equal(await scalar('select active from public.jobs where id=$1',[first]),false);
 assert.equal(String(await scalar('select free_job_expires_at from private.cafe_job_entitlements where cafe_id=$1',[cafe])),String(before));
});
test('free access never accepts forged client deadlines or private sweep calls',async()=>{
 await user(cafe);
 await denied("update private.cafe_job_entitlements set free_job_expires_at='2099-01-01' where cafe_id=$1",[cafe],'42501');
 await denied('select private.expire_free_job_posts()',[],'42501');
 await root();assert.equal(await scalar("select has_function_privilege('anon','public.cafe_job_access()','execute')"),false);
 await user(barista);assert.equal(await scalar('select public.cafe_job_access()'),null);
 await user(fresh);assert.equal((await scalar('select public.cafe_job_access()')).free_job_id,null);
});
test('reapplying migration does not extend deadlines or replace native paid-access rules',async()=>{
 await deadline();const before=(await db.query('select * from private.cafe_job_entitlements order by cafe_id')).rows;
 const paidBefore=await scalar("select pg_get_functiondef('private.cafe_has_paid_job_entitlement(uuid)'::regprocedure)");
 await db.exec(migration);
 assert.deepEqual((await db.query('select * from private.cafe_job_entitlements order by cafe_id')).rows,before);
 assert.equal(await scalar("select pg_get_functiondef('private.cafe_has_paid_job_entitlement(uuid)'::regprocedure)"),paidBefore);
});
