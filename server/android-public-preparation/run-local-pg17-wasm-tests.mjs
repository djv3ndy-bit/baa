// Local synthetic single-backend acceptance only. No hosted connections.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--runtime-root', 'EXPLICIT_LOCAL_RUNTIME_REQUIRED');
const runtimeRoot = path.resolve(args[1]);
assert(runtimeRoot.startsWith('/private/tmp/baristamatch-pg17-wasm-'), 'UNEXPECTED_RUNTIME_LOCATION');
const packageInfo = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package/package.json'), 'utf8'));
assert.equal(packageInfo.name, '@electric-sql/pglite');
assert.equal(packageInfo.version, '0.3.7');
const download = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'download-verification.json'), 'utf8'));
assert.equal(download.registryIntegrityVerified, true);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
assert.equal(sha256(fs.readFileSync(path.join(runtimeRoot, 'pglite-0.3.7.tgz'))), '5939f21eb5f44cabe729ea159ab8b741d3ed2b9d4cb14e630dd3f0cef0bc5108');
// Node loads the approved runtime/WASM from local files. Any unexpected fetch
// aborts; this test helper has no API URL, service client, password or token.
globalThis.fetch = async () => { throw new Error('NETWORK_DISABLED_FOR_LOCAL_TESTS'); };
const { PGlite } = await import(pathToFileURL(path.join(runtimeRoot, 'package/dist/index.js')).href);
const proposal = fs.readFileSync(path.join(root, 'proposed-production-billing-fcm.sql'), 'utf8');
const expectedSqlHash = 'c2101c477ed064daebec4ba2a4ea39a00ab3459c6801c87f97b3e13696439716';
assert.equal(sha256(proposal), expectedSqlHash, 'APPROVED_SQL_CHANGED');
const fixture = fs.readFileSync(path.join(root, 'local-pg17-fixtures.sql'), 'utf8');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'local-pg17-wasm-cases.json'), 'utf8'));
const nativePlan = JSON.parse(fs.readFileSync(path.join(root, 'local-pg17-test-report.json'), 'utf8'));
const validation = fs.readFileSync(path.join(root, 'validation.sql'), 'utf8');
const manifest = '-- 2. Preservation manifest:' + validation.split('-- 2. Preservation manifest:')[1].split('-- 3. New-object')[0];
const names = [...plan.cases.map(x => x.name), ...plan.guards.map(x => x.name),
  'existing-object-preservation', 'validation-query-syntax', 'collision-abort', 'successful-rerun-aborts'];
