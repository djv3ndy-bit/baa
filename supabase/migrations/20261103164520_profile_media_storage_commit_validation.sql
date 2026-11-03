-- New isolated repair; never replay the applied moderation foundation.
-- Caller owns the transaction. No client/public signatures, role grants, bucket
-- settings, review/publication settings or existing policy expressions change.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $baseline$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='private.consume_profile_media_upload(text,jsonb)'::regprocedure) IS DISTINCT FROM 'e37dda001d183f17fa1ebf029e8d510d'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='private.guard_profile_media_storage_lifecycle()'::regprocedure) IS DISTINCT FROM '4f99c84e9cd8fdb6e5d1872e7a69f652'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='private.ugc_require_active_member()'::regprocedure) IS DISTINCT FROM '241b9f5c07d70c8d78ec128f00cc4208'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='storage.update_updated_at_column()'::regprocedure) IS DISTINCT FROM '7596e66a7698d5a6b5129c5ce9b24c5f'
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='storage.objects'::regclass AND tgname='update_objects_updated_at' AND pg_get_triggerdef(oid)='CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column()' AND tgenabled='O')
 OR NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='storage.objects'::regclass AND a.attname='path_tokens' AND a.attgenerated='s' AND pg_get_expr(d.adbin,d.adrelid)='string_to_array(name, ''/''::text)')
 OR (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='storage.objects'::regclass AND a.attnum>0 AND NOT a.attisdropped) IS DISTINCT FROM '[{"name":"id","type":"uuid","not_null":true,"default":"gen_random_uuid()","generated":""},{"name":"bucket_id","type":"text","not_null":false,"default":null,"generated":""},{"name":"name","type":"text","not_null":false,"default":null,"generated":""},{"name":"owner","type":"uuid","not_null":false,"default":null,"generated":""},{"name":"created_at","type":"timestamp with time zone","not_null":false,"default":"now()","generated":""},{"name":"updated_at","type":"timestamp with time zone","not_null":false,"default":"now()","generated":""},{"name":"last_accessed_at","type":"timestamp with time zone","not_null":false,"default":"now()","generated":""},{"name":"metadata","type":"jsonb","not_null":false,"default":null,"generated":""},{"name":"path_tokens","type":"text[]","not_null":false,"default":"string_to_array(name, ''/''::text)","generated":"s"},{"name":"version","type":"text","not_null":false,"default":null,"generated":""},{"name":"owner_id","type":"text","not_null":false,"default":null,"generated":""},{"name":"user_metadata","type":"jsonb","not_null":false,"default":null,"generated":""},{"name":"archived_at","type":"timestamp with time zone","not_null":false,"default":null,"generated":""},{"name":"is_delete_marker","type":"boolean","not_null":true,"default":"false","generated":""},{"name":"is_versioned","type":"boolean","not_null":true,"default":"false","generated":""}]'::jsonb
 OR (SELECT array_agg(tgname::text ORDER BY tgname) FROM pg_trigger WHERE tgrelid='storage.objects'::regclass AND NOT tgisinternal AND (tgtype&2)=2 AND (tgtype&16)=16) IS DISTINCT FROM ARRAY['ugc_storage_lifecycle','update_objects_updated_at']::text[]
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='private.profile_media_upload_intents'::regclass)
 OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='private.profile_media_upload_intents'::regclass AND attname='used_object_id' AND NOT attisdropped)
 OR EXISTS(SELECT 1 FROM private.profile_media_upload_intents WHERE used_at IS NOT NULL OR used_transaction IS NOT NULL)
 OR EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='ugc-media-staging')
 OR EXISTS(SELECT 1 FROM private.profile_media_reviews)
 OR (SELECT public FROM storage.buckets WHERE id='ugc-media-staging') IS DISTINCT FROM false
 OR (SELECT publication_active FROM private.ugc_moderation_configuration WHERE singleton) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'ugc_storage_commit_repair_baseline_mismatch'; END IF;
END;
$baseline$;

