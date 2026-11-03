import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMediaPublisher} from '../../server/moderation/mediaPublication.mjs';
// Destructive fixture suite: never accept a general DATABASE_URL or production configuration.
assert.equal(process.env.BJM_MODERATION_FIXTURE_ACK,'isolated-fixture-only','Explicit isolated fixture acknowledgement is required');
const localSocket=process.env.BJM_UGC_PG_SOCKET;
let connectionConfig;
if(localSocket){
  assert.match(localSocket,/^\/private\/tmp\/bjm-ugc-[a-z0-9-]+$/,'Local fixtures require a task-owned private socket');
  const port=Number(process.env.BJM_MODERATION_TEST_PORT||'55447');assert(Number.isInteger(port)&&port>=1024&&port<=65535);
  connectionConfig={host:localSocket,port,user:'postgres',database:'postgres',ssl:false,connectionTimeoutMillis:5000};
}else{
  assert.equal(process.env.BJM_MODERATION_CI_FIXTURE,'1','Dedicated CI service must be explicit');
  assert.equal(process.env.PGHOST,'127.0.0.1');assert.equal(process.env.PGPORT,'5432');
  assert.equal(process.env.PGDATABASE,'bjm_moderation_test');assert.equal(process.env.PGUSER,'postgres');
  assert.equal(process.env.PGPASSWORD,'isolated-moderation-ci-fixture-only');
  connectionConfig={host:'127.0.0.1',port:5432,user:'postgres',database:'bjm_moderation_test',password:process.env.PGPASSWORD,ssl:false,connectionTimeoutMillis:5000};
}
const pg = await import(process.env.BJM_UGC_PG_MODULE || 'pg');
const { Client } = pg.default || pg;
const db = new Client(connectionConfig);
await db.connect();
const serverVersion=Number((await db.query("SHOW server_version_num")).rows[0].server_version_num);assert(serverVersion>=170000&&serverVersion<180000,'This suite requires PostgreSQL17');
const foundation=fs.readFileSync(new URL('../../supabase/migrations/20261103072016_member_content_moderation_foundation.sql',import.meta.url),'utf8');
const baseFixture=fs.readFileSync(new URL('./moderation-fixture.sql',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(baseFixture).digest('hex'),'21238547c346d56c2a1d9fdc4b9f851426b0f5cb3e38fdb1f7f8fbb60f0bf531','Review fixture changes explicitly');
const overlay=fs.readFileSync(new URL('./storage-objects-vendor-fixture.sql',import.meta.url),'utf8').split('-- VENDOR ROUTINES\n');assert.equal(overlay.length,2);
const table=/CREATE TABLE storage.objects\([\s\S]*?\);/;assert(table.test(baseFixture));
const fixture=baseFixture.replace(table,()=>overlay[0])+overlay[1];
const migrationSha256='b20246cb8179f6ae862470f24c45515368bb1adac29c3fd5f1d7f44d56697fb2';
function resolveFrozenMigration(directory){
 const names=fs.readdirSync(directory).filter(name=>name.endsWith('_profile_media_storage_commit_validation.sql'));
 assert.equal(names.length,1,'Exactly one Storage commit repair migration is required');
 assert.match(names[0],/^\d{14}_profile_media_storage_commit_validation\.sql$/);
 const bytes=fs.readFileSync(path.join(directory,names[0]));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),migrationSha256,'The reviewed Storage repair SQL must remain byte-identical');
 return {name:names[0],sql:bytes.toString('utf8')};
}
const {sql:migration}=resolveFrozenMigration(fileURLToPath(new URL('../../supabase/migrations/',import.meta.url)));
const U='11111111-1111-4111-8111-111111111111',V='22222222-2222-4222-8222-222222222222',SIZE=947566;
const q=async(sql,args=[],client=db)=>(await client.query(sql,args)).rows;
async function tx(work,{role='authenticated',id=U,rollback=false,isolation='READ COMMITTED'}={},client=db){await q('BEGIN ISOLATION LEVEL '+isolation,[],client);try{await q('SET LOCAL ROLE '+role,[],client);const claims=role==='authenticated'?{sub:id,is_anonymous:false,role}:{role};await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[role==='authenticated'?id:'',JSON.stringify(claims)],client);const r=await work(client);await q(rollback?'ROLLBACK':'COMMIT',[],client);return r;}catch(e){await q('ROLLBACK',[],client);throw e;}}
const reserve=async({owner=U,size=SIZE,field='avatar_url',mime='image/png'}={})=>(await tx(c=>q('SELECT public.reserve_profile_media_upload($1,$2,$3) r',[field,mime,size],c),{id:owner}))[0].r;
const rawInsert=(i,metadata,{owner=U,id=null,client=db}={})=>q("INSERT INTO storage.objects(id,bucket_id,name,owner_id,metadata) VALUES(coalesce($1::uuid,gen_random_uuid()),'ugc-media-staging',$2,$3,$4::jsonb) RETURNING id",[id,i.object_path,owner,metadata===null?null:JSON.stringify(metadata)],client);
const insert=(i,metadata,opts={})=>tx(c=>rawInsert(i,metadata,{...opts,client:c}),opts);
const state=async()=> (await q("SELECT (SELECT count(*)::int FROM storage.objects WHERE bucket_id='ugc-media-staging') objects,(SELECT count(*)::int FROM private.profile_media_upload_intents WHERE used_at IS NOT NULL) used,(SELECT count(*)::int FROM private.profile_media_reviews) reviews,(SELECT count(*)::int FROM private.moderation_notice_outbox) notices"))[0];
const full={size:SIZE,mimetype:'image/png'};
let baseline;
const contracts=()=>q("SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' signature,md5(pg_get_functiondef(p.oid)) body,pg_get_userbyid(p.proowner) owner,p.proacl::text acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('private','public','storage','auth') ORDER BY 1");
async function setup({apply=true}={}){
 await q('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS private CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS storage CASCADE;');
 await q("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END$$;");
 await q(fixture);await q("SELECT set_config('storage.allow_delete_query','true',false)");await q('BEGIN');try{await q(foundation);await q('COMMIT');}catch(e){await q('ROLLBACK');throw e;}
 await q('INSERT INTO auth.users VALUES($1),($2)',[U,V]);await q("INSERT INTO public.profiles(id,role,cafe_name,avatar_url,is_discoverable) VALUES($1,'cafe_owner_manager','TEST ONLY hidden Café','https://old.example/logo.png',false),($2,'cafe_owner_manager','TEST ONLY other Café',NULL,false)",[U,V]);
 baseline=await contracts();
 if(apply){await q('BEGIN');try{await q(migration);await q('COMMIT');}catch(e){await q('ROLLBACK');throw e;}}
}
beforeEach(()=>setup());after(()=>db.end());

