-- Migration: 20261009124000_drop_legacy_paid_tables.sql
-- Clean up legacy paid rooms, held files, and references following migration to 100% free Cloudflare R2 storage.

-- 1. Update cleanup RPC function to remove references to public.paid_rooms
CREATE OR REPLACE FUNCTION public.get_expired_handoff_files()
RETURNS TABLE (name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, storage
AS $$
  SELECT o.name
  FROM storage.objects o
  WHERE o.bucket_id = 'handoff-files'
    AND o.created_at < NOW() - INTERVAL '15 minutes';
$$;

GRANT EXECUTE ON FUNCTION public.get_expired_handoff_files() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_expired_handoff_files() TO anon;

-- 2. Drop legacy storage RLS policies that referenced paid_rooms
DROP POLICY IF EXISTS "Enforce free tier limit unless paid" ON storage.objects;
DROP POLICY IF EXISTS "Allow anonymous upload to room folder" ON storage.objects;

-- 3. Remove paid_rooms from Supabase Realtime publication if present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'paid_rooms'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.paid_rooms;
  END IF;
END $$;

-- 4. Drop legacy empty tables
DROP TABLE IF EXISTS public.paid_rooms CASCADE;
DROP TABLE IF EXISTS public.held_files CASCADE;
