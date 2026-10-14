import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const sql = readFileSync(new URL('../sql/office-chat-gateway-review.sql',import.meta.url),'utf8');
const legacySql = readFileSync(new URL('../sql/office-read-review.sql',import.meta.url),'utf8');
const activationSql=readFileSync(new URL('../operations/chat-gateway-activation.sql',import.meta.url),'utf8');
const rollbackSql=readFileSync(new URL('../operations/chat-gateway-rollback.sql',import.meta.url),'utf8');
const OWNER='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const CLIENT='33333333-3333-4333-8333-333333333333';
const UPSTREAM='66666666-6666-4666-8666-666666666666';
const SESSION='44444444-4444-4444-8444-444444444444';
const CHAT='office-chat-client';
const REDIRECT='https://chatgpt.com/connector/oauth/synthetic-test';
const RESOURCE='https://office.example/mcp';
const CHALLENGE='a'.repeat(43);
const hash = value => createHash('sha256').update(String(value)).digest('hex');
let nonce=0;
const fresh = label => hash(`${label}:${++nonce}`);
const fixture = `
create role anon; create role authenticated; create role service_role bypassrls;
create role authenticator noinherit; create role supabase_auth_admin noinherit;
create schema auth; create schema storage; create schema graphql_public;
create schema extensions; create schema cron;
create table extensions.pg_stat_statements(query text);
create table cron.job(id integer);
create table cron.job_run_details(id integer);
grant select on extensions.pg_stat_statements,cron.job,cron.job_run_details to public;
grant delete on cron.job_run_details to public;
grant usage on schema public, auth, storage, graphql_public to anon,authenticated,service_role;
create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
create table auth.oauth_consents(id uuid not null default gen_random_uuid(),user_id uuid,client_id uuid,revoked_at timestamptz,granted_at timestamptz not null default now());
create table auth.sessions(id uuid primary key,user_id uuid,oauth_client_id uuid,not_after timestamptz);
create table public.profiles(id uuid primary key,role text,email text);
create table public.jobs(id uuid primary key,active boolean,private_note text);
create table public.applications(id uuid primary key,status text,private_note text);
create table public.cafe_subscriptions(id uuid primary key,status text,cancel_at_period_end boolean,complimentary_access boolean,private_customer text);
create table public.subscription_payments(id uuid primary key,status text,created_at timestamptz,private_payment text);
create table public.support_tickets(id uuid primary key,status text,created_at timestamptz,email text,description text);
create table storage.objects(id uuid primary key,owner uuid,name text);
alter table public.profiles enable row level security;
alter table public.jobs enable row level security;
alter table public.applications enable row level security;
alter table public.cafe_subscriptions enable row level security;
alter table public.subscription_payments enable row level security;
alter table public.support_tickets enable row level security;
alter table storage.objects enable row level security;
grant select,insert,update,delete on public.profiles,public.jobs,public.applications,public.cafe_subscriptions to authenticated;
grant select,insert,update,delete on storage.objects to authenticated;
create policy customer_access on public.profiles to authenticated using(true) with check(true);
create policy customer_access on public.jobs to authenticated using(true) with check(true);
create policy customer_access on public.applications to authenticated using(true) with check(true);
create policy customer_access on public.cafe_subscriptions to authenticated using(true) with check(true);
create policy customer_storage on storage.objects to authenticated using(true) with check(true);
create function public.customer_write() returns void language sql security definer as $$insert into public.jobs values(gen_random_uuid(),true,'secret');$$;
revoke all on function public.customer_write() from public;
grant execute on function public.customer_write() to authenticated;
insert into auth.users values('${OWNER}',now(),false,null,null),('${OTHER}',now(),false,null,null);
insert into auth.sessions values('${SESSION}','${OWNER}','${CLIENT}',null);
insert into auth.sessions values('${OTHER}','${OTHER}','${CLIENT}',null),
 ('55555555-5555-4555-8555-555555555555','${OWNER}','${OTHER}',null);
insert into public.profiles values('${OWNER}','cafe_owner_manager','owner@private.test'),('${OTHER}','barista','barista@private.test');
insert into public.jobs values(gen_random_uuid(),true,'private');
insert into public.applications values(gen_random_uuid(),'new','private');
insert into public.cafe_subscriptions values(gen_random_uuid(),'active',false,false,'secret'),(gen_random_uuid(),'past_due',true,false,'secret');
insert into public.subscription_payments values(gen_random_uuid(),'succeeded',now(),'secret'),(gen_random_uuid(),'failed',now(),'secret'),(gen_random_uuid(),'failed',now()-interval '40 days','secret');
insert into public.support_tickets values(gen_random_uuid(),'investigating',now(),'private@private.test','private'),(gen_random_uuid(),'fixed',now(),'private@private.test','private'),(gen_random_uuid(),'new',now()-interval '40 days','private@private.test','private');
insert into auth.oauth_consents(user_id,client_id,revoked_at) values('${OWNER}','${CLIENT}',null),('${OWNER}','${UPSTREAM}',null);
`;

