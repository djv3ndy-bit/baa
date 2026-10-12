import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const runtimeRoot=process.env.ANDROID_PUBLIC_QUEUE_PGLITE_ROOT;
const PGlite=runtimeRoot?(await import(pathToFileURL(`${runtimeRoot}/package/dist/index.js`).href)).PGlite:null;
const sql=fs.readFileSync(new URL('../../server/android-public-notifications/sql/android_public_push_queue.sql',import.meta.url),'utf8');
const mcp=fs.readFileSync(new URL('../../server/android-public-notifications/sql/android_public_push_queue_mcp.sql',import.meta.url),'utf8');
const cafe='10000000-0000-4000-8000-000000000001',barista='10000000-0000-4000-8000-000000000002',other='10000000-0000-4000-8000-000000000003';
const job='20000000-0000-4000-8000-000000000001',app='30000000-0000-4000-8000-000000000001',match='40000000-0000-4000-8000-000000000001';
const id=i=>`50000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const fixture=`
create role anon;create role authenticated;create role service_role bypassrls;
create schema private;
create table private.native_billing_configuration(singleton boolean,environment text);
insert into private.native_billing_configuration values(true,'Production');
create table public.profiles(id uuid primary key,role text,suspended_at timestamptz);
create table public.jobs(id uuid primary key,owner_id uuid);
create table public.applications(id uuid primary key,barista_id uuid,job_id uuid,status text);
create table public.discovery_matches(id uuid primary key,cafe_id uuid,barista_id uuid);
create table public.notifications(id uuid primary key,recipient_id uuid,actor_id uuid,application_id uuid,type text,read_at timestamptz,created_at timestamptz default now());
create table public.discovery_message_notifications(id uuid primary key,recipient_id uuid,discovery_match_id uuid,read_at timestamptz,created_at timestamptz default now());
create table private.blocks(a uuid,b uuid);
create function private.members_are_blocked(a uuid,b uuid) returns boolean language sql stable as $$select exists(select 1 from private.blocks x where (x.a=a and x.b=b) or (x.a=b and x.b=a))$$;
create table public.android_device_push_tokens(fcm_token text primary key,user_id uuid,enabled boolean default true,platform text default 'android',firebase_project_id text default 'baristamatch',package_name text default 'com.baristajobmatch.app',updated_at timestamptz default now());
create table public.device_push_tokens(expo_push_token text primary key,user_id uuid);
insert into public.device_push_tokens values('fixture_expo_untouched','${cafe}');
insert into public.profiles values('${cafe}','cafe_owner_manager',null),('${barista}','barista',null),('${other}','barista',null);
insert into public.jobs values('${job}','${cafe}');
insert into public.applications values('${app}','${barista}','${job}','matched');
insert into public.discovery_matches values('${match}','${cafe}','${barista}');
insert into public.android_device_push_tokens(fcm_token,user_id) values('fixture_native_token','${cafe}');
alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
alter default privileges in schema private grant execute on functions to anon,authenticated,service_role;
grant usage on schema public to anon,authenticated,service_role;`;
const db=PGlite?new PGlite():null;
const val=async(query,params=[])=>Object.values((await db.query(query,params)).rows[0])[0];
const notify=async(i,{type='message',recipient=cafe,actor=barista,created='2000-01-01Z'}={})=>db.query('insert into public.notifications(id,recipient_id,actor_id,application_id,type,created_at) values($1,$2,$3,$4,$5,$6)',[id(i),recipient,actor,app,type,created]);
const initialize=async()=>{await db.query('select private.android_public_push_initialize()');await db.query('update private.android_public_push_configuration set dispatch_enabled=true');};
const poll=async(limit=200)=>val('select public.android_public_push_poll($1)',[limit]);
const claim=async()=>val('select public.android_public_push_claim()');
const revalidate=async(l)=>val('select public.android_public_push_revalidate($1,$2)',[l.delivery_id,l.lease_id]);
const finish=async(l,result)=>val('select public.android_public_push_finish($1,$2,$3)',[l.delivery_id,l.lease_id,result]);
const snapshot=async()=>JSON.stringify((await db.query(`select c.relname,c.relrowsecurity,c.relacl::text,(select count(*) from pg_trigger t where t.tgrelid=c.oid) triggers from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname`)).rows);
let before;
if(db){await db.exec(fixture);before=await snapshot();await db.exec(sql);assert.equal(await snapshot(),before);}

test('Android production private queue PG17 actual SQL (synthetic exclusive backend; no hosted/concurrency proof)',{skip:!db},async t=>{
  assert.equal(Math.floor(Number(await val("select current_setting('server_version_num')"))/10000),17);
  const run=(name,fn)=>t.test(name,async()=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback; reset role');}});
  await run('default off and uninitialized cannot observe, claim or send',async()=>{await notify(1);assert.equal((await poll()).ready,false);assert.equal(await claim(),null);assert.equal(await val('select count(*) from private.android_public_push_events'),0);});
  await run('atomic baseline ignores existing rows, activates observation only and cannot run twice',async()=>{
    await notify(1);assert.equal(await val('select private.android_public_push_initialize()'),1);assert.equal((await poll()).ready,false);
    assert.equal(await val("select state from private.android_public_push_events"),'baseline');
    await assert.rejects(db.query('select private.android_public_push_initialize()'),{message:'ANDROID_BASELINE_ALREADY_INITIALIZED'});
  });
  await run('all four families derive exact recipient and route from saved relationships',async()=>{
    await initialize();await notify(1);await notify(2,{type:'match',recipient:barista,actor:cafe});
    await db.query("update public.applications set status='interested'");await notify(3,{type:'application'});
    assert.equal(await val("select notification_type from private.android_public_push_source('notification',$1)",[id(3)]),'application');
    await db.query("update public.applications set status='matched'");
    await db.query('insert into public.discovery_message_notifications(id,recipient_id,discovery_match_id) values($1,$2,$3)',[id(4),cafe,match]);await poll();
    const routes=(await db.query('select source_kind,notification_type,route from private.android_public_push_events order by source_id')).rows;
    assert.deepEqual(routes.map(x=>x.route),[`/chat/${app}?kind=application`,'/matches',null,`/chat/${match}?kind=discovery`]);
    await db.query("update public.applications set status='interested'");assert.equal(await val("select route from private.android_public_push_source('notification',$1)",[id(3)]),'/candidates');
  });
  await run('backdated source and UUID inserted behind completed cursor are recovered without created_at watermark',async()=>{
    await initialize();await notify(20);await notify(30);await poll(1);await notify(10);await poll(1);await poll(1);await poll(1);
    assert.equal(await val('select count(*) from private.android_public_push_events'),3);await poll();assert.equal(await val('select count(*) from private.android_public_push_deliveries'),3);
  });
  await run('source repeated polling snapshots tokens once and never replays to later devices',async()=>{
    await initialize();await notify(1);await poll();await db.query("insert into public.android_device_push_tokens(fcm_token,user_id) values('new_device',$1)",[cafe]);await poll();
    assert.equal(await val('select count(*) from private.android_public_push_deliveries'),1);
  });
  await run('claim has opaque lease, revalidation returns only bound raw token and generic route',async()=>{
    await initialize();await notify(1);await poll();const l=await claim();assert.ok(l.lease_id);const r=await revalidate(l);
    assert.deepEqual(Object.keys(r).sort(),['fcm_token','notification_type','recipient_id','route','source_id']);assert.equal(r.fcm_token,'fixture_native_token');
    assert.equal(await finish(l,'accepted'),true);assert.equal(await finish(l,'accepted'),false);assert.equal(await claim(),null);
  });
  for(const [name,change] of [
    ['read',"update public.notifications set read_at=now()"],['deleted',"delete from public.notifications"],
    ['withdrawn',"update public.applications set status='withdrawn'"],['suspended',"update public.profiles set suspended_at=now()"],
    ['blocked',`insert into private.blocks values('${cafe}','${barista}')`],
    ['wrong recipient',`update public.notifications set recipient_id='${other}'`],['wrong actor',`update public.notifications set actor_id='${other}'`],
    ['token removed',"delete from public.android_device_push_tokens"],['token disabled',"update public.android_device_push_tokens set enabled=false"],
    ['token refreshed',"update public.android_device_push_tokens set updated_at=now()+interval '1 second'"],
    ['token reassigned',`update public.android_device_push_tokens set user_id='${other}'`],
    ['dispatch paused',"update private.android_public_push_configuration set dispatch_enabled=false"],
  ])await run(`${name} after queue/claim suppresses delivery`,async()=>{await initialize();await notify(1);await poll();const l=await claim();await db.exec(change);assert.equal(await revalidate(l),null);});
  await run('invalid token cleanup cannot disable refreshed/reassigned registration',async()=>{
    await initialize();await notify(1);await poll();const l=await claim();await db.query("update public.android_device_push_tokens set updated_at=now()+interval '1 second'");
    assert.equal(await finish(l,'invalid'),true);assert.equal(await val('select enabled from public.android_device_push_tokens'),true);
  });
  await run('invalid current token is disabled and legacy Expo row is untouched',async()=>{
    await initialize();await notify(1);await poll();const l=await claim();assert.equal(await finish(l,'invalid'),true);
    assert.equal(await val('select enabled from public.android_device_push_tokens'),false);assert.equal(await val('select count(*) from public.device_push_tokens'),1);
  });
  await run('retry backs off, final attempt terminal, expired lease cannot finish another lease',async()=>{
    await initialize();await notify(1);await poll();let l=await claim();await finish(l,'retry');assert.equal(await claim(),null);
    await db.query("update private.android_public_push_deliveries set available_at=now()-interval '1 second'");l=await claim();
    await db.query("update private.android_public_push_deliveries set lease_until=now()-interval '1 second'");const next=await claim();
    assert.notEqual(next.lease_id,l.lease_id);assert.equal(await finish(l,'accepted'),false);await finish(next,'retry');
    await db.query("update private.android_public_push_deliveries set available_at=now()-interval '1 second',attempts=4");const last=await claim();await finish(last,'retry');
    assert.equal(await val('select state from private.android_public_push_deliveries'),'dead');assert.equal(await claim(),null);
  });
  await run('stale event cannot be claimed or revalidated',async()=>{
    await initialize();await notify(1);await poll();await db.query("update private.android_public_push_events set expires_at=now()-interval '1 second'");assert.equal(await claim(),null);
    assert.equal(await val('select state from private.android_public_push_deliveries'),'dead');
  });
  await run('old terminal deliveries purged but retained source dedup tombstone survives',async()=>{
    await initialize();await notify(1);await poll();const l=await claim();await finish(l,'accepted');
    await db.exec("update private.android_public_push_deliveries set finished_at=now()-interval '8 days'; update private.android_public_push_events set observed_at=now()-interval '8 days'");
    await poll();assert.equal(await val('select count(*) from private.android_public_push_deliveries'),0);assert.equal(await val('select count(*) from private.android_public_push_events'),1);
    await poll();assert.equal(await val('select count(*) from private.android_public_push_deliveries'),0);
  });
  for(const role of ['anon','authenticated'])await run(`${role} cannot read private queue or invoke privileged RPCs`,async()=>{
    assert.equal(await val("select has_table_privilege($1,'private.android_public_push_events','SELECT')",[role]),false);
    for(const fn of ['public.android_public_push_poll(integer)','public.android_public_push_claim()','public.android_public_push_revalidate(uuid,uuid)','public.android_public_push_finish(uuid,uuid,text)','private.android_public_push_initialize()'])
      assert.equal(await val('select has_function_privilege($1,$2,\'EXECUTE\')',[role,fn]),false);
  });
  await run('service has only narrow RPC execution; no direct source/queue access or baseline activation',async()=>{
    for(const table of ['public.notifications','public.discovery_message_notifications','private.android_public_push_events','private.android_public_push_configuration'])assert.equal(await val('select has_table_privilege(\'service_role\',$1,\'SELECT\')',[table]),false);
    assert.equal(await val("select has_function_privilege('service_role','private.android_public_push_initialize()','EXECUTE')"),false);
    await initialize();await notify(1);await db.exec('set role service_role');assert.equal((await poll()).ready,true);assert.ok(await claim());
  });
  await run('unknown types and mismatched source relationships cannot produce alerts',async()=>{
    await initialize();await notify(1,{type:'system'});await notify(2,{recipient:other});await poll();assert.equal(await claim(),null);
  });

  await run('101 registrations fail closed rather than silently truncating recipients',async()=>{
    await initialize();await db.query('delete from public.android_device_push_tokens');
    await db.query("insert into public.android_device_push_tokens(fcm_token,user_id) select 'fixture_'||g,$1 from generate_series(1,101) g",[cafe]);
    await notify(1);await poll();assert.equal(await claim(),null);assert.equal(await val('select state from private.android_public_push_events'),'skipped');
  });
  await run('invalid limits rejected before queue/source writes',async()=>{
    await assert.rejects(poll(201),{message:'ANDROID_POLL_LIMIT'});
  });
  await t.test('atomic MCP payload exactly preserves standalone body and has no transaction controls',async()=>{
    assert.equal(mcp.split('execute $androidQueueDDL$')[1].split('$androidQueueDDL$;')[0],sql.split('begin;\n')[1].slice(0,-'commit;\n'.length));
    const isolated=new PGlite();try{await isolated.exec(fixture);await isolated.exec(mcp);
      assert.equal((await isolated.query("select count(*) c from pg_class where relnamespace='private'::regnamespace and relkind='r' and relname like 'android_public_push_%'")).rows[0].c,4);
      await assert.rejects(isolated.exec(mcp),{message:'ANDROID_QUEUE_COLLISION'});
    }finally{await isolated.close();}
  });
  await t.test('post-DDL failure and enclosing transaction rollback remove every new queue object',async()=>{
    for(const enclosing of [false,true]){const isolated=new PGlite();try{await isolated.exec(fixture);
      if(enclosing){await isolated.exec('begin');await isolated.exec(mcp);await isolated.exec('rollback');}
      else await assert.rejects(isolated.exec(mcp.replace('end;\n$androidQueue$;',"raise exception 'INJECTED_AFTER_DDL';\nend;\n$androidQueue$;")),{message:'INJECTED_AFTER_DDL'});
      assert.equal((await isolated.query("select count(*) c from pg_class where relnamespace='private'::regnamespace and relname like 'android_public_push_%'")).rows[0].c,0);
      assert.equal((await isolated.query("select count(*) c from pg_proc where proname like 'android_public_push_%'")).rows[0].c,0);
    }finally{await isolated.close();}}
  });
  await t.test('wrong singleton environment fails before DDL atomically',async()=>{
    const isolated=new PGlite();try{await isolated.exec(fixture);await isolated.exec("update private.native_billing_configuration set environment='Sandbox'");
      await assert.rejects(isolated.exec(mcp),{message:'ANDROID_PRODUCTION_QUEUE_REQUIRED'});
      assert.equal((await isolated.query("select to_regclass('private.android_public_push_events') t")).rows[0].t,null);
    }finally{await isolated.close();}
  });
  await run('only new internal FK hooks target new queue objects; all source ACL/RLS/hooks preserved',async()=>{
    assert.equal(await snapshot(),before);assert.equal(await val("select count(*) from pg_constraint where contype='f' and connamespace='private'::regnamespace"),1);
    assert.equal(await val("select count(*) from pg_class where relnamespace='private'::regnamespace and relname like 'android_public_push_%' and relkind='r' and relrowsecurity"),4);
  });
});
test.after(async()=>{if(db)await db.close();});
