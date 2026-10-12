-- READ-ONLY REVIEW QUERIES. Do not run until the selected project is independently
-- verified as lmwqrxoitraofaftpwhe and the relevant read/application step approved.
-- No user, Auth, token, purchase, payload, secret, or cron-command rows are read.
-- Save BEFORE/AFTER separately. Section 2 existing-object manifests must match.
-- Section 1 presence flags intentionally change false -> true; Production config
-- and executor/version expectations stay unchanged. Do not byte-compare all1-2.
-- Sections 3-4 are post-application inspection and work only after objects exist.

-- 1. Nonsecret project/runtime preconditions. Project identity is EXTERNAL.
select current_user as executor, current_setting('server_version') as postgres_version;
select singleton, environment from private.native_billing_configuration order by singleton;
-- Expected exactly true/Production, unchanged before/after.
select to_regprocedure('public.native_checkout_provider(uuid,text,uuid)') is not null as provider_exists,
       to_regclass('public.android_device_push_tokens') is not null as android_tokens_exist,
       to_regprocedure('private.android_device_push_tokens_touch()') is not null as android_touch_exists;
-- Expected all false before, all true after. No reviewer objects are introduced.

-- 2. Preservation manifest: hash definitions/ACLs rather than printing bodies.
-- Changes outside the explicit new objects require investigation before rollout.
-- These hashes do not prove hosted-project identity or row/data preservation.
-- The relation manifest excludes ALL internal triggers, including auth.users RI
-- triggers. It cannot establish preservation of old Auth internal triggers. The
-- separate section3 query inventories only the4 expected NEW FK triggers.
select 'routine' as kind, n.nspname as schema_name,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as object_name,
       md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text,'<NULL>') || p.proowner::text) as definition_acl_md5
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','private') and p.prokind in ('f','p','w')
  and not (n.nspname='public' and p.proname='native_checkout_provider')
  and not (n.nspname='private' and p.proname='android_device_push_tokens_touch')
order by schema_name, object_name;

select 'relation' as kind,n.nspname as schema_name,c.relname as object_name,
       md5(jsonb_build_object(
         'kind',c.relkind,'owner',c.relowner,'acl',c.relacl,
         'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
         'columns',(select jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,
           a.attnotnull,a.attidentity,a.attgenerated,a.attacl,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
           from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
           where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
         'constraints',(select jsonb_agg(jsonb_build_array(k.conname,pg_get_constraintdef(k.oid),k.convalidated) order by k.conname)
           from pg_constraint k where k.conrelid=c.oid),
         'indexes',(select jsonb_agg(jsonb_build_array(i.indexrelid::regclass::text,
           pg_get_indexdef(i.indexrelid),i.indisvalid) order by i.indexrelid::regclass::text)
           from pg_index i where i.indrelid=c.oid),
         'triggers',(select jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) order by t.tgname)
           from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal),
         'policies',(select jsonb_agg(jsonb_build_array(q.polname,q.polcmd,q.polpermissive,q.polroles,
           pg_get_expr(q.polqual,q.polrelid),pg_get_expr(q.polwithcheck,q.polrelid)) order by q.polname)
           from pg_policy q where q.polrelid=c.oid)
       )::text) as definition_acl_md5
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where (n.nspname in ('public','private') or (n.nspname='auth' and c.relname='users'))
  and c.relkind in ('r','p','S','v','m','f')
  and not (n.nspname='public' and c.relname='android_device_push_tokens')
order by schema_name, object_name;

select nspname as schema_name,nspowner::regrole::text as owner,nspacl::text as acl
from pg_namespace where nspname in ('public','private','auth') order by nspname;
select d.defaclrole::regrole::text as owner,coalesce(n.nspname,'<global>') as schema_name,
       d.defaclobjtype as object_type,d.defaclacl::text as acl
from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
order by owner,schema_name,object_type;
-- Event-trigger definitions/enabled state remain unchanged. No body/secret output.
select e.evtname,e.evtevent,e.evtenabled,e.evttags,e.evtowner::regrole::text as owner,
       e.evtfoid::regprocedure::text as function_name
from pg_event_trigger e order by e.evtname;

