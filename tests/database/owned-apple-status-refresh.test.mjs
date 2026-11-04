import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAppleSandboxFixture,resetAppleSandboxFixture,reviewer,ordinary,barista} from './apple-sandbox-fixture.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const migrationPath='supabase/migrations/20261104143313_owned_apple_status_refresh.sql';
const product='com.baristajobmatch.cafe.pro.monthly';
let db,pg,connection,baseline;const socket=process.env.BJM_OWNED_REFRESH_PG_SOCKET;const ci=process.env.BJM_OWNED_REFRESH_CI_FIXTURE==='1';const concurrent=Boolean(socket||ci);
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0]??{})[0]??null;
async function role(name,fn){await db.exec('set role '+name);try{return await fn();}finally{await db.exec('reset role');}}
const snapshot=(id=reviewer)=>role('service_role',()=>scalar('select public.native_billing_owned_apple_refresh($1)',[id]));
const applySql='select public.native_billing_apply_owned_apple_refresh('+Array.from({length:15},(_,i)=>'$'+(i+1)).join(',')+')';
function args(s,override={}){const p={user:s.userId,binding:s.binding,chain:s.subscriptionId,revision:s.revision,generation:s.generation,authorized:s.authorizedAt,expires:s.expiresAt,start:s.windowStartsAt,end:s.windowEndsAt,product:s.productId,transaction:'synthetic-verified-new',status:'expired',period:s.currentPeriodEnd,grace:null,auto:false,...override};return [p.user,p.binding,p.chain,p.revision,p.generation,p.authorized,p.expires,p.start,p.end,p.product,p.transaction,p.status,p.period,p.grace,p.auto];}
const apply=(s,p={})=>role('service_role',()=>scalar(applySql,args(s,p)));
const ledger=()=>scalar("select coalesce(jsonb_agg(to_jsonb(s) order by provider,environment,provider_subscription_key),'[]'::jsonb) from private.native_billing_subscriptions s");
const protectedRows=()=>scalar("select jsonb_build_object('profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),'billing',(select jsonb_agg(to_jsonb(s) order by user_id) from public.cafe_subscriptions s),'accounts',(select coalesce(jsonb_agg(to_jsonb(a) order by user_id),'[]'::jsonb) from private.native_billing_accounts a),'registry',(select jsonb_agg(to_jsonb(a) order by user_id) from private.apple_sandbox_test_allowlist a),'maps',(select jsonb_agg(to_jsonb(a) order by user_id) from private.apple_sandbox_test_accounts a),'events',(select coalesce(jsonb_agg(to_jsonb(e) order by event_id),'[]'::jsonb) from private.native_billing_events e),'attempts',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from private.native_checkout_attempts t))");
const oldContracts=()=>scalar("select jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('definition',md5(pg_get_functiondef(p.oid)),'owner',p.proowner,'acl',p.proacl,'config',p.proconfig)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f' and p.proname not in ('native_billing_owned_apple_refresh','native_billing_apply_owned_apple_refresh')");
async function seed({id=reviewer,chain='synthetic-primary-original',provider='apple',environment='Sandbox',status='active',fresh=false,future=false,sku=product,revision=1}={}){
 const binding=await scalar('select public.native_billing_account($1)',[id]);
 await db.query(`insert into private.native_billing_subscriptions(provider,environment,provider_subscription_id,provider_subscription_key,user_id,product_id,transaction_id,status,current_period_end,auto_renews,revision,verified_at) values($1,$2,$3,encode(sha256(convert_to($3,'UTF8')),'hex'),$4,$5,'synthetic-original-tx',$6,clock_timestamp()+($7::text||' minutes')::interval,true,$8,clock_timestamp()-($9::text||' seconds')::interval)`,[provider,environment,chain,id,sku,status,future?10:-1,revision,fresh?0:120]);
 return binding;
}
before(async()=>{
 if(socket||ci){
  if(ci){assert.equal(socket,undefined);assert.equal(process.env.BJM_OWNED_REFRESH_PG_DRIVER,undefined);({default:pg}=await import(new URL('../moderation-database/node_modules/pg/lib/index.js',import.meta.url)));connection={host:'127.0.0.1',port:5432,user:'postgres',database:'bjm_owned_refresh_test',password:'isolated-owned-refresh-ci-fixture-only'};}
  else{assert.match(socket,/^\/private\/tmp\/bjm-owned-apple-refresh-[a-z0-9-]+$/);assert.equal(process.env.BJM_OWNED_REFRESH_PG_DRIVER,'/private/tmp/bjm-storekit-pg17-tools-20261031/node_modules/pg/lib/index.js');({default:pg}=await import(process.env.BJM_OWNED_REFRESH_PG_DRIVER));connection={host:socket,port:55448,user:'postgres',database:'postgres'};}
  const c=new pg.Client(connection);await c.connect();assert.match((await c.query('show server_version')).rows[0].server_version,/^17\./);
  db={query:(q,a)=>c.query(q,a),exec:q=>c.query(q),close:()=>c.end()};
 }else{const {PGlite}=await import('@electric-sql/pglite');db=new PGlite();}
 assert.equal(await scalar("select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth') and c.relkind in ('r','p')"),0,'Refuse nonempty or shared database before fixture writes');
 await createAppleSandboxFixture(db);
 await db.exec(read('tests/database/owned-apple-status-refresh.fixture.sql'));
 baseline=await oldContracts();
 const migration=read(migrationPath);assert.match(migration,/CREATE FUNCTION public\.native_billing_owned_apple_refresh/);
 await db.exec(migration);
});
beforeEach(async()=>{
 await resetAppleSandboxFixture(db);
 await db.exec(`delete from private.apple_sandbox_test_allowlist where purpose='owner_qa';
 update private.apple_sandbox_test_allowlist set window_starts_at=clock_timestamp()-interval '1 hour',window_ends_at=clock_timestamp()+interval '1 day' where purpose='app_review';
 insert into private.apple_sandbox_test_accounts(user_id,purpose,enabled,generation,authorized_at,expires_at) values('${reviewer}','app_review',true,1,clock_timestamp()-interval '30 minutes',clock_timestamp()+interval '1 hour');`);
});
after(()=>db?.close());

