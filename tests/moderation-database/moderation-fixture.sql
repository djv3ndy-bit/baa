-- Synthetic local PG17 fixture, real catalog-derived column/default shapes; no customer records.
CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA private;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;
GRANT USAGE ON SCHEMA private TO authenticated;
REVOKE USAGE ON SCHEMA private FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION auth.uid(),auth.jwt() TO anon,authenticated,service_role;

CREATE TABLE public.profiles(id uuid NOT NULL,
role text NOT NULL,
display_name text,
cafe_name text,
location text,
bio text,
skills text[] DEFAULT '{}'::text[] NOT NULL,
availability text,
experience text,
pay_expectation text,
video_path text,
avatar_url text,
updated_at timestamptz DEFAULT now() NOT NULL,
preferred_city text,
preferred_state text,
preferred_postal_code text,
preferred_radius_miles integer DEFAULT 25,
preferred_latitude double precision,
preferred_longitude double precision,
is_discoverable boolean DEFAULT false NOT NULL,
verification_status text DEFAULT 'unverified'::text NOT NULL,
suspended_at timestamptz,
trust_updated_at timestamptz DEFAULT now() NOT NULL,
cafe_address text,
open_hours text,
shop_type text,
barista_preferences text[] DEFAULT '{}'::text[] NOT NULL,
bar_picture_url text,
created_at timestamptz DEFAULT now() NOT NULL,
visible_to_cafes boolean DEFAULT false NOT NULL,
PRIMARY KEY(id),
FOREIGN KEY(id) REFERENCES auth.users(id) ON DELETE CASCADE,
CHECK(role IN('barista','cafe_owner_manager')));
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.jobs(id uuid DEFAULT gen_random_uuid() NOT NULL,
owner_id uuid NOT NULL,
title text NOT NULL,
location text NOT NULL,
pay_min numeric,
pay_max numeric,
schedule text,
description text NOT NULL,
required_skills text[] DEFAULT '{}'::text[] NOT NULL,
active boolean DEFAULT true NOT NULL,
created_at timestamptz DEFAULT now() NOT NULL,
updated_at timestamptz DEFAULT now() NOT NULL,
address_line1 text,
address_line2 text,
city text,
state text,
postal_code text,
latitude double precision,
longitude double precision,
PRIMARY KEY(id),
FOREIGN KEY(owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE);
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.user_reports(id uuid DEFAULT gen_random_uuid() NOT NULL,
reporter_id uuid NOT NULL,
reported_id uuid,
conversation_id text,
conversation_kind text,
reason text NOT NULL,
details text,
created_at timestamptz DEFAULT now() NOT NULL,
PRIMARY KEY(id),
FOREIGN KEY(reporter_id) REFERENCES auth.users(id) ON DELETE CASCADE,
FOREIGN KEY(reported_id) REFERENCES auth.users(id) ON DELETE SET NULL,
CHECK(reason IN('harassment','spam_or_scam')),
CHECK(conversation_kind IN('discovery','application')));
ALTER TABLE public.user_reports ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.enforce_profile_discoverability()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.suspended_at is not null or not public.profile_meets_visibility_requirements(new) then new.is_discoverable:=false; end if;
  new.trust_updated_at:=now(); return new;
end $function$;

CREATE OR REPLACE FUNCTION public.profile_meets_visibility_requirements(p public.profiles)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.protect_profile_authorization_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.verification_status := 'unverified';
      new.suspended_at := null;
      new.trust_updated_at := null;
    elsif new.id is distinct from old.id
       or new.role is distinct from old.role
       or new.verification_status is distinct from old.verification_status
       or new.suspended_at is distinct from old.suspended_at
       or new.trust_updated_at is distinct from old.trust_updated_at then
      raise exception 'Protected account fields cannot be changed';
    end if;
  end if;
  return new;
end;
$function$;

CREATE TRIGGER protect_profile_authorization_fields BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.protect_profile_authorization_fields();
CREATE TRIGGER trg_enforce_profile_discoverability BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_discoverability();

CREATE POLICY own_profile ON public.profiles FOR ALL TO authenticated USING(id=auth.uid()) WITH CHECK(id=auth.uid());
CREATE POLICY own_jobs ON public.jobs FOR ALL TO authenticated USING(owner_id=auth.uid()) WITH CHECK(owner_id=auth.uid());
CREATE POLICY own_reports ON public.user_reports FOR INSERT TO authenticated WITH CHECK(reporter_id=auth.uid() AND reported_id IS DISTINCT FROM auth.uid() AND char_length(coalesce(details,''))<=2000);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.profiles,public.jobs TO authenticated;
GRANT INSERT ON public.user_reports TO authenticated;
CREATE TABLE storage.buckets(id text PRIMARY KEY,name text NOT NULL,public boolean NOT NULL DEFAULT false,file_size_limit bigint,allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text REFERENCES storage.buckets(id),name text NOT NULL,owner_id text,metadata jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),last_accessed_at timestamptz,UNIQUE(bucket_id,name));
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$SELECT string_to_array($1,'/')$$;
GRANT SELECT ON storage.buckets TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;
GRANT ALL ON storage.objects,storage.buckets TO service_role;
CREATE POLICY legacy_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id IN('cafe-images','coffee-videos') AND owner_id=auth.uid()::text);
CREATE POLICY legacy_update ON storage.objects FOR UPDATE TO authenticated USING(bucket_id IN('cafe-images','coffee-videos') AND owner_id=auth.uid()::text) WITH CHECK(owner_id=auth.uid()::text);
CREATE POLICY legacy_read ON storage.objects FOR SELECT TO authenticated USING(owner_id=auth.uid()::text);
CREATE POLICY legacy_delete ON storage.objects FOR DELETE TO authenticated USING(owner_id=auth.uid()::text);
INSERT INTO storage.buckets VALUES('cafe-images','cafe-images',true,5242880,ARRAY['image/jpeg','image/png','image/webp']),('coffee-videos','coffee-videos',false,52428800,ARRAY['video/mp4','video/quicktime','video/webm']);
