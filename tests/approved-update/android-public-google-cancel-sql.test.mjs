import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

// Explicit approved LOCAL PG17 WASM runtime only. CI without that runtime must
// not silently substitute its existing PG18 package as target-major proof.
const runtimeRoot=process.env.BARISTAMATCH_PG17_RUNTIME_ROOT;
const file=path=>readFileSync(new URL(`../../${path}`,import.meta.url),'utf8');
const cafe='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const barista='10000000-0000-4000-8000-000000000003',first='20000000-0000-4000-8000-000000000001';
const second='20000000-0000-4000-8000-000000000002';
test('Google-only cancellation SQL acceptance on approved local PG17 (no hosted/concurrency proof)',{skip:!runtimeRoot},async t=>{
  assert.match(runtimeRoot,/^\/private\/tmp\/baristamatch-pg17-wasm-[A-Za-z0-9]+$/);
  const packageInfo=JSON.parse(readFileSync(`${runtimeRoot}/package/package.json`,'utf8'));
  assert.equal(packageInfo.name,'@electric-sql/pglite');assert.equal(packageInfo.version,'0.3.7');
  const downloaded=readFileSync(`${runtimeRoot}/pglite-0.3.7.tgz`);
  assert.equal(createHash('sha256').update(downloaded).digest('hex'),'5939f21eb5f44cabe729ea159ab8b741d3ed2b9d4cb14e630dd3f0cef0bc5108');
  globalThis.fetch=async()=>{throw Error('LOCAL_TEST_NETWORK_FORBIDDEN');};
  const {PGlite}=await import(pathToFileURL(`${runtimeRoot}/package/dist/index.js`).href);
  const db=new PGlite();
  const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0];
  const claim=(provider='google',user=cafe,id=first)=>scalar("select public.native_checkout_claim($1,$2,'Production',$3)",[user,provider,id]);
  const cancel=(before=false,user=cafe,id=first)=>scalar('select public.android_google_checkout_cancel($1,$2,$3)',[user,id,before]);
  const state=()=>scalar('select state from private.native_checkout_attempts where id=$1',[first]);
  const source=file('server/android-public-billing/sql/google_checkout_cancel.sql');
  const settlement=file('server/android-public-billing/sql/google_checkout_settle.sql');
  try {
    assert.equal(Math.floor((await scalar("select current_setting('server_version_num')::int"))/10000),17);
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create table public.profiles(id uuid primary key,role text,suspended_at timestamptz);
      create table public.cafe_subscriptions(user_id uuid primary key,stripe_customer_id text,stripe_subscription_id text,status text,
        current_period_end timestamptz,cancel_at_period_end boolean default false,updated_at timestamptz default now(),
        stripe_checkout_claim_id uuid,stripe_checkout_claim_expires_at timestamptz,stripe_checkout_claim_kind text,
        stripe_checkout_attempt_id uuid,stripe_checkout_channel text,stripe_checkout_ui_mode text);
      insert into public.profiles values('${cafe}','cafe_owner_manager',null),('${other}','cafe_owner_manager',null),('${barista}','barista',null);
      insert into public.cafe_subscriptions(user_id,status) values('${cafe}','free'),('${other}','free');`);
    // Execute real original state-machine definitions, not sentinel stubs.
    await db.exec(file('review/native-billing-ledger.sql'));
    await db.exec(file('review/native-checkout-coordination.sql'));
    await db.exec(file('server/native-billing/sql/checkout_provider.sql'));
    const manifest=()=>db.query("select p.oid::regprocedure::text as identity,pg_get_functiondef(p.oid) as definition,p.proacl::text as acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname not in ('android_google_checkout_cancel','android_google_checkout_settle_verified') order by 1");
    const baseline=await manifest();await db.exec(source);await db.exec(settlement);assert.deepEqual(await manifest(),baseline);
    const run=async(name,fn)=>t.test(name,async()=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback;reset role');}});
    await run('new RPC service-only ACL; original atomics and provider lookup definitions/ACL preserved',async()=>{
      for(const role of ['anon','authenticated'])assert.equal(await scalar(`select has_function_privilege('${role}','public.android_google_checkout_cancel(uuid,uuid,boolean)','EXECUTE')`),false);
      assert.equal(await scalar("select has_function_privilege('service_role','public.android_google_checkout_cancel(uuid,uuid,boolean)','EXECUTE')"),true);
      assert.equal(await scalar("select prosecdef from pg_proc where oid='public.android_google_checkout_cancel(uuid,uuid,boolean)'::regprocedure"),true);
      assert.deepEqual(await manifest(),baseline);
    });
    for(const role of ['anon','authenticated'])await run(`${role} cannot execute even with a matching user UUID`,async()=>{
      await claim();await db.exec('savepoint forbidden');await db.exec(`set local role ${role}`);
      await assert.rejects(cancel(),e=>e.code==='42501');await db.exec('rollback to savepoint forbidden');assert.equal(await state(),'reserved');
    });
    await run('owned Google reserved cancellation releases original pending checkout; repeat is idempotent',async()=>{
      await claim();await db.exec('set local role service_role');assert.equal(await cancel(),true);assert.equal(await cancel(),true);
      await db.exec('reset role');assert.equal(await state(),'cancelled');
      assert.equal(await scalar("select public.native_checkout_pending($1,'Production')",[cafe]),false);
    });
    await run('owned Google started explicit cancellation works while original provider lookup stays reserved-only',async()=>{
      await claim();assert.equal(await scalar("select public.native_checkout_start($1,'Production',$2)",[cafe,first]),true);
      assert.equal(await scalar("select public.native_checkout_provider($1,'Production',$2)",[cafe,first]),null);
      await db.exec('set local role service_role');assert.equal(await cancel(),true);await db.exec('reset role');assert.equal(await state(),'cancelled');
    });
    await run('prelaunch cleanup cannot release a concurrently started attempt',async()=>{
      await claim();assert.equal(await scalar("select public.native_checkout_start($1,'Production',$2)",[cafe,first]),true);
      assert.equal(await cancel(true),false);assert.equal(await state(),'started');
    });
    await run('Apple reservation and started Apple checkout are never canceled by Android wrapper',async()=>{
      await claim('apple');assert.equal(await cancel(),false);assert.equal(await state(),'reserved');
      await scalar("select public.native_checkout_start($1,'Production',$2)",[cafe,first]);assert.equal(await cancel(),false);assert.equal(await state(),'started');
      assert.equal(await scalar("select public.native_checkout_cancel($1,'Production',$2,false)",[cafe,first]),true);
    });
    await run('another user and another attempt cannot cancel the owned checkout',async()=>{
      await claim();assert.equal(await cancel(false,other),false);assert.equal(await cancel(false,cafe,second),false);assert.equal(await state(),'reserved');
    });
    await run('wrong stored environment cannot be canceled through hardcoded Production wrapper',async()=>{
      await claim();await db.exec("update private.native_checkout_attempts set environment='Sandbox'");assert.equal(await cancel(),false);
      assert.equal(await state(),'reserved');
    });
    await run('suspended, barista and missing billing records deny cancellation',async()=>{
      await claim();await db.exec("update public.profiles set suspended_at=now() where id='"+cafe+"'");assert.equal(await cancel(),false);
      await db.exec("update public.profiles set suspended_at=null,role='barista' where id='"+cafe+"'");assert.equal(await cancel(),false);
      await db.exec("update public.profiles set role='cafe_owner_manager' where id='"+cafe+"';delete from public.cafe_subscriptions where user_id='"+cafe+"'");
      assert.equal(await cancel(),false);assert.equal(await state(),'reserved');
    });
    await run('expired and verified attempts are preserved; null cancellation arguments fail closed',async()=>{
      await claim();for(const value of ['expired','verified']){await db.query('update private.native_checkout_attempts set state=$1',[value]);assert.equal(await cancel(),false);}
      assert.equal(await cancel(null),false);assert.equal(await cancel(false,null),false);assert.equal(await cancel(false,cafe,null),false);
    });
    await run('unused expired reservation may be cleaned; lifetime started reservation cannot silently expire',async()=>{
      await claim();await db.exec("update private.native_checkout_attempts set reserved_until=now()-interval '1 hour'");
      assert.equal(await cancel(true),true);assert.equal(await state(),'cancelled');
    });
    await run('existing shared Stripe/native claim exclusion and one-use start are intact',async()=>{
      await claim();assert.equal(await scalar("select public.claim_stripe_checkout($1,$2,$3,'web','embedded')",[cafe,second,second]),null);
      assert.equal(await scalar("select public.native_checkout_start($1,'Production',$2)",[cafe,first]),true);
      assert.equal(await scalar("select public.native_checkout_start($1,'Production',$2)",[cafe,first]),false);
      assert.equal(await cancel(),true);assert.ok(await scalar("select public.claim_stripe_checkout($1,$2,$3,'web','embedded')",[cafe,second,second]));
    });
    await run('removed Production singleton prevents cancellation',async()=>{
      await claim();await db.exec("update private.native_billing_configuration set environment='Sandbox'");assert.equal(await cancel(),false);assert.equal(await state(),'reserved');
    });
    const settle=(user=cafe)=>scalar('select public.android_google_checkout_settle_verified($1)',[user]);
    const apply=async(provider,status,end='2099-01-01T00:00:00Z',renews=true)=>{
      const binding=await scalar('select public.native_billing_account($1)',[cafe]);
      await scalar("select public.native_billing_apply($1,$2,$3,'Production','fixture-token','fixture.monthly','fixture-tx',$4,$5,null,$6,0)",[cafe,binding,provider,status,end,renews]);
    };
    await run('Google settlement is service-only; anon/authenticated cannot clear a pending attempt',async()=>{
      await claim();
      for(const role of ['anon','authenticated']) {
        assert.equal(await scalar(`select has_function_privilege('${role}','public.android_google_checkout_settle_verified(uuid)','EXECUTE')`),false);
        await db.exec('savepoint forbidden');await db.exec(`set local role ${role}`);
        await assert.rejects(settle(),e=>e.code==='42501');await db.exec('rollback to savepoint forbidden');
      }
      assert.equal(await state(),'reserved');
      assert.equal(await scalar("select has_function_privilege('service_role','public.android_google_checkout_settle_verified(uuid)','EXECUTE')"),true);
    });
    await run('durably verified active Google purchase settles only Google attempt; repeated settle is a no-op',async()=>{
      await claim();await scalar("select public.native_checkout_start($1,'Production',$2)",[cafe,first]);await apply('google','active');
      await db.exec('set local role service_role');assert.equal(await settle(),true);assert.equal(await settle(),false);
      await db.exec('reset role');assert.equal(await state(),'verified');
      assert.equal(await scalar("select public.native_checkout_pending($1,'Production')",[cafe]),false);
      assert.equal(await claim('google',cafe,second),null);
    });
    await run('active Apple ledger cannot settle Google; Google ledger cannot settle Apple attempt',async()=>{
      await claim();await apply('apple','active');assert.equal(await settle(),false);assert.equal(await state(),'reserved');
      await db.exec('truncate private.native_billing_subscriptions,private.native_checkout_attempts');
      await claim('apple');await apply('google','active');assert.equal(await settle(),false);assert.equal(await state(),'reserved');
    });
    await run('verified pending/payment-required/grace records settle only while already blocking a second charge',async()=>{
      for(const status of ['pending','payment_required','grace']) {
        await db.exec('truncate private.native_billing_subscriptions,private.native_checkout_attempts');
        await claim();await apply('google',status);assert.equal(await settle(),true);assert.equal(await state(),'verified');
      }
    });
    await run('revoked, expired, superseded and zero-revision Google records never settle uncertain store checkout',async()=>{
      await claim();await scalar("select public.native_checkout_start($1,'Production',$2)",[cafe,first]);await apply('google','expired','2000-01-01T00:00:00Z',false);
      assert.equal(await settle(),false);
      for(const extra of ["status='revoked'","status='active',current_period_end='2099-01-01',revision=0","revision=1,superseded_by='other'"]) {
        await db.exec(`update private.native_billing_subscriptions set ${extra}`);assert.equal(await settle(),false);
      }
      assert.equal(await state(),'started');
    });
    await run('expired nonrenewable active record does not settle a distinct uncertain store launch',async()=>{
      await claim();await apply('google','active','2000-01-01T00:00:00Z',false);assert.equal(await settle(),false);assert.equal(await state(),'reserved');
    });
    await run('another account, suspended owner and changed environment cannot settle checkout',async()=>{
      await claim();await apply('google','active');assert.equal(await settle(other),false);
      await db.exec("update public.profiles set suspended_at=now() where id='"+cafe+"'");assert.equal(await settle(),false);
      await db.exec("update public.profiles set suspended_at=null where id='"+cafe+"';update private.native_billing_configuration set environment='Sandbox'");
      assert.equal(await settle(),false);assert.equal(await state(),'reserved');
    });
    await run('successful reapplication aborts instead of replacing the RPC',async()=>{
      await db.exec('savepoint collision');await assert.rejects(db.exec(source),/already exists/);await db.exec('rollback;');
      assert.deepEqual(await manifest(),baseline);
    });
    console.log(`Google cancellation SQL SHA256 ${createHash('sha256').update(source).digest('hex')}; engine17 local exclusive WASM only.`);
    console.log(`Google settlement SQL SHA256 ${createHash('sha256').update(settlement).digest('hex')}; no existing function replaced.`);
  } finally {await db.close();}
});
