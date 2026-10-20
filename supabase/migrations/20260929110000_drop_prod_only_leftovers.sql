-- Bring production in line with the repo. These objects exist only on prod
-- (created outside the migration files) and nothing in the app uses them.
-- cleanup_old_handoff_files is SECURITY DEFINER and callable by anon, so anyone
-- could delete every handoff-files object older than 15 minutes, including paid
-- files that should live 30. cleanup-storage already handles expiry correctly.

-- Unschedule any pg_cron jobs that call the functions being dropped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE command ILIKE '%cleanup_old_handoff_files%'
       OR command ILIKE '%cleanup_expired_tokens%';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.cleanup_old_handoff_files();
DROP FUNCTION IF EXISTS public.cleanup_expired_tokens();
DROP TABLE IF EXISTS public.upload_tokens;

-- Prod also granted these to authenticated and matched on a name regex.
-- Recreate them as in init.sql: anon only, room folder check.
DROP POLICY IF EXISTS "Allow anonymous read from room folder" ON storage.objects;
CREATE POLICY "Allow anonymous read from room folder"
ON storage.objects FOR SELECT TO anon
USING (
  bucket_id = 'handoff-files'
  AND (storage.foldername(name))[1] ~ '^[a-z0-9]{10}$'
);

DROP POLICY IF EXISTS "Allow anonymous delete from room folder" ON storage.objects;
CREATE POLICY "Allow anonymous delete from room folder"
ON storage.objects FOR DELETE TO anon
USING (
  bucket_id = 'handoff-files'
  AND (storage.foldername(name))[1] ~ '^[a-z0-9]{10}$'
);