-- Retain exact consumed object identity after the object's eventual TTL deletion.
-- No FK: deleting temporary bytes must never make the reservation reusable.
ALTER TABLE private.profile_media_upload_intents ADD COLUMN used_object_id uuid;
ALTER TABLE private.profile_media_upload_intents ADD CONSTRAINT profile_media_used_object_binding
 CHECK ((used_at IS NULL AND used_object_id IS NULL) OR (used_at IS NOT NULL AND used_object_id IS NOT NULL));

-- Storage authorizes using a rolled-back speculative INSERT. Older official
-- versions omit metadata; current versions provide mimetype/contentLength, where
-- multipart contentLength includes boundaries and is NOT authoritative file size.
-- This compatibility predicate has no durable data writes. The constraint trigger
-- below validates real backend metadata and consumes at actual object COMMIT.
CREATE OR REPLACE FUNCTION private.consume_profile_media_upload(p_name text,p_metadata jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $consume$
DECLARE member_id uuid; intent private.profile_media_upload_intents%rowtype; observed_now timestamptz;
BEGIN
 member_id:=private.ugc_require_active_member();
 PERFORM pg_advisory_xact_lock(hashtextextended('ugc-media:'||member_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('ugc-media-global-bytes',0));
 SELECT * INTO intent FROM private.profile_media_upload_intents WHERE owner_id=member_id AND object_path=p_name FOR SHARE;
 observed_now:=clock_timestamp();
 IF NOT FOUND OR intent.expires_at<=observed_now OR intent.used_at IS NOT NULL
 OR intent.staged_deleted_at IS NOT NULL OR intent.cleanup_claim_id IS NOT NULL
 OR NOT private.ugc_owner_field_allowed(member_id,intent.field)
 OR (p_metadata IS NOT NULL AND jsonb_typeof(p_metadata)<>'object')
 OR (p_metadata ? 'mimetype' AND p_metadata->>'mimetype' IS DISTINCT FROM intent.mime_type)
 OR (p_metadata ? 'size' AND p_metadata->>'size' IS DISTINCT FROM intent.byte_size::text)
 THEN RETURN false; END IF;
 RETURN true;
END;
$consume$;
-- CREATE OR REPLACE preserves the exact existing ACL and owner.

CREATE FUNCTION private.validate_profile_media_object_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $commit_guard$
DECLARE asset storage.objects%rowtype; intent private.profile_media_upload_intents%rowtype;
 member_id uuid; observed_now timestamptz; owner_bytes numeric; total_bytes numeric;
BEGIN
 -- Unchanged-content read bookkeeping (including the installed vendor
 -- updated_at=now() trigger) is not a second upload. The immediate
 -- immutability trigger prevents any consumed object content/identity change.
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'last_accessed_at'-'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'last_accessed_at'-'updated_at')
 THEN RETURN NULL; END IF;
 -- Re-read the persisted final row: queued NEW can contain the speculative shape
 -- or intermediate metadata from earlier statements in the same transaction.
 SELECT * INTO asset FROM storage.objects WHERE id=NEW.id;
 IF NOT FOUND OR asset.bucket_id<>'ugc-media-staging'
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_invalid_media'; END IF;
 IF current_setting('transaction_isolation')<>'read committed'
 OR asset.owner_id IS NULL OR asset.owner_id!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
 member_id:=asset.owner_id::uuid;
 -- Existing lifecycle BEFORE trigger already uses profile -> owner order.
 PERFORM id FROM public.profiles WHERE id=member_id AND role IN('barista','cafe_owner_manager') AND suspended_at IS NULL FOR SHARE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=member_id)
 OR EXISTS(SELECT 1 FROM private.profile_media_owner_lifecycle WHERE owner_id=member_id)
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ugc-media:'||member_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('ugc-media-global-bytes',0));
 SELECT * INTO intent FROM private.profile_media_upload_intents WHERE owner_id=member_id AND object_path=asset.name FOR UPDATE;
 observed_now:=clock_timestamp();
 IF NOT FOUND OR intent.expires_at<=observed_now OR intent.staged_deleted_at IS NOT NULL
 OR intent.cleanup_claim_id IS NOT NULL OR NOT private.ugc_owner_field_allowed(member_id,intent.field)
 OR asset.is_delete_marker IS DISTINCT FROM false OR asset.is_versioned IS DISTINCT FROM false OR asset.archived_at IS NOT NULL
 OR (asset.owner IS NOT NULL AND asset.owner IS DISTINCT FROM member_id)
 OR asset.metadata->>'mimetype' IS DISTINCT FROM intent.mime_type
 OR asset.metadata->>'size' IS DISTINCT FROM intent.byte_size::text
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_invalid_media'; END IF;
 -- Repeated deferred events are idempotent only for this exact row and XID.
 IF intent.used_at IS NOT NULL THEN
  IF intent.used_transaction=pg_current_xact_id() AND intent.used_object_id=asset.id THEN RETURN NULL; END IF;
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_upload_expired';
 END IF;
 -- The row is already present in this transaction: exclude only this exact row
 -- before adding its exact reserved size. Other newly inserted rows count too.
 SELECT coalesce(sum((metadata->>'size')::numeric),0) INTO owner_bytes FROM storage.objects
  WHERE bucket_id='ugc-media-staging' AND owner_id=member_id::text AND id<>asset.id;
 SELECT coalesce(sum((metadata->>'size')::numeric),0) INTO total_bytes FROM storage.objects
  WHERE bucket_id='ugc-media-staging' AND id<>asset.id;
 IF owner_bytes+intent.byte_size>104857600 OR total_bytes+intent.byte_size>1073741824
 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_staging_quota_reached'; END IF;
 UPDATE private.profile_media_upload_intents
 SET used_at=observed_now,used_transaction=pg_current_xact_id(),used_object_id=asset.id WHERE id=intent.id;
 RETURN NULL;
END;
$commit_guard$;
REVOKE ALL ON FUNCTION private.validate_profile_media_object_commit() FROM PUBLIC,anon,authenticated,service_role;

-- Prevent privileged final upserts from replacing already committed temporary
-- content. Same-transaction intermediate metadata is validated at COMMIT. Only
-- last-access/updated-at bookkeeping on consumed objects may change afterwards.
CREATE FUNCTION private.guard_profile_media_object_immutability() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $immutable_guard$
DECLARE intent private.profile_media_upload_intents%rowtype;
BEGIN
 IF OLD.bucket_id='ugc-media-staging' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.bucket_id IS DISTINCT FROM OLD.bucket_id
   OR NEW.name IS DISTINCT FROM OLD.name OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
  THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_invalid_media'; END IF;
  SELECT * INTO intent FROM private.profile_media_upload_intents WHERE object_path=OLD.name;
  IF NOT FOUND OR (intent.used_at IS NOT NULL AND
   (to_jsonb(NEW)-'last_accessed_at'-'updated_at'-'path_tokens') IS DISTINCT FROM (to_jsonb(OLD)-'last_accessed_at'-'updated_at'-'path_tokens'))
  THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_invalid_media'; END IF;
  -- Runs AFTER the pinned vendor timestamp trigger. Preserve strict source
  -- fingerprints during read bookkeeping; do not weaken their field set.
  IF intent.used_at IS NOT NULL THEN NEW.updated_at:=OLD.updated_at; END IF;
 ELSIF NEW.bucket_id='ugc-media-staging' THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_invalid_media';
 END IF;
 RETURN NEW;
END;
$immutable_guard$;
REVOKE ALL ON FUNCTION private.guard_profile_media_object_immutability() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER zz_ugc_staging_object_immutable BEFORE UPDATE ON storage.objects
 FOR EACH ROW WHEN (OLD.bucket_id='ugc-media-staging' OR NEW.bucket_id='ugc-media-staging')
 EXECUTE FUNCTION private.guard_profile_media_object_immutability();
CREATE CONSTRAINT TRIGGER ugc_staging_object_commit
 AFTER INSERT OR UPDATE ON storage.objects DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN (NEW.bucket_id='ugc-media-staging')
 EXECUTE FUNCTION private.validate_profile_media_object_commit();

NOTIFY pgrst,'reload schema';
