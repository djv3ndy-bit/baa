import {before,after,beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const root=p=>readFileSync(new URL(`../../${p}`,import.meta.url),'utf8');
const cafe='00000000-0000-4000-8000-000000000004',barista='00000000-0000-4000-8000-000000000001',stripeCafe='00000000-0000-4000-8000-000000000003';
let db;
const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0];
before(async()=>{
 db=new PGlite();await db.exec(root('tests/database/job-posting-entitlement-fixture.sql'));
 await db.exec(root('supabase/migrations/20260908100000_enforce_cafe_job_posting_entitlements.sql'));
 await db.exec(root('supabase/migrations/20260908110000_consolidate_job_participant_visibility.sql'));
 await db.exec(root('review/native-billing-ledger.sql'));
 await db.exec(root('review/native-checkout-coordination.sql').split('create table private.native_checkout_attempts')[0]);
 await db.exec(root('review/native-job-access.sql'));
});
beforeEach(async()=>db.exec('begin'));afterEach(async()=>db.exec('rollback'));after(async()=>db?.close());
async function user(id){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,true)",[id]);await db.exec('set local role authenticated');}
async function grant({status='active',environment='Production',end='2099-01-01T00:00:00Z',revision=0}={}){
 await db.exec('reset role');const binding=await scalar('select public.native_billing_account($1)',[cafe]);
 return scalar("select public.native_billing_apply($1,$2,'apple',$3,'test-original','test.monthly','test-transaction',$4,$5,null,false,$6)",[cafe,binding,environment,status,end,revision]);
}
const job=async(n)=>db.query("insert into public.jobs(id,owner_id,title,location) values($1,$2,'Synthetic role','Tampa, FL')",[`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`,cafe]);
async function expectRejected(operation,pattern){await db.exec('savepoint denied');try{await assert.rejects(operation(),pattern);}finally{await db.exec('rollback to savepoint denied;release savepoint denied');}}
test('verified native subscription enables additional jobs through existing authenticated database rules',async()=>{
 await grant();await user(cafe);await job(1);await job(2);await job(3);
 assert.equal(await scalar('select count(*)::int from public.jobs where owner_id=$1',[cafe]),3);
 await expectRejected(()=>job(4),/ACTIVE_JOB_LIMIT|3 active|JOB_ACTIVE_LIMIT/i);
});
test('native expiry hides paid-only jobs while preserving the first free job and all saved rows',async()=>{
 await grant();await user(cafe);await job(1);await job(2);await grant({status:'expired',end:'2001-01-01T00:00:00Z',revision:1});
 await user(barista);assert.equal(await scalar('select count(*)::int from public.jobs where owner_id=$1',[cafe]),1);
 await user(cafe);assert.equal(await scalar('select count(*)::int from public.jobs where owner_id=$1',[cafe]),2);
 await expectRejected(()=>job(3),/JOB_PRO_SUBSCRIPTION_REQUIRED/);
});
test('a sandbox receipt cannot unlock production job access',async()=>{
 await grant({environment:'Sandbox'});await user(cafe);await job(1);await expectRejected(()=>job(2),/JOB_PRO_SUBSCRIPTION_REQUIRED/);
});
test('existing Stripe subscribers retain their original paid entitlement',async()=>{
 assert.equal(await scalar('select private.cafe_has_paid_job_entitlement($1)',[stripeCafe]),true);
});
test('client roles cannot forge a native grant or use the private paid entitlement helper',async()=>{
 await user(cafe);await expectRejected(()=>scalar('select private.cafe_has_paid_job_entitlement($1)',[cafe]),/permission denied/);
 await expectRejected(()=>scalar('select public.native_billing_account($1)',[cafe]),/permission denied/);
});