const reviewedHelperBody = `
  select case when p.role = 'barista' then
    nullif(btrim(coalesce(p.display_name,'')),'') is not null and
    nullif(btrim(coalesce(p.avatar_url,'')),'') is not null and
    nullif(btrim(coalesce(p.location,'')),'') is not null and
    nullif(btrim(coalesce(p.bio,'')),'') is not null and
    exists(select 1 from unnest(p.skills) skill where nullif(btrim(skill),'') is not null) and
    nullif(btrim(coalesce(p.availability,'')),'') is not null and
    nullif(btrim(coalesce(p.experience,'')),'') is not null and
    nullif(btrim(coalesce(p.pay_expectation,'')),'') is not null
  when p.role = 'cafe_owner_manager' then
    nullif(btrim(coalesce(p.cafe_name,'')),'') is not null and
    nullif(btrim(coalesce(p.avatar_url,'')),'') is not null and
    nullif(btrim(coalesce(p.location,'')),'') is not null and
    nullif(btrim(coalesce(p.bio,'')),'') is not null and
    nullif(btrim(coalesce(p.cafe_address,'')),'') is not null and
    nullif(btrim(coalesce(p.open_hours,'')),'') is not null and
    nullif(btrim(coalesce(p.shop_type,'')),'') is not null and
    exists(select 1 from unnest(p.barista_preferences) preference where nullif(btrim(preference),'') is not null)
  else false end;
`;

async function setup({configure=true,legacy=false}={}) {
  const db=new PGlite();
  try {
    await db.exec(fixture);
    if(legacy) await db.exec(legacySql);
    await db.exec(sql);
    if(configure) await db.query(`insert into bjm_office_gateway.configuration values(true,$1,$2,$3,$4,$5,true)`,[OWNER,UPSTREAM,CHAT,REDIRECT,RESOURCE]);
    return db;
  } catch(error) { await db.close(); throw error; }
}
// Change the actual session identity, not just current_user under postgres.
// Successful auth_dispatch calls COMMIT, including null refresh-replay results.
async function asRole(db,role,statement,params=[],outer=false) {
  if(!outer) await db.exec('begin');
  await db.exec('savepoint gateway_call');
  await db.exec(`set local session authorization ${role}`);
  try {
    const result=await db.query(statement,params);
    await db.exec('set session authorization postgres; reset role; release savepoint gateway_call');
    if(!outer) await db.exec('commit');
    return result;
  } catch(error) {
    await db.exec('rollback to savepoint gateway_call; set session authorization postgres; reset role; release savepoint gateway_call');
    if(!outer) await db.exec('rollback');
    throw error;
  }
}
const dispatch=async(db,op,args,outer=false)=>(await asRole(db,'bjm_office_gateway_login',
  'select bjm_office_gateway.auth_dispatch($1,$2::jsonb) as value',[op,JSON.stringify(args)],outer)).rows[0].value;
const snapshot=async(db,access,client=CHAT,resource=RESOURCE,outer=false)=>(await asRole(db,'bjm_office_gateway_login',
  'select bjm_office_gateway.read_snapshot($1,$2,$3) as value',[access,client,resource],outer)).rows[0].value;
const verify=(db,access,outer=false)=>dispatch(db,'verify',{accessHash:access,clientId:CHAT,resource:RESOURCE},outer);
async function grant(db,outer=false) {
  const code=fresh('code'),access=fresh('access'),refresh=fresh('refresh');
  assert.deepEqual(await dispatch(db,'create_code',{codeHash:code,ownerId:OWNER,clientId:CHAT,redirectUri:REDIRECT,challenge:CHALLENGE,resource:RESOURCE},outer),{ok:true});
  const issued=await dispatch(db,'exchange_code',{codeHash:code,clientId:CHAT,redirectUri:REDIRECT,challenge:CHALLENGE,accessHash:access,refreshHash:refresh},outer);
  assert.equal(issued.ownerId,OWNER);
  return {code,access,refresh,issued};
}
async function rollback(db,work) {
  await db.exec('begin'); try { return await work(); } finally { await db.exec('rollback'); }
}