test('exact generated migration adds only two service RPCs; old contracts and private schema privileges unchanged',async()=>{
 assert.deepEqual(await oldContracts(),baseline);
 for(const name of ['native_billing_owned_apple_refresh','native_billing_apply_owned_apple_refresh']){
  const m=(await db.query("select p.prosecdef,p.provolatile,p.proconfig,pg_get_userbyid(p.proowner) owner from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=$1",[name])).rows;
  assert.equal(m.length,1);assert.equal(m[0].prosecdef,true);assert.equal(m[0].provolatile,'v');assert.equal(m[0].owner,'postgres');assert.deepEqual(m[0].proconfig,['search_path=pg_catalog, private','lock_timeout=1s']);
 }
 assert.equal(await scalar("select has_schema_privilege('service_role','private','USAGE')"),false);
});
test('members and anonymous cannot execute either RPC even with user metadata/UUID; service does not need private schema USAGE',async()=>{
 await seed();const s=await snapshot();assert.ok(s);
 for(const name of ['anon','authenticated'])await role(name,async()=>{
  await assert.rejects(scalar('select public.native_billing_owned_apple_refresh($1)',[reviewer]),/permission denied/);
  await assert.rejects(scalar(applySql,args(s)),/permission denied/);
 });
 assert.equal(await apply(s),'applied');
});
test('empty history snapshot is inert and never creates an account or sentinel',async()=>{
 const before=await protectedRows();assert.equal(await snapshot(),null);assert.deepEqual(await protectedRows(),before);assert.deepEqual(await ledger(),[]);
});
test('snapshot returns exact server-owned stale chain and authority only through service RPC',async()=>{
 const binding=await seed();const before=await protectedRows();const s=await snapshot();
 assert.deepEqual(Object.keys(s).sort(),['userId','provider','environment','subscriptionId','binding','productId','status','autoRenews','revision','generation','verifiedAt','currentPeriodEnd','gracePeriodEnd','authorizedAt','expiresAt','windowStartsAt','windowEndsAt'].sort());
 assert.equal(s.binding,binding);assert.equal(s.subscriptionId,'synthetic-primary-original');assert.equal(s.provider,'apple');assert.equal(s.environment,'Sandbox');assert.equal(s.generation,1);assert.equal(s.revision,1);assert.deepEqual(await protectedRows(),before);
});
test('fresh verification or future paid period is not refreshed',async()=>{
 await seed({fresh:true});assert.equal(await snapshot(),null);
 await db.exec("update private.native_billing_subscriptions set verified_at=clock_timestamp()-interval '120 seconds',current_period_end=clock_timestamp()+interval '1 hour'");assert.equal(await snapshot(),null);
});
test('future grace remains untouched, elapsed grace and payment_required are eligible',async()=>{
 await seed({status:'grace'});await db.exec("update private.native_billing_subscriptions set grace_period_end=clock_timestamp()+interval '1 hour'");assert.equal(await snapshot(),null);
 await db.exec("update private.native_billing_subscriptions set grace_period_end=clock_timestamp()-interval '1 minute'");assert.ok(await snapshot());
 await db.exec("update private.native_billing_subscriptions set status='payment_required'");assert.ok(await snapshot());
});
test('unrelated terminal history is allowed but multiple eligible stale chains fail closed',async()=>{
 await seed();await seed({chain:'synthetic-terminal',status:'expired'});assert.equal((await snapshot()).subscriptionId,'synthetic-primary-original');
 await seed({chain:'synthetic-second-stale'});assert.equal(await snapshot(),null);
});
test('wrong product, provider, environment, sentinel and superseded records are never selected',async()=>{
 for(const values of [{sku:'other.product'},{provider:'google'},{environment:'Production'},{revision:0},{status:'expired'},{status:'revoked'}]){
  await db.exec('truncate private.native_billing_subscriptions');await seed(values);assert.equal(await snapshot(),null);
 }
 await db.exec('truncate private.native_billing_subscriptions');await seed();await db.exec("update private.native_billing_subscriptions set superseded_by='synthetic-tombstone'");assert.equal(await snapshot(),null);
});
test('ordinary cafe/barista/null cannot obtain primary history',async()=>{
 await seed();for(const id of [ordinary,barista,null])assert.equal(await snapshot(id),null);
});
test('current role, suspension, owner pause and global Production gate snapshot',async()=>{
 await seed();
 for(const [change,restore] of [["update profiles set role='barista'","update profiles set role='cafe_owner_manager'"],["update profiles set suspended_at=clock_timestamp()","update profiles set suspended_at=null"],["update cafe_subscriptions set owner_paused_at=clock_timestamp()","update cafe_subscriptions set owner_paused_at=null"],["update private.native_billing_configuration set environment='Sandbox'","update private.native_billing_configuration set environment='Production'"]]){
  await db.exec(change);assert.equal(await snapshot(),null);await db.exec(restore);
 }
});
test('disabled, future authorization and expired mapping cannot refresh',async()=>{
 await seed();await db.exec('update private.apple_sandbox_test_accounts set enabled=false,authorized_at=null,expires_at=null');assert.equal(await snapshot(),null);
 await db.exec("update private.apple_sandbox_test_accounts set enabled=true,authorized_at=clock_timestamp()+interval '1 minute',expires_at=clock_timestamp()+interval '1 hour'");assert.equal(await snapshot(),null);
 await db.exec("update private.apple_sandbox_test_accounts set authorized_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 minute'");assert.equal(await snapshot(),null);
});
test('dedicated ownerQA is excluded even when otherwise mapped to Apple Sandbox',async()=>{
 await db.query("update profiles set cafe_name='TEST ONLY synthetic',is_discoverable=false where id=$1",[ordinary]);
 await db.query("insert into private.apple_sandbox_test_allowlist(purpose,user_id,window_starts_at,window_ends_at) values('owner_qa',$1,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')",[ordinary]);
 await db.query("insert into private.apple_sandbox_test_accounts(user_id,purpose,enabled,generation,authorized_at,expires_at) values($1,'owner_qa',true,1,clock_timestamp()-interval '30 minutes',clock_timestamp()+interval '30 minutes')",[ordinary]);
 await seed({id:ordinary});assert.equal(await scalar("select private.native_billing_environment($1,'apple')",[ordinary]),'Sandbox');assert.equal(await snapshot(ordinary),null);
});
test('valid verified expired update modifies only the existing ledger and preserves financial/authority/history records',async()=>{
 await seed();await seed({chain:'synthetic-retained-terminal',status:'revoked'});const s=await snapshot();const before=await protectedRows();
 assert.equal(await apply(s),'applied');assert.deepEqual(await protectedRows(),before);
 const rows=await ledger();assert.equal(rows.length,2);const target=rows.find(x=>x.provider_subscription_id===s.subscriptionId);assert.equal(target.status,'expired');assert.equal(target.revision,2);assert.equal(target.auto_renews,false);assert.equal(rows.find(x=>x.provider_subscription_id==='synthetic-retained-terminal').revision,1);
 assert.equal(await scalar("select public.native_billing_access($1,'Sandbox')",[reviewer]),false);assert.equal(await scalar("select public.native_billing_access($1,'Production')",[reviewer]),false);
});
test('lost chain, missing account or wrong binding never inserts/recreates a sentinel',async()=>{
 await seed();const s=await snapshot();const before=await ledger();
 assert.equal(await apply(s,{chain:'not-recorded'}),'stale');assert.equal(await apply(s,{binding:'00000000-0000-4000-8000-000000000009'}),'stale');assert.deepEqual(await ledger(),before);
 await db.exec('delete from private.native_billing_subscriptions');assert.equal(await apply(s),'stale');assert.deepEqual(await ledger(),[]);
});
test('CAS and every captured authority field must remain exact',async()=>{
 await seed();const s=await snapshot();const before=await ledger();
 for(const o of [{revision:2},{generation:2},{authorized:'2000-01-01'},{expires:'2099-01-01'},{start:'2000-01-01'},{end:'2099-01-01'}])assert.equal(await apply(s,o),'stale');
 await db.exec('update private.native_billing_subscriptions set revision=2');assert.equal(await apply(s),'stale');assert.equal((await ledger())[0].status,before[0].status);
});
test('changed registry, mapping, profile and owner pause fail closed after snapshot',async()=>{
 await seed();const s=await snapshot();
 await db.exec('update private.apple_sandbox_test_accounts set generation=2');assert.equal(await apply(s),'stale');await db.exec('update private.apple_sandbox_test_accounts set generation=1');
 await db.exec("update private.apple_sandbox_test_allowlist set window_ends_at=window_ends_at+interval '1 hour'");assert.equal(await apply(s),'stale');
 await db.query("update private.apple_sandbox_test_allowlist set window_ends_at=$1 where purpose='app_review'",[s.windowEndsAt]);
 await db.query('update profiles set suspended_at=clock_timestamp() where id=$1',[reviewer]);assert.equal(await apply(s),'stale');await db.query('update profiles set suspended_at=null where id=$1',[reviewer]);
 await db.query("update profiles set role='barista' where id=$1",[reviewer]);assert.equal(await apply(s),'stale');await db.query("update profiles set role='cafe_owner_manager' where id=$1",[reviewer]);
 await db.query('update cafe_subscriptions set owner_paused_at=clock_timestamp() where user_id=$1',[reviewer]);assert.equal(await apply(s),'stale');
 assert.equal((await ledger())[0].revision,1);
});
test('invalid result types/null authority and mismatched product cannot use existing-only apply',async()=>{
 await seed();const s=await snapshot();const before=await ledger();
 for(const o of [{revision:null},{generation:null},{authorized:null},{expires:null},{start:null},{end:null},{product:'other.product'},{transaction:''},{status:'pending'},{period:'infinity'},{auto:null}])assert.equal(await apply(s,o),'stale');
 assert.deepEqual(await ledger(),before);
});
test('repeatable-read/serializable snapshots cannot authorize refresh or apply',async()=>{
 await seed();const s=await snapshot();for(const level of ['repeatable read','serializable']){
  await db.exec('begin isolation level '+level);try{assert.equal(await snapshot(),null);assert.equal(await apply(s),'stale');}finally{await db.exec('rollback');}
 }
});
async function waitForLock(pid){for(let i=0;i<100;i++){if(await scalar("select wait_event_type='Lock' from pg_stat_activity where pid=$1",[pid]))return;await new Promise(r=>setTimeout(r,10));}throw Error('Expected actual PostgreSQL row-lock wait');}
async function racingApply(mutate,{expire=false,ledgerLock=false}={}){
 await seed();if(expire)await db.exec("update private.apple_sandbox_test_accounts set expires_at=clock_timestamp()+interval '0.3 seconds'");const s=await snapshot();assert.ok(s);
 const c=new pg.Client(connection);await c.connect();const pid=(await c.query('select pg_backend_pid() pid')).rows[0].pid;await c.query('set role service_role');
 await db.exec('begin');let pending;
 try{
  if(ledgerLock)await db.query('select 1 from private.native_billing_subscriptions where user_id=$1 for update',[reviewer]);else await db.query('select 1 from cafe_subscriptions where user_id=$1 for update',[reviewer]);
  pending=c.query(applySql,args(s));await waitForLock(pid);const waitStarted=Date.now();await mutate();await db.exec('commit');if(expire)assert.ok(Date.now()-waitStarted<950,'Expiry race must complete below1s lock timeout');
  assert.equal(Object.values((await pending).rows[0])[0],'stale');
 }finally{await db.exec('rollback');if(pending)await pending.catch(()=>{});await c.end();}
}
test('real concurrent revocation while waiting on cafe lock cannot apply old authority',{skip:!concurrent},async()=>{
 await racingApply(()=>db.query('select public.native_billing_set_apple_sandbox_tester($1,false)',[reviewer]));assert.equal((await ledger())[0].revision,1);
});
test('real lock wait cannot use a clock captured before authority expiry',{skip:!concurrent},async()=>{
 await racingApply(()=>db.exec('select pg_sleep(0.4)'),{expire:true});assert.equal((await ledger())[0].revision,1);
});
test('real concurrent deletion of locked existing chain never recreates it',{skip:!concurrent},async()=>{
 await racingApply(()=>db.exec('delete from private.native_billing_subscriptions'),{ledgerLock:true});assert.deepEqual(await ledger(),[]);
});

test('real foreground lock timeout is bounded and cannot mutate the ledger',{skip:!concurrent},async()=>{
 await seed();const s=await snapshot();const c=new pg.Client(connection);await c.connect();await c.query('set role service_role');await db.exec('begin');
 try{await db.query('select 1 from cafe_subscriptions where user_id=$1 for update',[reviewer]);const start=Date.now();assert.equal(Object.values((await c.query(applySql,args(s))).rows[0])[0],'stale');const elapsed=Date.now()-start;assert.ok(elapsed>=850&&elapsed<2500,'Expected real1s lock timeout');assert.equal((await ledger())[0].revision,1);}
 finally{await db.exec('rollback');await c.end();}
});
