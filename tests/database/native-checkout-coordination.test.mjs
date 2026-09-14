import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const cafe='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',barista='00000000-0000-4000-8000-000000000003';
const first='10000000-0000-4000-8000-000000000001',second='10000000-0000-4000-8000-000000000002';
let db;
const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0];
const file=path=>readFileSync(new URL(`../../${path}`,import.meta.url),'utf8');
before(async()=>{
 db=new PGlite();await db.exec(`
 create role anon;create role authenticated;create role service_role bypassrls;
 create table public.profiles(id uuid primary key,role text,suspended_at timestamptz);
 create table public.cafe_subscriptions(user_id uuid primary key,stripe_customer_id text,stripe_subscription_id text,status text,current_period_end timestamptz,cancel_at_period_end boolean default false,updated_at timestamptz default now());
 create table public.stripe_webhook_events(event_id text primary key,event_type text,processed_at timestamptz default now());
 create table public.subscription_payments(cafe_user_id uuid,provider text,provider_payment_id text primary key,amount_cents integer,currency text,status text,paid_at timestamptz);
 insert into public.profiles values('${cafe}','cafe_owner_manager',null),('${other}','cafe_owner_manager',null),('${barista}','barista',null);
 insert into public.cafe_subscriptions(user_id,status) values('${cafe}','free'),('${other}','free');`);
 await db.exec(file('supabase/migrations/20260908090000_harden_stripe_runtime_coordination.sql'));
 await db.exec(file('supabase/migrations/20260909044749_bind_checkout_attempt_ui_mode.sql'));
 await db.exec(file('review/native-billing-ledger.sql'));
 await db.exec(file('review/native-checkout-coordination.sql'));
});
beforeEach(async()=>{await db.exec(`reset role;truncate private.native_checkout_attempts,private.native_billing_subscriptions;update public.cafe_subscriptions set stripe_customer_id=null,stripe_subscription_id=null,status='free',stripe_checkout_claim_id=null,stripe_checkout_claim_expires_at=null,stripe_checkout_claim_kind=null,stripe_checkout_attempt_id=null,stripe_checkout_channel=null,stripe_checkout_ui_mode=null;update public.profiles set suspended_at=null;`)});
after(async()=>db?.close());
const claim=(id=first,user=cafe,provider='apple')=>scalar("select public.native_checkout_claim($1,$2,'Production',$3)",[user,provider,id]);
const start=(id=first,user=cafe)=>scalar("select public.native_checkout_start($1,'Production',$2)",[user,id]);
const cancel=(id=first,beforeLaunch=false,user=cafe)=>scalar("select public.native_checkout_cancel($1,'Production',$2,$3)",[user,id,beforeLaunch]);
const pending=()=>scalar("select public.native_checkout_pending($1,'Production')",[cafe]);
const web=()=>scalar("select public.claim_stripe_checkout($1,$2,$3,'web','embedded')",[cafe,second,second]);
async function paid(status='active',end='2099-01-01T00:00:00Z',renews=true){
 const binding=await scalar('select public.native_billing_account($1)',[cafe]);
 return scalar("select public.native_billing_apply($1,$2,'apple','Production','original','test.monthly','transaction',$3,$4,null,$5,0)",[cafe,binding,status,end,renews]);
}
test('a native reservation prevents simultaneous website or other native checkout',async()=>{
 const result=await claim();assert.equal(result.attemptId,first);assert.notEqual(result.accountBinding,cafe);
 assert.equal(await pending(),true);assert.equal(await claim(second),null);assert.equal(await web(),null);
});
test('a live Stripe lease and its durable interrupted attempt both prevent native checkout',async()=>{
 assert.ok(await web());assert.equal(await claim(),null);
 await db.exec("update public.cafe_subscriptions set stripe_checkout_claim_expires_at=now()-interval '1 minute'");
 assert.equal(await claim(),null);
 await scalar('select public.release_stripe_checkout($1,$2,true)',[cafe,second]);assert.ok(await claim());
});
test('Stripe subscriptions needing recovery block native checkout even before a live provider lookup',async()=>{
 for(const state of ['active','trialing','past_due','unpaid','incomplete','paused']){
 await db.query("update public.cafe_subscriptions set status=$1,stripe_subscription_id='sub_existing' where user_id=$2",[state,cafe]);
 assert.equal(await claim(),null);
 }
});
test('store launch authorization is single use and scoped to the original account',async()=>{
 await claim();assert.equal(await start(first,other),false);assert.equal(await start(),true);assert.equal(await start(),false);assert.equal(await web(),null);
});
test('only unused reservations expire; a started or pending purchase never unlocks on a timer',async()=>{
 await claim();await db.exec("update private.native_checkout_attempts set reserved_until=now()-interval '1 minute'");
 assert.equal(await start(),false);assert.equal(await pending(),false);assert.ok(await claim(second));
 assert.equal(await start(second),true);await db.exec("update private.native_checkout_attempts set reserved_until=now()-interval '1 day'");
 assert.equal(await pending(),true);assert.equal(await web(),null);assert.equal(await claim(),null);
});
test('before-launch cleanup cannot clear a started checkout; a definite SDK cancellation is idempotent',async()=>{
 await claim();await start();assert.equal(await cancel(first,true),false);assert.equal(await pending(),true);
 assert.equal(await cancel(),true);assert.equal(await cancel(),true);assert.equal(await pending(),false);assert.ok(await web());
});
test('a delayed cancellation cannot clear a different attempt or another account',async()=>{
 await claim();await cancel();await claim(second);assert.equal(await cancel(first,false,other),false);await cancel(first);
 assert.equal(await pending(),true);assert.equal(await start(second),true);
});
test('paid native access blocks website checkout and subscription replacement',async()=>{
 await paid();assert.equal(await web(),null);assert.equal(await claim(),null);
});
test('an expired non-renewing native subscription preserves the existing website checkout flow',async()=>{
 await paid('active','2001-01-01T00:00:00Z',false);const result=await web();assert.equal(result.uiMode,'embedded');assert.equal(result.channel,'web');
});
test('renewable overdue subscriptions must be reconciled before another purchase',async()=>{
 await paid('active','2001-01-01T00:00:00Z',true);assert.equal(await claim(),null);assert.equal(await web(),null);
});
test('verified current access settles a reservation while remaining protected against duplicate checkout',async()=>{
 await claim();await start();await paid();assert.equal(await scalar("select public.native_checkout_settle_verified($1,'Production')",[cafe]),true);
 assert.equal(await pending(),false);assert.equal(await web(),null);assert.equal(await claim(second),null);
});
test('an old expired restoration cannot settle an unrelated open native purchase',async()=>{
 await claim();await start();await paid('expired','2001-01-01T00:00:00Z',false);
 await scalar("select public.native_checkout_settle_verified($1,'Production')",[cafe]);assert.equal(await pending(),true);
});
test('anonymous, barista, suspended and wrong-environment attempts cannot reserve checkout',async()=>{
 await assert.rejects(claim(first,barista),/unavailable/);
 await db.query('update public.profiles set suspended_at=now() where id=$1',[cafe]);await assert.rejects(claim(),/unavailable/);
 await assert.rejects(scalar("select public.native_checkout_claim($1,'apple','Sandbox',$2)",[other,first]),/unavailable/);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(claim(first,other),/permission denied/);await assert.rejects(pending(),/permission denied/);await db.exec('reset role');}
});
