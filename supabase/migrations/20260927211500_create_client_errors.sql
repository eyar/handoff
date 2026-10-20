-- Migration: 20260927211500_create_client_errors.sql
-- Table for anonymous, ephemeral client error telemetry

CREATE TABLE IF NOT EXISTS public.client_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type VARCHAR(50) NOT NULL,
  error_message TEXT NOT NULL,
  error_details JSONB DEFAULT '{}'::jsonb,
  room_id VARCHAR(10),
  user_agent TEXT
);

-- Index for fast sorting by created_at and cleanup
CREATE INDEX IF NOT EXISTS idx_client_errors_created_at ON public.client_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_errors_room_id ON public.client_errors (room_id);

-- Enable Row-Level Security
ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;

-- Allow anonymous users to INSERT error reports
DROP POLICY IF EXISTS "Allow anon insert to client_errors" ON public.client_errors;
CREATE POLICY "Allow anon insert to client_errors"
ON public.client_errors FOR INSERT TO anon
WITH CHECK (true);
