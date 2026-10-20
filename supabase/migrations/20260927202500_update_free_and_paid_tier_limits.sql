-- Migration: 20260927202500_update_free_and_paid_tier_limits.sql
-- 1. Ensure bucket allows up to 1.5 GB (1,610,612,736 bytes)
UPDATE storage.buckets
SET file_size_limit = 1610612736
WHERE id = 'handoff-files';

-- 2. Drop the redundant open upload policy if it still exists
DROP POLICY IF EXISTS "Allow anonymous upload to room folder" ON storage.objects;
DROP POLICY IF EXISTS "Enforce free tier limit unless paid" ON storage.objects;

-- 3. Recreate the storage upload policy with 200 MB free / 1.5 GB paid limits
CREATE POLICY "Enforce free tier limit unless paid"
ON storage.objects FOR INSERT TO anon
WITH CHECK (
  bucket_id = 'handoff-files'
  AND (storage.foldername(name))[1] ~ '^[a-z0-9]{10}$'
  AND (
    -- Free tier: Files <= 200 MB (209,715,200 bytes) are always allowed
    COALESCE((metadata->>'size')::bigint, 0) <= 209715200
    OR
    -- Paid tier: Files > 200 MB up to 1.5 GB (1,610,612,736 bytes) strictly require verified entry in paid_rooms
    (
      COALESCE((metadata->>'size')::bigint, 0) <= 1610612736
      AND EXISTS (
        SELECT 1 FROM public.paid_rooms
        WHERE room_id = (storage.foldername(name))[1]
      )
    )
  )
);