test('gateway SQL isolates Office state and report privileges in a real local PostgreSQL engine',async t=>{
  const db=await setup({legacy:true});
  try {
    await t.test('login stays disabled and legacy roles/mapping are untouched',async()=>{
      assert.deepEqual((await db.query(`select rolname,rolcanlogin,rolinherit,rolbypassrls,rolcreaterole from pg_roles
        where rolname in('bjm_office_gateway_login','bjm_office_chat_issuer','bjm_office_chat_aggregate') order by rolname`)).rows,
        ['bjm_office_chat_aggregate','bjm_office_chat_issuer','bjm_office_gateway_login'].map(rolname=>({rolname,rolcanlogin:false,rolinherit:false,rolbypassrls:false,rolcreaterole:false})));
      assert.equal((await db.query('select count(*)::int as n from bjm_office_private.configuration')).rows[0].n,0);
      assert.equal((await db.query(`select pg_has_role('authenticator','bjm_office_gateway_login','MEMBER') as member`)).rows[0].member,false);
    });
    await t.test('owner code issues bounded tokens and count-only snapshot without owner Auth session dependency',async()=>{
      const g=await grant(db);
      assert.equal(g.issued.refreshExpiresAt-g.issued.accessExpiresAt,30*86400-900);
      const verified=await verify(db,g.access);
      assert.deepEqual(verified,{ownerId:OWNER,clientId:CHAT,resource:RESOURCE,accessExpiresAt:g.issued.accessExpiresAt});
      const data=await snapshot(db,g.access);
      assert.deepEqual(data.metrics,{profiles:2,cafes:1,baristas:1,jobs:1,applications:1,subscriptions:2,payments:3});
      assert.deepEqual(data.support,{total_recent:2,open:1});
      assert.deepEqual(data.billing,{subscriptions:{total:2,active:1,past_due:1,canceling:1},payments:{recent:2,failed:1,refunded:0}});
      assert.doesNotMatch(JSON.stringify(data),/private|email|owner_id|client_id|token_hash|encrypted_payload/);
      await rollback(db,async()=>{await db.exec('delete from auth.sessions');assert.equal((await snapshot(db,g.access,CHAT,RESOURCE,true)).metrics.profiles,2);});
    });
    await t.test('separate legacy owner JWT report remains unchanged alongside the new machine boundary',async()=>{
      await rollback(db,async()=>{
        await db.query('insert into bjm_office_private.configuration values(true,$1,$2,$3,$4,true)',[OWNER,CLIENT,RESOURCE,'https://project.example/auth/v1']);
        const now=Math.floor(Date.now()/1000);
        await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:OWNER,client_id:CLIENT,role:'bjm_office_reader',aud:RESOURCE,
          iss:'https://project.example/auth/v1',scope:'openid',is_anonymous:false,session_id:SESSION,iat:now,exp:now+600})]);
        assert.equal((await asRole(db,'bjm_office_reader','select public.office_read_snapshot() as snapshot',[],true)).rows[0].snapshot.metrics.profiles,2);
      });
    });
    await t.test('login cannot read raw business/Auth/storage/private state, write customers, switch roles or run legacy RPC',async()=>{
      for(const q of ['select * from public.profiles','select role from public.profiles','select * from public.support_tickets','select * from public.subscription_payments',
        'select * from auth.users','select * from auth.sessions','select * from auth.oauth_consents','select * from storage.objects',
        'select * from bjm_office_gateway.configuration','select * from bjm_office_gateway.active_owner','select * from bjm_office_gateway.tokens',
        'select * from bjm_office_gateway.flows','select * from bjm_office_gateway.codes','select * from bjm_office_gateway.grants',
        'select bjm_office_gateway.context_valid()','select bjm_office_gateway.assert_isolated()',
        "insert into public.jobs values(gen_random_uuid(),true,'injected')",'update public.cafe_subscriptions set cancel_at_period_end=true','delete from public.applications',
        'select public.customer_write()','select public.office_read_snapshot()','set role authenticated','set role bjm_office_chat_aggregate','set role bjm_office_chat_issuer']) {
        await assert.rejects(asRole(db,'bjm_office_gateway_login',q),/permission denied/);
      }
      assert.equal((await db.query('select count(*)::int as n from public.jobs')).rows[0].n,1);
      for(const role of ['anon','authenticated','service_role','bjm_office_reader']) {
        await assert.rejects(asRole(db,role,"select bjm_office_gateway.auth_dispatch('verify','{}')"),/permission denied/);
        await assert.rejects(asRole(db,role,"select bjm_office_gateway.read_snapshot('x','x','x')"),/permission denied/);
      }
    });
    await t.test('encrypted bootstrap flow is single-use, expires, and may precede first upstream consent',async()=>{
      await rollback(db,async()=>{
        await db.exec('delete from auth.oauth_consents');
        const flow=fresh('flow');
        assert.deepEqual(await dispatch(db,'create_flow',{flowHash:flow,encryptedPayload:'opaque-ciphertext'},true),{ok:true});
        assert.equal(await dispatch(db,'create_code',{codeHash:fresh('code'),ownerId:OWNER,clientId:CHAT,redirectUri:REDIRECT,challenge:CHALLENGE,resource:RESOURCE},true),null);
        await db.exec('update bjm_office_gateway.configuration set enabled=false');
        assert.deepEqual(await dispatch(db,'consume_flow',{flowHash:flow},true),{encryptedPayload:'opaque-ciphertext'});
        assert.equal(await dispatch(db,'consume_flow',{flowHash:flow},true),null);
        assert.equal(await dispatch(db,'create_flow',{flowHash:fresh('flow'),encryptedPayload:'ciphertext'},true),null);
      });
      const flow=fresh('flow');
      await dispatch(db,'create_flow',{flowHash:flow,encryptedPayload:'expired'});
      await db.query('update bjm_office_gateway.flows set expires_at=now()-interval \'1 second\' where flow_hash=$1',[flow]);
      assert.equal(await dispatch(db,'consume_flow',{flowHash:flow}),null);
    });
    await t.test('public authorization flow storage is capped atomically and expired slots are reclaimed',async()=>{
      await rollback(db,async()=>{
        for(let n=0;n<100;n++) assert.deepEqual(await dispatch(db,'create_flow',{flowHash:fresh('bounded-flow'),encryptedPayload:'ciphertext'},true),{ok:true});
        assert.equal(await dispatch(db,'create_flow',{flowHash:fresh('over-cap'),encryptedPayload:'ciphertext'},true),null);
        assert.equal((await db.query('select count(*)::int as n from bjm_office_gateway.flows')).rows[0].n,100);
        await db.exec("update bjm_office_gateway.flows set expires_at=now()-interval '1 second'");
        assert.deepEqual(await dispatch(db,'create_flow',{flowHash:fresh('reclaimed'),encryptedPayload:'ciphertext'},true),{ok:true});
        assert.equal((await db.query('select count(*)::int as n from bjm_office_gateway.flows')).rows[0].n,1);
      });
    });
    await t.test('code is short-lived, single-use and bound to owner/client/callback/PKCE/resource',async()=>{
      const g=await grant(db);
      const attempt={codeHash:g.code,clientId:CHAT,redirectUri:REDIRECT,challenge:CHALLENGE,accessHash:fresh('a'),refreshHash:fresh('r')};
      assert.equal(await dispatch(db,'exchange_code',attempt),null);
      const code=fresh('code');
      const create={codeHash:code,ownerId:OWNER,clientId:CHAT,redirectUri:REDIRECT,challenge:CHALLENGE,resource:RESOURCE};
      for(const change of [{ownerId:OTHER},{clientId:'other'},{redirectUri:'https://evil.example/cb'},{resource:'https://wrong.example/mcp'},{challenge:'bad'}])
        assert.equal(await dispatch(db,'create_code',{...create,...change}),null);
      assert.deepEqual(await dispatch(db,'create_code',create),{ok:true});
      for(const change of [{clientId:'other'},{redirectUri:'https://evil.example/cb'},{challenge:'b'.repeat(43)}])
        assert.equal(await dispatch(db,'exchange_code',{...attempt,codeHash:code,...change}),null);
      await db.query('update bjm_office_gateway.codes set expires_at=now()-interval \'1 second\' where code_hash=$1',[code]);
      assert.equal(await dispatch(db,'exchange_code',{...attempt,codeHash:code}),null);
    });
    await t.test('stable ChatGPT callback works while every request remains bound to one exact configured URI',async()=>{
      const stable='https://chatgpt.com/connector_platform_oauth_redirect';
      await rollback(db,async()=>{
        await db.query('update bjm_office_gateway.configuration set redirect_uri=$1',[stable]);
        const code=fresh('stable-code'),create={codeHash:code,ownerId:OWNER,clientId:CHAT,redirectUri:stable,challenge:CHALLENGE,resource:RESOURCE};
        assert.equal(await dispatch(db,'create_code',{...create,redirectUri:REDIRECT},true),null);
        assert.deepEqual(await dispatch(db,'create_code',create,true),{ok:true});
        const exchange={codeHash:code,clientId:CHAT,redirectUri:stable,challenge:CHALLENGE,accessHash:fresh('stable-a'),refreshHash:fresh('stable-r')};
        assert.equal(await dispatch(db,'exchange_code',{...exchange,redirectUri:REDIRECT},true),null);
        assert.equal((await dispatch(db,'exchange_code',exchange,true)).ownerId,OWNER);
      });
      for(const foreign of ['https://evil.example/connector_platform_oauth_redirect',stable+'?extra=1','https://chatgpt.com/other'])
        await assert.rejects(rollback(db,()=>db.query('update bjm_office_gateway.configuration set redirect_uri=$1',[foreign])),/check constraint/);
    });
    await t.test('malformed operation arguments fail closed without echo or extra accepted fields',async()=>{
      for(const [op,args] of [['verify',null],['verify',[]],['unknown',{}],['verify',{accessHash:'bad',clientId:CHAT,resource:RESOURCE}],
        ['verify',{accessHash:fresh('a'),clientId:CHAT,resource:RESOURCE,admin:true}],['create_flow',{flowHash:fresh('f'),encryptedPayload:42}],
        ['create_flow',{flowHash:fresh('f'),encryptedPayload:'x'.repeat(65537)}]]) assert.equal(await dispatch(db,op,args),null);
    });
    await t.test('wrong/unknown/expired tokens and disabled config deny both verify and snapshot',async()=>{
      const g=await grant(db);
      for(const access of [fresh('unknown'),g.refresh,'bad']) {
        assert.equal(await verify(db,access),null); await assert.rejects(snapshot(db,access),/Office access denied/);
      }
      for(const change of [{clientId:'other',resource:RESOURCE},{clientId:CHAT,resource:'https://wrong.example/mcp'}]) {
        assert.equal(await dispatch(db,'verify',{accessHash:g.access,...change}),null);
        await assert.rejects(snapshot(db,g.access,change.clientId,change.resource),/Office access denied/);
      }
      for(const change of ['update bjm_office_gateway.configuration set enabled=false',
        "update bjm_office_gateway.tokens set expires_at=now()-interval '1 second' where kind='access'",
        "update bjm_office_gateway.grants set refresh_expires_at=now()-interval '1 second'"])
        await rollback(db,async()=>{await db.exec(change);assert.equal(await verify(db,g.access,true),null);await assert.rejects(snapshot(db,g.access,CHAT,RESOURCE,true),/Office access denied/);});
    });
    await t.test('owner ban/deletion/anonymity/unconfirmation or exact upstream consent revocation cuts reports off',async()=>{
      const g=await grant(db);
      for(const change of ["update auth.users set banned_until=now()+interval '1 day' where id='"+OWNER+"'",
        'update auth.users set email_confirmed_at=null','update auth.users set is_anonymous=true','update auth.users set deleted_at=now()',
        'delete from auth.oauth_consents','update auth.oauth_consents set revoked_at=now()',
        `delete from auth.oauth_consents where client_id='${UPSTREAM}'`,
        `update auth.oauth_consents set client_id='${OTHER}'`,`update auth.oauth_consents set user_id='${OTHER}'`])
        await rollback(db,async()=>{await db.exec(change);assert.equal(await verify(db,g.access,true),null);await assert.rejects(snapshot(db,g.access,CHAT,RESOURCE,true),/Office access denied/);});
    });
    await t.test('upstream re-consent cannot revive old access, refresh or pending authorization codes',async()=>{
      await rollback(db,async()=>{
        const old=await grant(db,true),code=fresh('pending-code');
        await dispatch(db,'create_code',{codeHash:code,ownerId:OWNER,clientId:CHAT,redirectUri:REDIRECT,challenge:CHALLENGE,resource:RESOURCE},true);
        await db.query('update auth.oauth_consents set revoked_at=now() where client_id=$1',[UPSTREAM]);
        assert.equal(await verify(db,old.access,true),null);
        // Current GoTrue re-consent keeps the row ID but advances granted_at.
        await db.query("update auth.oauth_consents set revoked_at=null,granted_at=granted_at+interval '1 microsecond' where client_id=$1",[UPSTREAM]);
        assert.equal(await verify(db,old.access,true),null);
        await assert.rejects(snapshot(db,old.access,CHAT,RESOURCE,true),/Office access denied/);
        assert.equal(await dispatch(db,'refresh',{refreshHash:old.refresh,clientId:CHAT,resource:RESOURCE,newAccessHash:fresh('a'),newRefreshHash:fresh('r')},true),null);
        assert.equal(await dispatch(db,'exchange_code',{codeHash:code,clientId:CHAT,redirectUri:REDIRECT,challenge:CHALLENGE,accessHash:fresh('a'),refreshHash:fresh('r')},true),null);
        const current=await grant(db,true);assert.ok(await verify(db,current.access,true));
        await db.exec("set timezone='Pacific/Auckland'");
        assert.ok(await verify(db,current.access,true));
      });
    });
    await t.test('refresh rotates once, keeps the absolute lifetime, invalidates old access and rejects/revokes replay family',async()=>{
      const g=await grant(db),access=fresh('rotated-a'),refresh=fresh('rotated-r');
      const next=await dispatch(db,'refresh',{refreshHash:g.refresh,clientId:CHAT,resource:RESOURCE,newAccessHash:access,newRefreshHash:refresh});
      assert.equal(next.refreshExpiresAt,g.issued.refreshExpiresAt);
      assert.equal(await verify(db,g.access),null);assert.equal((await verify(db,access)).ownerId,OWNER);
      assert.equal(await dispatch(db,'refresh',{refreshHash:g.refresh,clientId:CHAT,resource:RESOURCE,newAccessHash:fresh('a'),newRefreshHash:fresh('r')}),null);
      assert.equal(await verify(db,access),null);
      assert.equal(await dispatch(db,'refresh',{refreshHash:refresh,clientId:CHAT,resource:RESOURCE,newAccessHash:fresh('a'),newRefreshHash:fresh('r')}),null);
      await assert.rejects(snapshot(db,access),/Office access denied/);
    });
    await t.test('refresh wrong-client/resource cannot revoke a valid family and access is capped by absolute expiry',async()=>{
      const g=await grant(db);
      for(const change of [{clientId:'other'},{resource:'https://wrong.example/mcp'}])
        assert.equal(await dispatch(db,'refresh',{refreshHash:g.refresh,clientId:CHAT,resource:RESOURCE,newAccessHash:fresh('a'),newRefreshHash:fresh('r'),...change}),null);
      assert.ok(await verify(db,g.access));
      await rollback(db,async()=>{
        await db.query("update bjm_office_gateway.grants set refresh_expires_at=now()+interval '2 minutes' where id=(select grant_id from bjm_office_gateway.tokens where token_hash=$1)",[g.refresh]);
        const rotated=await dispatch(db,'refresh',{refreshHash:g.refresh,clientId:CHAT,resource:RESOURCE,newAccessHash:fresh('a'),newRefreshHash:fresh('r')},true);
        assert.equal(rotated.accessExpiresAt,rotated.refreshExpiresAt);
      });
    });
    await t.test('expired refresh and token-hash collisions cannot consume a usable refresh grant',async()=>{
      const g=await grant(db);
      const input={refreshHash:g.refresh,clientId:CHAT,resource:RESOURCE,newAccessHash:g.access,newRefreshHash:fresh('r')};
      assert.equal(await dispatch(db,'refresh',input),null);assert.ok(await verify(db,g.access));
      await rollback(db,async()=>{
        await db.query("update bjm_office_gateway.tokens set expires_at=now()-interval '1 second' where token_hash=$1",[g.refresh]);
        assert.equal(await dispatch(db,'refresh',{...input,newAccessHash:fresh('a')},true),null);
        assert.ok(await verify(db,g.access,true));
      });
      const access=fresh('a'),refresh=fresh('r');
      assert.ok(await dispatch(db,'refresh',{...input,newAccessHash:access,newRefreshHash:refresh}));
      assert.ok(await verify(db,access));
    });
    await t.test('cleanup retains used refresh tombstones until absolute expiry and deletes only expired Office families in bounded batches',async()=>{
      await rollback(db,async()=>{
        const g=await grant(db,true),a=fresh('a'),r=fresh('r');
        await dispatch(db,'refresh',{refreshHash:g.refresh,clientId:CHAT,resource:RESOURCE,newAccessHash:a,newRefreshHash:r},true);
        await dispatch(db,'verify',{accessHash:a,clientId:CHAT,resource:RESOURCE},true);
        assert.equal((await db.query('select count(*)::int as n from bjm_office_gateway.tokens where token_hash=$1 and used_at is not null',[g.refresh])).rows[0].n,1);
        const liveOwnerSessions=(await db.query('select count(*)::int as n from auth.sessions')).rows[0].n;
        await db.query("update bjm_office_gateway.grants set refresh_expires_at=now()-interval '1 second' where id=(select grant_id from bjm_office_gateway.tokens where token_hash=$1)",[r]);
        await dispatch(db,'verify',{accessHash:a,clientId:CHAT,resource:RESOURCE},true);
        assert.equal((await db.query('select count(*)::int as n from bjm_office_gateway.tokens where token_hash=any($1::text[])',[[g.access,g.refresh,a,r]])).rows[0].n,0);
        await db.exec(`insert into bjm_office_gateway.grants(owner_id,client_id,resource,consent_version,refresh_expires_at)
          select '${OWNER}','${CHAT}','${RESOURCE}','${'0'.repeat(32)}',now()-interval '1 day' from generate_series(1,101)`);
        await dispatch(db,'verify',{accessHash:fresh('unknown'),clientId:CHAT,resource:RESOURCE},true);
        assert.equal((await db.query('select count(*)::int as n from bjm_office_gateway.grants where refresh_expires_at<=now()')).rows[0].n,1);
        assert.equal((await db.query('select count(*)::int as n from auth.sessions')).rows[0].n,liveOwnerSessions);
      });
    });
    await t.test('revoke removes only its Office grant family, remains available while disabled and is non-disclosing',async()=>{
      const one=await grant(db),two=await grant(db);
      assert.deepEqual(await dispatch(db,'revoke',{tokenHash:one.access,clientId:'wrong'}),{revoked:true});assert.ok(await verify(db,one.access));
      assert.deepEqual(await dispatch(db,'revoke',{tokenHash:one.refresh,clientId:CHAT}),{revoked:true});
      assert.equal(await verify(db,one.access),null);assert.ok(await verify(db,two.access));
      await rollback(db,async()=>{await db.exec('update bjm_office_gateway.configuration set enabled=false');
        assert.deepEqual(await dispatch(db,'revoke',{tokenHash:two.access,clientId:CHAT},true),{revoked:true});
        assert.equal((await db.query('select count(*)::int as n from bjm_office_gateway.grants where revoked_at is not null')).rows[0].n>0,true);});
      assert.deepEqual(await dispatch(db,'revoke',{tokenHash:fresh('unknown'),clientId:CHAT}),{revoked:true});
    });
    await t.test('unavailable source privilege returns partial null fields rather than zero',async()=>{
      const g=await grant(db);
      await rollback(db,async()=>{await db.exec('revoke select(status,created_at) on public.subscription_payments from bjm_office_chat_aggregate');
        const data=await snapshot(db,g.access,CHAT,RESOURCE,true);
        assert.equal(data.metrics.payments,null);assert.equal(data.billing.payments.recent,null);assert.equal(data.metrics.profiles,2);});
    });
    await t.test('PUBLIC permissions in unreachable schemas stay unchanged; reachable grants stop every gateway call',async()=>{
      const g=await grant(db);
      for(const q of ['select * from cron.job','delete from cron.job_run_details','select * from extensions.pg_stat_statements'])
        await assert.rejects(asRole(db,'bjm_office_gateway_login',q),/permission denied for schema/);
      for(const change of ['grant select on public.profiles to public','grant delete on public.jobs to public',
        'grant select(email) on public.profiles to bjm_office_gateway_login',
        'grant usage on schema cron to bjm_office_gateway_login',
        'grant usage on schema extensions to bjm_office_gateway_login',
        'create function public.unreviewed_write() returns void language sql security definer as $$delete from public.jobs;$$',
        'grant create on schema public to public','grant authenticated to bjm_office_gateway_login']) {
        await rollback(db,async()=>{await db.exec(change);await assert.rejects(verify(db,g.access,true),/Gateway/);await assert.rejects(snapshot(db,g.access,CHAT,RESOURCE,true),/Gateway/);});
      }
    });
    await t.test('numeric-OID sequence bypass is audited even without schema usage',async()=>{
      const g=await grant(db);
      await rollback(db,async()=>{
        await db.exec('create sequence cron.gateway_disposable; grant usage,select,update on sequence cron.gateway_disposable to public');
        const oid=(await db.query("select 'cron.gateway_disposable'::regclass::oid as oid")).rows[0].oid;
        await assert.rejects(asRole(db,'bjm_office_gateway_login',"select nextval('cron.gateway_disposable')",[],true),/permission denied for schema/);
        assert.equal((await asRole(db,'bjm_office_gateway_login',`select nextval(${oid}::oid::regclass) as value`,[],true)).rows[0].value,1);
        await assert.rejects(verify(db,g.access,true),/sequence privileges/);
      });
    });
    await t.test('only exact reviewed immutable caller-input-only PUBLIC helper is allowed',async()=>{
      assert.equal(createHash('md5').update(reviewedHelperBody).digest('hex'),'b9f07ff05df2af5ff6c3552f382a7565');
      await rollback(db,async()=>{
        await db.exec(`alter table public.profiles add column display_name text,add column avatar_url text,add column location text,add column bio text,
          add column skills text[],add column availability text,add column experience text,add column pay_expectation text,add column cafe_name text,
          add column cafe_address text,add column open_hours text,add column shop_type text,add column barista_preferences text[];
          create function public.profile_meets_visibility_requirements(p public.profiles) returns boolean language sql immutable security invoker set search_path='' as $$${reviewedHelperBody}$$;`);
        const g=await grant(db,true);
        assert.equal((await snapshot(db,g.access,CHAT,RESOURCE,true)).metrics.profiles,2);
        await db.exec("create or replace function public.profile_meets_visibility_requirements(p public.profiles) returns boolean language sql immutable security invoker set search_path='' as $$select true;$$");
        await assert.rejects(verify(db,g.access,true),/unreviewed routine/);
      });
    });
    await t.test('trusted view/function/schema grants, definition and owner drift fail before data reads',async()=>{
      const g=await grant(db);
      for(const change of [
        "create or replace view bjm_office_gateway.active_owner with(security_barrier=true,security_invoker=false) as select id as owner_id,'unreviewed'::text as consent_version from auth.users",
        'alter view bjm_office_gateway.active_owner set(security_barrier=false)',
        'grant select(owner_id) on bjm_office_gateway.active_owner to authenticated',
        'grant select on bjm_office_gateway.tokens to bjm_office_gateway_login',
        'grant select(token_hash) on bjm_office_gateway.tokens to authenticated',
        'grant usage on schema bjm_office_gateway to authenticated',
        'grant execute on function bjm_office_gateway.auth_dispatch(text,jsonb) to authenticated',
        'alter function bjm_office_gateway.read_snapshot(text,text,text) owner to postgres',
        "create or replace function bjm_office_gateway.context_valid() returns boolean language plpgsql stable security invoker set search_path='' as $$begin return true; end$$",
        'grant usage on schema auth to bjm_office_chat_aggregate',
        'grant select(id) on auth.users to bjm_office_chat_issuer',
        'alter table bjm_office_gateway.flows add column unexpected text default \'changed\'',
        'alter table bjm_office_gateway.tokens disable row level security',
        'alter table public.jobs add column gateway_family uuid references bjm_office_gateway.grants(id) on delete cascade',
        `create function public.gateway_trigger_fixture() returns trigger language plpgsql security definer as $$begin delete from public.jobs;return new;end$$;
          create trigger gateway_trigger_fixture before insert on bjm_office_gateway.flows for each row execute function public.gateway_trigger_fixture()`])
        await rollback(db,async()=>{await db.exec(change);await assert.rejects(verify(db,g.access,true),/Gateway/);});
    });
    await t.test('missing/changed and restrictive RLS fail instead of fabricating a zero',async()=>{
      const g=await grant(db);
      for(const change of ['drop policy gateway_aggregate_select on public.profiles',
        'alter policy gateway_aggregate_select on public.profiles using(false)',
        'create policy truncate_gateway on public.profiles as restrictive for select to public using(false)'])
        await rollback(db,async()=>{await db.exec(change);await assert.rejects(snapshot(db,g.access,CHAT,RESOURCE,true),/RLS/);});
    });
    await t.test('ordinary customer retains its existing allowed mutations',async()=>{
      await asRole(db,'authenticated','select public.customer_write()');
      assert.equal((await db.query('select count(*)::int as n from public.jobs')).rows[0].n,2);
    });
  } finally { await db.close(); }
});

