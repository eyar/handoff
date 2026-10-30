-- Adds the 'unpaired' event: a visit still not paired after a minute, and whether it reached the server.

ALTER TABLE public.usage_events DROP CONSTRAINT IF EXISTS usage_events_event_check;
ALTER TABLE public.usage_events
  ADD CONSTRAINT usage_events_event_check CHECK (event IN ('visit', 'paired', 'transfer', 'unpaired'));
