-- HELD: separate compatibility approval is required after updated clients are staged.
-- This does not change bucket public/private flags or existing approved media values.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $activation_gate$
BEGIN
  IF current_user<>'postgres' OR current_setting('transaction_isolation')<>'read committed'
     OR (SELECT publication_active FROM private.ugc_moderation_configuration WHERE singleton) IS DISTINCT FROM false
     OR NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='cafe-images' AND public)
     OR NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='coffee-videos' AND NOT public) THEN RAISE EXCEPTION 'ugc_activation_baseline_failed'; END IF;
END;
$activation_gate$;

CREATE FUNCTION private.enforce_reviewed_profile_media() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private AS $publication_guard$
DECLARE field_name text; next_value text; old_value text;
BEGIN
  FOREACH field_name IN ARRAY ARRAY['avatar_url','bar_picture_url','video_path'] LOOP
    next_value:=to_jsonb(NEW)->>field_name;
    old_value:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->>field_name ELSE NULL END;
    IF next_value IS NOT DISTINCT FROM old_value OR next_value IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS(SELECT 1 FROM private.profile_media_reviews WHERE owner_id=NEW.id AND field=field_name
       AND status='published' AND published_value=next_value) THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ugc_reviewed_media_required';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$publication_guard$;
REVOKE ALL ON FUNCTION private.enforce_reviewed_profile_media() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ugc_reviewed_profile_media BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION private.enforce_reviewed_profile_media();

-- RESTRICTIVE adds an AND to all existing permissive policies; RLS/service behavior is not widened.
CREATE POLICY "Published media requires approved service copy" ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK(bucket_id NOT IN('cafe-images','coffee-videos'));
CREATE POLICY "Published media is immutable to members" ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
USING(bucket_id NOT IN('cafe-images','coffee-videos')) WITH CHECK(bucket_id NOT IN('cafe-images','coffee-videos'));

UPDATE private.ugc_moderation_configuration SET publication_active=true WHERE singleton;
NOTIFY pgrst,'reload schema';
