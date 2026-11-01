import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createAppleSandboxFixture,resetAppleSandboxFixture,reviewer,ordinary,barista,stripeCafe,guardProtocol,attemptId,draftSql} from './apple-sandbox-fixture.mjs';

let db;
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0]??{})[0]??null;
const enable=()=>scalar("select public.native_billing_set_apple_sandbox_tester($1,true,clock_timestamp()+interval '1 day')",[reviewer]);
const revoke=()=>scalar('select public.native_billing_set_apple_sandbox_tester($1,false)',[reviewer]);
const context=(id=reviewer,provider=null)=>scalar('select public.native_billing_context($1,$2)',[id,provider]);
const claim=(id=reviewer,env='Sandbox',guard=guardProtocol,provider='apple',attempt=attemptId)=>scalar('select public.native_checkout_claim($1,$2,$3,$4,$5)',[id,provider,env,attempt,guard]);
const start=(id=reviewer,env='Sandbox',guard=guardProtocol,attempt=attemptId)=>scalar('select public.native_checkout_start($1,$2,$3,$4)',[id,env,attempt,guard]);
const access=(id=reviewer,env='Sandbox')=>scalar('select public.native_billing_access($1,$2)',[id,env]);
const binding=id=>scalar('select public.native_billing_account($1)',[id]);
async function role(name,run){
 await db.exec('set role '+name);
 try{return await run();}finally{await db.exec('reset role');}
}
async function user(id,run){
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
 return role('authenticated',run);
}
async function grant({id=reviewer,environment='Sandbox',provider='apple',status='active',end='2099-01-01',revision=0,subscription='synthetic-original',transaction='synthetic-transaction',storeBinding}={}){
 const token=storeBinding??await binding(id);
 return scalar('select public.native_billing_apply($1,$2,$3,$4,$5,$6,$7,$8,$9,null,false,$10,null)',[id,token,provider,environment,subscription,'synthetic.monthly',transaction,status,end,revision]);
}
async function seedUnauthorizedSandbox(id=ordinary,provider='apple'){
 await binding(id);
 await db.query("insert into private.native_billing_subscriptions(provider,environment,provider_subscription_id,provider_subscription_key,user_id,product_id,transaction_id,status,current_period_end,auto_renews,revision) values($1,'Sandbox','untrusted-synthetic',encode(sha256(convert_to('untrusted-synthetic','UTF8')),'hex'),$2,'synthetic.monthly','untrusted-tx','active','2099-01-01',false,1)",[provider,id]);
}
const job=(n,id=reviewer)=>db.query("insert into public.jobs(id,owner_id,title,location) values($1,$2,'Synthetic role','Miami, FL')",['60000000-0000-4000-8000-'+String(n).padStart(12,'0'),id]);

before(async()=>{db=new PGlite();await createAppleSandboxFixture(db);});
beforeEach(()=>resetAppleSandboxFixture(db));
after(()=>db?.close());