test('empty config inert install denies issuance and reports without enabling login',async()=>{
  const db=await setup({configure:false});
  try {
    assert.equal(await dispatch(db,'create_flow',{flowHash:fresh('f'),encryptedPayload:'encrypted'}),null);
    assert.equal(await verify(db,fresh('a')),null);
    await assert.rejects(snapshot(db,fresh('a')),/Office access denied/);
  } finally { await db.close(); }
});

async function nonSuperuser(db) {
  await db.exec(fixture);
  await db.exec(`create role migration_runner login createrole noinherit nobypassrls;
    create role migration_auditor;
    grant migration_auditor to migration_runner with set true,inherit false,admin true;
    do $$begin execute format('grant create on database %I to migration_runner',current_database());end$$;
    grant usage,create on schema public to migration_runner with grant option;
    grant usage on schema auth to migration_runner;
    grant select on auth.users,auth.oauth_consents to migration_runner;
    alter table public.profiles owner to migration_runner;alter table public.jobs owner to migration_runner;
    alter table public.applications owner to migration_runner;alter table public.cafe_subscriptions owner to migration_runner;
    alter table public.subscription_payments owner to migration_runner;alter table public.support_tickets owner to migration_runner;
    set session authorization migration_runner;set createrole_self_grant='';`);
}
const memberships=async db=>(await db.query(`select pg_get_userbyid(roleid) as role,pg_get_userbyid(grantor) as grantor,
  admin_option,inherit_option,set_option from pg_auth_members where member='migration_runner'::regrole order by 1,2`)).rows;

