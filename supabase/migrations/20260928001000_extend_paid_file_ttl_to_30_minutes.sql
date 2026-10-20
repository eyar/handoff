-- Migration: 20260928001000_extend_paid_file_ttl_to_30_minutes.sql
-- Extend file storage TTL to 30 minutes for paid rooms, while maintaining 10 minutes for free rooms.

CREATE OR REPLACE FUNCTION public.get_expired_handoff_files()
RETURNS TABLE (name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, storage
AS $$
  SELECT o.name
  FROM storage.objects o
  WHERE o.bucket_id = 'handoff-files'
    AND (
      -- If room is verified in paid_rooms, retain files for 30 minutes
      (
        EXISTS (
          SELECT 1 FROM public.paid_rooms p
          WHERE p.room_id = (storage.foldername(o.name))[1]
        )
        AND o.created_at < NOW() - INTERVAL '30 minutes'
      )
      OR
      -- If room is on standard free tier, retain files for 10 minutes
      (
        NOT EXISTS (
          SELECT 1 FROM public.paid_rooms p
          WHERE p.room_id = (storage.foldername(o.name))[1]
        )
        AND o.created_at < NOW() - INTERVAL '10 minutes'
      )
    );
$$;

GRANT EXECUTE ON FUNCTION public.get_expired_handoff_files() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_expired_handoff_files() TO anon;
