-- Create or configure the handoff-files storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('handoff-files', 'handoff-files', true, 524288000, null)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 524288000;

-- Drop existing policies if re-running
DROP POLICY IF EXISTS "Allow anonymous upload to room folder" ON storage.objects;
DROP POLICY IF EXISTS "Allow anonymous read from room folder" ON storage.objects;
DROP POLICY IF EXISTS "Allow anonymous delete from room folder" ON storage.objects;

-- Allow anonymous uploads scoped to 10-char room IDs (e.g. handoff-files/{roomId}/{fileId}-{name})
CREATE POLICY "Allow anonymous upload to room folder"
ON storage.objects FOR INSERT TO anon
WITH CHECK (
  bucket_id = 'handoff-files' 
  AND (storage.foldername(name))[1] ~ '^[a-z0-9]{10}$'
);

-- Allow anonymous downloads scoped to room folder
CREATE POLICY "Allow anonymous read from room folder"
ON storage.objects FOR SELECT TO anon
USING (
  bucket_id = 'handoff-files' 
  AND (storage.foldername(name))[1] ~ '^[a-z0-9]{10}$'
);

-- Allow anonymous deletion for room teardown
CREATE POLICY "Allow anonymous delete from room folder"
ON storage.objects FOR DELETE TO anon
USING (
  bucket_id = 'handoff-files' 
  AND (storage.foldername(name))[1] ~ '^[a-z0-9]{10}$'
);

-- RPC for cleanup-storage Edge Function to identify files older than 15 minutes
CREATE OR REPLACE FUNCTION public.get_expired_handoff_files()
RETURNS TABLE (name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, storage
AS $$
  SELECT name
  FROM storage.objects
  WHERE bucket_id = 'handoff-files'
    AND created_at < NOW() - INTERVAL '15 minutes';
$$;

GRANT EXECUTE ON FUNCTION public.get_expired_handoff_files() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_expired_handoff_files() TO anon;
