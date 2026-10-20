-- Migration: 20260926140000_cleanup_interval_and_paid_rooms.sql
-- 1. Create paid_rooms table if not already created
CREATE TABLE IF NOT EXISTS public.paid_rooms (
  room_id VARCHAR(10) PRIMARY KEY,
  transaction_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Indexes for fast lookup and 2-hour cleanup
CREATE INDEX IF NOT EXISTS idx_paid_rooms_room_id ON public.paid_rooms (room_id);
CREATE INDEX IF NOT EXISTS idx_paid_rooms_created_at ON public.paid_rooms (created_at);

-- 3. Row Level Security for paid_rooms
ALTER TABLE public.paid_rooms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon select on paid_rooms" ON public.paid_rooms;
CREATE POLICY "Allow anon select on paid_rooms"
ON public.paid_rooms FOR SELECT TO anon
USING (true);

-- 4. Enable Supabase Realtime publication for paid_rooms
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'paid_rooms'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.paid_rooms;
  END IF;
END $$;

-- 5. Storage RLS guardrail: Enforce 50 MB upload limit unless paid
DROP POLICY IF EXISTS "Allow anonymous upload to room folder" ON storage.objects;
DROP POLICY IF EXISTS "Enforce free tier limit unless paid" ON storage.objects;

CREATE POLICY "Enforce free tier limit unless paid"
ON storage.objects FOR INSERT TO anon
WITH CHECK (
  bucket_id = 'handoff-files'
  AND (storage.foldername(name))[1] ~ '^[a-z0-9]{10}$'
  AND (
    COALESCE((metadata->>'size')::bigint, 0) <= 52428800
    OR
    EXISTS (
      SELECT 1 FROM public.paid_rooms
      WHERE room_id = (storage.foldername(name))[1]
    )
  )
);

-- 6. RPC for cleanup-storage Edge Function: updated to 10 minutes (instead of 15)
CREATE OR REPLACE FUNCTION public.get_expired_handoff_files()
RETURNS TABLE (name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, storage
AS $$
  SELECT name
  FROM storage.objects
  WHERE bucket_id = 'handoff-files'
    AND created_at < NOW() - INTERVAL '10 minutes';
$$;

GRANT EXECUTE ON FUNCTION public.get_expired_handoff_files() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_expired_handoff_files() TO anon;