test('non-superuser installer needs Auth SELECT but no delegation authority, restores temporary SET and stays inert',async()=>{
  const db=new PGlite();
  try {
    await nonSuperuser(db);const before=await memberships(db);
    assert.equal((await db.query("select has_schema_privilege(current_user,'auth','USAGE WITH GRANT OPTION') as can_delegate")).rows[0].can_delegate,false);
    await db.exec(sql);
    const after=await memberships(db);
    assert.deepEqual(after.filter(x=>x.role==='migration_auditor'),before);
    for(const role of ['bjm_office_chat_issuer','bjm_office_chat_aggregate'])
      assert.equal((await db.query('select pg_has_role(current_user,$1,\'SET\') as can_set',[role])).rows[0].can_set,false);
    assert.equal((await db.query('select count(*)::int as n from bjm_office_gateway.configuration')).rows[0].n,0);
  } finally { await db.close(); }
});

test('installer preserves preexisting same-grantor relationship instead of revoking legitimate grants',async()=>{
  const db=new PGlite();
  try {
    await nonSuperuser(db);
    const adjusted=sql.replace('-- Preserve each creator-side relationship',
      'grant bjm_office_chat_issuer,bjm_office_chat_aggregate to current_user with set false,inherit true,admin false granted by current_user;\n-- Preserve each creator-side relationship');
    await db.exec(adjusted);
    assert.deepEqual((await memberships(db)).filter(x=>x.grantor==='migration_runner'&&x.role.startsWith('bjm_office_chat_')),
      ['bjm_office_chat_aggregate','bjm_office_chat_issuer'].map(role=>({role,grantor:'migration_runner',admin_option:false,inherit_option:true,set_option:false})));
  } finally { await db.close(); }
});

