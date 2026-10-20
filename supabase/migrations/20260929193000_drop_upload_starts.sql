-- The Shortcut upload-start ping (20260929150000_create_upload_starts.sql) was never
-- wired into the iOS Shortcut, so the table stayed empty. Remove it.
DROP TABLE IF EXISTS public.upload_starts;
