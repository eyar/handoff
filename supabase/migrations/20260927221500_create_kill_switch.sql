-- Migration: 20260927221500_create_kill_switch.sql
-- Table for dynamic application settings including Emergency Kill Switch

CREATE TABLE IF NOT EXISTS public.app_config (
  key VARCHAR(50) PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index
CREATE INDEX IF NOT EXISTS idx_app_config_key ON public.app_config (key);

-- Enable RLS
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

-- Allow anonymous read of app configuration
DROP POLICY IF EXISTS "Allow anon select on app_config" ON public.app_config;
CREATE POLICY "Allow anon select on app_config"
ON public.app_config FOR SELECT TO anon
USING (true);

-- Insert default kill_switch configuration (inactive)
INSERT INTO public.app_config (key, value)
VALUES (
  'kill_switch',
  '{"active": false, "message": "Handoff is temporarily paused for maintenance. Please check back shortly."}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- Update Storage RLS policy to enforce kill switch at database level
DROP POLICY IF EXISTS "Enforce free tier limit unless paid" ON storage.objects;
CREATE POLICY "Enforce free tier limit unless paid"
ON storage.objects
FOR INSERT
TO anon
WITH CHECK (
  bucket_id = 'handoff-files'
  AND (storage.foldername(name))[1] ~ '^[a-z0-9]{10}$'
  AND NOT (
    EXISTS (
      SELECT 1 FROM public.app_config
      WHERE key = 'kill_switch' AND (value->>'active')::boolean = true
    )
  )
  AND (
    COALESCE((metadata->>'size')::bigint, 0) <= 209715200 -- 200 MB
    OR (
      COALESCE((metadata->>'size')::bigint, 0) <= 1610612736 -- 1.5 GB
      AND EXISTS (
        SELECT 1 FROM public.paid_rooms
        WHERE paid_rooms.room_id = (storage.foldername(name))[1]
      )
    )
  )
);

-- Enable Realtime publication on app_config so client browsers react immediately
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.app_config;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