test('exact current multipart permission probe rolls back then privileged final commit and ordinary Submit succeed',async()=>{
 const i=await reserve();await insert(i,{mimetype:'image/png',contentLength:SIZE+229,contentEncoding:'identity'},{rollback:true});assert.deepEqual(await state(),{objects:0,used:0,reviews:0,notices:0});
 const [{id}]=await insert(i,full,{role:'service_role'});assert.deepEqual(await state(),{objects:1,used:1,reviews:0,notices:0});
 const [{used_object_id}]=await q('SELECT used_object_id FROM private.profile_media_upload_intents WHERE id=$1',[i.upload_id]);assert.equal(used_object_id,id);
 const [{r}]=await tx(c=>q("SELECT public.submit_profile_media_review('avatar_url',$1) r",[i.object_path],c));assert.equal(r.status,'pending');assert.equal(r.request_id,i.upload_id);assert.deepEqual(await state(),{objects:1,used:1,reviews:1,notices:1});
});
test('historical metadata-less permission probe rolls back with no durable consumption',async()=>{
 const i=await reserve();await insert(i,null,{rollback:true});assert.deepEqual(await state(),{objects:0,used:0,reviews:0,notices:0});await insert(i,full,{role:'service_role'});assert.equal((await state()).used,1);
});
test('exact final-metadata reauthorization probe also rolls back before privileged actual INSERT',async()=>{
 const i=await reserve();await insert(i,full,{rollback:true});assert.equal((await state()).used,0);await insert(i,full,{role:'service_role'});assert.equal((await state()).used,1);
});
for(const role of ['authenticated','service_role'])for(const [name,metadata]of[['NULL',null],['probe-only',{mimetype:'image/png',contentLength:SIZE}],['empty',{}],['wrong MIME',{...full,mimetype:'image/jpeg'}],['wrong size',{...full,size:SIZE+1}]])test(`${role} cannot COMMIT ${name} metadata`,async()=>{
 const i=await reserve();await assert.rejects(insert(i,metadata,{role}),e=>e.code==='42501');assert.deepEqual(await state(),{objects:0,used:0,reviews:0,notices:0});
});
test('admission predicate is side-effect-free even with complete exact metadata',async()=>{
 const i=await reserve();const [{ok}]=await tx(c=>q('SELECT private.consume_profile_media_upload($1,$2::jsonb) ok',[i.object_path,JSON.stringify(full)],c));assert.equal(ok,true);assert.equal((await state()).used,0);
});
test('deferred validator inspects final row and repeated INSERT/UPDATE events consume one exact row',async()=>{
 const i=await reserve();const [{id}]=await tx(async c=>{const rows=await rawInsert(i,null,{client:c});await q('UPDATE storage.objects SET metadata=$1::jsonb WHERE id=$2',[JSON.stringify(full),rows[0].id],c);return rows;},{role:'service_role'});
 assert.equal((await state()).used,1);assert.equal((await q('SELECT used_object_id FROM private.profile_media_upload_intents WHERE id=$1',[i.upload_id]))[0].used_object_id,id);
});
test('later invalid intermediate UPDATE makes whole COMMIT fail instead of accepting stale INSERT NEW',async()=>{
 const i=await reserve();await assert.rejects(tx(async c=>{const [{id}]=await rawInsert(i,full,{client:c});await q("UPDATE storage.objects SET metadata='{}'::jsonb WHERE id=$1",[id],c);},{role:'service_role'}),e=>e.code==='42501');assert.equal((await state()).objects,0);
});
for(const owner of [null,V])for(const role of ['authenticated','service_role'])test(`${role} rejects ${owner===null?'absent':'foreign'} owner with exact file metadata`,async()=>{
 const i=await reserve();await assert.rejects(insert(i,full,{role,owner}),e=>e.code==='42501');assert.equal((await state()).used,0);
});
test('unreserved privileged insertion fails at COMMIT',async()=>{
 await assert.rejects(insert({object_path:U+'/00000000-0000-4000-8000-000000000000.png'},full,{role:'service_role'}),e=>e.code==='42501');assert.equal((await state()).objects,0);
});
for(const mutation of ['expired','suspended','deleting','wrong role','staged deleted','cleanup claimed'])test(`final commit rechecks ${mutation} state`,async()=>{
 const i=await reserve({field:mutation==='wrong role'?'bar_picture_url':'avatar_url'});
 if(mutation==='expired')await q("UPDATE private.profile_media_upload_intents SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[i.upload_id]);
 if(mutation==='suspended')await q('UPDATE public.profiles SET suspended_at=clock_timestamp() WHERE id=$1',[U]);
 if(mutation==='deleting')await q('INSERT INTO private.profile_media_owner_lifecycle(owner_id) VALUES($1)',[U]);
 if(mutation==='wrong role')await q("UPDATE public.profiles SET role='barista' WHERE id=$1",[U]);
 if(mutation==='staged deleted')await q('UPDATE private.profile_media_upload_intents SET staged_deleted_at=clock_timestamp() WHERE id=$1',[i.upload_id]);
 if(mutation==='cleanup claimed')await q("UPDATE private.profile_media_upload_intents SET cleanup_claim_id=gen_random_uuid(),cleanup_claim_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[i.upload_id]);
 await assert.rejects(insert(i,full,{role:'service_role'}),e=>e.code==='42501');assert.equal((await state()).used,0);
});
test('committed intent cannot be reused after temporary object deletion',async()=>{
 const i=await reserve();await insert(i,full,{role:'service_role'});await q("DELETE FROM storage.objects WHERE bucket_id='ugc-media-staging'");await assert.rejects(insert(i,full,{role:'service_role'}),e=>e.code==='42501');assert.equal((await state()).objects,0);assert.equal((await state()).used,1);
});
test('same-XID delete/reinsert cannot bind the consumed reservation to a different actual row',async()=>{
 const i=await reserve();await assert.rejects(tx(async c=>{await rawInsert(i,full,{client:c});await q('SET CONSTRAINTS ALL IMMEDIATE',[],c);await q("DELETE FROM storage.objects WHERE bucket_id='ugc-media-staging'",[],c);await rawInsert(i,full,{client:c});},{role:'service_role'}),e=>e.code==='42501');assert.equal((await state()).used,0);assert.equal((await state()).objects,0);
});
test('privileged UPDATE cannot change committed metadata, owner, path, or other content fields',async()=>{
 const i=await reserve();const [{id}]=await insert(i,full,{role:'service_role'});for(const [set,args]of[["metadata='{}'::jsonb",[]],['owner_id=$2',[V]],["name=name||'.other'",[]],["version='replacement'",[]],['owner=$2::uuid',[V]],["user_metadata='{\"x\":1}'",[]],['archived_at=clock_timestamp()',[]],['is_delete_marker=true',[]],['is_versioned=true',[]],['created_at=clock_timestamp()',[]]])await assert.rejects(tx(c=>q('UPDATE storage.objects SET '+set+' WHERE id=$1',[id,...args],c),{role:'service_role'}),e=>e.code==='42501');
 assert.equal((await state()).objects,1);assert.equal((await state()).used,1);
});
test('actual vendor updated_at trigger plus last_accessed_at bookkeeping remains valid after expiry without consuming twice',async()=>{
 const i=await reserve();const [{id}]=await insert(i,full,{role:'service_role'});await q("UPDATE private.profile_media_upload_intents SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[i.upload_id]);const before=(await q('SELECT updated_at::text value FROM storage.objects WHERE id=$1',[id]))[0].value;const fp=(await q("SELECT md5((to_jsonb(o)-'last_accessed_at')::text) value FROM storage.objects o WHERE id=$1",[id]))[0].value;await tx(c=>q('UPDATE storage.objects SET last_accessed_at=clock_timestamp() WHERE id=$1',[id],c),{role:'service_role'});assert.equal((await q('SELECT updated_at::text value FROM storage.objects WHERE id=$1',[id]))[0].value,before);assert.equal((await state()).used,1);assert.equal((await q("SELECT md5((to_jsonb(o)-'last_accessed_at')::text) value FROM storage.objects o WHERE id=$1",[id]))[0].value,fp);
});
test('staging stays private, authenticated updates remain denied, public bucket writes unchanged, publication stays false',async()=>{
 const i=await reserve();await insert(i,full);assert.equal((await tx(c=>q("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='ugc-media-staging'",[],c),{id:V}))[0].n,0);assert.equal((await tx(c=>q("UPDATE storage.objects SET metadata='{}' WHERE name=$1 RETURNING id",[i.object_path],c))).length,0);
 await tx(c=>q("INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES('cafe-images',$1,$2,'{}')",[U+'/legacy.png',U],c));assert.equal((await q("SELECT public FROM storage.buckets WHERE id='ugc-media-staging'"))[0].public,false);assert.equal((await q('SELECT publication_active FROM private.ugc_moderation_configuration'))[0].publication_active,false);
});
test('no public/service callable trigger helper or new role grant; all old function contracts except admission body unchanged',async()=>{
 const after=await contracts();const old=baseline.filter(x=>!x.signature.startsWith('private.consume_profile_media_upload('));assert.deepEqual(after.filter(x=>old.some(y=>y.signature===x.signature)),old);const a=after.find(x=>x.signature.startsWith('private.consume_profile_media_upload(')),b=baseline.find(x=>x.signature===a.signature);assert.equal(a.owner,b.owner);assert.equal(a.acl,b.acl);
 for(const name of ['validate_profile_media_object_commit','guard_profile_media_object_immutability'])for(const role of ['anon','authenticated','service_role'])assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[role,'private.'+name+'()']))[0].ok,false);
 assert.deepEqual((await q("SELECT tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgname='ugc_staging_object_commit'"))[0],{tgdeferrable:true,tginitdeferred:true});
});
for(const isolation of ['REPEATABLE READ','SERIALIZABLE'])test(`${isolation} final insert fails closed`,async()=>{const i=await reserve();await assert.rejects(insert(i,full,{role:'service_role',isolation}),e=>e.code==='42501');assert.equal((await state()).used,0);});
test('fault after canonical DDL rolls back helper, column, triggers and caller migration history',async()=>{
 await setup({apply:false});await q('CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY)');
 await q('BEGIN');try{await q(migration);await q("INSERT INTO supabase_migrations.schema_migrations VALUES('local-synthetic-version')");await assert.rejects(q("DO $$BEGIN RAISE EXCEPTION 'fault_after_ddl'; END$$"),/fault_after_ddl/);}finally{await q('ROLLBACK');}
 assert.equal((await q("SELECT count(*)::int n FROM pg_attribute WHERE attrelid='private.profile_media_upload_intents'::regclass AND attname='used_object_id' AND NOT attisdropped"))[0].n,0);assert.equal((await q("SELECT count(*)::int n FROM pg_trigger WHERE tgname='ugc_staging_object_commit'"))[0].n,0);assert.equal((await q('SELECT count(*)::int n FROM supabase_migrations.schema_migrations'))[0].n,0);assert.deepEqual(await contracts(),baseline);await q('DROP SCHEMA supabase_migrations CASCADE');
});