assert.equal(names.length, 61);
assert.deepEqual([...names].sort(), [...nativePlan.caseNames].sort(), 'NATIVE_PLAN_DIVERGED');
const results = [];
let engine;
let activeCase = 'runtime-major-check';
const report = {
  scope: 'LOCAL SYNTHETIC PG17.5 WASM ONLY; NOT HOSTED MIGRATION PROOF',
  candidateSqlSha256: expectedSqlHash,
  packageVersion: '0.3.7',
  status: 'FAIL', plannedCases: names.length,
  limits: ['Minimal synthetic dependency contracts; checkout stubs do not test existing state-machine internals.',
    'Single exclusive WASM backend; no concurrent lock/race proof.',
    'Not native PostgreSQL17.6, hosted target, managed event trigger, PostgREST or mobile runtime acceptance.'],
};
const snapshot = async db => JSON.stringify((await db.exec(manifest)).map(result => result.rows));
const sqlAssert = condition => `select test_harness.assert(${condition});`;
async function newDatabase() {
  const db = new PGlite();
  try {
    // Only the runtime metadata query precedes this assertion. No fixture or
    // candidate SQL may run on a different engine major.
    const version = (await db.query("select current_setting('server_version') as version,current_setting('server_version_num')::int as version_num,current_user as executor,current_setting('server_encoding') as encoding")).rows[0];
    assert.equal(Math.floor(version.version_num / 10000), 17, 'UNSUPPORTED_ENGINE_MAJOR');
    assert.equal(version.executor, 'postgres');
    assert.equal(version.encoding, 'UTF8');
    engine ??= version;
    await db.exec(fixture);
    return db;
  } catch (error) { await db.close(); throw error; }
}
async function resetSession(db) {
  await db.exec("rollback; reset role; select set_config('request.jwt.claim.sub','',false);");
  const row = (await db.query("select current_user as executor, nullif(current_setting('request.jwt.claim.sub',true),'') as identity")).rows[0];
  assert.equal(row.executor, 'postgres', 'ROLE_LEAK_AFTER_CASE');
  assert.equal(row.identity, null, 'IDENTITY_LEAK_AFTER_CASE');
}
async function expectError(db, sql, expectedCode) {
  let actual;
  try { await db.exec(sql); } catch (error) { actual = error.code; }
  finally { await resetSession(db); }
  assert.equal(actual, expectedCode, 'EXPECTED_SQLSTATE_MISMATCH');
}
try {
  const db = await newDatabase();
  try {
    activeCase = 'existing-object-preservation';
    const before = await snapshot(db);
    await db.exec(proposal);
    assert.equal(await snapshot(db), before);
    results.push({ name: activeCase, status: 'PASS' });
    activeCase = 'validation-query-syntax';
    await db.exec('-- 3. New-object' + validation.split('-- 3. New-object')[1]);
    results.push({ name: activeCase, status: 'PASS' });
    await db.exec(`insert into public.android_device_push_tokens(fcm_token,user_id) values('qa_token_a','${plan.syntheticUserA}'),('qa_token_b','${plan.syntheticUserB}');`);
    for (const test of plan.cases) {
      activeCase = test.name;
      let caught;
      try {
        await db.exec(`begin; set local role ${test.role};`);
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [test.user ?? '']);
        const current = (await db.query("select current_user as executor,r.rolbypassrls,c.relowner::regrole::text as table_owner,row_security_active(c.oid) as rls_applies from pg_roles r cross join pg_class c where r.rolname=current_user and c.oid='public.android_device_push_tokens'::regclass")).rows[0];
        assert.equal(current.executor, test.role, 'TEST_ROLE_NOT_APPLIED');
        if (test.role === 'authenticated') {
          assert.equal(current.rolbypassrls, false, 'RLS_ROLE_BYPASSES_SECURITY');
          assert.notEqual(current.executor, current.table_owner, 'RLS_TEST_RAN_AS_OWNER');
          assert.equal(current.rls_applies, true, 'ROW_SECURITY_NOT_ACTIVE');
        }
        await db.exec(test.sql);
      } catch (error) { caught = error; }
      finally { await resetSession(db); }
      if (test.expected_error) assert.equal(caught?.code, test.expected_error, 'EXPECTED_SQLSTATE_MISMATCH');
      else if (caught) throw caught;
      // All cases roll back, including errors and Auth cascade; no prior test can
      // silently change the next fixture/role/identity.
      await db.exec(sqlAssert('(select count(*)=2 from public.android_device_push_tokens)'));
      results.push({ name: activeCase, status: 'PASS' });
    }
    for (const guard of plan.guards) {
      activeCase = guard.name;
      const isolated = await newDatabase();
      try {
        if (guard.setup) await isolated.exec(guard.setup);
        await expectError(isolated, guard.prefix + proposal, 'P0001');
        await isolated.exec(sqlAssert("to_regclass('public.android_device_push_tokens') is null and to_regprocedure('public.native_checkout_provider(uuid,text,uuid)') is null and to_regprocedure('private.android_device_push_tokens_touch()') is null"));
        results.push({ name: activeCase, status: 'PASS' });
      } finally { await isolated.close(); }
    }
    activeCase = 'collision-abort';
    const collision = await newDatabase();
    try {
      await collision.exec("create function public.native_checkout_provider(uuid,text,uuid) returns text language sql as $$select 'sentinel'::text$$;");
      await expectError(collision, proposal, 'P0001');
      await collision.exec(sqlAssert("public.native_checkout_provider(null,null,null)='sentinel' and to_regclass('public.android_device_push_tokens') is null"));
      results.push({ name: activeCase, status: 'PASS' });
    } finally { await collision.close(); }
    activeCase = 'successful-rerun-aborts';
    const beforeRerun = await snapshot(db);
    await expectError(db, proposal, 'P0001');
    assert.equal(await snapshot(db), beforeRerun);
    await db.exec(sqlAssert('(select count(*)=2 from public.android_device_push_tokens)'));
    results.push({ name: activeCase, status: 'PASS' });
    assert.equal(results.length, 61);
    report.status = 'PASS';
  } finally { await db.close(); }
} catch (error) {
  report.failure = { case: activeCase, code: /^[0-9A-Z]{5}$/.test(error?.code ?? '') ? error.code : 'LOCAL_ASSERTION_OR_RUNTIME_FAILURE' };
} finally {
  report.engine = engine;
  report.executedCases = results.length;
  report.results = results;
  fs.writeFileSync(path.join(root, 'local-pg17-wasm-test-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ scope: report.scope, status: report.status, engine, plannedCases: report.plannedCases, passedCases: results.length, failure: report.failure }));
}
if (report.status !== 'PASS') process.exitCode = 1;