test('draft leaves mapping empty, global Production intact, and ordinary Apple/Google contexts unchanged',async()=>{
 assert.equal(await scalar('select count(*)::int from private.apple_sandbox_test_accounts'),0);
 assert.equal(await scalar('select environment from private.native_billing_configuration'),'Production');
 for(const provider of [null,'apple','google'])assert.deepEqual(await context(ordinary,provider),{environment:'Production',appleSandboxTester:false});
 assert.deepEqual(await context(),{environment:'Production',appleSandboxTester:false});
});
test('only the exact eligible café can be enabled with bounded expiry',async()=>{
 for(const id of [ordinary,barista,null])await assert.rejects(scalar("select public.native_billing_set_apple_sandbox_tester($1,true,clock_timestamp()+interval '1 day')",[id]),/not eligible/);
 for(const expiry of [null,'2000-01-01','2099-01-01'])await assert.rejects(scalar('select public.native_billing_set_apple_sandbox_tester($1,true,$2)',[reviewer,expiry]),/activation blocked/);
 assert.equal(await scalar('select count(*)::int from private.apple_sandbox_test_accounts'),0);
 assert.deepEqual(await enable(),{environment:'Sandbox',appleSandboxTester:true});
 assert.deepEqual(await context(reviewer,'apple'),{environment:'Sandbox',appleSandboxTester:true});
 await assert.rejects(context(reviewer,'google'),/context unavailable/);
 assert.equal(await scalar('select environment from private.native_billing_configuration'),'Production');
});
test('suspension, wrong role, owner pause and missing account state fail activation',async()=>{
 for(const change of ["update profiles set suspended_at=now()","update profiles set role='barista'"]){
  await db.exec(change+" where id='"+reviewer+"'");
  await assert.rejects(enable(),/activation blocked/);
  await db.exec("update profiles set suspended_at=null,role='cafe_owner_manager' where id='"+reviewer+"'");
 }
 await db.query('update cafe_subscriptions set owner_paused_at=now() where user_id=$1',[reviewer]);
 await assert.rejects(enable(),/activation blocked/);
 await db.query('delete from cafe_subscriptions where user_id=$1',[reviewer]);
 await assert.rejects(enable(),/unavailable/);
});
test('all unresolved Stripe fields and ambiguous statuses block mapping activation',async()=>{
 const fields={stripe_customer_id:"'cus_synthetic'",stripe_subscription_id:"'sub_synthetic'",stripe_checkout_attempt_id:"'50000000-0000-4000-8000-000000000003'",stripe_checkout_claim_id:"'50000000-0000-4000-8000-000000000004'",stripe_checkout_claim_expires_at:"'2000-01-01'"};
 for(const [field,value] of Object.entries(fields)){
  await db.exec('update cafe_subscriptions set '+field+'='+value+" where user_id='"+reviewer+"'");
  await assert.rejects(enable(),/activation blocked/,field);
  await db.exec('update cafe_subscriptions set '+field+"=null where user_id='"+reviewer+"'");
 }
 for(const status of ['active','past_due','unpaid','incomplete','paused']){
  await db.query('update cafe_subscriptions set status=$1 where user_id=$2',[status,reviewer]);
  await assert.rejects(enable(),/activation blocked/,status);
 }
});
test('Production native activity and open reservations prevent entering a different billing domain',async()=>{
 await grant({environment:'Production'});
 await assert.rejects(enable(),/activation blocked/);
 await db.exec('truncate private.native_billing_subscriptions');
 assert.ok(await claim(reviewer,'Production',null));
 await assert.rejects(enable(),/activation blocked/);
});
test('mapped Sandbox claim and start require the exact client guard, persisted with the attempt',async()=>{
 await enable();
 assert.equal(await claim(reviewer,'Sandbox',null),null);
 assert.equal(await claim(reviewer,'Production',guardProtocol),null);
 assert.equal(await claim(reviewer,'Sandbox',guardProtocol,'google'),null);
 const result=await claim();assert.equal(result.attemptId,attemptId);
 assert.equal(await scalar('select guard_protocol from private.native_checkout_attempts where id=$1',[attemptId]),guardProtocol);
 assert.equal(await scalar('select sandbox_tester_generation::int from private.native_checkout_attempts where id=$1',[attemptId]),1);
 assert.deepEqual(await scalar('select public.native_checkout_attempt_context($1,$2)',[reviewer,attemptId]),{environment:'Sandbox',provider:'apple',guardProtocol});
 assert.equal(await scalar('select public.native_checkout_attempt_context($1,$2)',[ordinary,attemptId]),null);
 assert.equal(await start(reviewer,'Sandbox',null),false);
 assert.equal(await start(),true);
});
test('ordinary Production and isolated Sandbox QA preserve legacy NULL guard and Google behavior',async()=>{
 assert.ok(await claim(ordinary,'Production',null,'google'));
 assert.equal(await start(ordinary,'Production',null),true);
 await resetAppleSandboxFixture(db);
 await db.exec("update private.native_billing_configuration set environment='Sandbox'");
 assert.deepEqual(await context(ordinary,'google'),{environment:'Sandbox',appleSandboxTester:false});
 assert.ok(await claim(ordinary,'Sandbox',null,'google'));
 assert.equal(await start(ordinary,'Sandbox',null),true);
 await grant({id:ordinary,provider:'google'});
 assert.equal(await access(ordinary,'Sandbox'),true);
});
test('ordinary Production checkout and status ignore unrelated historical Sandbox noise with an empty mapping',async()=>{
 await seedUnauthorizedSandbox();
 await db.query("insert into private.native_checkout_attempts(id,user_id,provider,environment,state,reserved_until) values($1,$2,'apple','Sandbox','started','2000-01-01')",[attemptId,ordinary]);
 assert.equal(await scalar('select public.native_checkout_pending($1,$2)',[ordinary,'Production']),false);
 assert.equal(await scalar('select private.native_checkout_is_blocked($1)',[ordinary]),false);
 const productionAttempt='50000000-0000-4000-8000-000000000020';
 assert.ok(await claim(ordinary,'Production',null,'apple',productionAttempt));
 assert.equal(await start(ordinary,'Production',null,productionAttempt),true);
 assert.equal(await access(ordinary,'Sandbox'),false);
 assert.equal(await scalar('select count(*)::int from private.apple_sandbox_test_accounts'),0);
});
test('ordinary Stripe coordination also ignores unrelated Sandbox noise while preserving its own claim',async()=>{
 await seedUnauthorizedSandbox();
 const result=await scalar("select public.claim_stripe_checkout($1,'50000000-0000-4000-8000-000000000021','50000000-0000-4000-8000-000000000022','web','hosted')",[ordinary]);
 assert.equal(result.attemptId,'50000000-0000-4000-8000-000000000022');
 assert.equal(await claim(ordinary,'Production',null),null,'actual Stripe coordination still blocks a native launch');
});
test('revocation immediately blocks launches but preserves exact recorded-environment cancellation',async()=>{
 await enable();await claim();await revoke();
 assert.deepEqual(await context(),{environment:'Production',appleSandboxTester:false});
 assert.equal(await start(),false);
 assert.equal(await scalar('select public.native_checkout_provider($1,$2,$3)',[reviewer,'Sandbox',attemptId]),null);
 assert.equal(await scalar('select public.native_checkout_cancel($1,$2,$3,false)',[ordinary,'Sandbox',attemptId]),false);
 assert.equal(await scalar('select public.native_checkout_cancel($1,$2,$3,false)',[reviewer,'Production',attemptId]),false);
 assert.equal(await scalar('select public.native_checkout_cancel($1,$2,$3,false)',[reviewer,'Sandbox',attemptId]),true);
 assert.equal(await scalar('select state from private.native_checkout_attempts'),'cancelled');
});
test('mapping expiry and a stale generation cannot launch or recover an older reservation',async()=>{
 await enable();await claim();
 await db.query("update private.apple_sandbox_test_accounts set expires_at=clock_timestamp()-interval '1 second' where user_id=$1",[reviewer]);
 assert.equal(await start(),false);
 assert.deepEqual(await context(),{environment:'Production',appleSandboxTester:false});
 await db.query("update private.apple_sandbox_test_accounts set expires_at=clock_timestamp()+interval '1 day',generation=generation+1 where user_id=$1",[reviewer]);
 assert.equal(await start(),false);
 await db.query("update private.native_checkout_attempts set state='started' where id=$1",[attemptId]);
 assert.equal(await scalar('select public.native_checkout_recover_apple($1,$2,$3)',[reviewer,'Sandbox',guardProtocol]),null);
});
test('started Sandbox reservations survive revocation and block new Production or Stripe checkout',async()=>{
 await enable();await claim();await start();await revoke();
 assert.equal(await scalar('select public.native_checkout_pending($1,$2)',[reviewer,'Production']),true);
 assert.equal(await claim(reviewer,'Production',null),null);
 assert.equal(await scalar("select public.claim_stripe_checkout($1,'50000000-0000-4000-8000-000000000005','50000000-0000-4000-8000-000000000006','web','hosted')",[reviewer]),null);
 await assert.rejects(enable(),/activation blocked/);
});
test('current mapped Apple Sandbox entitlement enables real guarded extra jobs, then revocation removes paid access',async()=>{
 await enable();assert.equal(await grant(),'applied');
 assert.equal(await access(),true);assert.equal(await access(reviewer,'Production'),false);
 assert.equal(await scalar('select private.cafe_has_paid_job_entitlement($1)',[reviewer]),true);
 await user(reviewer,async()=>{await job(1);await job(2);assert.equal(await scalar('select public.cafe_has_hiring_access($1)',[reviewer]),true);});
 await revoke();
 assert.equal(await access(),false);assert.equal(await scalar('select private.cafe_has_paid_job_entitlement($1)',[reviewer]),false);
 await user(reviewer,async()=>{await assert.rejects(job(3),/JOB_PRO_SUBSCRIPTION_REQUIRED/);assert.equal(await scalar('select public.cafe_has_hiring_access($1)',[reviewer]),false);});
});
test('ordinary users cannot grant Sandbox subscriptions or use historical Sandbox rows as Production paid access',async()=>{
 await assert.rejects(grant({id:ordinary}),/not authorized/);
 await seedUnauthorizedSandbox();
 assert.equal(await access(ordinary,'Sandbox'),false);assert.equal(await access(ordinary,'Production'),false);
 await user(ordinary,async()=>{await job(1,ordinary);await assert.rejects(job(2,ordinary),/JOB_PRO_SUBSCRIPTION_REQUIRED/);});
});
test('an Apple tester mapping does not authorize Google Sandbox entitlements',async()=>{
 await enable();
 await assert.rejects(grant({provider:'google'}),/not authorized/);
 await seedUnauthorizedSandbox(reviewer,'google');
 assert.equal(await access(),false);
 assert.deepEqual((await scalar('select public.native_billing_summary($1,$2)',[reviewer,'Sandbox'])).subscriptions,[]);
});
test('genuine Production native customers gain ordinary paid jobs and hiring access without tester mapping',async()=>{
 await grant({id:ordinary,environment:'Production'});
 assert.equal(await access(ordinary,'Production'),true);
 await user(ordinary,async()=>{assert.equal(await scalar('select public.cafe_has_hiring_access($1)',[ordinary]),true);await job(1,ordinary);await job(2,ordinary);});
 assert.equal(await scalar('select count(*)::int from private.apple_sandbox_test_accounts'),0);
});
test('native paid access respects suspension, role, owner pause and expiry without changing existing Stripe/free access',async()=>{
 await enable();await grant();
 await db.query('update cafe_subscriptions set owner_paused_at=now() where user_id=$1',[reviewer]);
 assert.equal(await access(),false);
 await user(reviewer,async()=>assert.equal(await scalar('select public.cafe_has_hiring_access($1)',[reviewer]),false));
 await db.query('update cafe_subscriptions set owner_paused_at=null where user_id=$1',[reviewer]);
 await db.query('update profiles set suspended_at=now() where id=$1',[reviewer]);assert.equal(await access(),false);
 await db.query("update profiles set suspended_at=null,role='barista' where id=$1",[reviewer]);assert.equal(await access(),false);
 await db.query("update profiles set role='cafe_owner_manager' where id=$1",[reviewer]);
 await db.query("update private.apple_sandbox_test_accounts set expires_at=clock_timestamp()-interval '1 second' where user_id=$1",[reviewer]);
 assert.equal(await access(),false);
 await db.query("update private.apple_sandbox_test_accounts set expires_at=clock_timestamp()+interval '1 day' where user_id=$1",[reviewer]);
 await grant({status:'expired',end:'2000-01-01',revision:1});assert.equal(await access(),false);
 assert.equal(await scalar('select private.cafe_has_paid_job_entitlement($1)',[stripeCafe]),true);
 await db.query('update cafe_subscriptions set complimentary_access=true where user_id=$1',[ordinary]);
 await user(ordinary,async()=>assert.equal(await scalar('select public.cafe_has_hiring_access($1)',[ordinary]),true));
 assert.equal(await scalar('select private.cafe_has_paid_job_entitlement($1)',[ordinary]),false);
});
test('self-only native boolean cannot reveal another user and preserves invoker hiring helper',async()=>{
 await enable();await grant();
 await user(ordinary,async()=>{
  assert.equal(await scalar('select public.native_billing_self_access($1)',[reviewer]),false);
  assert.equal(await scalar('select public.cafe_has_hiring_access($1)',[reviewer]),false);
 });
 assert.equal(await scalar("select prosecdef from pg_proc where oid='public.cafe_has_hiring_access(uuid)'::regprocedure"),false);
});
test('existing job-match message policy preserves participant chat after revoke while paid access is removed',async()=>{
 await enable();await grant();
 await user(reviewer,()=>job(10));
 const jobId='60000000-0000-4000-8000-000000000010';
 const application='80000000-0000-4000-8000-000000000001';
 await db.query("insert into public.applications(id,job_id,barista_id,status) values($1,$2,$3,'matched')",[application,jobId,barista]);
 const send=()=>db.query("insert into public.messages(application_id,sender_id,body) values($1,$2,'TEST ONLY synthetic local message')",[application,reviewer]);
 await user(reviewer,send);
 await revoke();
 assert.equal(await access(),false);
 await user(reviewer,send);
 await user(ordinary,async()=>assert.rejects(send(),/row-level security policy/));
 assert.equal(await scalar('select count(*)::int from public.messages where application_id=$1',[application]),2);
});
test('saved discovery message policy permits current mapped entitlement and rejects the café send after revoke',async()=>{
 await enable();await grant();
 const match='80000000-0000-4000-8000-000000000002';
 await db.query('insert into public.discovery_matches(id,barista_id,cafe_id) values($1,$2,$3)',[match,barista,reviewer]);
 const send=()=>db.query("insert into public.discovery_messages(match_id,sender_id,body) values($1,$2,'TEST ONLY synthetic local discovery message')",[match,reviewer]);
 await user(reviewer,send);
 await revoke();
 await user(reviewer,async()=>assert.rejects(send(),/row-level security policy/));
 assert.equal(await scalar('select count(*)::int from public.discovery_messages where match_id=$1',[match]),1);
});
test('mapping revoke allows owned historical revocation and settlement without restoring current paid access',async()=>{
 await enable();const result=await claim();await start();await grant({storeBinding:result.accountBinding});await revoke();
 assert.equal(await scalar('select public.native_checkout_settle_verified($1,$2)',[reviewer,'Sandbox']),true);
 assert.equal(await scalar('select state from private.native_checkout_attempts'),'verified');
 assert.equal(await grant({status:'revoked',revision:1}),'applied');
 assert.equal(await access(),false);
 await assert.rejects(grant({status:'active',revision:2}),/not authorized/);
 await assert.rejects(grant({status:'revoked',revision:0,subscription:'new-unowned'}),/not authorized/);
 assert.equal(await scalar('select revision::int from private.native_billing_subscriptions'),2);
});
test('expired or refunded proof cannot settle unrelated started attempts',async()=>{
 await enable();await claim();await start();
 await grant({status:'expired',end:'2000-01-01'});
 await scalar('select public.native_checkout_settle_verified($1,$2)',[reviewer,'Sandbox']);
 assert.equal(await scalar('select state from private.native_checkout_attempts'),'started');
});
test('ownership, optimistic revisions and event replay safeguards survive the environment change',async()=>{
 await enable();const token=await binding(reviewer);await grant({storeBinding:token});
 assert.equal(await grant({storeBinding:token}),'retry');
 assert.equal(await grant({storeBinding:token,revision:1}),'duplicate');
 await assert.rejects(grant({id:ordinary,environment:'Production',storeBinding:token}),/ownership could not be confirmed/);
 const args=['apple','Sandbox','synthetic-event','a'.repeat(64),'70000000-0000-4000-8000-000000000001'];
 assert.equal(await scalar('select public.native_billing_claim_event($1,$2,$3,$4,$5)',args),'claimed');
 assert.equal(await scalar('select public.native_billing_finish_event($1,$2,$3,$4,true)',[args[0],args[1],args[2],args[4]]),true);
 assert.equal(await scalar('select public.native_billing_claim_event($1,$2,$3,$4,$5)',args),'duplicate');
 await assert.rejects(scalar('select public.native_billing_claim_event($1,$2,$3,$4,$5)',[...args.slice(0,3),'b'.repeat(64),args[4]]),/identity conflict/);
});
test('summary refuses client-selected wrong environments and exposes no receipts or account bindings',async()=>{
 await enable();await grant();
 await assert.rejects(scalar('select public.native_billing_summary($1,$2)',[reviewer,'Production']),/not authorized/);
 const summary=await scalar('select public.native_billing_summary($1,$2)',[reviewer,'Sandbox']);
 assert.equal(summary.subscriptions.length,1);
 assert.deepEqual(Object.keys(summary.subscriptions[0]).sort(),['autoRenews','currentPeriodEnd','gracePeriodEnd','provider','status'].sort());
 assert.doesNotMatch(JSON.stringify(summary),/synthetic-original|synthetic-transaction|store_binding|accountBinding/);
});
test('summary exposes only an authoritative pause boolean and resumes it without changing saved financial status',async()=>{
 await enable();await grant();
 const summary=()=>scalar('select public.native_billing_summary($1,$2)',[reviewer,'Sandbox']);
 const initial=await summary();assert.equal(initial.ownerPaused,false);
 const originalProfile=await scalar('select to_jsonb(p) from public.profiles p where id=$1',[reviewer]);
 const originalCafe=await scalar('select to_jsonb(s) from public.cafe_subscriptions s where user_id=$1',[reviewer]);
 await db.query("update public.cafe_subscriptions set owner_paused_at='2026-10-31T13:00:00Z' where user_id=$1",[reviewer]);
 const paused=await summary();assert.equal(paused.ownerPaused,true);
 assert.deepEqual(paused.subscriptions,initial.subscriptions);
 assert.doesNotMatch(JSON.stringify(paused),/2026-10-31|owner_paused_at/);
 await db.query('update public.cafe_subscriptions set owner_paused_at=null where user_id=$1',[reviewer]);
 assert.equal((await summary()).ownerPaused,false);
 assert.deepEqual(await scalar('select to_jsonb(p) from public.profiles p where id=$1',[reviewer]),originalProfile);
 assert.deepEqual(await scalar('select to_jsonb(s) from public.cafe_subscriptions s where user_id=$1',[reviewer]),originalCafe);
 await db.query('delete from public.cafe_subscriptions where user_id=$1',[reviewer]);
 assert.equal((await summary()).ownerPaused,true,'a missing café state fails closed');
});
test('anonymous/authenticated clients cannot inspect or write mapping/ledger or invoke privileged RPCs',async()=>{
 for(const clientRole of ['anon','authenticated']){
  await role(clientRole,async()=>{
   for(const table of ['apple_sandbox_test_accounts','native_billing_accounts','native_billing_subscriptions','native_billing_events','native_billing_configuration','native_checkout_attempts']){
    await assert.rejects(db.exec('select * from private.'+table),/permission denied/);
    await assert.rejects(db.exec('delete from private.'+table),/permission denied/);
   }
   await assert.rejects(enable(),/permission denied/);
   await assert.rejects(context(),/permission denied/);
   await assert.rejects(claim(),/permission denied/);
   await assert.rejects(scalar('select public.native_checkout_attempt_context($1,$2)',[reviewer,attemptId]),/permission denied/);
   await assert.rejects(scalar('select private.native_billing_environment($1,null)',[reviewer]),/permission denied/);
  });
 }
 await role('service_role',async()=>{
  await assert.rejects(db.exec('select * from private.apple_sandbox_test_accounts'),/permission denied/);
  await assert.rejects(db.exec("insert into private.apple_sandbox_test_accounts(user_id) values('"+reviewer+"')"),/permission denied/);
  assert.deepEqual(await enable(),{environment:'Sandbox',appleSandboxTester:true});
 });
 assert.equal(await scalar("select count(*)::int from pg_policies where schemaname='private' and tablename='apple_sandbox_test_accounts'"),0);
 assert.equal(await scalar("select relrowsecurity from pg_class where oid='private.apple_sandbox_test_accounts'::regclass"),true);
 assert.equal(await scalar("select count(*)::int from pg_proc where pronamespace='public'::regnamespace and proname in ('native_checkout_claim','native_checkout_start','native_checkout_recover_apple')"),3);
});