-- 3. New-object definitions/constraints/policies/trigger; catalog only.
select c.relname,c.relowner::regrole::text as owner,c.relrowsecurity,c.relforcerowsecurity
from pg_class c where c.oid='public.android_device_push_tokens'::regclass;
select a.attname,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull,
       pg_get_expr(d.adbin,d.adrelid) as default_expression
from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
where a.attrelid='public.android_device_push_tokens'::regclass and a.attnum>0 and not a.attisdropped
order by a.attnum;
select conname,contype,convalidated,pg_get_constraintdef(oid) as definition
from pg_constraint where conrelid='public.android_device_push_tokens'::regclass order by conname;
select i.indexrelid::regclass::text as name,i.indisvalid,pg_get_indexdef(i.indexrelid) as definition
from pg_index i where i.indrelid='public.android_device_push_tokens'::regclass order by name;
select policyname,roles,cmd,qual,with_check from pg_policies
where schemaname='public' and tablename='android_device_push_tokens' order by policyname;
select tgname,tgenabled,pg_get_triggerdef(oid) as definition from pg_trigger
where tgrelid='public.android_device_push_tokens'::regclass and not tgisinternal order by tgname;
-- New FK creates4 enabled internal RI triggers:2 on this table,2 on auth.users.
-- Names include generated OIDs; inspect count/relation/function semantics rather
-- than comparing generated names across disposable/hosted databases.
select k.conname,n.nspname as table_schema,c.relname as table_name,
       t.tgname,t.tgenabled,t.tgisinternal,t.tgfoid::regprocedure::text as trigger_function
from pg_constraint k join pg_trigger t on t.tgconstraint=k.oid
join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
where k.conrelid='public.android_device_push_tokens'::regclass and k.contype='f'
  and k.confrelid='auth.users'::regclass
order by table_schema,table_name,trigger_function;
select p.oid::regprocedure::text as name,p.proowner::regrole::text as owner,p.prosecdef,p.provolatile,
       p.proconfig,pg_get_functiondef(p.oid) as definition
from pg_proc p where p.oid in (
  'public.native_checkout_provider(uuid,text,uuid)'::regprocedure,
  'private.android_device_push_tokens_touch()'::regprocedure
) order by name;

-- 4. Explicit and effective privileges. PUBLIC must have no object ACL entries.
select coalesce(r.rolname,'PUBLIC') as grantee,a.privilege_type,a.is_grantable
from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
left join pg_roles r on r.oid=a.grantee
where c.oid='public.android_device_push_tokens'::regclass
order by grantee,a.privilege_type;
select a.attname,coalesce(r.rolname,'PUBLIC') as grantee,x.privilege_type,x.is_grantable
from pg_attribute a cross join lateral aclexplode(a.attacl) x
left join pg_roles r on r.oid=x.grantee
where a.attrelid='public.android_device_push_tokens'::regclass order by a.attname,grantee,x.privilege_type;
select p.oid::regprocedure::text as name,coalesce(r.rolname,'PUBLIC') as grantee,
       a.privilege_type,a.is_grantable
from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
left join pg_roles r on r.oid=a.grantee
where p.oid in ('public.native_checkout_provider(uuid,text,uuid)'::regprocedure,
               'private.android_device_push_tokens_touch()'::regprocedure)
order by name,grantee,a.privilege_type;
select r.role,p.operation,
       has_table_privilege(r.role,'public.android_device_push_tokens',p.operation) as allowed
from (values ('anon'),('authenticated'),('service_role')) as r(role)
cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) as p(operation)
order by r.role,p.operation;
select a.attname,has_column_privilege('service_role','public.android_device_push_tokens',a.attname,'UPDATE') as service_can_update
from pg_attribute a where a.attrelid='public.android_device_push_tokens'::regclass
and a.attnum>0 and not a.attisdropped order by a.attnum;
select r.role,has_function_privilege(r.role,'public.native_checkout_provider(uuid,text,uuid)','EXECUTE') as provider_execute,
       has_function_privilege(r.role,'private.android_device_push_tokens_touch()','EXECUTE') as touch_execute
from (values ('anon'),('authenticated'),('service_role')) as r(role) order by r.role;
-- Expected: authenticated table CRUD only; service SELECT + enabled/updated_at
-- column UPDATE; anon none; provider EXECUTE service only; touch EXECUTE none.
-- These metadata checks do not replace local/hosted two-user RLS/runtime tests.
