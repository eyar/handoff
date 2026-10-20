-- Hold Shortcut uploads over the free limit until the receiving room pays.
-- The bucket is private and has no anon policies, so the files have no public
-- URL; the release-held-file edge function signs a URL once the room is in paid_rooms.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('handoff-held', 'handoff-held', false, 1610612736, null) -- 1.5 GB
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 1610612736;

CREATE TABLE IF NOT EXISTS public.held_files (
  id TEXT PRIMARY KEY,
  storage_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  size BIGINT,
  room_id VARCHAR(10), -- set at upload for an explicit room, otherwise claimed by the first paid room
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_held_files_created_at ON public.held_files (created_at);

-- RLS on with no policies: only the service role (edge functions) can read or write.
ALTER TABLE public.held_files ENABLE ROW LEVEL SECURITY;