test('failed PUBLIC grant or missing Auth read preflight atomically rolls back roles/state/membership',async()=>{
  for(const change of ['create function public.unreviewed_gateway_fixture() returns int language sql as $$select 1;$$',
    'grant delete on public.jobs to public',
    'set session authorization postgres; revoke select on auth.oauth_consents from migration_runner; set session authorization migration_runner']) {
    const db=new PGlite();
    try {
      await nonSuperuser(db);await db.exec(change);const before=await memberships(db);
      await assert.rejects(db.exec(sql),/Gateway/);await db.exec('rollback');
      assert.equal((await db.query("select count(*)::int as n from pg_roles where rolname in('bjm_office_gateway_login','bjm_office_chat_issuer','bjm_office_chat_aggregate')")).rows[0].n,0);
      assert.equal((await db.query("select count(*)::int as n from pg_namespace where nspname='bjm_office_gateway'")).rows[0].n,0);
      assert.deepEqual(await memberships(db),before);
    } finally { await db.close(); }
  }
});

test('activation templates deliberately abort unrendered; synthetic sequential setup, enable and rollback preserve customer/legacy state',async()=>{
  const db=await setup({configure:false,legacy:true});
  try {
    await assert.rejects(db.exec(activationSql),/REVIEW_ONLY_PHASE_A/);await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int as n from bjm_office_gateway.configuration')).rows[0].n,0);
    await db.exec(`create type auth.oauth_client_type as enum('public','confidential');
      create type auth.oauth_registration_type as enum('manual','dynamic');
      create table auth.oauth_clients(id uuid,deleted_at timestamptz,client_type auth.oauth_client_type,registration_type auth.oauth_registration_type,token_endpoint_auth_method text,
      client_secret_hash text,client_name text,redirect_uris text,grant_types text);
      insert into auth.oauth_clients values('${UPSTREAM}',null,'public','manual','none','','BaristaMatch AI Office Identity','https://office.example/oauth/owner/callback','authorization_code');`);
    // Deliberately synthetic non-network fixture; no genuine credential is
    // created or retrieved. PostgreSQL accepts pre-hashed SCRAM text as-is.
    const verifier=`SCRAM-SHA-256$4096:${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}:${Buffer.alloc(32).toString('base64')}`;
    const values={'__VERIFIED_OWNER_UUID__':OWNER,'__VERIFIED_NEW_UPSTREAM_CLIENT_UUID__':UPSTREAM,
      '__VERIFIED_PREREGISTERED_CHAT_CLIENT_ID__':CHAT,'__EXACT_CHATGPT_CALLBACK__':REDIRECT,
      '__EXACT_APPROVED_OFFICE_HTTPS_ORIGIN__':'https://office.example','__PRIVATE_SCRAM_SHA_256_VERIFIER__':verifier};
    let rendered=activationSql.replace(/^do \$\$ begin raise exception 'REVIEW_ONLY_PHASE_[AB]:[^\n]*\n/gm,'');
    for(const [key,value] of Object.entries(values)) rendered=rendered.replaceAll(key,value);
    const [phaseA,phaseB]=rendered.split('-- PHASE B:');
    for(const malformed of [phaseA.replaceAll(UPSTREAM,CLIENT),phaseA.replaceAll(REDIRECT,'https://evil.example/cb')]) {
      await assert.rejects(db.exec(malformed),/identity client|check constraint/);await db.exec('rollback');
      assert.equal((await db.query('select count(*)::int as n from bjm_office_gateway.configuration')).rows[0].n,0);
      assert.equal((await db.query("select rolcanlogin from pg_roles where rolname='bjm_office_gateway_login'")).rows[0].rolcanlogin,false);
    }
    await db.exec("update auth.oauth_clients set redirect_uris='https://wrong.example/oauth/owner/callback'");
    await assert.rejects(db.exec(phaseA),/exact new public identity client/);await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int as n from bjm_office_gateway.configuration')).rows[0].n,0);
    await db.exec("update auth.oauth_clients set redirect_uris='https://office.example/oauth/owner/callback'");
    await db.exec(phaseA);
    assert.equal((await db.query('select enabled from bjm_office_gateway.configuration')).rows[0].enabled,false);
    const role=(await db.query("select rolcanlogin,rolconnlimit,rolconfig from pg_roles where rolname='bjm_office_gateway_login'")).rows[0];
    assert.equal(role.rolcanlogin,true);assert.equal(role.rolconnlimit,3);
    for(const config of ['statement_timeout=5s','lock_timeout=1s','idle_in_transaction_session_timeout=15s']) assert.ok(role.rolconfig.includes(config));
    assert.equal(await verify(db,fresh('disabled')),null);
    for(const mismatched of [phaseB.replaceAll(CHAT,'another-chat-client'),phaseB.replaceAll(REDIRECT,'https://chatgpt.com/connector_platform_oauth_redirect')]) {
      await assert.rejects(db.exec('-- PHASE B:'+mismatched),/Exact disabled gateway mapping/);await db.exec('rollback');
      assert.equal((await db.query('select enabled from bjm_office_gateway.configuration')).rows[0].enabled,false);
    }
    await db.exec('-- PHASE B:'+phaseB);
    const g=await grant(db);assert.ok(await verify(db,g.access));
    await assert.rejects(db.exec(rollbackSql),/REVIEW_ONLY_ROLLBACK/);await db.exec('rollback');
    assert.ok(await verify(db,g.access));
    await db.exec(rollbackSql.replace(/^do \$\$ begin raise exception 'REVIEW_ONLY_ROLLBACK:[^\n]*\n/gm,''));
    assert.equal(await verify(db,g.access),null);await assert.rejects(snapshot(db,g.access),/Office access denied/);
    assert.equal((await db.query("select rolcanlogin from pg_roles where rolname='bjm_office_gateway_login'")).rows[0].rolcanlogin,false);
    assert.equal((await db.query('select count(*)::int as n from auth.sessions')).rows[0].n,3);
    assert.equal((await db.query('select count(*)::int as n from bjm_office_private.configuration')).rows[0].n,0);
  } finally { await db.close(); }
});
