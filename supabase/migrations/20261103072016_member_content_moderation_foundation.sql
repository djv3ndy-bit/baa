-- LOCAL CANDIDATE. Apply only after exact production preflight and owner rollout approval.
-- Atomic migration caller owns the transaction/history. Media activation is separate and HELD.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $baseline$
BEGIN
  IF current_user <> 'postgres' OR current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'UGC migration requires postgres and READ COMMITTED';
  END IF;
  IF NOT has_schema_privilege('authenticated','private','USAGE') THEN RAISE EXCEPTION 'UGC member wrapper private-schema capability missing; stop without normalizing grants'; END IF;
  IF to_regclass('private.profile_media_upload_intents') IS NOT NULL
     OR to_regprocedure('public.reserve_profile_media_upload(text,text,bigint)') IS NOT NULL
     OR EXISTS(SELECT 1 FROM storage.buckets WHERE id='ugc-media-staging') THEN
    RAISE EXCEPTION 'UGC foundation already present or unexpected name collision';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='cafe-images' AND public
      AND file_size_limit=5242880 AND allowed_mime_types=ARRAY['image/jpeg','image/png','image/webp'])
     OR NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='coffee-videos' AND NOT public
      AND file_size_limit=52428800 AND allowed_mime_types=ARRAY['video/mp4','video/quicktime','video/webm'])
     OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.profiles'::regclass AND relrowsecurity)
     OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.jobs'::regclass AND relrowsecurity)
     OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.user_reports'::regclass AND relrowsecurity)
     OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.protect_profile_authorization_fields()'::regprocedure))
       IS DISTINCT FROM '097a7c0d5fa64d9009f4e7b0157aa9cd'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.enforce_profile_discoverability()'::regprocedure))
       IS DISTINCT FROM '1cb325972c8f580ea59866376bfb8762' THEN
    RAISE EXCEPTION 'UGC live baseline drift; stop, do not normalize or replay';
  END IF;
END;
$baseline$;

CREATE TABLE private.ugc_moderation_configuration(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  publication_active boolean NOT NULL DEFAULT false
);
INSERT INTO private.ugc_moderation_configuration VALUES(true,false);

CREATE TABLE private.profile_media_owner_lifecycle(
  owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deletion_requested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE private.profile_media_upload_intents(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  field text NOT NULL CHECK(field IN('avatar_url','bar_picture_url','video_path')),
  object_path text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK(mime_type IN('image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm')),
  byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 52428800),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_transaction xid8,
  cleanup_claim_id uuid,
  cleanup_claim_expires_at timestamptz,
  staged_deleted_at timestamptz,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
  CHECK((used_at IS NULL)=(used_transaction IS NULL)),
  CHECK((cleanup_claim_id IS NULL)=(cleanup_claim_expires_at IS NULL))
);
CREATE INDEX profile_media_intents_owner_created_idx ON private.profile_media_upload_intents(owner_id,created_at DESC);

CREATE TABLE private.profile_media_reviews(
  id uuid PRIMARY KEY REFERENCES private.profile_media_upload_intents(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  field text NOT NULL CHECK(field IN('avatar_url','bar_picture_url','video_path')),
  object_path text NOT NULL UNIQUE,
  source_object_id uuid NOT NULL,
  source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{32}$'),
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 52428800),
  prior_value text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','publishing','published','cancelled')),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  due_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  reviewed_at timestamptz,
  reviewed_by text,
  rejection_code text CHECK(rejection_code IN('inappropriate_content','privacy_or_consent','unsafe_file','other')),
  private_review_note text,
  claim_id uuid,
  claim_expires_at timestamptz,
  published_value text,
  published_sha256 text CHECK(published_sha256 ~ '^[a-f0-9]{64}$'),
  published_at timestamptz,
  terminal_at timestamptz,
  CHECK((claim_id IS NULL)=(claim_expires_at IS NULL)),
  CHECK((status='publishing')=(claim_id IS NOT NULL)),
  CHECK(status NOT IN('approved','publishing','published') OR reviewed_at IS NOT NULL),
  CHECK(status<>'rejected' OR rejection_code IS NOT NULL),
  CHECK((status IN('rejected','cancelled','published'))=(terminal_at IS NOT NULL)),
  CHECK(status<>'published' OR (published_value IS NOT NULL AND published_at IS NOT NULL AND published_sha256 IS NOT NULL))
);
CREATE UNIQUE INDEX profile_media_one_open_field_idx ON private.profile_media_reviews(owner_id,field)
  WHERE status IN('pending','approved','publishing');
CREATE INDEX profile_media_reviews_due_idx ON private.profile_media_reviews(status,due_at) WHERE status IN('pending','approved');
CREATE INDEX profile_media_reviews_owner_field_submitted_idx ON private.profile_media_reviews(owner_id,field,submitted_at DESC,id DESC);

