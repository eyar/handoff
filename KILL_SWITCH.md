# Emergency Kill Switch & Maintenance Mode

Handoff includes an emergency kill switch system designed to immediately halt file transfers and room activity in the event of unexpected viral traffic or legal/cost exposure.

---

## Quick Reference Table

| Environment | Check Status | Turn Kill Switch ON (Block Traffic) | Turn Kill Switch OFF (Resume Traffic) |
| :--- | :--- | :--- | :--- |
| **Hosted / Prod** | `node scripts/kill-switch.js status` | `node scripts/kill-switch.js on` | `node scripts/kill-switch.js off` |
| **Local** | `node scripts/kill-switch.js status --local` | `node scripts/kill-switch.js on --local` | `node scripts/kill-switch.js off --local` |

---

## npm Shortcuts

```bash
# Production / Hosted
npm run kill-switch:status
npm run kill-switch:on
npm run kill-switch:off

# Local
npm run kill-switch:status local
npm run kill-switch:on -- --local
npm run kill-switch:off -- --local
```

### Custom Maintenance Message

You can provide an optional custom message when toggling the switch ON:

```bash
node scripts/kill-switch.js on "Handoff is temporarily paused for scheduled maintenance. Back shortly!"
```

---

## How It Works Under the Hood

1. **Database Level (Storage RLS)**:
   - Evaluates `public.app_config.value->>'active'` directly inside the `storage.objects` INSERT policy.
   - Any upload attempt is rejected immediately with an HTTP `403 Forbidden` response at Postgres level.

2. **Edge Function Hard Gate**:
   - `r2-sign` and `shortcut-upload` Edge Functions check `public.app_config` before minting presigned URLs or accepting uploads, returning `503 Service Unavailable` if the kill switch is active.

3. **Frontend Realtime Sync**:
   - Web clients subscribe to `app_config` changes via Supabase Realtime broadcast.
   - When activated, all active browser tabs instantly display a top maintenance banner and disable the file dropzone and transfer buttons in real time without requiring a page refresh.
