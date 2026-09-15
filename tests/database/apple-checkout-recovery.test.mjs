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
 await db.exec(file('server/native-billing/sql/recover_apple_checkout.sql'));
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
const recover=(user=cafe,environment='Production')=>scalar('select public.native_checkout_recover_apple($1,$2)',[user,environment]);
test('Apple recovery returns the same started reservation and leaves website checkout locked',async()=>{
 const original=await claim();await start();const before=await db.query('select * from private.native_checkout_attempts');
 for(let i=0;i<3;i++)assert.deepEqual(await recover(),original);
 assert.deepEqual(await db.query('select * from private.native_checkout_attempts'),before);
 assert.equal(await web(),null);assert.equal(await claim(second),null);assert.equal(await pending(),true);
});
test('recovery cannot create a purchase or reopen a canceled or unused reservation',async()=>{
 assert.equal(await recover(),null);await claim();assert.equal(await recover(),null);await start();await cancel();assert.equal(await recover(),null);
});
test('recovery is scoped to an active café, Apple and the configured environment',async()=>{
 await claim();await start();assert.equal(await recover(other),null);assert.equal(await recover(barista),null);assert.equal(await recover(cafe,'Sandbox'),null);
 await db.query('update public.profiles set suspended_at=now() where id=$1',[cafe]);assert.equal(await recover(),null);
 await db.query('update public.profiles set suspended_at=null where id=$1',[cafe]);await db.exec("update private.native_checkout_attempts set provider='google'");assert.equal(await recover(),null);
});
test('active and unresolved native subscriptions block recovery before another store request',async()=>{
 await claim();await start();
 for(const state of ['active','grace','pending','payment_required']){
 await db.exec('truncate private.native_billing_subscriptions');await paid(state);assert.equal(await recover(),null);
 }
});
test('a completed native subscription settles recovery and keeps cross-provider protection',async()=>{
 await claim();await start();await paid();await scalar("select public.native_checkout_settle_verified($1,'Production')",[cafe]);assert.equal(await recover(),null);assert.equal(await web(),null);
});
test('an expired non-renewing record can be reconciled without releasing the original checkout',async()=>{
 await claim();await start();await paid('expired','2001-01-01T00:00:00Z',false);assert.ok(await recover());assert.equal(await pending(),true);assert.equal(await web(),null);
});
test('existing Stripe subscriptions and sessions prevent a resumed Apple checkout',async()=>{
 await claim();await start();
 for(const state of ['active','trialing','past_due','unpaid','incomplete','paused']){
 await db.query("update public.cafe_subscriptions set stripe_subscription_id='sub_existing',status=$1 where user_id=$2",[state,cafe]);assert.equal(await recover(),null);
 }
 await db.query("update public.cafe_subscriptions set stripe_subscription_id=null,status='free',stripe_checkout_attempt_id=$1 where user_id=$2",[second,cafe]);assert.equal(await recover(),null);
});
test('anonymous and authenticated clients cannot retrieve private checkout identities',async()=>{
 await claim();await start();
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(recover(),/permission denied/);await db.exec('reset role');}
 await db.exec('set role service_role');assert.ok(await recover());await db.exec('reset role');
});
