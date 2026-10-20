-- Migration: 20260927214500_create_client_errors_notify_trigger.sql
-- Trigger to dispatch an asynchronous HTTP POST via pg_net to the notify-telemetry edge function

CREATE OR REPLACE FUNCTION public.trigger_notify_client_error()
RETURNS TRIGGER AS $$
DECLARE
  edge_url text := 'https://kljzghiiovsvymixqgrf.supabase.co/functions/v1/notify-telemetry';
  payload jsonb;
BEGIN
  -- Construct payload matching webhook format
  payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', row_to_json(NEW)
  );

  -- Asynchronously post via pg_net (non-blocking, never delays the client insert)
  PERFORM net.http_post(
    url := edge_url,
    body := payload,
    headers := '{"Content-Type": "application/json"}'::jsonb
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never abort or fail the user's error insert if notification dispatch fails
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Re-create trigger on client_errors
DROP TRIGGER IF EXISTS trg_client_errors_notify ON public.client_errors;
CREATE TRIGGER trg_client_errors_notify
AFTER INSERT ON public.client_errors
FOR EACH ROW
EXECUTE FUNCTION public.trigger_notify_client_error();
