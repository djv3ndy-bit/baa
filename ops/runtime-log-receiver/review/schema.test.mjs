import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '../../../tests/database/node_modules/@electric-sql/pglite/dist/index.js';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const key = 'a'.repeat(64);
let sequence = 0;
const digest = () => (++sequence).toString(16).padStart(64, '0');
const stamp = (offset = 0) => new Date(Date.now() + offset).toISOString();
const event = (category = 'runtime_ok', offset = 0) => ({event_key:digest(),occurred_at:stamp(offset),category});
async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table public.existing_app_table(id integer primary key, customer_text text);
    alter table public.existing_app_table enable row level security;
    create policy own_policy on public.existing_app_table to authenticated using (id = 42);
    grant select on public.existing_app_table to authenticated;
    insert into public.existing_app_table values (42,'existing fixture');`);
  await db.exec(schema);
  await db.query(`insert into ops_monitoring.runtime_ingest_keys(token_digest,expires_at)
    values ($1,clock_timestamp()+interval '1 hour')`,[key]);
  return db;
}
async function ingest(db, events, delivery=digest(), credential=key) {
  return (await db.query('select public.era_runtime_ingest($1,$2,$3) as result',[credential,delivery,JSON.stringify(events)])).rows[0].result;
}
async function summary(db, since=stamp(-7000000), until=stamp()) {
  return (await db.query('select public.era_runtime_summary($1,$2) as result',[since,until])).rows[0].result;
}
async function state(db) { return (await db.query('select * from ops_monitoring.runtime_state')).rows[0]; }

test('isolated schema keeps existing app rows, privileges and policies; all private tables RLS and RPCs invoker',async()=>{
  const db=await setup(); try {
    assert.deepEqual((await db.query('select * from public.existing_app_table')).rows,[{id:42,customer_text:'existing fixture'}]);
    assert.equal((await db.query("select has_table_privilege('authenticated','public.existing_app_table','select') as allowed")).rows[0].allowed,true);
    assert.equal((await db.query("select count(*)::int as n from pg_policies where tablename='existing_app_table' and policyname='own_policy'")).rows[0].n,1);
    const tables=(await db.query("select relrowsecurity,relforcerowsecurity from pg_class c join pg_namespace n on c.relnamespace=n.oid where n.nspname='ops_monitoring' and c.relkind='r'")).rows;
    assert.equal(tables.length,4); assert.ok(tables.every(x=>x.relrowsecurity&&x.relforcerowsecurity));
    const funcs=(await db.query("select prosecdef,proconfig from pg_proc where proname in ('era_runtime_ingest','era_runtime_summary','prune_runtime')")).rows;
    assert.equal(funcs.length,3); assert.ok(funcs.every(x=>!x.prosecdef&&x.proconfig.includes('search_path=""')));
    await assert.rejects(db.exec(schema),/already exists/); await db.exec('rollback');
  }finally{await db.close();}
});

test('anonymous and signed-in app users cannot reach private rows or public RPCs; service role can',async()=>{
  const db=await setup(); try {
    for(const role of ['anon','authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select * from ops_monitoring.runtime_events'),/permission denied/);
      await assert.rejects(ingest(db,[]),/permission denied/);
      await assert.rejects(summary(db),/permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    assert.equal((await ingest(db,[event()])).accepted,true);
    assert.equal((await summary(db)).schema_version,1);
  }finally{await db.close();}
});

test('unknown, revoked and expired digests fail closed with no stored delivery',async()=>{
  const db=await setup(); try {
    assert.deepEqual(await ingest(db,[event()],digest(),'b'.repeat(64)),{authorized:false});
    assert.equal((await state(db)).truncated,false);
    await db.exec('update ops_monitoring.runtime_ingest_keys set revoked_at=clock_timestamp()');
    assert.deepEqual(await ingest(db,[event()]),{authorized:false});
    await db.exec("update ops_monitoring.runtime_ingest_keys set revoked_at=null,created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'");
    assert.deepEqual(await ingest(db,[event()]),{authorized:false});
    assert.equal((await state(db)).delivery_count,0);
  }finally{await db.close();}
});

test('shape, timestamp, category, bounds and conflicting-key validation are atomic',async()=>{
  const db=await setup(); try {
    const normal=event();
    for(const batch of [{},null,[{...normal,raw_message:'must never store'}],[{...normal,event_key:'raw'}],
      [{...normal,category:'customer_data'}],[{...normal,occurred_at:'2026-02-30T12:00:00.000Z'}],
      [{...normal,occurred_at:stamp().replace(/:\d{2}\.\d{3}Z$/,':60.000Z')}],
      [event('runtime_ok',-86401000)],[event('runtime_ok',61000)],[normal,normal],
      [normal,{...normal,category:'runtime_fatal'}]]) {
      const result=await ingest(db,batch); assert.equal(result.accepted,false); assert.equal(result.status,'invalid_batch');
    }
    assert.equal((await ingest(db,[normal])).inserted_events,1);
    assert.equal((await ingest(db,[{...normal,category:'runtime_fatal'}])).status,'invalid_batch');
    assert.equal((await state(db)).event_count,1);
  }finally{await db.close();}
});

test('unique categories count once; delivery retries and event retries cannot refresh heartbeat',async()=>{
  const db=await setup(); try {
    const batch=['runtime_fatal','runtime_error','http_5xx','runtime_ok'].map(c=>event(c,-1000));
    const delivery=digest(); const first=await ingest(db,batch,delivery);
    assert.equal(first.inserted_events,4); const initial=await state(db);
    assert.deepEqual(await ingest(db,batch,delivery),{authorized:true,accepted:true,duplicate:true,inserted_events:0});
    assert.equal((await ingest(db,batch)).inserted_events,0);
    await ingest(db,[]);
    const after=await state(db); assert.equal(after.last_delivery_at.getTime(),initial.last_delivery_at.getTime());
    const result=await summary(db,stamp(-7000000),stamp());
    assert.deepEqual(result.counts,{runtime_fatal:1,runtime_error:1,http_5xx:1,runtime_ok:1});
    assert.equal(result.complete,false); assert.equal(result.truncated,false);
    assert.match(result.last_delivery_at,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(Object.keys(result).sort(),['schema_version','project_id','environment','window','counts','coverage_started_at','last_delivery_at','complete','truncated'].sort());
  }finally{await db.close();}
});

test('old retries do not warm feed; stale gaps reset coverage and require a full new window',async()=>{
  const db=await setup(); try {
    await ingest(db,[event('runtime_error',-3600000)]);
    assert.equal((await state(db)).last_delivery_at,null);
    await ingest(db,[event()]);
    await db.exec("update ops_monitoring.runtime_state set coverage_started_at=clock_timestamp()-interval '3 hours',last_delivery_at=clock_timestamp()-interval '16 minutes'");
    assert.equal((await summary(db,stamp(-7000000),stamp())).complete,false);
    await ingest(db,[event()]);
    const reset=await state(db); assert.ok(reset.coverage_started_at.getTime()>Date.now()-10000);
    assert.equal((await summary(db,stamp(-7000000),stamp())).complete,false);
    await db.exec("update ops_monitoring.runtime_state set coverage_started_at=clock_timestamp()-interval '3 hours'");
    assert.equal((await summary(db,stamp(-7000000),stamp())).complete,true);
    await db.exec('update ops_monitoring.runtime_ingest_keys set revoked_at=clock_timestamp()');
    assert.equal((await summary(db,stamp(-7000000),stamp())).complete,false);
  }finally{await db.close();}
});

test('retention prunes only isolated data, exact counters, and capacity fails without silently truncating',async()=>{
  const db=await setup(); try {
    await ingest(db,[event('runtime_error',-3600000)]);
    await db.exec("update ops_monitoring.runtime_events set occurred_at=clock_timestamp()-interval '25 hours'; update ops_monitoring.runtime_deliveries set received_at=clock_timestamp()-interval '25 hours'");
    await db.exec('select ops_monitoring.prune_runtime()');
    assert.equal((await state(db)).event_count,0); assert.equal((await state(db)).delivery_count,0);
    // Counter ceiling simulates an already full private store without 100k rows.
    await db.exec('update ops_monitoring.runtime_state set event_count=100000');
    const capacity=await ingest(db,[event('runtime_fatal')]);
    assert.equal(capacity.status,'capacity_exceeded'); assert.equal(capacity.accepted,false);
    assert.equal((await state(db)).truncated,true); assert.equal((await state(db)).coverage_started_at,null);
    const result=await summary(db,stamp(-7000000),stamp()); assert.equal(result.truncated,true); assert.equal(result.complete,false);
    assert.equal((await db.query('select count(*)::int as n from ops_monitoring.runtime_events')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int as n from public.existing_app_table')).rows[0].n,1);
    await db.exec('update ops_monitoring.runtime_state set event_count=0');
    await ingest(db,[event()]);
    const recovering=await summary(db,stamp(-7000000),stamp());
    assert.equal(recovering.truncated,false); assert.equal(recovering.complete,false);
    assert.ok(new Date(recovering.coverage_started_at).getTime()>Date.now()-10000);
  }finally{await db.close();}
});

test('window bounds reject null, infinities, future and oversized periods; half-open counts exclude boundary',async()=>{
  const db=await setup(); try {
    for(const [a,b] of [[null,stamp()],['-infinity',stamp()],[stamp(-7201000),stamp()],[stamp(),stamp(-1000)],[stamp(-1000),stamp(61000)],[stamp(-86401000),stamp(-86400000)]]) {
      assert.deepEqual(await summary(db,a,b),{status:'invalid_window'});
    }
    const until=stamp(-1000); await ingest(db,[{event_key:digest(),occurred_at:until,category:'runtime_fatal'}]);
    assert.equal((await summary(db,stamp(-7000000),until)).counts.runtime_fatal,0);
  }finally{await db.close();}
});

test('authenticated malformed or contradictory feed latches a gap; unknown tokens cannot sabotage coverage',async()=>{
  const db=await setup(); try {
    const original=event(); await ingest(db,[original]);
    for(const bad of [null,[{...original,category:'runtime_fatal'}],[original,{...original,category:'runtime_fatal'}]]) {
      await db.exec("update ops_monitoring.runtime_state set coverage_started_at=clock_timestamp()-interval '3 hours'");
      assert.equal((await summary(db)).complete,true);
      const before=await state(db);
      assert.deepEqual(await ingest(db,null,digest(),'b'.repeat(64)),{authorized:false});
      assert.equal((await summary(db)).complete,true);
      assert.equal((await ingest(db,bad)).status,'invalid_batch');
      const rejected=await state(db);
      assert.equal(rejected.truncated,true); assert.equal(rejected.coverage_started_at,null);
      assert.equal(rejected.last_delivery_at.getTime(),before.last_delivery_at.getTime());
      assert.equal(rejected.event_count,before.event_count);
      assert.equal((await summary(db)).complete,false);
      await ingest(db,[event()]);
      const recovering=await summary(db);
      assert.equal(recovering.complete,false);
      assert.ok(new Date(recovering.coverage_started_at).getTime()>Date.now()-10000);
    }
  }finally{await db.close();}
});

test('empty registered-key probe is read-only, including retention, counters and coverage',async()=>{
  const db=await setup(); try {
    await ingest(db,[event()]);
    // An expired row proves probe does not quietly prune; the real cron/ingest does.
    await db.exec("update ops_monitoring.runtime_events set occurred_at=clock_timestamp()-interval '25 hours'");
    async function snapshot() {
      const result={};
      for(const table of ['runtime_ingest_keys','runtime_state','runtime_events','runtime_deliveries']) {
        result[table]=(await db.query(`select * from ops_monitoring.${table} order by 1`)).rows;
      }
      return result;
    }
    const before=await snapshot();
    assert.deepEqual(await ingest(db,[]),{authorized:true,accepted:true,duplicate:false,inserted_events:0});
    assert.deepEqual(await snapshot(),before);
    assert.deepEqual(await ingest(db,[],digest(),'b'.repeat(64)),{authorized:false});
    assert.deepEqual(await snapshot(),before);
  }finally{await db.close();}
});