CREATE TABLE private.member_report_reviews(
  report_id uuid PRIMARY KEY REFERENCES public.user_reports(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'new' CHECK(status IN('new','in_review','resolved','dismissed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  due_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  reviewed_at timestamptz,
  reviewed_by text,
  resolution_note text,
  legacy_intake boolean NOT NULL DEFAULT false,
  CHECK(status NOT IN('resolved','dismissed') OR (reviewed_at IS NOT NULL AND char_length(btrim(resolution_note))>0))
);
CREATE INDEX member_report_reviews_due_idx ON private.member_report_reviews(status,due_at) WHERE status IN('new','in_review');

CREATE TABLE private.moderation_notice_deliveries(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utc_hour timestamptz NOT NULL UNIQUE,
  first_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','delivered','needs_attention')),
  claim_id uuid,
  claim_expires_at timestamptz,
  delivered_at timestamptz,
  CHECK((claim_id IS NULL)=(claim_expires_at IS NULL)),
  CHECK(status<>'delivered' OR delivered_at IS NOT NULL)
);
CREATE TABLE private.moderation_notice_outbox(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK(event_type IN('media_pending','safety_report')),
  item_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  due_at timestamptz NOT NULL,
  delivery_id uuid REFERENCES private.moderation_notice_deliveries(id),
  delivered_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE(event_type,item_id)
);
CREATE INDEX moderation_notice_pending_idx ON private.moderation_notice_outbox(due_at,created_at,id)
 WHERE delivered_at IS NULL AND cancelled_at IS NULL AND delivery_id IS NULL;
CREATE INDEX moderation_notice_delivery_idx ON private.moderation_notice_outbox(delivery_id,id) WHERE delivery_id IS NOT NULL;

ALTER TABLE private.ugc_moderation_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.profile_media_owner_lifecycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.profile_media_upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.profile_media_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.member_report_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.moderation_notice_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.moderation_notice_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.ugc_moderation_configuration,private.profile_media_owner_lifecycle,private.profile_media_upload_intents,private.profile_media_reviews,
 private.member_report_reviews,private.moderation_notice_deliveries,private.moderation_notice_outbox FROM PUBLIC,anon,authenticated,service_role;

-- Existing reports have no review state. Queue retained rows without assuming they were resolved.
-- Lock intake until the new trigger is committed; bound initial operator workload explicitly.
LOCK TABLE public.user_reports IN SHARE ROW EXCLUSIVE MODE;
DO $legacy_report_bound$ BEGIN
  IF (SELECT count(*) FROM public.user_reports)>25 THEN RAISE EXCEPTION 'ugc_legacy_report_volume_requires_review'; END IF;
END; $legacy_report_bound$;
INSERT INTO private.member_report_reviews(report_id,legacy_intake) SELECT id,true FROM public.user_reports;
INSERT INTO private.moderation_notice_outbox(event_type,item_id,due_at)
SELECT 'safety_report',report_id,due_at FROM private.member_report_reviews WHERE legacy_intake;

CREATE FUNCTION private.ugc_text_is_allowed(p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $text_filter$
  WITH folded AS (
    SELECT regexp_replace(translate(lower(normalize(coalesce(p_value,''),NFKC)),
      '@013457'||chr(8203)||chr(8204)||chr(8205)||chr(65279),'aoieast'), '[[:cntrl:]]','','g') value
  )
  SELECT char_length(value)<=12000 AND value !~
    '\m(k[._ -]*i[._ -]*l[._ -]*l[[:space:]_.-]+(y[._ -]*o[._ -]*u|u)|s[._ -]*h[._ -]*o[._ -]*o[._ -]*t[[:space:]_.-]+(y[._ -]*o[._ -]*u|u)|r[._ -]*a[._ -]*p[._ -]*e|n[._ -]*i[._ -]*g[._ -]*g[._ -]*(e[._ -]*r|a)|f[._ -]*a[._ -]*g[._ -]*g[._ -]*o[._ -]*t|f[._ -]*u[._ -]*c[._ -]*k(ing|er|s)?|c[._ -]*u[._ -]*n[._ -]*t|b[._ -]*l[._ -]*o[._ -]*w[._ -]*j[._ -]*o[._ -]*b(s)?|h[._ -]*a[._ -]*n[._ -]*d[._ -]*j[._ -]*o[._ -]*b(s)?|p[._ -]*o[._ -]*r[._ -]*n(ography|ographic)?|only[._ -]*fans|send[[:space:]_.-]+n[._ -]*u[._ -]*d[._ -]*e(s)?|sex[[:space:]_.-]+for[[:space:]_.-]+money)\M'
  FROM folded;
$text_filter$;
REVOKE ALL ON FUNCTION private.ugc_text_is_allowed(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.enforce_member_text_moderation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $text_trigger$
DECLARE content jsonb; old_content jsonb; piece jsonb;
BEGIN
  IF TG_TABLE_NAME='profiles' THEN
    content:=jsonb_build_array(NEW.display_name,NEW.cafe_name,NEW.location,NEW.bio,NEW.skills,NEW.availability,
      NEW.experience,NEW.pay_expectation,NEW.cafe_address,NEW.open_hours,NEW.shop_type,NEW.barista_preferences,
      NEW.preferred_city,NEW.preferred_state,NEW.preferred_postal_code);
    IF TG_OP='UPDATE' THEN
      old_content:=jsonb_build_array(OLD.display_name,OLD.cafe_name,OLD.location,OLD.bio,OLD.skills,OLD.availability,
        OLD.experience,OLD.pay_expectation,OLD.cafe_address,OLD.open_hours,OLD.shop_type,OLD.barista_preferences,
        OLD.preferred_city,OLD.preferred_state,OLD.preferred_postal_code);
      IF content=old_content AND NOT(NEW.is_discoverable IS TRUE AND OLD.is_discoverable IS NOT TRUE) THEN RETURN NEW; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='jobs' THEN
    content:=jsonb_build_array(NEW.title,NEW.location,NEW.schedule,NEW.description,NEW.required_skills,
      NEW.address_line1,NEW.address_line2,NEW.city,NEW.state,NEW.postal_code);
    IF TG_OP='UPDATE' THEN
      old_content:=jsonb_build_array(OLD.title,OLD.location,OLD.schedule,OLD.description,OLD.required_skills,
        OLD.address_line1,OLD.address_line2,OLD.city,OLD.state,OLD.postal_code);
      IF content=old_content AND NOT(NEW.active IS TRUE AND OLD.active IS NOT TRUE) THEN RETURN NEW; END IF;
    END IF;
  ELSE RAISE EXCEPTION 'ugc_wrong_trigger_relation'; END IF;
  FOR piece IN SELECT value FROM jsonb_array_elements(content) LOOP
    IF NOT private.ugc_text_is_allowed(CASE WHEN jsonb_typeof(piece)='string' THEN piece#>>'{}' ELSE piece::text END) THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_content_not_allowed';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$text_trigger$;
REVOKE ALL ON FUNCTION private.enforce_member_text_moderation() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ugc_profile_text_filter BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION private.enforce_member_text_moderation();
CREATE TRIGGER ugc_job_text_filter BEFORE INSERT OR UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION private.enforce_member_text_moderation();

CREATE FUNCTION private.ugc_require_active_member() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $active_member$
DECLARE member_id uuid:=auth.uid();
BEGIN
  IF member_id IS NULL OR current_setting('transaction_isolation')<>'read committed'
     OR coalesce((auth.jwt()->>'is_anonymous')::boolean,false)
     OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=member_id) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied';
  END IF;
  PERFORM id FROM public.profiles WHERE id=member_id AND role IN('barista','cafe_owner_manager') AND suspended_at IS NULL FOR SHARE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM private.profile_media_owner_lifecycle WHERE owner_id=member_id) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
  RETURN member_id;
END;
$active_member$;
REVOKE ALL ON FUNCTION private.ugc_require_active_member() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.ugc_owner_field_allowed(p_owner_id uuid,p_field text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $field_role$
 SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_owner_id AND (p_field='avatar_url' OR(p_field='bar_picture_url' AND role='cafe_owner_manager') OR(p_field='video_path' AND role='barista')));
$field_role$;
REVOKE ALL ON FUNCTION private.ugc_owner_field_allowed(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.reserve_profile_media_upload(p_field text,p_mime_type text,p_size bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $reserve$
DECLARE member_id uuid; upload_id uuid:=gen_random_uuid(); extension text; inserted private.profile_media_upload_intents%rowtype; observed_now timestamptz:=clock_timestamp();
BEGIN
  member_id:=private.ugc_require_active_member();
  PERFORM pg_advisory_xact_lock(hashtextextended('ugc-media:'||member_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ugc-media-global-bytes',0));
  IF p_field IS NULL OR p_mime_type IS NULL OR p_size IS NULL OR p_size<1
     OR p_field NOT IN('avatar_url','bar_picture_url','video_path') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_invalid_media'; END IF;
  IF (p_field='bar_picture_url' AND NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=member_id AND role='cafe_owner_manager'))
     OR (p_field='video_path' AND NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=member_id AND role='barista'))
     OR (p_field='video_path' AND (p_mime_type NOT IN('video/mp4','video/quicktime','video/webm') OR p_size>52428800))
     OR (p_field<>'video_path' AND (p_mime_type NOT IN('image/jpeg','image/png','image/webp') OR p_size>5242880)) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_invalid_media';
  END IF;
  IF (SELECT count(*) FROM private.profile_media_upload_intents WHERE owner_id=member_id AND created_at>observed_now-interval '1 hour')>=6
     OR (SELECT count(*) FROM private.profile_media_upload_intents WHERE owner_id=member_id AND created_at>observed_now-interval '24 hours')>=12 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_rate_limited';
  END IF;
  IF coalesce((SELECT sum((metadata->>'size')::bigint) FROM storage.objects WHERE bucket_id='ugc-media-staging' AND owner_id=member_id::text),0)
    +coalesce((SELECT sum(byte_size) FROM private.profile_media_upload_intents WHERE owner_id=member_id AND used_at IS NULL AND expires_at>observed_now),0)+p_size>104857600 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_staging_quota_reached';
  END IF;
  IF coalesce((SELECT sum((metadata->>'size')::bigint) FROM storage.objects WHERE bucket_id='ugc-media-staging'),0)
    +coalesce((SELECT sum(byte_size) FROM private.profile_media_upload_intents WHERE used_at IS NULL AND expires_at>observed_now),0)+p_size>1073741824 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_staging_quota_reached';
  END IF;
  IF EXISTS(SELECT 1 FROM private.profile_media_reviews WHERE owner_id=member_id AND field=p_field AND status IN('pending','approved','publishing')) THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='ugc_media_review_exists';
  END IF;
  extension:=CASE p_mime_type WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp' WHEN 'video/mp4' THEN 'mp4' WHEN 'video/quicktime' THEN 'mov' ELSE 'webm' END;
  INSERT INTO private.profile_media_upload_intents(id,owner_id,field,object_path,mime_type,byte_size,created_at,expires_at)
  VALUES(upload_id,member_id,p_field,member_id::text||'/'||upload_id::text||'.'||extension,p_mime_type,p_size,observed_now,observed_now+interval '10 minutes') RETURNING * INTO inserted;
  RETURN jsonb_build_object('upload_id',upload_id,'bucket','ugc-media-staging','object_path',inserted.object_path,'expires_at',inserted.expires_at);
END;
$reserve$;
REVOKE ALL ON FUNCTION private.reserve_profile_media_upload(text,text,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.reserve_profile_media_upload(text,text,bigint) TO authenticated;
CREATE FUNCTION public.reserve_profile_media_upload(p_field text,p_mime_type text,p_size bigint) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $wrapper$ SELECT private.reserve_profile_media_upload(p_field,p_mime_type,p_size); $wrapper$;
REVOKE ALL ON FUNCTION public.reserve_profile_media_upload(text,text,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.reserve_profile_media_upload(text,text,bigint) TO authenticated;

CREATE FUNCTION private.consume_profile_media_upload(p_name text,p_metadata jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $consume$
DECLARE member_id uuid; intent private.profile_media_upload_intents%rowtype; observed_now timestamptz:=clock_timestamp();
BEGIN
  member_id:=private.ugc_require_active_member();
  PERFORM pg_advisory_xact_lock(hashtextextended('ugc-media:'||member_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ugc-media-global-bytes',0));
  SELECT * INTO intent FROM private.profile_media_upload_intents WHERE owner_id=member_id AND object_path=p_name FOR UPDATE;
  IF NOT FOUND OR intent.expires_at<=observed_now OR p_metadata->>'mimetype' IS DISTINCT FROM intent.mime_type
     OR p_metadata->>'size' IS DISTINCT FROM intent.byte_size::text THEN RETURN false; END IF;
  IF intent.used_at IS NOT NULL THEN RETURN intent.used_transaction=pg_current_xact_id(); END IF;
  IF coalesce((SELECT sum((metadata->>'size')::bigint) FROM storage.objects WHERE bucket_id='ugc-media-staging' AND owner_id=member_id::text),0)+intent.byte_size>104857600 THEN RETURN false; END IF;
  IF coalesce((SELECT sum((metadata->>'size')::bigint) FROM storage.objects WHERE bucket_id='ugc-media-staging'),0)+intent.byte_size>1073741824 THEN RETURN false; END IF;
  UPDATE private.profile_media_upload_intents SET used_at=observed_now,used_transaction=pg_current_xact_id() WHERE id=intent.id;
  RETURN true;
END;
$consume$;
REVOKE ALL ON FUNCTION private.consume_profile_media_upload(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.consume_profile_media_upload(text,jsonb) TO authenticated;
CREATE FUNCTION private.may_delete_staged_media(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,private AS $delete_staging$
 SELECT auth.uid() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM private.profile_media_reviews WHERE owner_id=auth.uid() AND object_path=p_name AND status IN('pending','approved','publishing'));
$delete_staging$;
REVOKE ALL ON FUNCTION private.may_delete_staged_media(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.may_delete_staged_media(text) TO authenticated;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('ugc-media-staging','ugc-media-staging',false,52428800,ARRAY['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm']);
CREATE POLICY "Members upload reserved private review media" ON storage.objects FOR INSERT TO authenticated
WITH CHECK(bucket_id='ugc-media-staging' AND owner_id=(SELECT auth.uid())::text
 AND private.consume_profile_media_upload(name,metadata));
CREATE POLICY "Members read their own private review media" ON storage.objects FOR SELECT TO authenticated
USING(bucket_id='ugc-media-staging' AND owner_id=(SELECT auth.uid())::text AND (storage.foldername(name))[1]=(SELECT auth.uid())::text);
CREATE POLICY "Members remove unused private review media" ON storage.objects FOR DELETE TO authenticated
USING(bucket_id='ugc-media-staging' AND owner_id=(SELECT auth.uid())::text AND (storage.foldername(name))[1]=(SELECT auth.uid())::text AND private.may_delete_staged_media(name));
CREATE POLICY "Review uploads are immutable" ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
USING(bucket_id<>'ugc-media-staging') WITH CHECK(bucket_id<>'ugc-media-staging');
CREATE POLICY "Review uploads always require a reservation" ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK(bucket_id<>'ugc-media-staging' OR (owner_id=(SELECT auth.uid())::text AND private.consume_profile_media_upload(name,metadata)));
CREATE POLICY "Review uploads always remain owner private" ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated
USING(bucket_id<>'ugc-media-staging' OR (owner_id=(SELECT auth.uid())::text AND (storage.foldername(name))[1]=(SELECT auth.uid())::text));
CREATE POLICY "Active review uploads cannot be removed" ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
USING(bucket_id<>'ugc-media-staging' OR (owner_id=(SELECT auth.uid())::text AND (storage.foldername(name))[1]=(SELECT auth.uid())::text AND private.may_delete_staged_media(name)));

CREATE FUNCTION private.submit_profile_media_review(p_field text,p_object_path text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $submit$
DECLARE member_id uuid; intent private.profile_media_upload_intents%rowtype; existing_review private.profile_media_reviews%rowtype; asset storage.objects%rowtype; previous text;
BEGIN
  member_id:=private.ugc_require_active_member();
  IF NOT private.ugc_owner_field_allowed(member_id,p_field) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_invalid_media'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ugc-media:'||member_id::text,0));
  SELECT * INTO intent FROM private.profile_media_upload_intents WHERE owner_id=member_id AND object_path=p_object_path AND field=p_field FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_invalid_media'; END IF;
  SELECT * INTO existing_review FROM private.profile_media_reviews WHERE id=intent.id;
  IF FOUND THEN RETURN jsonb_build_object('request_id',existing_review.id,'field',existing_review.field,'status',existing_review.status,'submitted_at',existing_review.submitted_at); END IF;
  IF intent.used_at IS NULL OR intent.used_at<clock_timestamp()-interval '24 hours' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_upload_expired'; END IF;
  SELECT * INTO asset FROM storage.objects WHERE bucket_id='ugc-media-staging' AND name=intent.object_path AND owner_id=member_id::text FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_upload_not_found'; END IF;
  IF asset.metadata->>'mimetype' IS DISTINCT FROM intent.mime_type OR asset.metadata->>'size' IS DISTINCT FROM intent.byte_size::text THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_invalid_media'; END IF;
  IF EXISTS(SELECT 1 FROM private.profile_media_reviews WHERE owner_id=member_id AND field=p_field AND status IN('pending','approved','publishing')) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='ugc_media_review_exists'; END IF;
  SELECT to_jsonb(p)->>p_field INTO previous FROM public.profiles p WHERE id=member_id;
  INSERT INTO private.profile_media_reviews(id,owner_id,field,object_path,source_object_id,source_fingerprint,mime_type,byte_size,prior_value)
  VALUES(intent.id,member_id,p_field,p_object_path,asset.id,md5((to_jsonb(asset)-'last_accessed_at')::text),intent.mime_type,intent.byte_size,previous) RETURNING * INTO existing_review;
  INSERT INTO private.moderation_notice_outbox(event_type,item_id,due_at) VALUES('media_pending',intent.id,existing_review.due_at);
  RETURN jsonb_build_object('request_id',intent.id,'field',p_field,'status','pending','submitted_at',existing_review.submitted_at);
END;
$submit$;
REVOKE ALL ON FUNCTION private.submit_profile_media_review(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.submit_profile_media_review(text,text) TO authenticated;
CREATE FUNCTION public.submit_profile_media_review(p_field text,p_object_path text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $wrapper$ SELECT private.submit_profile_media_review(p_field,p_object_path); $wrapper$;
REVOKE ALL ON FUNCTION public.submit_profile_media_review(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.submit_profile_media_review(text,text) TO authenticated;

CREATE FUNCTION private.my_profile_media_reviews() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $own_status$
DECLARE member_id uuid; result jsonb;
BEGIN
  member_id:=private.ugc_require_active_member();
  SELECT coalesce(jsonb_agg(jsonb_build_object('request_id',r.id,'field',r.field,'status',r.status,'submitted_at',r.submitted_at,'reviewed_at',r.reviewed_at,'rejection_code',r.rejection_code,'published_value',r.published_value,
    'can_publish',(SELECT publication_active FROM private.ugc_moderation_configuration WHERE singleton) AND (r.status='approved' OR (r.status='publishing' AND r.claim_expires_at<=clock_timestamp()))) ORDER BY r.submitted_at DESC),'[]'::jsonb)
  INTO result FROM (SELECT DISTINCT ON(field) * FROM private.profile_media_reviews WHERE owner_id=member_id ORDER BY field,submitted_at DESC,id DESC) r;
  RETURN result;
END;
$own_status$;
REVOKE ALL ON FUNCTION private.my_profile_media_reviews() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.my_profile_media_reviews() TO authenticated;
CREATE FUNCTION public.my_profile_media_reviews() RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $wrapper$ SELECT private.my_profile_media_reviews(); $wrapper$;
REVOKE ALL ON FUNCTION public.my_profile_media_reviews() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.my_profile_media_reviews() TO authenticated;

CREATE FUNCTION private.cancel_profile_media_review(p_request_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $cancel_review$
DECLARE member_id uuid; item private.profile_media_reviews%rowtype;
BEGIN
  member_id:=private.ugc_require_active_member();
  SELECT * INTO item FROM private.profile_media_reviews WHERE id=p_request_id AND owner_id=member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
  IF item.status='cancelled' THEN RETURN true; END IF;
  IF item.status NOT IN('pending','approved') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_publication_in_progress'; END IF;
  UPDATE private.profile_media_reviews SET status='cancelled',terminal_at=clock_timestamp() WHERE id=item.id;
  UPDATE private.moderation_notice_outbox SET cancelled_at=clock_timestamp() WHERE event_type='media_pending' AND item_id=item.id AND delivery_id IS NULL AND delivered_at IS NULL;
  RETURN true;
END;
$cancel_review$;
REVOKE ALL ON FUNCTION private.cancel_profile_media_review(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.cancel_profile_media_review(uuid) TO authenticated;
CREATE FUNCTION public.cancel_profile_media_review(p_request_id uuid) RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $wrapper$ SELECT private.cancel_profile_media_review(p_request_id); $wrapper$;
REVOKE ALL ON FUNCTION public.cancel_profile_media_review(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.cancel_profile_media_review(uuid) TO authenticated;

-- Studio-only operator decision. No service/client grant or user_metadata authority.
CREATE FUNCTION private.review_profile_media(p_request_id uuid,p_decision text,p_rejection_code text DEFAULT NULL,p_private_note text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,private AS $owner_review$
DECLARE item private.profile_media_reviews%rowtype;
BEGIN
  IF current_user<>'postgres' OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ugc_owner_review_required'; END IF;
  SELECT * INTO item FROM private.profile_media_reviews WHERE id=p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ugc_review_not_found'; END IF;
  PERFORM id FROM public.profiles WHERE id=item.owner_id FOR SHARE;
  SELECT * INTO item FROM private.profile_media_reviews WHERE id=p_request_id FOR UPDATE;
  IF item.status<>'pending' OR p_decision IS NULL OR p_decision NOT IN('approved','rejected')
    OR char_length(coalesce(p_private_note,''))>2000 OR (p_decision='rejected' AND (p_rejection_code IS NULL OR p_rejection_code NOT IN('inappropriate_content','privacy_or_consent','unsafe_file','other'))) THEN RAISE EXCEPTION 'ugc_invalid_review_decision'; END IF;
  IF NOT EXISTS(SELECT 1 FROM storage.objects x WHERE x.id=item.source_object_id AND x.bucket_id='ugc-media-staging' AND x.name=item.object_path AND md5((to_jsonb(x)-'last_accessed_at')::text)=item.source_fingerprint) THEN RAISE EXCEPTION 'ugc_review_asset_changed'; END IF;
  UPDATE private.profile_media_reviews SET status=p_decision,reviewed_at=clock_timestamp(),reviewed_by=current_user,rejection_code=CASE WHEN p_decision='rejected' THEN p_rejection_code END,terminal_at=CASE WHEN p_decision='rejected' THEN clock_timestamp() END,private_review_note=p_private_note WHERE id=item.id;
  UPDATE private.moderation_notice_outbox SET cancelled_at=clock_timestamp() WHERE event_type='media_pending' AND item_id=item.id AND delivery_id IS NULL AND delivered_at IS NULL;
  RETURN true;
END;
$owner_review$;
REVOKE ALL ON FUNCTION private.review_profile_media(uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.queue_member_safety_report() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $queue_report$
BEGIN
  INSERT INTO private.member_report_reviews(report_id) VALUES(NEW.id);
  INSERT INTO private.moderation_notice_outbox(event_type,item_id,due_at) SELECT 'safety_report',report_id,due_at FROM private.member_report_reviews WHERE report_id=NEW.id;
  RETURN NEW;
END;
$queue_report$;
REVOKE ALL ON FUNCTION private.queue_member_safety_report() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION private.bound_member_safety_report() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $bound_report$
DECLARE member_id uuid:=auth.uid(); observed_now timestamptz:=clock_timestamp();
BEGIN
  IF member_id IS NULL OR NEW.reporter_id IS DISTINCT FROM member_id OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_report_access_denied'; END IF;
  PERFORM private.ugc_require_active_member();
  PERFORM pg_advisory_xact_lock(hashtextextended('ugc-report:'||member_id::text,0));
  NEW.created_at:=observed_now;
  IF (SELECT count(*) FROM public.user_reports WHERE reporter_id=member_id AND created_at>observed_now-interval '1 hour')>=5
    OR (SELECT count(*) FROM public.user_reports WHERE reporter_id=member_id AND created_at>observed_now-interval '24 hours')>=20 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_rate_limited'; END IF;
  IF EXISTS(SELECT 1 FROM public.user_reports u JOIN private.member_report_reviews r ON r.report_id=u.id WHERE u.reporter_id=member_id AND u.reported_id IS NOT DISTINCT FROM NEW.reported_id AND u.reason=NEW.reason AND u.conversation_id IS NOT DISTINCT FROM NEW.conversation_id AND u.conversation_kind IS NOT DISTINCT FROM NEW.conversation_kind AND r.status IN('new','in_review') AND u.created_at>observed_now-interval '24 hours') THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='ugc_report_already_received'; END IF;
  RETURN NEW;
END;
$bound_report$;
REVOKE ALL ON FUNCTION private.bound_member_safety_report() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ugc_bound_safety_reports BEFORE INSERT ON public.user_reports FOR EACH ROW EXECUTE FUNCTION private.bound_member_safety_report();
CREATE TRIGGER ugc_queue_safety_reports AFTER INSERT ON public.user_reports FOR EACH ROW EXECUTE FUNCTION private.queue_member_safety_report();
CREATE INDEX user_reports_reporter_created_idx ON public.user_reports(reporter_id,created_at DESC);

CREATE FUNCTION private.triage_member_report(p_report_id uuid,p_status text,p_resolution_note text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,private AS $triage$
BEGIN
  IF current_user<>'postgres' OR p_status IS NULL OR p_status NOT IN('in_review','resolved','dismissed')
    OR char_length(coalesce(p_resolution_note,''))>2000 OR (p_status IN('resolved','dismissed') AND char_length(btrim(coalesce(p_resolution_note,'')))=0) THEN RAISE EXCEPTION 'ugc_owner_triage_required'; END IF;
  UPDATE private.member_report_reviews SET status=p_status,reviewed_at=clock_timestamp(),reviewed_by=current_user,resolution_note=p_resolution_note WHERE report_id=p_report_id AND status IN('new','in_review');
  IF NOT FOUND THEN RAISE EXCEPTION 'ugc_report_not_open'; END IF;
  IF p_status IN('resolved','dismissed') THEN UPDATE private.moderation_notice_outbox SET cancelled_at=clock_timestamp() WHERE event_type='safety_report' AND item_id=p_report_id AND delivery_id IS NULL AND delivered_at IS NULL; END IF;
  RETURN true;
END;
$triage$;
REVOKE ALL ON FUNCTION private.triage_member_report(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Publication and notice functions appended below; no legacy media restrictions activate here.

CREATE FUNCTION private.claim_profile_media_publication(p_owner_id uuid,p_request_id uuid,p_claim_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $claim_publication$
DECLARE item private.profile_media_reviews%rowtype; observed_now timestamptz:=clock_timestamp(); destination text; current_value text;
BEGIN
  IF p_owner_id IS NULL OR p_request_id IS NULL OR p_claim_id IS NULL OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
  PERFORM id FROM public.profiles WHERE id=p_owner_id AND suspended_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_owner_id) OR EXISTS(SELECT 1 FROM private.profile_media_owner_lifecycle WHERE owner_id=p_owner_id) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
  SELECT * INTO item FROM private.profile_media_reviews WHERE id=p_request_id AND owner_id=p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
  IF NOT private.ugc_owner_field_allowed(p_owner_id,item.field) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_invalid_media'; END IF;
  IF item.status='published' THEN RETURN jsonb_build_object('requestId',item.id,'status','published','field',item.field,'value',item.published_value); END IF;
  IF NOT(SELECT publication_active FROM private.ugc_moderation_configuration WHERE singleton) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_publication_unavailable'; END IF;
  IF item.status='publishing' AND item.claim_expires_at>observed_now THEN RETURN jsonb_build_object('requestId',item.id,'status','publishing'); END IF;
  IF item.status NOT IN('approved','publishing') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_media_not_approved'; END IF;
  SELECT to_jsonb(p)->>item.field INTO current_value FROM public.profiles p WHERE id=p_owner_id;
  IF current_value IS DISTINCT FROM item.prior_value THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_profile_changed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM storage.objects x WHERE x.id=item.source_object_id AND x.bucket_id='ugc-media-staging' AND x.name=item.object_path AND x.owner_id=p_owner_id::text AND md5((to_jsonb(x)-'last_accessed_at')::text)=item.source_fingerprint) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_invalid_media'; END IF;
  destination:=p_owner_id::text||'/approved-'||item.id::text||'.'||split_part(item.object_path,'.',2);
  UPDATE private.profile_media_reviews SET status='publishing',claim_id=p_claim_id,claim_expires_at=observed_now+interval '5 minutes' WHERE id=item.id;
  RETURN jsonb_build_object('requestId',item.id,'status','claimed','field',item.field,'sourceBucket','ugc-media-staging','sourcePath',item.object_path,'targetBucket',CASE WHEN item.field='video_path' THEN 'coffee-videos' ELSE 'cafe-images' END,'targetPath',destination,'mimeType',item.mime_type,'byteSize',item.byte_size);
END;
$claim_publication$;
REVOKE ALL ON FUNCTION private.claim_profile_media_publication(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.claim_profile_media_publication(uuid,uuid,uuid) TO service_role;
CREATE FUNCTION public.claim_profile_media_publication(p_owner_id uuid,p_request_id uuid,p_claim_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog BEGIN ATOMIC SELECT private.claim_profile_media_publication(p_owner_id,p_request_id,p_claim_id); END;
REVOKE ALL ON FUNCTION public.claim_profile_media_publication(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_profile_media_publication(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION private.finish_profile_media_publication(p_owner_id uuid,p_request_id uuid,p_claim_id uuid,p_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $finish_publication$
DECLARE item private.profile_media_reviews%rowtype; destination text; published text; target_bucket text; current_value text;
BEGIN
  IF p_owner_id IS NULL OR p_request_id IS NULL OR p_claim_id IS NULL OR p_sha256 IS NULL OR p_sha256!~'^[a-f0-9]{64}$' OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
  PERFORM id FROM public.profiles WHERE id=p_owner_id AND suspended_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_owner_id) OR EXISTS(SELECT 1 FROM private.profile_media_owner_lifecycle WHERE owner_id=p_owner_id) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
  SELECT * INTO item FROM private.profile_media_reviews WHERE id=p_request_id AND owner_id=p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
  IF NOT private.ugc_owner_field_allowed(p_owner_id,item.field) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_invalid_media'; END IF;
  IF item.status='published' AND item.published_sha256=p_sha256 THEN RETURN jsonb_build_object('requestId',item.id,'status','published','field',item.field,'value',item.published_value); END IF;
  IF item.status<>'publishing' OR item.claim_id IS DISTINCT FROM p_claim_id OR item.claim_expires_at<=clock_timestamp()
    OR NOT(SELECT publication_active FROM private.ugc_moderation_configuration WHERE singleton) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_publication_in_progress'; END IF;
  SELECT to_jsonb(p)->>item.field INTO current_value FROM public.profiles p WHERE id=p_owner_id;
  IF current_value IS DISTINCT FROM item.prior_value THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_profile_changed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM storage.objects x WHERE x.id=item.source_object_id AND x.bucket_id='ugc-media-staging' AND x.name=item.object_path AND md5((to_jsonb(x)-'last_accessed_at')::text)=item.source_fingerprint) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_invalid_media'; END IF;
  destination:=p_owner_id::text||'/approved-'||item.id::text||'.'||split_part(item.object_path,'.',2);
  target_bucket:=CASE WHEN item.field='video_path' THEN 'coffee-videos' ELSE 'cafe-images' END;
  IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id=target_bucket AND name=destination AND metadata->>'mimetype'=item.mime_type AND metadata->>'size'=item.byte_size::text) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_invalid_media'; END IF;
  published:=CASE WHEN item.field='video_path' THEN destination ELSE 'https://lmwqrxoitraofaftpwhe.supabase.co/storage/v1/object/public/cafe-images/'||destination END;
  -- Status changes first, within this transaction, so the restrictive profile trigger sees the exact approved publication.
  UPDATE private.profile_media_reviews SET status='published',claim_id=NULL,claim_expires_at=NULL,published_value=published,published_sha256=p_sha256,published_at=clock_timestamp(),terminal_at=clock_timestamp() WHERE id=item.id;
  IF item.field='avatar_url' THEN UPDATE public.profiles SET avatar_url=published,updated_at=clock_timestamp() WHERE id=p_owner_id;
  ELSIF item.field='bar_picture_url' THEN UPDATE public.profiles SET bar_picture_url=published,updated_at=clock_timestamp() WHERE id=p_owner_id;
  ELSE UPDATE public.profiles SET video_path=published,updated_at=clock_timestamp() WHERE id=p_owner_id; END IF;
  RETURN jsonb_build_object('requestId',item.id,'status','published','field',item.field,'value',published);
END;
$finish_publication$;
REVOKE ALL ON FUNCTION private.finish_profile_media_publication(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.finish_profile_media_publication(uuid,uuid,uuid,text) TO service_role;
CREATE FUNCTION public.finish_profile_media_publication(p_owner_id uuid,p_request_id uuid,p_claim_id uuid,p_sha256 text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog BEGIN ATOMIC SELECT private.finish_profile_media_publication(p_owner_id,p_request_id,p_claim_id,p_sha256); END;
REVOKE ALL ON FUNCTION public.finish_profile_media_publication(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.finish_profile_media_publication(uuid,uuid,uuid,text) TO service_role;

CREATE FUNCTION private.fail_profile_media_publication(p_owner_id uuid,p_request_id uuid,p_claim_id uuid,p_unsafe boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $fail_publication$
BEGIN
  PERFORM id FROM public.profiles WHERE id=p_owner_id FOR UPDATE;
  UPDATE private.profile_media_reviews SET status=CASE WHEN p_unsafe IS TRUE THEN 'rejected' ELSE 'approved' END,
    rejection_code=CASE WHEN p_unsafe IS TRUE THEN 'unsafe_file' END,terminal_at=CASE WHEN p_unsafe IS TRUE THEN clock_timestamp() END,claim_id=NULL,claim_expires_at=NULL
    WHERE id=p_request_id AND owner_id=p_owner_id AND status='publishing' AND claim_id=p_claim_id;
  RETURN FOUND;
END;
$fail_publication$;
REVOKE ALL ON FUNCTION private.fail_profile_media_publication(uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.fail_profile_media_publication(uuid,uuid,uuid,boolean) TO service_role;
CREATE FUNCTION public.fail_profile_media_publication(p_owner_id uuid,p_request_id uuid,p_claim_id uuid,p_unsafe boolean DEFAULT false) RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog BEGIN ATOMIC SELECT private.fail_profile_media_publication(p_owner_id,p_request_id,p_claim_id,p_unsafe); END;
REVOKE ALL ON FUNCTION public.fail_profile_media_publication(uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fail_profile_media_publication(uuid,uuid,uuid,boolean) TO service_role;

CREATE FUNCTION private.claim_moderation_notices(p_claim_id uuid,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $notice_claim$
DECLARE group_row private.moderation_notice_deliveries%rowtype; observed_now timestamptz:=clock_timestamp(); items jsonb; hour_slot timestamptz; attention_count integer;
BEGIN
  IF p_claim_id IS NULL OR p_limit IS NULL OR p_limit<1 OR p_limit>25 OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ugc_invalid_notice_claim'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ugc-notice-delivery',0));
  observed_now:=clock_timestamp();
  UPDATE private.moderation_notice_deliveries SET status='needs_attention',claim_id=NULL,claim_expires_at=NULL
    WHERE status='pending' AND first_attempt_at<=observed_now-interval '23 hours' AND (claim_expires_at IS NULL OR claim_expires_at<=observed_now);
  SELECT count(*)::integer INTO attention_count FROM private.moderation_notice_deliveries WHERE status='needs_attention';
  SELECT * INTO group_row FROM private.moderation_notice_deliveries WHERE status='pending' AND claim_id=p_claim_id AND claim_expires_at>observed_now FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO group_row FROM private.moderation_notice_deliveries WHERE status='pending' AND first_attempt_at>observed_now-interval '23 hours' AND (claim_id IS NULL OR claim_expires_at<=observed_now) ORDER BY first_attempt_at,id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      hour_slot:=date_trunc('hour',observed_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
      IF EXISTS(SELECT 1 FROM private.moderation_notice_deliveries WHERE utc_hour=hour_slot)
         OR NOT EXISTS(SELECT 1 FROM private.moderation_notice_outbox WHERE delivery_id IS NULL AND delivered_at IS NULL AND cancelled_at IS NULL) THEN RETURN jsonb_build_object('claimId',p_claim_id,'items','[]'::jsonb,'needsAttentionCount',attention_count); END IF;
      INSERT INTO private.moderation_notice_deliveries(utc_hour,first_attempt_at) VALUES(hour_slot,observed_now) RETURNING * INTO group_row;
      UPDATE private.moderation_notice_outbox SET delivery_id=group_row.id WHERE id IN
        (SELECT id FROM private.moderation_notice_outbox WHERE delivery_id IS NULL AND delivered_at IS NULL AND cancelled_at IS NULL ORDER BY due_at,created_at,id LIMIT p_limit FOR UPDATE);
      UPDATE private.moderation_notice_deliveries SET first_attempt_at=clock_timestamp() WHERE id=group_row.id RETURNING * INTO group_row;
    END IF;
    UPDATE private.moderation_notice_deliveries SET claim_id=p_claim_id,claim_expires_at=observed_now+interval '5 minutes' WHERE id=group_row.id RETURNING * INTO group_row;
  END IF;
  SELECT jsonb_agg(jsonb_build_object('noticeId',id,'eventType',event_type,'createdAt',created_at,'dueAt',due_at) ORDER BY due_at,created_at,id) INTO items FROM private.moderation_notice_outbox WHERE delivery_id=group_row.id;
  RETURN jsonb_build_object('claimId',p_claim_id,'deliveryId',group_row.id,'firstAttemptAt',group_row.first_attempt_at,'items',items,'needsAttentionCount',attention_count);
END;
$notice_claim$;
REVOKE ALL ON FUNCTION private.claim_moderation_notices(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.claim_moderation_notices(uuid,integer) TO service_role;
CREATE FUNCTION public.claim_moderation_notices(p_claim_id uuid,p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog BEGIN ATOMIC SELECT private.claim_moderation_notices(p_claim_id,p_limit); END;
REVOKE ALL ON FUNCTION public.claim_moderation_notices(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_moderation_notices(uuid,integer) TO service_role;

CREATE FUNCTION private.ack_moderation_notices(p_claim_id uuid,p_notice_ids uuid[],p_delivered boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $notice_ack$
DECLARE group_row private.moderation_notice_deliveries%rowtype; expected uuid[]; actual uuid[]; result integer;
BEGIN
  IF p_claim_id IS NULL OR p_notice_ids IS NULL OR p_delivered IS NULL OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ugc_invalid_notice_ack'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ugc-notice-delivery',0));
  SELECT * INTO group_row FROM private.moderation_notice_deliveries WHERE status='pending' AND claim_id=p_claim_id AND claim_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT array_agg(id ORDER BY id) INTO expected FROM private.moderation_notice_outbox WHERE delivery_id=group_row.id;
  SELECT array_agg(x ORDER BY x) INTO actual FROM unnest(p_notice_ids) x;
  IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'ugc_invalid_notice_ack'; END IF;
  IF p_delivered THEN
    UPDATE private.moderation_notice_outbox SET delivered_at=clock_timestamp() WHERE delivery_id=group_row.id;
    GET DIAGNOSTICS result=ROW_COUNT;
    UPDATE private.moderation_notice_deliveries SET status='delivered',delivered_at=clock_timestamp(),claim_id=NULL,claim_expires_at=NULL WHERE id=group_row.id;
  ELSE
    result:=cardinality(expected);
    UPDATE private.moderation_notice_deliveries SET claim_id=NULL,claim_expires_at=NULL WHERE id=group_row.id;
  END IF;
  RETURN result;
END;
$notice_ack$;
REVOKE ALL ON FUNCTION private.ack_moderation_notices(uuid,uuid[],boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.ack_moderation_notices(uuid,uuid[],boolean) TO service_role;
CREATE FUNCTION public.ack_moderation_notices(p_claim_id uuid,p_notice_ids uuid[],p_delivered boolean) RETURNS integer LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog BEGIN ATOMIC SELECT private.ack_moderation_notices(p_claim_id,p_notice_ids,p_delivered); END;
REVOKE ALL ON FUNCTION public.ack_moderation_notices(uuid,uuid[],boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ack_moderation_notices(uuid,uuid[],boolean) TO service_role;

CREATE FUNCTION private.moderation_notice_summary() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,private AS $notice_summary$
 SELECT jsonb_build_object('pending',count(*),'overdue',count(*) FILTER(WHERE due_at<now()),'oldestCreatedAt',min(created_at),'oldestDueAt',min(due_at),'needsAttentionCount',(SELECT count(*) FROM private.moderation_notice_deliveries WHERE status='needs_attention'))
 FROM private.moderation_notice_outbox WHERE delivered_at IS NULL AND cancelled_at IS NULL;
$notice_summary$;
REVOKE ALL ON FUNCTION private.moderation_notice_summary() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.moderation_notice_summary() TO service_role;
CREATE FUNCTION public.moderation_notice_summary() RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog BEGIN ATOMIC SELECT private.moderation_notice_summary(); END;
REVOKE ALL ON FUNCTION public.moderation_notice_summary() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.moderation_notice_summary() TO service_role;

CREATE FUNCTION private.claim_staged_media_cleanup(p_claim_id uuid,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $cleanup_claim$
DECLARE observed_now timestamptz:=clock_timestamp(); items jsonb;
BEGIN
  IF p_claim_id IS NULL OR p_limit IS NULL OR p_limit<1 OR p_limit>25 OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ugc_invalid_cleanup_claim'; END IF;
  IF EXISTS(SELECT 1 FROM private.profile_media_upload_intents WHERE cleanup_claim_id=p_claim_id AND cleanup_claim_expires_at>observed_now AND staged_deleted_at IS NULL) THEN
    SELECT jsonb_agg(jsonb_build_object('uploadId',id,'ownerId',owner_id,'objectPath',object_path) ORDER BY created_at,id) INTO items FROM private.profile_media_upload_intents WHERE cleanup_claim_id=p_claim_id AND cleanup_claim_expires_at>observed_now AND staged_deleted_at IS NULL;
    RETURN jsonb_build_object('claimId',p_claim_id,'items',items);
  END IF;
  -- Eligibility is monotonic: no member operation resurrects terminal reviews or reuses an expired intent.
  WITH candidates AS (
    SELECT i.id FROM private.profile_media_upload_intents i
    LEFT JOIN private.profile_media_reviews r ON r.id=i.id
    WHERE i.staged_deleted_at IS NULL AND (i.cleanup_claim_id=p_claim_id OR i.cleanup_claim_id IS NULL OR i.cleanup_claim_expires_at<=observed_now)
      AND ((r.id IS NULL AND i.expires_at<observed_now-interval '24 hours')
        OR (r.status IN('rejected','cancelled','published') AND r.terminal_at<observed_now-interval '7 days'))
      AND EXISTS(SELECT 1 FROM storage.objects x WHERE x.bucket_id='ugc-media-staging' AND x.name=i.object_path AND x.owner_id=i.owner_id::text)
    ORDER BY i.created_at,i.id LIMIT p_limit FOR UPDATE OF i SKIP LOCKED
  ) UPDATE private.profile_media_upload_intents i SET cleanup_claim_id=p_claim_id,cleanup_claim_expires_at=observed_now+interval '5 minutes' FROM candidates c WHERE i.id=c.id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('uploadId',i.id,'ownerId',i.owner_id,'objectPath',i.object_path) ORDER BY i.created_at,i.id),'[]'::jsonb)
  INTO items FROM private.profile_media_upload_intents i WHERE cleanup_claim_id=p_claim_id AND cleanup_claim_expires_at>observed_now AND staged_deleted_at IS NULL;
  RETURN jsonb_build_object('claimId',p_claim_id,'items',items);
END;
$cleanup_claim$;
REVOKE ALL ON FUNCTION private.claim_staged_media_cleanup(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.claim_staged_media_cleanup(uuid,integer) TO service_role;
CREATE FUNCTION public.claim_staged_media_cleanup(p_claim_id uuid,p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog BEGIN ATOMIC SELECT private.claim_staged_media_cleanup(p_claim_id,p_limit); END;
REVOKE ALL ON FUNCTION public.claim_staged_media_cleanup(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_staged_media_cleanup(uuid,integer) TO service_role;

CREATE FUNCTION private.ack_staged_media_cleanup(p_claim_id uuid,p_upload_ids uuid[],p_deleted boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $cleanup_ack$
DECLARE affected integer;
BEGIN
  IF p_claim_id IS NULL OR p_upload_ids IS NULL OR cardinality(p_upload_ids)>25 OR p_deleted IS NULL OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ugc_invalid_cleanup_ack'; END IF;
  UPDATE private.profile_media_upload_intents AS intent SET staged_deleted_at=CASE WHEN p_deleted THEN clock_timestamp() ELSE staged_deleted_at END,cleanup_claim_id=NULL,cleanup_claim_expires_at=NULL
    WHERE intent.id=ANY(p_upload_ids) AND intent.cleanup_claim_id=p_claim_id AND intent.cleanup_claim_expires_at>clock_timestamp()
      AND (NOT p_deleted OR NOT EXISTS(SELECT 1 FROM storage.objects x WHERE x.bucket_id='ugc-media-staging' AND x.name=intent.object_path AND x.owner_id=intent.owner_id::text));
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END;
$cleanup_ack$;
REVOKE ALL ON FUNCTION private.ack_staged_media_cleanup(uuid,uuid[],boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.ack_staged_media_cleanup(uuid,uuid[],boolean) TO service_role;
CREATE FUNCTION public.ack_staged_media_cleanup(p_claim_id uuid,p_upload_ids uuid[],p_deleted boolean) RETURNS integer LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog BEGIN ATOMIC SELECT private.ack_staged_media_cleanup(p_claim_id,p_upload_ids,p_deleted); END;
REVOKE ALL ON FUNCTION public.ack_staged_media_cleanup(uuid,uuid[],boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ack_staged_media_cleanup(uuid,uuid[],boolean) TO service_role;

CREATE FUNCTION private.begin_profile_media_account_deletion(p_owner_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $begin_media_deletion$
BEGIN
  IF p_owner_id IS NULL OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
  -- Auth first prevents direct Auth-deletion deadlocks; publication never waits on an Auth row lock.
  PERFORM id FROM auth.users WHERE id=p_owner_id FOR KEY SHARE;
  IF NOT FOUND THEN RETURN true; END IF;
  PERFORM id FROM public.profiles WHERE id=p_owner_id FOR UPDATE;
  INSERT INTO private.profile_media_owner_lifecycle(owner_id) VALUES(p_owner_id) ON CONFLICT(owner_id) DO NOTHING;
  RETURN true;
END;
$begin_media_deletion$;
REVOKE ALL ON FUNCTION private.begin_profile_media_account_deletion(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.begin_profile_media_account_deletion(uuid) TO service_role;
CREATE FUNCTION public.begin_profile_media_account_deletion(p_owner_id uuid) RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog BEGIN ATOMIC SELECT private.begin_profile_media_account_deletion(p_owner_id); END;
REVOKE ALL ON FUNCTION public.begin_profile_media_account_deletion(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_profile_media_account_deletion(uuid) TO service_role;

CREATE FUNCTION private.guard_profile_media_storage_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $storage_lifecycle$
DECLARE owner_text text; owner_uuid uuid; review_id uuid; item private.profile_media_reviews%rowtype; profile_present boolean;
BEGIN
  IF NEW.bucket_id NOT IN('ugc-media-staging','cafe-images','coffee-videos') THEN RETURN NEW; END IF;
  owner_text:=split_part(NEW.name,'/',1);
  IF owner_text!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN RETURN NEW; END IF;
  owner_uuid:=owner_text::uuid;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
  PERFORM id FROM public.profiles WHERE id=owner_uuid FOR SHARE;
  profile_present:=FOUND;
  -- This remains present if a profile alone is removed; it cascades only when Auth is deleted.
  IF EXISTS(SELECT 1 FROM private.profile_media_owner_lifecycle WHERE owner_id=owner_uuid) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
  IF NEW.bucket_id IN('cafe-images','coffee-videos') AND NEW.name~'^[0-9a-f-]{36}/approved-[0-9a-f-]{36}\.(jpg|png|webp|mp4|mov|webm)$' THEN
    IF NOT profile_present OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=owner_uuid)
       OR current_setting('role',true) NOT IN('none','postgres','service_role') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ugc_media_access_denied'; END IF;
    IF TG_OP='UPDATE' AND NEW.bucket_id=OLD.bucket_id AND NEW.name=OLD.name AND NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id AND NEW.metadata IS NOT DISTINCT FROM OLD.metadata THEN RETURN NEW; END IF;
    BEGIN review_id:=substring(split_part(NEW.name,'/',2) FROM 10 FOR 36)::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_invalid_media'; END;
    SELECT * INTO item FROM private.profile_media_reviews WHERE id=review_id AND owner_id=owner_uuid FOR SHARE;
    IF NOT FOUND OR item.status<>'publishing' OR item.claim_expires_at<=clock_timestamp()
      OR NOT(SELECT publication_active FROM private.ugc_moderation_configuration WHERE singleton)
      OR NOT private.ugc_owner_field_allowed(owner_uuid,item.field)
      OR NEW.bucket_id IS DISTINCT FROM (CASE WHEN item.field='video_path' THEN 'coffee-videos' ELSE 'cafe-images' END)
      OR NEW.name IS DISTINCT FROM owner_uuid::text||'/approved-'||item.id::text||'.'||split_part(item.object_path,'.',2)
      OR NEW.metadata->>'mimetype' IS DISTINCT FROM item.mime_type OR NEW.metadata->>'size' IS DISTINCT FROM item.byte_size::text
      OR NOT EXISTS(SELECT 1 FROM storage.objects x WHERE x.id=item.source_object_id AND x.bucket_id='ugc-media-staging' AND x.name=item.object_path AND md5((to_jsonb(x)-'last_accessed_at')::text)=item.source_fingerprint) THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_invalid_media';
    END IF;
    NEW.owner_id:=owner_uuid::text;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$storage_lifecycle$;
REVOKE ALL ON FUNCTION private.guard_profile_media_storage_lifecycle() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ugc_storage_lifecycle BEFORE INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION private.guard_profile_media_storage_lifecycle();

NOTIFY pgrst,'reload schema';
