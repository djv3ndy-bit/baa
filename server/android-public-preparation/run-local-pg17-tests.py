#!/usr/bin/env python3
"""Disposable synthetic PG17 acceptance only; never connects to a hosted server.
No packages/downloads. Use --plan-only without a PG17 installation.
All runtime files/reports are restricted to this script's preparation directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent
A = '10000000-0000-4000-8000-000000000001'
B = '10000000-0000-4000-8000-000000000002'
C = '10000000-0000-4000-8000-000000000003'
D = '10000000-0000-4000-8000-000000000004'
E = '10000000-0000-4000-8000-000000000005'

def attempt(n):
    return f'20000000-0000-4000-8000-{n:012d}'

def provider(user=A, n=1, environment='Production'):
    return f"public.native_checkout_provider('{user}','{environment}','{attempt(n)}')"

def assertion(condition):
    return f'select test_harness.assert({condition});'

CASES = []
def case(name, sql, role='postgres', user=None, error=None):
    CASES.append(dict(name=name, sql=sql, role=role, user=user, expected_error=error))

case('provider-valid-google', assertion(provider()+"='google'"), 'service_role')
case('provider-valid-apple-not-rewritten', assertion(provider(n=2)+"='apple'"), 'service_role')
for label,n,user in [('expired',3,A),('started',4,A),('cancelled',5,A),('wrong-owner',6,A),
                     ('barista',7,C),('sandbox',8,A),('suspended',9,D),('missing-profile',10,E)]:
    case('provider-denies-'+label, assertion(provider(user,n,'Sandbox' if n==8 else 'Production')+' is null'), 'service_role')
case('provider-denies-null-arguments', assertion("public.native_checkout_provider(null,'Production',null) is null"), 'service_role')
case('provider-denies-changed-configuration', "update private.native_billing_configuration set environment='Sandbox'; set local role service_role; "+assertion(provider()+' is null'))
for role in ['anon','authenticated']:
    case('provider-no-execute-'+role,'select '+provider()+';',role,error='42501')
case('catalog-rls-four-owner-policies',assertion("(select relrowsecurity from pg_class where oid='public.android_device_push_tokens'::regclass)")+assertion("(select count(*)=4 from pg_policy where polrelid='public.android_device_push_tokens'::regclass and polroles=array['authenticated'::regrole::oid])"))
case('owner-select-sees-only-own', assertion("(select count(*)=1 and bool_and(user_id='"+A+"') from public.android_device_push_tokens)"),'authenticated',A)
case('owner-insert-own',f"insert into public.android_device_push_tokens(fcm_token,user_id) values('qa_insert_a','{A}'); "+assertion("(select count(*)=2 from public.android_device_push_tokens)"),'authenticated',A)
case('owner-delete-own',"delete from public.android_device_push_tokens where fcm_token='qa_token_a'; "+assertion("(select count(*)=0 from public.android_device_push_tokens)"),'authenticated',A)
case('foreign-read-hidden',assertion("(select count(*)=0 from public.android_device_push_tokens where fcm_token='qa_token_b')"),'authenticated',A)
case('foreign-update-noop',"with changed as (update public.android_device_push_tokens set enabled=false where fcm_token='qa_token_b' returning 1) "+assertion('(select count(*)=0 from changed)'),'authenticated',A)
case('foreign-delete-noop',"with changed as (delete from public.android_device_push_tokens where fcm_token='qa_token_b' returning 1) "+assertion('(select count(*)=0 from changed)'),'authenticated',A)
case('foreign-insert-denied',f"insert into public.android_device_push_tokens(fcm_token,user_id) values('qa_foreign','{B}');",'authenticated',A,'42501')
case('ownership-transfer-denied',f"update public.android_device_push_tokens set user_id='{B}' where fcm_token='qa_token_a';",'authenticated',A,'42501')
case('foreign-token-upsert-denied',f"insert into public.android_device_push_tokens(fcm_token,user_id) values('qa_token_a','{B}') on conflict(fcm_token) do update set enabled=true;",'authenticated',B,'42501')
case('signedout-auth-role-sees-no-rows',assertion('(select count(*)=0 from public.android_device_push_tokens)'),'authenticated')
case('signedout-auth-role-insert-denied',f"insert into public.android_device_push_tokens(fcm_token,user_id) values('qa_signedout','{A}');",'authenticated',None,'42501')
for label,value in [('empty',"''"),('too-long',"repeat('x',2049)"),('ascii-space',"'qa token'"),('control',"E'qa\\ntoken'"),('nbsp',"U&'qa\\00A0token'"),('bom',"U&'qa\\FEFFtoken'")]:
    case('invalid-token-'+label,f"insert into public.android_device_push_tokens(fcm_token,user_id) values({value},'{A}');",'authenticated',A,'23514')
case('max-token-bytes-accepted',f"insert into public.android_device_push_tokens(fcm_token,user_id) values(repeat('x',2048),'{A}');",'authenticated',A)
for field,value in [('platform','ios'),('firebase_project_id','foreign'),('package_name','foreign.package')]:
    case('identity-pin-'+field,f"insert into public.android_device_push_tokens(fcm_token,user_id,{field}) values('qa_bad_identity','{A}','{value}');",'authenticated',A,'23514')
case('server-assigned-timestamps',f"insert into public.android_device_push_tokens(fcm_token,user_id,created_at,updated_at) values('qa_timestamp','{A}','2099-01-01','2099-01-01'); "+assertion("(select created_at between transaction_timestamp() and statement_timestamp() and updated_at between transaction_timestamp() and statement_timestamp() from public.android_device_push_tokens where fcm_token='qa_timestamp')"), 'authenticated',A)
case('created-time-preserved-on-owner-update',"update public.android_device_push_tokens set created_at='2099-01-01',updated_at='2099-01-01',enabled=false where fcm_token='qa_token_a'; "+assertion("(select created_at<'2099-01-01' and updated_at between transaction_timestamp() and statement_timestamp() and not enabled from public.android_device_push_tokens where fcm_token='qa_token_a')"),'authenticated',A)
case('service-select-all',assertion('(select count(*)=2 from public.android_device_push_tokens)'),'service_role')
case('service-can-disable-only-columns',"update public.android_device_push_tokens set enabled=false,updated_at='2099-01-01' where fcm_token='qa_token_a'; "+assertion("(select not enabled and updated_at between transaction_timestamp() and statement_timestamp() from public.android_device_push_tokens where fcm_token='qa_token_a')"),'service_role')
for field,value in [('fcm_token',"'qa_replaced'"),('user_id',f"'{B}'"),('firebase_project_id',"'baristamatch'"),('package_name',"'com.baristajobmatch.app'"),('platform',"'android'"),('created_at',"now()")]:
    case('service-cannot-update-'+field,f"update public.android_device_push_tokens set {field}={value} where fcm_token='qa_token_a';",'service_role',error='42501')
case('service-cannot-register',f"insert into public.android_device_push_tokens(fcm_token,user_id) values('qa_service','{A}');",'service_role',error='42501')
case('service-cannot-delete',"delete from public.android_device_push_tokens where fcm_token='qa_token_a';",'service_role',error='42501')
case('anon-cannot-read','select count(*) from public.android_device_push_tokens;','anon',error='42501')
case('anon-cannot-register',f"insert into public.android_device_push_tokens(fcm_token,user_id) values('qa_anon','{A}');",'anon',error='42501')
case('auth-deletion-cascades-only-owner',f"delete from auth.users where id='{A}'; "+assertion(f"(select count(*)=0 from public.android_device_push_tokens where user_id='{A}')")+assertion(f"(select count(*)=1 from public.android_device_push_tokens where user_id='{B}')"))

GUARDS = [
 ('sandbox-precondition',"update private.native_billing_configuration set environment='Sandbox';",''),
 ('missing-configuration',"delete from private.native_billing_configuration;",''),
 ('missing-signature',"drop function public.native_checkout_start(uuid,text,uuid);",''),
 ('wrong-column-contract',"alter table public.profiles alter column suspended_at type text using suspended_at::text;",''),
 ('unknown-executor','', 'set role authenticated;'),
 ('unexpected-default-grantee',"create role unexpected_default_reader; alter default privileges for role postgres in schema public grant select on tables to unexpected_default_reader;",''),
]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin',type=Path,help='Existing native PostgreSQL 17 bin directory; never installed by this helper')
    parser.add_argument('--plan-only',action='store_true',help='No database execution; write explicit UNEXECUTED manifest')
    args=parser.parse_args()
    report={'scope':'LOCAL SYNTHETIC DISPOSABLE ONLY; NOT HOSTED MIGRATION PROOF',
            'candidateSqlSha256':hashlib.sha256((ROOT/'proposed-production-billing-fcm.sql').read_bytes()).hexdigest(),
            'status':'UNEXECUTED','plannedCases':len(CASES)+len(GUARDS)+4,
            'caseNames':[x['name'] for x in CASES]+[x[0] for x in GUARDS]+['existing-object-preservation','validation-query-syntax','collision-abort','successful-rerun-aborts'],
            'limitations':['Minimal fixture contracts and sentinel checkout stubs, not the full production schema.',
             'Single local backend tests do not prove multi-session races, hosted project identity, PostgREST, managed event triggers or mobile runtime.']}
    if args.plan_only:
        (ROOT/'local-pg17-test-report.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({'status':'UNEXECUTED','plannedCases':report['plannedCases'],'scope':report['scope']}))
        return
    if args.pg_bin is None:parser.error('Provide --plan-only or an already installed native --pg-bin')
    pg_bin=args.pg_bin.resolve()
    binaries={name:pg_bin/name for name in ['initdb','postgres','psql']}
    for path in binaries.values():
        if not path.is_file() or not os.access(path,os.X_OK):parser.error('Native PostgreSQL binaries missing; no install attempted')
    # Strip inherited PG settings; -X/no-password and private socket avoid user
    # startup files, credential files, services and accidental hosted connections.
    env={'PATH':os.defpath,'LC_ALL':'C','PGCONNECT_TIMEOUT':'2','PGAPPNAME':'baristamatch-local-synthetic-tests'}
    version=subprocess.run([str(binaries['postgres']),'--version'],capture_output=True,text=True,env=env,check=True).stdout.strip()
    if not re.search(r'\b17(?:\.|\b)',version):parser.error('PostgreSQL major 17 is required; no SQL executed')
    results=[]
    process=None
    with tempfile.TemporaryDirectory(prefix='local-pg17-',dir=ROOT) as td:
        sandbox=Path(td); os.chmod(sandbox,0o700)
        data=sandbox/'data'; socket=sandbox/'socket'; socket.mkdir(mode=0o700)
        env.update({'TMPDIR':str(sandbox),'PGPASSFILE':str(sandbox/'absent.pgpass'),'PGSERVICEFILE':str(sandbox/'absent.pg_service.conf')})
        subprocess.run([str(binaries['initdb']),'-D',str(data),'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'],capture_output=True,text=True,env=env,check=True)
        with (sandbox/'server.log').open('w') as log:
            process=subprocess.Popen([str(binaries['postgres']),'-D',str(data),'-h','','-k',str(socket),'-p','55432','-c','fsync=off'],stdout=log,stderr=log,env=env)
            try:
                def sql(text,database='postgres',expected_error=None):
                    # Host is always this disposable Unix socket. No URL/hostname,
                    # credentials or arbitrary connection options are accepted.
                    completed=subprocess.run([str(binaries['psql']),'-X','--no-password','-q','-A','-t','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h',str(socket),'-p','55432','-U','postgres','-d',database],input=text,capture_output=True,text=True,env=env,timeout=35)
                    code_match=re.search(r'ERROR:\s+([0-9A-Z]{5}):',completed.stderr)
                    error_code=code_match.group(1) if code_match else None
                    if expected_error:
                        if completed.returncode==0 or error_code!=expected_error:
                            raise RuntimeError('LOCAL_EXPECTED_SQLSTATE_MISMATCH')
                    elif completed.returncode:
                        raise RuntimeError('LOCAL_SQL_FAILED_'+(error_code or 'UNCLASSIFIED'))
                    return completed.stdout
                deadline=time.monotonic()+10
                while True:
                    try:sql('select 1;');break
                    except RuntimeError:
                        if process.poll() is not None or time.monotonic()>deadline:raise RuntimeError('LOCAL_SERVER_START_FAILED')
                        time.sleep(.1)
                sql('create database fixture_base;')
                sql((ROOT/'local-pg17-fixtures.sql').read_text(),'fixture_base')
                sql('create database test_main template fixture_base;')
                proposal=(ROOT/'proposed-production-billing-fcm.sql').read_text()
                validation=(ROOT/'validation.sql').read_text()
                manifest='-- 2. Preservation manifest:'+validation.split('-- 2. Preservation manifest:')[1].split('-- 3. New-object')[0]
                before=sql(manifest,'test_main')
                sql(proposal,'test_main')
                if before!=sql(manifest,'test_main'):raise RuntimeError('LOCAL_PRESERVATION_MANIFEST_CHANGED')
                results.append({'name':'existing-object-preservation','status':'PASS'})
                sql('-- 3. New-object'+validation.split('-- 3. New-object')[1],'test_main')
                results.append({'name':'validation-query-syntax','status':'PASS'})
                sql(f"insert into public.android_device_push_tokens(fcm_token,user_id) values('qa_token_a','{A}'),('qa_token_b','{B}');",'test_main')
                for test in CASES:
                    block='begin; set local role '+test['role']+';'
                    if test['user']:block+="select set_config('request.jwt.claim.sub','"+test['user']+"',true);"
                    else:block+="select set_config('request.jwt.claim.sub','',true);"
                    sql(block+test['sql']+'rollback;','test_main',test['expected_error'])
                    results.append({'name':test['name'],'status':'PASS'})
                for index,(name,setup,prefix) in enumerate(GUARDS):
                    database=f'guard_{index}'; sql(f'create database {database} template fixture_base;')
                    if setup:sql(setup,database)
                    sql(prefix+proposal,database,'P0001')
                    sql(assertion("to_regclass('public.android_device_push_tokens') is null and to_regprocedure('public.native_checkout_provider(uuid,text,uuid)') is null and to_regprocedure('private.android_device_push_tokens_touch()') is null"),database)
                    results.append({'name':name,'status':'PASS'})
                sql('create database guard_collision template fixture_base;')
                sql("create function public.native_checkout_provider(uuid,text,uuid) returns text language sql as $$select 'sentinel'::text$$;",'guard_collision')
                sql(proposal,'guard_collision','P0001')
                sql(assertion("public.native_checkout_provider(null,null,null)='sentinel' and to_regclass('public.android_device_push_tokens') is null"),'guard_collision')
                results.append({'name':'collision-abort','status':'PASS'})
                before=sql(manifest,'test_main')
                sql(proposal,'test_main','P0001')
                if before!=sql(manifest,'test_main'):raise RuntimeError('LOCAL_RERUN_CHANGED_BASELINE')
                sql(assertion('(select count(*)=2 from public.android_device_push_tokens)'),'test_main')
                results.append({'name':'successful-rerun-aborts','status':'PASS'})
                report.update({'status':'PASS','runtime':version,'executedCases':len(results),'results':results})
            except Exception as error:
                report.update({'status':'FAIL','runtime':version,'executedCases':len(results),'results':results,'safeError':str(error) if str(error).startswith('LOCAL_') else type(error).__name__})
            finally:
                if process and process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    try:process.wait(timeout=10)
                    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
    (ROOT/'local-pg17-test-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:report[k] for k in ['scope','status','plannedCases']} | {'executedCases':report.get('executedCases',0)}))
    if report['status']!='PASS':raise SystemExit(1)

if __name__=='__main__':main()
