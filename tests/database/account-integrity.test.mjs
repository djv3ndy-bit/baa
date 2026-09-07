import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const barista='00000000-0000-4000-8000-000000000001', cafe='00000000-0000-4000-8000-000000000002';
const stranger='00000000-0000-4000-8000-000000000003', otherCafe='00000000-0000-4000-8000-000000000004';
const job='10000000-0000-4000-8000-000000000001', otherJob='10000000-0000-4000-8000-000000000002', legacyJob='10000000-0000-4000-8000-000000000003';
const match='20000000-0000-4000-8000-000000000001', otherMatch='20000000-0000-4000-8000-000000000002';
const migration=readFileSync(new URL('../../supabase/migrations/20260907050656_repair_account_integrity_and_discovery_notifications.sql',import.meta.url),'utf8');
let db;
const sql = (text,params=[])=>db.query(text,params);
async function asUser(id){await db.exec('reset role');await sql("select set_config('request.jwt.claim.sub',$1,true)",[id]);await db.exec('set local role authenticated');}
async function rejected(text,params=[],pattern=/not allowed|row-level security|permission denied|must start|cannot be changed|applicant|Florida|unavailable/){
  await db.exec('savepoint expected_failure');
  try{await assert.rejects(sql(text,params),pattern);}finally{await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure');}
}
async function apply(){await asUser(barista);return (await sql("insert into applications(job_id,barista_id,status) values($1,$2,'interested') returning id",[job,barista])).rows[0].id;}
before(async()=>{
  db=new PGlite();
  await db.exec(readFileSync(new URL('./fixture.sql',import.meta.url),'utf8'));
  await db.exec(migration);
});
beforeEach(async()=>{await db.exec('begin');await db.exec('update profiles set is_discoverable=true');});
afterEach(async()=>{await db.exec('rollback');});
after(async()=>{await db.close();});

test('complete café saves discoverable with current fields and no legacy skills or experience',async()=>{
  await asUser(cafe);
  const {rows}=await sql('update profiles set is_discoverable=true where id=$1 returning is_discoverable,skills,experience',[cafe]);
  assert.deepEqual(rows[0],{is_discoverable:true,skills:[],experience:null});
});
test('incomplete and suspended café profiles stay hidden',async()=>{
  const {rows}=await sql("update profiles set cafe_address='',is_discoverable=true where id=$1 returning is_discoverable",[cafe]);assert.equal(rows[0].is_discoverable,false);
  const suspended=await sql('update profiles set suspended_at=now(),is_discoverable=true where id=$1 returning is_discoverable',[otherCafe]);assert.equal(suspended.rows[0].is_discoverable,false);
});
test('whitespace-only skills and preferences cannot satisfy profile completion',async()=>{
  assert.equal((await sql("update profiles set skills=array['  ',null],is_discoverable=true where id=$1 returning is_discoverable",[barista])).rows[0].is_discoverable,false);
  assert.equal((await sql("update profiles set barista_preferences=array['  ',null],is_discoverable=true where id=$1 returning is_discoverable",[cafe])).rows[0].is_discoverable,false);
});
test('migration preserves barista visibility opt-out and complimentary billing',async()=>{
  const {rows}=await sql('select visible_to_cafes from profiles where id=$1',[barista]);assert.equal(rows[0].visible_to_cafes,false);
  assert.equal((await sql('select bool_and(complimentary_access) retained from cafe_subscriptions')).rows[0].retained,true);
});
test('OAuth user without role and unsupported metadata roles can register without a profile',async()=>{
  for(const meta of [{},null,{role:'admin'}]){
    const {rows}=await sql('insert into auth.users(id,raw_user_meta_data) values(gen_random_uuid(),$1) returning id',[meta]);
    assert.equal((await sql('select count(*)::int n from profiles where id=$1',[rows[0].id])).rows[0].n,0);
  }
});
test('email registrations create the selected role and trimmed starter profile',async()=>{
  for(const role of ['barista','cafe_owner_manager']){
    const {rows}=await sql('insert into auth.users(id,raw_user_meta_data) values(gen_random_uuid(),$1) returning id',[{role,display_name:'  Test Barista  ',cafe_name:'  Test Cafe  ',location:'  Miami, FL  '}]);
    const p=(await sql('select * from profiles where id=$1',[rows[0].id])).rows[0];assert.equal(p.role,role);assert.equal(p.location,'Miami, FL');assert.equal(p.is_discoverable,false);
    assert.equal(role==='barista'?p.display_name:p.cafe_name,role==='barista'?'Test Barista':'Test Cafe');
  }
});
test('direct initial matched, declined, withdrawn and null applications are rejected',async()=>{
  await asUser(barista);
  for(const status of ['matched','declined','withdrawn',null])await rejected('insert into applications(job_id,barista_id,status) values($1,$2,$3)',[job,barista,status]);
});
test('applications still require eligible own barista profile and discoverable café',async()=>{
  await asUser(cafe);await rejected("insert into applications(job_id,barista_id,status) values($1,$2,'interested')",[job,cafe]);
  await asUser(barista);await rejected("insert into applications(job_id,barista_id,status) values($1,$2,'interested')",[job,stranger]);
  await db.exec('reset role');await sql('update profiles set is_discoverable=false where id=$1',[cafe]);await asUser(barista);
  await rejected("insert into applications(job_id,barista_id,status) values($1,$2,'interested')",[job,barista]);
});
test('eligible barista can apply and owning café can match',async()=>{
  const id=await apply();await asUser(cafe);
  assert.equal((await sql("update applications set status='matched' where id=$1 returning status",[id])).rows[0].status,'matched');
});
test('barista cannot self-match; unrelated accounts cannot change another application',async()=>{
  const id=await apply();await rejected("update applications set status='matched' where id=$1",[id]);
  for(const account of [stranger,otherCafe]){await asUser(account);assert.equal((await sql("update applications set status='matched' where id=$1 returning id",[id])).rows.length,0);}
});
test('application identity and other applicant notes cannot be rewritten by café',async()=>{
  const id=await apply();await asUser(cafe);
  await rejected('update applications set barista_id=$1 where id=$2',[stranger,id]);
  await rejected('update applications set job_id=$1 where id=$2',[otherJob,id]);
  await rejected('update applications set id=gen_random_uuid() where id=$1',[id]);
  await rejected("update applications set created_at=now()+interval '1 hour' where id=$1",[id]);
  await rejected("update applications set note='Changed' where id=$1",[id]);
});
test('withdrawn or declined applications cannot be resurrected into matches',async()=>{
  const id=await apply();await sql("update applications set status='withdrawn' where id=$1",[id]);await asUser(cafe);
  await rejected("update applications set status='matched' where id=$1",[id]);
});
test('café can decline and applicant can withdraw an accepted match',async()=>{
  const id=await apply();await asUser(cafe);await sql("update applications set status='matched' where id=$1",[id]);await asUser(barista);
  assert.equal((await sql("update applications set status='withdrawn' where id=$1 returning status",[id])).rows[0].status,'withdrawn');
  await db.exec('reset role');await sql('delete from applications where id=$1',[id]);
  const next=await apply();await asUser(cafe);assert.equal((await sql("update applications set status='declined' where id=$1 returning status",[next])).rows[0].status,'declined');
  await rejected("update applications set status='matched' where id=$1",[next]);
});
test('valid Florida job saves canonical structured location',async()=>{
  await asUser(cafe);const {rows}=await sql("insert into jobs(owner_id,location,address_line1,city,state,postal_code) values($1,'arbitrary','123 Main',' Miami ',' fl ','33101-1234') returning location,state",[cafe]);
  assert.deepEqual(rows[0],{location:'Miami, FL, 33101-1234',state:'FL'});
});
test('empty state, other states, missing city/address and malformed ZIP are rejected',async()=>{
  await asUser(cafe);
  for(const [address,city,state,zip] of [['123 Main','Miami','','33101'],['123 Main','Miami','GA','33101'],['123 Main','','FL','33101'],['','Miami','FL','33101'],['123 Main','Miami','FL','abc']])
    await rejected("insert into jobs(owner_id,location,address_line1,city,state,postal_code) values($1,'Miami',$2,$3,$4,$5)",[cafe,address,city,state,zip]);
});
test('legacy job can be paused or edited without changing its incomplete address',async()=>{
  await asUser(cafe);assert.equal((await sql("update jobs set active=false,description='Updated' where id=$1 returning state,active",[legacyJob])).rows[0].active,false);
  await rejected("update jobs set state='FL' where id=$1",[legacyJob]);
});
test('discovery message creates separate recipient state without changing native application notifications',async()=>{
  await asUser(barista);await sql('insert into discovery_messages(match_id,sender_id,body) values($1,$2,$3)',[match,barista,'Hello']);await asUser(cafe);
  const {rows}=await sql('select recipient_id,discovery_match_id,read_at from discovery_message_notifications');
  assert.deepEqual(rows,[{recipient_id:cafe,discovery_match_id:match,read_at:null}]);
  assert.equal((await sql('select count(*)::int n from notifications')).rows[0].n,0);
  await db.exec('reset role');
  assert.equal((await sql("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='notifications' and column_name='discovery_match_id'")).rows[0].n,0);
  assert.deepEqual((await sql("select column_name from information_schema.columns where table_schema='public' and table_name='discovery_message_notifications' order by ordinal_position")).rows.map(x=>x.column_name),['id','recipient_id','discovery_match_id','created_at','read_at']);
});
test('mark-read only clears the caller notification for the selected conversation',async()=>{
  await asUser(barista);await sql("insert into discovery_messages(match_id,sender_id,body) values($1,$2,'Hi')",[match,barista]);
  await asUser(stranger);await sql("insert into discovery_messages(match_id,sender_id,body) values($1,$2,'Hi')",[otherMatch,stranger]);
  await asUser(cafe);await sql("insert into discovery_messages(match_id,sender_id,body) values($1,$2,'Reply')",[match,cafe]);
  assert.equal((await sql('select mark_discovery_conversation_read($1) n',[match])).rows[0].n,1);
  assert.equal((await sql('select mark_discovery_conversation_read($1) n',[match])).rows[0].n,0);
  assert.equal((await sql('select count(*)::int n from discovery_message_notifications where read_at is null')).rows[0].n,1);
  await asUser(barista);assert.equal((await sql('select count(*)::int n from discovery_message_notifications where read_at is null')).rows[0].n,1);
});
test('notification grants permit only own SELECT and read_at updates after broad default grants',async()=>{
  await asUser(barista);await sql("insert into discovery_messages(match_id,sender_id,body) values($1,$2,'Hello')",[match,barista]);
  await asUser(cafe);const id=(await sql('select id from discovery_message_notifications')).rows[0].id;
  await rejected('insert into discovery_message_notifications(recipient_id,discovery_match_id) values($1,$2)',[cafe,match]);
  await rejected('update discovery_message_notifications set recipient_id=$1 where id=$2',[barista,id]);
  await rejected('update discovery_message_notifications set discovery_match_id=$1 where id=$2',[otherMatch,id]);
  await rejected("update discovery_message_notifications set created_at=now()+interval '1 day' where id=$1",[id]);
  await rejected('delete from discovery_message_notifications where id=$1',[id]);
  await asUser(stranger);assert.equal((await sql('select id from discovery_message_notifications where id=$1',[id])).rows.length,0);
  assert.equal((await sql('update discovery_message_notifications set read_at=now() where id=$1 returning id',[id])).rows.length,0);
  await asUser(cafe);assert.equal((await sql('update discovery_message_notifications set read_at=now() where id=$1 returning id',[id])).rows.length,1);
  await db.exec('reset role;set local role anon');await rejected('select * from discovery_message_notifications');
  await db.exec('reset role;set local role service_role');await rejected('insert into discovery_message_notifications(recipient_id,discovery_match_id) values($1,$2)',[cafe,match]);
});
test('discovery notification relationships cascade and Realtime registration is idempotent',async()=>{
  await asUser(barista);await sql("insert into discovery_messages(match_id,sender_id,body) values($1,$2,'Hello')",[match,barista]);
  await db.exec('reset role');
  const before=await sql('select id,read_at from discovery_message_notifications');
  await db.exec(migration);
  assert.deepEqual((await sql('select id,read_at from discovery_message_notifications')).rows,before.rows);
  assert.equal((await sql("select count(*)::int n from pg_publication_tables where pubname='supabase_realtime' and tablename='discovery_message_notifications'")).rows[0].n,1);
  await sql('delete from discovery_messages where match_id=$1',[match]);
  await sql('delete from discovery_matches where id=$1',[match]);
  assert.equal((await sql('select count(*)::int n from discovery_message_notifications')).rows[0].n,0);
});
test('unrelated, blocked and anonymous callers cannot mark a discovery conversation read',async()=>{
  await asUser(stranger);await rejected('select mark_discovery_conversation_read($1)',[match]);
  await db.exec('reset role');await sql('insert into user_blocks values($1,$2)',[barista,cafe]);await asUser(cafe);
  await rejected('select mark_discovery_conversation_read($1)',[match]);
  await db.exec('reset role; set local role anon');await rejected('select mark_discovery_conversation_read($1)',[match]);
});
test('privileged trigger helpers are not exposed to ordinary clients',async()=>{
  const {rows}=await sql("select has_function_privilege('authenticated','private.create_discovery_message_notification()','execute') notification,has_function_privilege('authenticated','private.handle_new_email_profile()','execute') signup");
  assert.deepEqual(rows[0],{notification:false,signup:false});
});
