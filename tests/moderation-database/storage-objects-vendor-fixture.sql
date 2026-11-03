-- Synthetic Storage table overlay: exact15 columns/defaults/generated expression
-- and vendor trigger bodies captured read-only 2026-11-03 15:29:19Z.
-- Synthetic base PK/FK/unique constraints and roles are retained. This is not a
-- complete Storage-server schema or hosted service integration.
CREATE TABLE storage.objects(
id uuid DEFAULT gen_random_uuid() NOT NULL,
bucket_id text,
name text,
owner uuid,
created_at timestamp with time zone DEFAULT now(),
updated_at timestamp with time zone DEFAULT now(),
last_accessed_at timestamp with time zone DEFAULT now(),
metadata jsonb,
path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/'::text)) STORED,
version text,
owner_id text,
user_metadata jsonb,
archived_at timestamp with time zone,
is_delete_marker boolean DEFAULT false NOT NULL,
is_versioned boolean DEFAULT false NOT NULL,
 PRIMARY KEY(id), UNIQUE(bucket_id,name), FOREIGN KEY(bucket_id) REFERENCES storage.buckets(id));
-- VENDOR ROUTINES
CREATE OR REPLACE FUNCTION storage.protect_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    -- Check if storage.allow_delete_query is set to 'true'
    IF COALESCE(current_setting('storage.allow_delete_query', true), 'false') != 'true' THEN
        RAISE EXCEPTION 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
            USING HINT = 'This prevents accidental data loss from orphaned objects.',
                  ERRCODE = '42501';
    END IF;
    RETURN NULL;
END;
$function$;

CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();

CREATE OR REPLACE FUNCTION storage.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW; 
END;
$function$;

CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();
