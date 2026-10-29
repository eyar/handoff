-- Anonymous usage counts: visits, pairings and transfers (see public/modules/usage.js).
-- Each row is an event name and a few coarse buckets: no room id, key, IP, user agent, file name or exact size.
-- Timestamps are rounded down to the hour, and rows are deleted after 90 days by the cleanup-storage function.

CREATE TABLE IF NOT EXISTS public.usage_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('hour', NOW()),
  event VARCHAR(16) NOT NULL CHECK (event IN ('visit', 'paired', 'transfer')),
  props JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(props) = 'object' AND octet_length(props::text) <= 300)
);

CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON public.usage_events (created_at);

-- Clients can't choose the timestamp: it's always the current hour
CREATE OR REPLACE FUNCTION public.usage_events_round_time()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.created_at := date_trunc('hour', NOW());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS usage_events_round_time ON public.usage_events;
CREATE TRIGGER usage_events_round_time
BEFORE INSERT ON public.usage_events
FOR EACH ROW EXECUTE FUNCTION public.usage_events_round_time();

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

-- Anonymous clients may insert, never read.
DROP POLICY IF EXISTS "Allow anon insert to usage_events" ON public.usage_events;
CREATE POLICY "Allow anon insert to usage_events"
ON public.usage_events FOR INSERT TO anon
WITH CHECK (true);