// Administrative fixture seeding below creates only synthetic reservations and
// metadata, never file bytes. It exercises final admission independently of the
// earlier, separately tested reserve gate. Every seeded staging row still passes
// the canonical COMMIT validator under the Storage service role.
async function seedPhysicalBytes(owner,total){
 await q("UPDATE public.profiles SET role='barista' WHERE id=$1",[owner]);
 while(total>0){const bytes=Math.min(total,52428800);const [{id}]=await q('SELECT gen_random_uuid() id');const object_path=owner+'/'+id+'.mp4';await q("INSERT INTO private.profile_media_upload_intents(id,owner_id,field,object_path,mime_type,byte_size,expires_at) VALUES($1,$2,'video_path',$3,'video/mp4',$4,clock_timestamp()+interval '9 minutes')",[id,owner,object_path,bytes]);await insert({object_path},{size:bytes,mimetype:'video/mp4'},{role:'service_role',owner});total-=bytes;}
}
async function seedGlobalBytes(total){let n=0;while(total>0){const [{id}]=await q('SELECT gen_random_uuid() id');await q('INSERT INTO auth.users VALUES($1)',[id]);await q("INSERT INTO public.profiles(id,role,display_name,is_discoverable) VALUES($1,'barista','TEST ONLY quota fixture',false)",[id]);const bytes=Math.min(total,104857600);await seedPhysicalBytes(id,bytes);total-=bytes;n++;}return n;}
async function openClient(){const c=new Client(connectionConfig);await c.connect();return c;}
async function beginService(c){await q('BEGIN',[],c);await q('SET LOCAL ROLE service_role',[],c);await q("SELECT set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)",[],c);}
async function waitForLock(client){const [{pid}]=await q('SELECT pg_backend_pid() pid',[],client);return pid;}
async function observeWait(pid){for(let n=0;n<100;n++){const rows=await q("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid]);if(rows[0]?.wait_event_type==='Lock')return true;await new Promise(r=>setTimeout(r,10));}return false;}

test('current object counts once: exact 100 MiB owner boundary succeeds, one byte beyond fails',async()=>{
 let i=await reserve();await seedPhysicalBytes(U,104857600-SIZE);await insert(i,full,{role:'service_role'});assert.equal(Number((await q("SELECT sum((metadata->>'size')::bigint)::text bytes FROM storage.objects WHERE bucket_id='ugc-media-staging' AND owner_id=$1",[U]))[0].bytes),104857600);
 await setup();i=await reserve();await seedPhysicalBytes(U,104857600-SIZE+1);const before=await state();await assert.rejects(insert(i,full,{role:'service_role'}),e=>e.code==='22023'&&e.message==='ugc_staging_quota_reached');assert.deepEqual(await state(),before);
});
test('exact 1 GiB global boundary succeeds, one byte beyond fails despite different owners',async()=>{
 let i=await reserve();await seedGlobalBytes(1073741824-SIZE);await insert(i,full,{role:'service_role'});assert.equal(Number((await q("SELECT sum((metadata->>'size')::bigint)::text bytes FROM storage.objects WHERE bucket_id='ugc-media-staging'"))[0].bytes),1073741824);
 await setup();i=await reserve();await seedGlobalBytes(1073741824-SIZE+1);const before=await state();await assert.rejects(insert(i,full,{role:'service_role'}),e=>e.code==='22023');assert.deepEqual(await state(),before);
});
test('expiry is rechecked after a genuine blocking global lock, not before waiting',async()=>{
 const i=await reserve();await q("UPDATE private.profile_media_upload_intents SET created_at=clock_timestamp()-interval '9 minutes',expires_at=clock_timestamp()+interval '0.5 seconds' WHERE id=$1",[i.upload_id]);
 const blocker=await openClient(),worker=await openClient();let pending;
 try{await q('BEGIN',[],blocker);await q("SELECT pg_advisory_xact_lock(hashtextextended('ugc-media-global-bytes',0))",[],blocker);const pid=await waitForLock(worker);await beginService(worker);await rawInsert(i,full,{client:worker});pending=q('COMMIT',[],worker).then(()=>({ok:true}),e=>({ok:false,code:e.code}));assert.equal(await observeWait(pid),true);await new Promise(r=>setTimeout(r,650));await q('COMMIT',[],blocker);assert.deepEqual(await pending,{ok:false,code:'42501'});assert.equal((await state()).used,0);assert.equal((await state()).objects,0);}finally{await q('ROLLBACK',[],blocker).catch(()=>{});await q('ROLLBACK',[],worker).catch(()=>{});await Promise.all([blocker.end(),worker.end()]);}
});
for(const scope of ['owner','global'])test(`two final COMMITs serialize under ${scope} quota and admit only one available slot`,async()=>{
 const a=await reserve(),b=await reserve({owner:scope==='owner'?U:V});if(scope==='owner')await seedPhysicalBytes(U,104857600-SIZE);else await seedGlobalBytes(1073741824-SIZE);
 const before=await state();const blocker=await openClient(),one=await openClient(),two=await openClient();
 try{await q('BEGIN',[],blocker);await q("SELECT pg_advisory_xact_lock(hashtextextended('ugc-media-global-bytes',0))",[],blocker);const p1=await waitForLock(one),p2=await waitForLock(two);await beginService(one);await beginService(two);await rawInsert(a,full,{client:one});await rawInsert(b,full,{owner:scope==='owner'?U:V,client:two});const settle=c=>q('COMMIT',[],c).then(()=>({ok:true}),e=>({ok:false,code:e.code}));const r1=settle(one),r2=settle(two);assert.equal(await observeWait(p1),true);assert.equal(await observeWait(p2),true);await q('COMMIT',[],blocker);const results=await Promise.all([r1,r2]);assert.equal(results.filter(x=>x.ok).length,1);assert.deepEqual(results.filter(x=>!x.ok),[{ok:false,code:'22023'}]);const after=await state();assert.equal(after.objects,before.objects+1);assert.equal(after.used,before.used+1);const [{bytes}]=await q("SELECT coalesce(sum((metadata->>'size')::bigint),0)::text bytes FROM storage.objects WHERE bucket_id='ugc-media-staging'"+(scope==='owner'?' AND owner_id=$1':''),scope==='owner'?[U]:[]);assert.equal(Number(bytes),scope==='owner'?104857600:1073741824);}finally{for(const c of [blocker,one,two])await q('ROLLBACK',[],c).catch(()=>{});await Promise.all([blocker.end(),one.end(),two.end()]);}
});

test('reserve still enforces per-hour rate and owned immutable server-generated paths',async()=>{
 const reservations=[];for(let n=0;n<6;n++)reservations.push(await reserve({size:1}));await assert.rejects(reserve({size:1}),e=>e.code==='22023'&&e.message==='ugc_rate_limited');for(const i of reservations){assert.match(i.object_path,new RegExp('^'+U+'/[0-9a-f-]{36}\\.png$'));assert.equal(i.bucket,'ugc-media-staging');}
});
test('baseline drift aborts before adding any new object binding or helper',async()=>{
 await setup({apply:false});await q("CREATE OR REPLACE FUNCTION private.consume_profile_media_upload(p_name text,p_metadata jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT true'");await q('BEGIN');try{await assert.rejects(q(migration),/ugc_storage_commit_repair_baseline_mismatch/);}finally{await q('ROLLBACK');}assert.equal((await q("SELECT count(*)::int n FROM pg_attribute WHERE attrelid='private.profile_media_upload_intents'::regclass AND attname='used_object_id' AND NOT attisdropped"))[0].n,0);assert.equal((await q("SELECT count(*)::int n FROM pg_trigger WHERE tgname='ugc_staging_object_commit'"))[0].n,0);
});

for(const [name,set,args] of [['delete marker','is_delete_marker=true',[]],['archived','archived_at=clock_timestamp()',[]],['versioned','is_versioned=true',[]],['foreign deprecated owner','owner=$2::uuid',[V]]])test(`final commit denies ${name} despite exact file metadata`,async()=>{const i=await reserve();await assert.rejects(tx(async c=>{const [{id}]=await rawInsert(i,full,{client:c});await q('UPDATE storage.objects SET '+set+' WHERE id=$1',[id,...args],c);},{role:'service_role'}),e=>e.code==='42501');assert.equal((await state()).objects,0);assert.equal((await state()).used,0);});
test('ordinary public bucket keeps vendor updated_at behavior and generated path tokens',async()=>{const [{id}]=await tx(c=>q("INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES('cafe-images',$1,$2,'{}') RETURNING id",[U+'/legacy.png',U],c));const before=(await q('SELECT updated_at::text value FROM storage.objects WHERE id=$1',[id]))[0].value;await tx(c=>q('UPDATE storage.objects SET last_accessed_at=clock_timestamp() WHERE id=$1',[id],c),{role:'service_role'});const row=(await q('SELECT updated_at::text value,path_tokens FROM storage.objects WHERE id=$1',[id]))[0];assert.notEqual(row.value,before);assert.deepEqual(row.path_tokens,[U,'legacy.png']);});
test('pinned generated schema and vendor timestamp drift fail before repair DDL',async()=>{for(const change of ["ALTER TABLE storage.objects ADD COLUMN unexpected_generated text GENERATED ALWAYS AS (name) STORED","CREATE OR REPLACE FUNCTION storage.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'"]){await setup({apply:false});await q(change);await q('BEGIN');try{await assert.rejects(q(migration),/ugc_storage_commit_repair_baseline_mismatch/);}finally{await q('ROLLBACK');}assert.equal((await q("SELECT count(*)::int n FROM pg_attribute WHERE attrelid='private.profile_media_upload_intents'::regclass AND attname='used_object_id' AND NOT attisdropped"))[0].n,0);}});

test('provider version-only filename reconciliation preserves exact SQL; duplicates and changed contents fail closed',()=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bjm-storage-version-resolver-'));try{const reconciled='20990101000000_profile_media_storage_commit_validation.sql';fs.writeFileSync(path.join(directory,reconciled),migration);assert.equal(resolveFrozenMigration(directory).sql,migration);assert.equal(resolveFrozenMigration(directory).name,reconciled);const duplicate='20990101000001_profile_media_storage_commit_validation.sql';fs.writeFileSync(path.join(directory,duplicate),migration);assert.throws(()=>resolveFrozenMigration(directory),/Exactly one/);fs.unlinkSync(path.join(directory,duplicate));fs.writeFileSync(path.join(directory,reconciled),migration+'\n');assert.throws(()=>resolveFrozenMigration(directory),/byte-identical/);}finally{fs.rmSync(directory,{recursive:true,force:true});}});

// Actual publisher + real PostgreSQL with the official COPY metadata-probe shape.
// Auth/storage byte transport is inert: this is not a hosted Storage service test.
for(const probeMode of ['metadata-preserving','historical-metadata-less'])test(`actual publisher with b202+activation ${probeMode} COPY protocol`,async()=>{
 const bytes=Buffer.from('ffd8ffe000000000','hex'),i=await reserve({mime:'image/jpeg',size:bytes.length});await tx(c=>q("INSERT INTO storage.objects(bucket_id,name,owner_id,metadata,user_metadata) VALUES('ugc-media-staging',$1,$2,$3::jsonb,'{\"unreviewed\":\"must stay private\"}'::jsonb)",[i.object_path,U,JSON.stringify({mimetype:'image/jpeg',size:bytes.length})],c),{role:'service_role'});const [{review}]=await tx(c=>q("SELECT public.submit_profile_media_review('avatar_url',$1) review",[i.object_path],c));await q("SELECT private.review_profile_media($1,'approved')",[review.request_id]);const activation=fs.readFileSync(new URL('../../review/HELD-20261103061904_reviewed_media_publication_activation.sql',import.meta.url),'utf8');await q('BEGIN');try{await q(activation);await q('COMMIT');}catch(e){await q('ROLLBACK');throw e;}
 const seen=[],claimId='44444444-4444-4444-8444-444444444444',targetPath=U+'/approved-'+i.upload_id+'.jpg';let copied=null,probeRollbackClean=false;
 const fetchImpl=async(url,init={})=>{const route=new URL(url).pathname;seen.push({route,method:init.method??'GET'});if(route==='/auth/v1/user'){assert.equal(init.headers.Authorization,'Bearer inert-owner');return Response.json({id:U,is_anonymous:false});}
  if(route.startsWith('/rest/v1/rpc/')){const name=route.split('/').at(-1),a=JSON.parse(init.body);assert.equal(a.p_owner_id,U);let rows;if(name==='claim_profile_media_publication')rows=await tx(c=>q('SELECT public.claim_profile_media_publication($1,$2,$3) result',[a.p_owner_id,a.p_request_id,a.p_claim_id],c),{role:'service_role'});else if(name==='finish_profile_media_publication')rows=await tx(c=>q('SELECT public.finish_profile_media_publication($1,$2,$3,$4) result',[a.p_owner_id,a.p_request_id,a.p_claim_id,a.p_sha256],c),{role:'service_role'});else if(name==='fail_profile_media_publication')rows=await tx(c=>q('SELECT public.fail_profile_media_publication($1,$2,$3,$4) result',[a.p_owner_id,a.p_request_id,a.p_claim_id,a.p_unsafe],c),{role:'service_role'});else throw Error('Unexpected RPC');return Response.json(rows[0].result);}
  if(route==='/storage/v1/object/ugc-media-staging/'+i.object_path){assert.notEqual(init.method,'POST');return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});}
  if(route==='/storage/v1/object/copy'){assert.equal(init.method,'POST');assert.equal(init.headers['x-upsert'],'false');assert.deepEqual(JSON.parse(init.body),{bucketId:'ugc-media-staging',sourceKey:i.object_path,destinationBucket:'cafe-images',destinationKey:targetPath,copyMetadata:false});assert.equal(init.headers['x-metadata'],undefined);const [{metadata}]=await q("SELECT metadata FROM storage.objects WHERE bucket_id='ugc-media-staging' AND name=$1",[i.object_path]);assert.equal(metadata.size,bytes.length);const probe=probeMode==='metadata-preserving'?metadata:null;
   try{await tx(c=>q("INSERT INTO storage.objects(bucket_id,name,metadata,version) VALUES('cafe-images',$1,$2::jsonb,'1')",[targetPath,JSON.stringify(probe)],c),{role:'service_role',rollback:true});probeRollbackClean=(await q("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='cafe-images' AND name=$1",[targetPath]))[0].n===0;await tx(c=>q("INSERT INTO storage.objects(bucket_id,name,metadata,version) VALUES('cafe-images',$1,$2::jsonb,gen_random_uuid()::text)",[targetPath,JSON.stringify(metadata)],c),{role:'service_role'});copied=Buffer.from(bytes);return Response.json({Key:targetPath});}catch(error){assert.equal(error.code,'22023');assert.equal(error.message,'ugc_invalid_media');return Response.json({error:'ugc_invalid_media'},{status:400});}}
  if(route==='/storage/v1/object/cafe-images/'+targetPath){assert.notEqual(init.method,'POST','Never fall back to raw destination upload');return copied?new Response(copied):new Response('',{status:404});}
  throw Error('Unexpected request');};
 const publish=createMediaPublisher({fetchImpl,newId:()=>claimId,env:{SUPABASE_URL:'https://lmwqrxoitraofaftpwhe.supabase.co',SUPABASE_PUBLISHABLE_KEY:'inert-public',SUPABASE_SECRET_KEY:'inert-service'}});const out=await publish({authorization:'Bearer inert-owner',body:{requestId:i.upload_id}});assert.equal(seen.filter(x=>x.route==='/storage/v1/object/copy').length,1);
 if(probeMode==='metadata-preserving')assert.equal((await q("SELECT user_metadata FROM storage.objects WHERE bucket_id='cafe-images' AND name=$1",[targetPath]))[0].user_metadata,null);const row=(await q('SELECT status,published_value FROM private.profile_media_reviews WHERE id=$1',[i.upload_id]))[0];const profile=(await q('SELECT avatar_url,is_discoverable,visible_to_cafes FROM public.profiles WHERE id=$1',[U]))[0];assert.equal(profile.is_discoverable,false);assert.equal(profile.visible_to_cafes,false);
 if(probeMode==='metadata-preserving'){assert.equal(out.status,200);assert.equal(out.body.status,'published');assert.equal(row.status,'published');assert.equal(profile.avatar_url,row.published_value);assert.equal(probeRollbackClean,true);assert.equal((await q("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='cafe-images' AND name=$1",[targetPath]))[0].n,1);}else{assert.deepEqual(out,{status:409,body:{error:'ugc_publication_failed'}});assert.equal(row.status,'approved');assert.equal(row.published_value,null);assert.equal(profile.avatar_url,'https://old.example/logo.png');assert.equal((await q("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='cafe-images' AND name=$1",[targetPath]))[0].n,0);assert(!seen.some(x=>x.route.endsWith('/finish_profile_media_publication')));}
});
