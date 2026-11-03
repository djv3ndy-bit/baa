import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const foundation = readFileSync(new URL('../../supabase/migrations/20261103061704_member_content_moderation_foundation.sql', import.meta.url), 'utf8');
const activation = readFileSync(new URL('../../review/HELD-20261103061904_reviewed_media_publication_activation.sql', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./moderation-fixture.sql', import.meta.url), 'utf8');
const alice='11111111-1111-4111-8111-111111111111', bob='22222222-2222-4222-8222-222222222222', cafe='33333333-3333-4333-8333-333333333333';
const claim='44444444-4444-4444-8444-444444444444';
const q = async (sql, args=[]) => (await db.query(sql,args)).rows;
async function as(role, id, sql, args=[]) {
  await q('BEGIN');
  try { await q(`SET LOCAL ROLE ${role}`); await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[id||'',JSON.stringify({sub:id,is_anonymous:false})]); const rows=await q(sql,args); await q('COMMIT'); return rows; }
  catch(e) { await q('ROLLBACK'); throw e; }
}
async function rpc(name,args=[],id=alice,role='authenticated') {return (await as(role,id,`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS result`,args))[0].result;}
async function reserve(field='avatar_url',id=alice,mime='image/jpeg',size=4) {return rpc('reserve_profile_media_upload',[field,mime,size],id);}
async function upload(intent,id=alice,mime='image/jpeg',size=4) {return as('authenticated',id,"INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES('ugc-media-staging',$1,$2,jsonb_build_object('mimetype',$3::text,'size',$4::bigint)) RETURNING id",[intent.object_path,id,mime,size]);}
async function submit(intent,id=alice,field='avatar_url') {return rpc('submit_profile_media_review',[field,intent.object_path],id);}
async function pending(id=alice,field='avatar_url') {const i=await reserve(field,id,field==='video_path'?'video/mp4':'image/jpeg',4);await upload(i,id,field==='video_path'?'video/mp4':'image/jpeg');return {i,r:await submit(i,id,field)};}
async function approve(r) {return q("SELECT private.review_profile_media($1,'approved')",[r.request_id]);}
async function activate() {await q('BEGIN');try{await q(activation);await q('COMMIT');}catch(e){await q('ROLLBACK');throw e;}}
async function resetBase(){
  await q('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS private CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS storage CASCADE;');
  await q(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END$$;`);
  await q(fixture);
}
async function applyFoundation(){
  await q('BEGIN');try {await q(foundation);await q('COMMIT');}catch(e){await q('ROLLBACK');throw e;}
}
beforeEach(async()=>{
  await resetBase();await applyFoundation();
  await q('INSERT INTO auth.users VALUES($1),($2),($3)',[alice,bob,cafe]);
  await q("INSERT INTO public.profiles(id,role,display_name,avatar_url) VALUES($1,'barista','Alice','https://existing.example/approved.jpg'),($2,'barista','Bob',NULL),($3,'cafe_owner_manager','Cafe',NULL)",[alice,bob,cafe]);
});
after(()=>db.end());

test('foundation keeps legacy buckets and media writes working; private table ACLs fail closed',async()=>{
  assert.equal((await q("SELECT has_schema_privilege('service_role','private','USAGE') ok"))[0].ok,false);
  assert.equal((await q("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosqlbody IS NOT NULL AND NOT p.prosecdef AND p.proname IN('claim_profile_media_publication','finish_profile_media_publication','fail_profile_media_publication','claim_moderation_notices','ack_moderation_notices','moderation_notice_summary','claim_staged_media_cleanup','ack_staged_media_cleanup','begin_profile_media_account_deletion')"))[0].n,9);
  assert.deepEqual(await q('SELECT id,public FROM storage.buckets ORDER BY id'),[{id:'cafe-images',public:true},{id:'coffee-videos',public:false},{id:'ugc-media-staging',public:false}]);
  await as('authenticated',alice,"UPDATE public.profiles SET avatar_url='https://existing.example/new.jpg' WHERE id=$1",[alice]);
  await as('authenticated',alice,"INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES('cafe-images',$1,$2)",[alice+'/legacy.jpg',alice]);
  for(const role of ['anon','authenticated','service_role']) await assert.rejects(as(role,alice,'SELECT * FROM private.profile_media_reviews'),/permission denied/);
});
test('profile and job text filter handles normalized evasion, arrays, unchanged legacy text and reactivation',async()=>{
  await assert.rejects(as('authenticated',alice,"UPDATE public.profiles SET bio='k1ll you' WHERE id=$1",[alice]),/ugc_content_not_allowed/);
  await assert.rejects(as('authenticated',alice,"UPDATE public.profiles SET skills=ARRAY['normal','r.a.p.e'] WHERE id=$1",[alice]),/ugc_content_not_allowed/);
  await as('authenticated',alice,"UPDATE public.profiles SET bio='grape coffee and inclusive team' WHERE id=$1",[alice]);
  await assert.rejects(as('authenticated',cafe,"INSERT INTO public.jobs(owner_id,title,location,description) VALUES($1,'normal','Miami','kill you')",[cafe]),/ugc_content_not_allowed/);
  await q('ALTER TABLE public.jobs DISABLE TRIGGER ugc_job_text_filter');
  const [{id}]=await q("INSERT INTO public.jobs(owner_id,title,location,description,active) VALUES($1,'old','Miami','kill you',false) RETURNING id",[cafe]);
  await q('ALTER TABLE public.jobs ENABLE TRIGGER ugc_job_text_filter');
  await as('authenticated',cafe,'UPDATE public.jobs SET updated_at=now() WHERE id=$1',[id]);
  await assert.rejects(as('authenticated',cafe,'UPDATE public.jobs SET active=true WHERE id=$1',[id]),/ugc_content_not_allowed/);
});
test('reservation enforces roles, MIME, size, fixed ownership, expiry and budgets',async()=>{
  await assert.rejects(reserve('bar_picture_url'),/ugc_invalid_media/);
  await assert.rejects(reserve('video_path',cafe,'video/mp4'),/ugc_invalid_media/);
  await assert.rejects(reserve('avatar_url',alice,'image/svg+xml'),/ugc_invalid_media/);
  await assert.rejects(reserve('avatar_url',alice,'image/jpeg',5242881),/ugc_invalid_media/);
  await assert.rejects(as('anon',null,'SELECT public.reserve_profile_media_upload(\'avatar_url\',\'image/jpeg\',4)'),/permission denied/);
  const i=await reserve();assert.equal(i.object_path,alice+'/'+i.upload_id+'.jpg');
  await assert.rejects(upload(i,bob),/row-level security/);
  await assert.rejects(upload(i,alice,'image/png'),/row-level security/);
  await q("UPDATE private.profile_media_upload_intents SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE id=$1",[i.upload_id]);
  await assert.rejects(upload(i),/row-level security/);
  for(let n=0;n<5;n++)await reserve();
  await assert.rejects(reserve(),/ugc_rate_limited/);
});
test('private upload is immutable, cannot cross-own, and submit is exactly idempotent after expiry',async()=>{
  const {i,r}=await pending();assert.equal(r.request_id,i.upload_id);
  await q("UPDATE private.profile_media_upload_intents SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE id=$1",[i.upload_id]);
  assert.deepEqual(await submit(i),r);
  assert.equal((await q('SELECT count(*)::int n FROM private.profile_media_reviews'))[0].n,1);
  assert.equal((await q('SELECT count(*)::int n FROM private.moderation_notice_outbox'))[0].n,1);
  assert.equal((await as('authenticated',bob,"SELECT count(*)::int n FROM storage.objects WHERE bucket_id='ugc-media-staging'"))[0].n,0);
  assert.equal((await as('authenticated',alice,"UPDATE storage.objects SET metadata='{}' WHERE name=$1 RETURNING id",[i.object_path])).length,0);
  assert.equal((await as('authenticated',alice,'DELETE FROM storage.objects WHERE name=$1 RETURNING id',[i.object_path])).length,0);
  await assert.rejects(submit(i,bob),/ugc_invalid_media/);
  assert.equal((await q('SELECT avatar_url FROM public.profiles WHERE id=$1',[alice]))[0].avatar_url,'https://existing.example/approved.jpg');
});
test('cancellation releases one field; own status has latest unique field and no private note/path',async()=>{
  const {r}=await pending();assert.equal(await rpc('cancel_profile_media_review',[r.request_id]),true);assert.equal(await rpc('cancel_profile_media_review',[r.request_id]),true);
  const {r:next}=await pending();const statuses=await rpc('my_profile_media_reviews');assert.equal(statuses.length,1);assert.equal(statuses[0].request_id,next.request_id);assert.equal(statuses[0].can_publish,false);assert(!JSON.stringify(statuses).includes('object_path'));
  await assert.rejects(rpc('cancel_profile_media_review',[next.request_id],bob),/ugc_media_access_denied/);
});
test('owner review only, source integrity and controlled rejection',async()=>{
  const {r,i}=await pending();
  await assert.rejects(as('authenticated',alice,"SELECT private.review_profile_media($1,'approved')",[r.request_id]),/permission denied/);
  await assert.rejects(q("SELECT private.review_profile_media($1,'rejected','free text')",[r.request_id]),/ugc_invalid_review_decision/);
  await q("UPDATE storage.objects SET metadata=metadata||'{\"changed\":true}' WHERE name=$1",[i.object_path]);
  await assert.rejects(approve(r),/ugc_review_asset_changed/);
});
test('held activation blocks unreviewed media and old uploads without changing buckets or old URLs',async()=>{
  await activate();
  await assert.rejects(as('authenticated',alice,"UPDATE public.profiles SET avatar_url='https://bad.example/unreviewed.jpg' WHERE id=$1",[alice]),/ugc_reviewed_media_required/);
  await assert.rejects(as('authenticated',alice,"INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES('cafe-images',$1,$2)",[alice+'/legacy.jpg',alice]),/row-level security/);
  await as('authenticated',alice,'UPDATE public.profiles SET avatar_url=avatar_url WHERE id=$1',[alice]);
  assert.equal((await q('SELECT avatar_url FROM public.profiles WHERE id=$1',[alice]))[0].avatar_url,'https://existing.example/approved.jpg');
  await as('authenticated',alice,'UPDATE public.profiles SET avatar_url=NULL WHERE id=$1',[alice]);
});
test('publication service claim, exact CAS, immutable destination, lease recovery and idempotent finish',async()=>{
  const {r}=await pending();await approve(r);
  await assert.rejects(rpc('claim_profile_media_publication',[alice,r.request_id,claim],alice,'service_role'),/ugc_publication_unavailable/);
  await activate();
  await assert.rejects(rpc('claim_profile_media_publication',[alice,r.request_id,claim]),/permission denied/);
  const c=await rpc('claim_profile_media_publication',[alice,r.request_id,claim],alice,'service_role');assert.equal(c.status,'claimed');
  assert.equal((await rpc('claim_profile_media_publication',[alice,r.request_id,bob],alice,'service_role')).status,'publishing');
  await q("UPDATE private.profile_media_reviews SET claim_expires_at=now()-interval '1 second' WHERE id=$1",[r.request_id]);
  assert.equal((await rpc('my_profile_media_reviews'))[0].can_publish,true);
  await rpc('claim_profile_media_publication',[alice,r.request_id,bob],alice,'service_role');
  await q("INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES($1,$2,$3,'{\"mimetype\":\"image/jpeg\",\"size\":4}')",[c.targetBucket,c.targetPath,alice]);
  const result=await rpc('finish_profile_media_publication',[alice,r.request_id,bob,'a'.repeat(64)],alice,'service_role');assert.equal(result.status,'published');
  assert.deepEqual(await rpc('finish_profile_media_publication',[alice,r.request_id,bob,'a'.repeat(64)],alice,'service_role'),result);
  assert.equal((await q('SELECT avatar_url FROM public.profiles WHERE id=$1',[alice]))[0].avatar_url,result.value);
  assert.equal(await rpc('fail_profile_media_publication',[alice,r.request_id,bob,false],alice,'service_role'),false);
});
test('later owner removal prevents approved publication from overwriting profile; suspended owner denied',async()=>{
  const {r}=await pending();await approve(r);await activate();
  await as('authenticated',alice,'UPDATE public.profiles SET avatar_url=NULL WHERE id=$1',[alice]);
  await assert.rejects(rpc('claim_profile_media_publication',[alice,r.request_id,claim],alice,'service_role'),/ugc_profile_changed/);
  await q('UPDATE public.profiles SET suspended_at=now() WHERE id=$1',[alice]);
  await assert.rejects(reserve(),/ugc_media_access_denied/);
});
test('report trigger preserves wire shape, creates private24h queue, bounds duplicates and hides reports',async()=>{
  await as('authenticated',alice,"INSERT INTO public.user_reports(reporter_id,reported_id,reason,details) VALUES($1,$2,'harassment','test')",[alice,bob]);
  await assert.rejects(as('authenticated',alice,"INSERT INTO public.user_reports(reporter_id,reported_id,reason) VALUES($1,$2,'harassment')",[alice,bob]),/ugc_report_already_received/);
  await assert.rejects(as('authenticated',bob,'SELECT * FROM public.user_reports'),/permission denied/);
  assert.equal((await q("SELECT count(*)::int n FROM private.member_report_reviews WHERE status='new' AND due_at>now()+interval '23 hours'"))[0].n,1);
  const [{report_id}]=await q('SELECT report_id FROM private.member_report_reviews');
  await assert.rejects(as('authenticated',alice,"SELECT private.triage_member_report($1,'resolved','done')",[report_id]),/permission denied/);
  await q("SELECT private.triage_member_report($1,'resolved','owner tested')",[report_id]);
  assert((await q('SELECT cancelled_at FROM private.moderation_notice_outbox'))[0].cancelled_at);
});
test('notice group is immutable across triage/retry and one new digest per hour; partial ACK rejected',async()=>{
  const {r}=await pending();
  await as('authenticated',bob,"INSERT INTO public.user_reports(reporter_id,reported_id,reason) VALUES($1,$2,'spam_or_scam')",[bob,alice]);
  const g=await rpc('claim_moderation_notices',[claim,25],null,'service_role');assert.equal(g.items.length,2);
  await approve(r);assert.deepEqual(await rpc('claim_moderation_notices',[claim,25],null,'service_role'),g);
  await assert.rejects(rpc('ack_moderation_notices',[claim,[g.items[0].noticeId],true],null,'service_role'),/ugc_invalid_notice_ack/);
  assert.equal(await rpc('ack_moderation_notices',[claim,g.items.map(x=>x.noticeId),false],null,'service_role'),2);
  const retry=await rpc('claim_moderation_notices',[bob,25],null,'service_role');assert.equal(retry.deliveryId,g.deliveryId);assert.deepEqual(retry.items,g.items);assert.equal(retry.firstAttemptAt,g.firstAttemptAt);
  assert.equal(await rpc('ack_moderation_notices',[bob,g.items.map(x=>x.noticeId),true],null,'service_role'),2);
  await pending(cafe);
  assert.deepEqual(await rpc('claim_moderation_notices',[claim,25],null,'service_role'),{claimId:claim,items:[],needsAttentionCount:0});
});
test('expired notice lease reclaims same group; after23h stops automatic resend',async()=>{
  await pending();const g=await rpc('claim_moderation_notices',[claim,25],null,'service_role');
  await q("UPDATE private.moderation_notice_deliveries SET claim_expires_at=now()-interval '1 second' WHERE id=$1",[g.deliveryId]);
  const retry=await rpc('claim_moderation_notices',[bob,25],null,'service_role');assert.equal(retry.deliveryId,g.deliveryId);
  await q("UPDATE private.moderation_notice_deliveries SET first_attempt_at=now()-interval '23 hours 1 second',claim_expires_at=now()-interval '1 second' WHERE id=$1",[g.deliveryId]);
  assert.deepEqual(await rpc('claim_moderation_notices',[claim,25],null,'service_role'),{claimId:claim,items:[],needsAttentionCount:1});
  assert.equal((await q('SELECT status FROM private.moderation_notice_deliveries'))[0].status,'needs_attention');
});
test('profile deletion cascades private intents/reviews and retained notice payloads contain no personal content',async()=>{
  const {r}=await pending();const g=await rpc('claim_moderation_notices',[claim,25],null,'service_role');await q('DELETE FROM auth.users WHERE id=$1',[alice]);
  assert.equal((await q('SELECT count(*)::int n FROM private.profile_media_reviews'))[0].n,0);
  assert.equal((await q('SELECT count(*)::int n FROM private.profile_media_upload_intents'))[0].n,0);
  const retry=await rpc('claim_moderation_notices',[claim,25],null,'service_role');assert.deepEqual(retry,g);assert(!JSON.stringify(retry).includes(r.request_id));
});

test('legacy report backfill preserves raw rows, clearly marks legacy and aborts volume surprise atomically',async()=>{
  await resetBase();await q('INSERT INTO auth.users VALUES($1),($2)',[alice,bob]);
  await q("INSERT INTO public.user_reports(reporter_id,reported_id,reason,details,created_at) VALUES($1,$2,'harassment','synthetic legacy',now()-interval '30 days')",[alice,bob]);
  const before=await q('SELECT md5(to_jsonb(r)::text) hash FROM public.user_reports r');
  await applyFoundation();assert.deepEqual(await q('SELECT md5(to_jsonb(r)::text) hash FROM public.user_reports r'),before);
  assert.equal((await q("SELECT count(*)::int n FROM private.member_report_reviews WHERE legacy_intake AND due_at>now()+interval '23 hours'"))[0].n,1);
  await resetBase();await q('INSERT INTO auth.users VALUES($1),($2)',[alice,bob]);
  await q("INSERT INTO public.user_reports(reporter_id,reported_id,reason) SELECT $1,$2,'harassment' FROM generate_series(1,26)",[alice,bob]);
  await assert.rejects(applyFoundation(),/ugc_legacy_report_volume_requires_review/);
  assert.equal((await q("SELECT to_regclass('private.profile_media_reviews') exists"))[0].exists,null);
  assert.equal((await q('SELECT count(*)::int n FROM storage.buckets'))[0].n,2);
});
test('outstanding reservations enforce100MiB cap without deleting staged media or resetting records',async()=>{
  await reserve('video_path',alice,'video/mp4',52428800);await reserve('video_path',alice,'video/mp4',52428800);
  await assert.rejects(reserve(),/ugc_staging_quota_reached/);
  assert.equal((await q('SELECT count(*)::int n FROM private.profile_media_upload_intents'))[0].n,2);
});
test('per-reporter budget is bounded and suspended/anonymous members cannot enqueue',async()=>{
  for(let i=0;i<5;i++)await as('authenticated',alice,"INSERT INTO public.user_reports(reporter_id,reported_id,reason,conversation_id,conversation_kind) VALUES($1,$2,'harassment',$3,'discovery')",[alice,bob,'synthetic-'+i]);
  await assert.rejects(as('authenticated',alice,"INSERT INTO public.user_reports(reporter_id,reported_id,reason,conversation_id) VALUES($1,$2,'harassment','sixth')",[alice,bob]),/ugc_rate_limited/);
  await q('UPDATE public.profiles SET suspended_at=now() WHERE id=$1',[bob]);
  await assert.rejects(as('authenticated',bob,"INSERT INTO public.user_reports(reporter_id,reported_id,reason) VALUES($1,$2,'harassment')",[bob,alice]),/ugc_media_access_denied/);
  await q('BEGIN');await q('SET LOCAL ROLE authenticated');await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims','{\"is_anonymous\":true}',true)",[alice]);
  await assert.rejects(q("SELECT public.reserve_profile_media_upload('avatar_url','image/jpeg',4)"),/ugc_media_access_denied/);await q('ROLLBACK');
});
test('non-READ-COMMITTED calls reject stale snapshots for intake/publication/notices',async()=>{
  await q('BEGIN ISOLATION LEVEL REPEATABLE READ');await q('SET LOCAL ROLE authenticated');await q("SELECT set_config('request.jwt.claim.sub',$1,true)",[alice]);
  await assert.rejects(q("SELECT public.reserve_profile_media_upload('avatar_url','image/jpeg',4)"),/ugc_media_access_denied/);await q('ROLLBACK');
  await q('BEGIN ISOLATION LEVEL REPEATABLE READ');await q('SET LOCAL ROLE service_role');
  await assert.rejects(q('SELECT public.claim_moderation_notices($1,25)',[claim]),/ugc_invalid_notice_claim/);await q('ROLLBACK');
});
async function authenticatedConnection(id){const c=new Client(connectionConfig);await c.connect();await c.query('SET ROLE authenticated');await c.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims','{}',false)",[id]);return c;}
async function observedLock(connection){const pid=connection.processID;for(let n=0;n<100;n++){if((await q("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid]))[0]?.wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,5));}assert.fail('waiter never reached actual lock');}
test('real two-session suspension race rechecks active profile after row-lock wait',async()=>{
  const c=await authenticatedConnection(alice);
  try{await q('BEGIN');await q('UPDATE public.profiles SET suspended_at=now() WHERE id=$1',[alice]);
    const waiting=c.query("SELECT public.reserve_profile_media_upload('avatar_url','image/jpeg',4)");const outcome=waiting.then(()=>({ok:true}),e=>({error:e}));
    await observedLock(c);await q('COMMIT');assert.match((await outcome).error.message,/ugc_media_access_denied/);
    assert.equal((await q('SELECT count(*)::int n FROM private.profile_media_upload_intents'))[0].n,0);
  }finally{await q('ROLLBACK');await c.end();}
});
test('real concurrent reservations serialize the sixth/seventh intake without exceeding budget',async()=>{
  for(let n=0;n<5;n++)await reserve();const a=await authenticatedConnection(alice),b=await authenticatedConnection(alice);
  try{await q('BEGIN');await q("SELECT pg_advisory_xact_lock(hashtextextended('ugc-media:'||$1,0))",[alice]);
    const outcomes=[a,b].map(c=>c.query("SELECT public.reserve_profile_media_upload('avatar_url','image/jpeg',4)").then(()=>({ok:true}),e=>({error:e})));
    await observedLock(a);await observedLock(b);await q('COMMIT');const results=await Promise.all(outcomes);assert.equal(results.filter(x=>x.ok).length,1);assert.match(results.find(x=>x.error).error.message,/ugc_rate_limited/);
    assert.equal((await q('SELECT count(*)::int n FROM private.profile_media_upload_intents'))[0].n,6);
  }finally{await q('ROLLBACK');await a.end();await b.end();}
});

test('text filter rejects obvious sexual solicitation/obscenity and Unicode evasion without name/demographic substrings',async()=>{
  for(const text of ['ＦＵＣＫ','f.u.c.k','send nudes','blowjob','p0rn','sh00t you','n.i.g.g.e.r','k-i-l-l u'])assert.equal((await q('SELECT private.ugc_text_is_allowed($1) ok',[text]))[0].ok,false,text);
  for(const text of ['Hancock','Scunthorpe','grape espresso','inclusive LGBTQ+ café','Black and Jewish baristas welcome','sexual harassment is prohibited','Kike Café','Nude Espresso'])assert.equal((await q('SELECT private.ugc_text_is_allowed($1) ok',[text]))[0].ok,true,text);
});
test('global physical staging bytes include abandoned expired objects; expiry does not release real byte quota',async()=>{
  await q("INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES('ugc-media-staging',$1,$2,jsonb_build_object('mimetype','video/mp4','size',1073741824))",[bob+'/old-physical.mp4',bob]);
  await assert.rejects(reserve(),/ugc_staging_quota_reached/);
  assert.equal((await q("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='ugc-media-staging'"))[0].n,1);
});
test('staging cleanup claims only expired unsubmitted or7-day terminal assets, never pending/approved/publishing or legacy',async()=>{
  const old=await reserve();await upload(old);
  await q("UPDATE private.profile_media_upload_intents SET created_at=now()-interval '2 days 10 minutes',expires_at=now()-interval '2 days' WHERE id=$1",[old.upload_id]);
  const {r}=await pending(bob);await approve(r);
  const cancel=await pending(cafe);await rpc('cancel_profile_media_review',[cancel.r.request_id],cafe);
  await q("UPDATE private.profile_media_reviews SET terminal_at=now()-interval '8 days' WHERE id=$1",[cancel.r.request_id]);
  await q("INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES('cafe-images',$1,$2)",[alice+'/old-legacy.jpg',alice]);
  await assert.rejects(rpc('claim_staged_media_cleanup',[claim,25]),/permission denied/);
  const batch=await rpc('claim_staged_media_cleanup',[claim,25],null,'service_role');assert.equal(batch.items.length,2);assert.deepEqual(new Set(batch.items.map(x=>x.uploadId)),new Set([old.upload_id,cancel.r.request_id]));
  assert.deepEqual(await rpc('claim_staged_media_cleanup',[claim,25],null,'service_role'),batch);
  assert.equal(await rpc('ack_staged_media_cleanup',[claim,batch.items.map(x=>x.uploadId),true],null,'service_role'),0,'HTTP acknowledgement alone cannot mark physically present metadata deleted');
  assert.equal((await q('SELECT count(*)::int n FROM private.profile_media_upload_intents WHERE staged_deleted_at IS NOT NULL'))[0].n,0);
  await q("DELETE FROM storage.objects WHERE bucket_id='ugc-media-staging' AND name=ANY($1)",[batch.items.map(x=>x.objectPath)]);
  assert.equal(await rpc('ack_staged_media_cleanup',[claim,batch.items.map(x=>x.uploadId),true],null,'service_role'),2);
  assert.equal((await q('SELECT count(*)::int n FROM private.profile_media_upload_intents WHERE staged_deleted_at IS NOT NULL'))[0].n,2);
  assert.equal((await q("SELECT status FROM private.profile_media_reviews WHERE id=$1",[r.request_id]))[0].status,'approved');
});
test('deletion marker is service-only, idempotent, survives profile-only deletion and blocks new media',async()=>{
  await assert.rejects(rpc('begin_profile_media_account_deletion',[alice]),/permission denied/);
  assert.equal(await rpc('begin_profile_media_account_deletion',[alice],null,'service_role'),true);
  assert.equal(await rpc('begin_profile_media_account_deletion',[alice],null,'service_role'),true);
  await assert.rejects(reserve(),/ugc_media_access_denied/);
  await q('DELETE FROM public.profiles WHERE id=$1',[alice]);
  assert.equal((await q('SELECT count(*)::int n FROM private.profile_media_owner_lifecycle WHERE owner_id=$1',[alice]))[0].n,1);
  await assert.rejects(q("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('cafe-images',$1,'{}')",[alice+'/late-legacy.jpg']),/ugc_media_access_denied/);
  await q('DELETE FROM auth.users WHERE id=$1',[alice]);
  assert.equal((await q('SELECT count(*)::int n FROM private.profile_media_owner_lifecycle WHERE owner_id=$1',[alice]))[0].n,0);
});
async function serviceConnection(){const c=await authenticatedConnection(alice);await c.query('SET ROLE service_role');return c;}
async function preparedCopy(){const {r}=await pending();await approve(r);await activate();return rpc('claim_profile_media_publication',[alice,r.request_id,claim],null,'service_role');}
test('real publication/deletion race: committed target metadata precedes deletion freeze and is included in purge',async()=>{
  const copy=await preparedCopy(),p=await serviceConnection(),d=await serviceConnection();
  try{await p.query('BEGIN');await p.query("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,'{\"mimetype\":\"image/jpeg\",\"size\":4}')",[copy.targetBucket,copy.targetPath]);
    const waiting=d.query('SELECT public.begin_profile_media_account_deletion($1)',[alice]);const result=waiting.then(()=>({ok:true}),e=>({error:e}));await observedLock(d);await p.query('COMMIT');assert.equal((await result).ok,true);
    assert.equal((await q('SELECT count(*)::int n FROM storage.objects WHERE name=$1',[copy.targetPath]))[0].n,1);
    await q("DELETE FROM storage.objects WHERE bucket_id IN('cafe-images','coffee-videos','ugc-media-staging') AND split_part(name,'/',1)=$1",[alice]);await q('DELETE FROM auth.users WHERE id=$1',[alice]);
    await assert.rejects(p.query("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,'{\"mimetype\":\"image/jpeg\",\"size\":4}')",[copy.targetBucket,copy.targetPath]),/ugc_media_access_denied/);
    assert.equal((await q('SELECT count(*)::int n FROM storage.objects WHERE name=$1',[copy.targetPath]))[0].n,0);
  }finally{await p.query('ROLLBACK');await d.query('ROLLBACK');await p.end();await d.end();}
});
test('real publication/deletion race: in-flight late target waits then rejects after marker commit',async()=>{
  const copy=await preparedCopy(),p=await serviceConnection(),d=await serviceConnection();
  try{await d.query('BEGIN');await d.query('SELECT public.begin_profile_media_account_deletion($1)',[alice]);
    const waiting=p.query("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,'{\"mimetype\":\"image/jpeg\",\"size\":4}')",[copy.targetBucket,copy.targetPath]);const result=waiting.then(()=>({ok:true}),e=>({error:e}));await observedLock(p);await d.query('COMMIT');assert.match((await result).error.message,/ugc_media_access_denied/);
    assert.equal((await q('SELECT count(*)::int n FROM storage.objects WHERE name=$1',[copy.targetPath]))[0].n,0);
  }finally{await p.query('ROLLBACK');await d.query('ROLLBACK');await p.end();await d.end();}
});
test('members cannot exploit a live service publication lease to upload unreviewed bytes to its target',async()=>{
  const copy=await preparedCopy();await q('DROP POLICY "Published media requires approved service copy" ON storage.objects');
  await assert.rejects(as('authenticated',alice,"INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES($1,$2,$3,'{\"mimetype\":\"image/jpeg\",\"size\":4}')",[copy.targetBucket,copy.targetPath,alice]),/ugc_media_access_denied/);
});
test('full owner/field/history index supports owner FK deletion and latest-per-field status across every state',async()=>{
  const [index]=await q("SELECT i.indisvalid,i.indisready,i.indpred IS NULL full_index,i.indoption::smallint[] options,ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,true) FROM generate_series(1,i.indnkeyatts)n) keys FROM pg_index i WHERE i.indexrelid='private.profile_media_reviews_owner_field_submitted_idx'::regclass");
  assert.deepEqual(index,{indisvalid:true,indisready:true,full_index:true,options:[0,0,3,3],keys:['owner_id','field','submitted_at','id']});
  const {r}=await pending();await rpc('cancel_profile_media_review',[r.request_id]);await pending();
  assert.equal((await rpc('my_profile_media_reviews')).length,1);
});
test('real notice-lock wait refreshes immutable firstAttempt after a newly committed notice exists',async()=>{
  const c=await serviceConnection();
  try{await q('BEGIN');await q("SELECT pg_advisory_xact_lock(hashtextextended('ugc-notice-delivery',0))");
    const waiting=c.query('SELECT public.claim_moderation_notices($1,25) result',[claim]);const outcome=waiting.then(x=>({rows:x.rows}),e=>({error:e}));await observedLock(c);
    await new Promise(r=>setTimeout(r,1100));
    await q("INSERT INTO private.moderation_notice_outbox(event_type,item_id,due_at) VALUES('media_pending',$1,clock_timestamp()+interval '24 hours')",[claim]);await q('COMMIT');
    const done=await outcome;assert(!done.error);const batch=done.rows[0].result;assert.equal(batch.items.length,1);assert(Date.parse(batch.firstAttemptAt)>=Date.parse(batch.items[0].createdAt));
  }finally{await q('ROLLBACK');await c.end();}
});