test('the one-time draft rejects repeated application and cannot populate the tester mapping',async()=>{
 await assert.rejects(db.exec(draftSql()),/already present or schema drift/);
 await db.exec('rollback');
 assert.equal(await scalar('select count(*)::int from private.apple_sandbox_test_accounts'),0);
});
test('a stale transaction isolation snapshot cannot authorize new checkout or current paid access',async()=>{
 await enable();await grant();
 await db.exec('begin isolation level repeatable read');
 try{
  assert.equal(await access(),false);
  assert.equal(await claim(),null);
  await assert.rejects(context(),/context unavailable/);
 }finally{await db.exec('rollback');}
 assert.equal(await access(),true);
});
test('function drift aborts the draft atomically before mapping or privilege changes',async()=>{
 const disposable=new PGlite();
 try{
  await createAppleSandboxFixture(disposable,{applyDraft:false});
  await disposable.exec("create or replace function public.native_checkout_provider(p_user_id uuid,p_environment text,p_attempt_id uuid) returns text language sql stable security definer set search_path=pg_catalog,private as $$select 'apple'::text$$;");
  await assert.rejects(disposable.exec(draftSql()),/function\/security drift/);
  await disposable.exec('rollback');
  assert.equal((await disposable.query("select to_regclass('private.apple_sandbox_test_accounts') as relation")).rows[0].relation,null);
  assert.equal((await disposable.query("select count(*)::int as n from information_schema.columns where table_schema='private' and table_name='native_checkout_attempts' and column_name='guard_protocol'")).rows[0].n,0);
 }finally{await disposable.close();}
});
test('volatility, private-table privilege and unique-index drift all abort before new authorization objects',async()=>{
 const changes=[
  ["alter function public.native_billing_summary(uuid,text) volatile",/function\/security drift/],
  ["grant truncate on private.native_billing_events to service_role",/table\/security drift/],
  ["drop index private.native_checkout_one_open_account",/index drift/],
 ];
 for(const [change,expected] of changes){
  const disposable=new PGlite();
  try{
   await createAppleSandboxFixture(disposable,{applyDraft:false});await disposable.exec(change);
   await assert.rejects(disposable.exec(draftSql()),expected);
   await disposable.exec('rollback');
   assert.equal((await disposable.query("select to_regclass('private.apple_sandbox_test_accounts') as relation")).rows[0].relation,null);
  }finally{await disposable.close();}
 }
});
test('RPC parameter-name, default-expression and result-type drift are independently rejected',async()=>{
 const originalFixture=await import('node:fs').then(m=>m.readFileSync(new URL('./apple-sandbox-live-functions.fixture.sql',import.meta.url),'utf8'));
 const original=originalFixture.slice(originalFixture.indexOf('CREATE OR REPLACE FUNCTION public.native_billing_account'),originalFixture.indexOf('REVOKE ALL ON FUNCTION public.native_billing_account'));
 const apply=originalFixture.slice(originalFixture.indexOf('CREATE OR REPLACE FUNCTION public.native_billing_apply'),originalFixture.indexOf('REVOKE ALL ON FUNCTION public.native_billing_apply'));
 const changes=[
  'drop function public.native_billing_account(uuid);'+original.replace('native_billing_account(p_user_id uuid)','native_billing_account(p_buyer_id uuid)'),
  apply.replace('DEFAULT NULL::text',"DEFAULT 'unexpected-default'::text"),
  'drop function public.native_billing_account(uuid);'+original.replace('RETURNS uuid','RETURNS text'),
 ];
 for(const change of changes){
  const disposable=new PGlite();
  try{
   await createAppleSandboxFixture(disposable,{applyDraft:false});await disposable.exec(change);
   // Keep every other security attribute at baseline so this specifically
   // exercises named/default/result dispatch metadata, not default PUBLIC ACL.
   await disposable.exec('revoke all on function public.native_billing_account(uuid) from public,anon,authenticated;grant execute on function public.native_billing_account(uuid) to service_role;');
   await assert.rejects(disposable.exec(draftSql()),/RPC wire metadata drift/);
   await disposable.exec('rollback');
   assert.equal((await disposable.query("select to_regclass('private.apple_sandbox_test_accounts') as relation")).rows[0].relation,null);
  }finally{await disposable.close();}
 }
});

