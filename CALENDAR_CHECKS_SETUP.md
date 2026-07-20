# Calendar Event Checks — Cross-Device Sync Setup

Checking off a calendar event now syncs across devices (web ↔ mobile) instead of
staying on one device. The check state is stored as rows in a dedicated Notion
database. Until the two steps below are done, the feature **silently no-ops** and
calendar checks stay per-device (nothing breaks — it just isn't shared yet).

## The database (already created)

**Cardiac Calendar Checks** — `d6966f22ba3949b2b4fb228c1d280b07`

Schema:

| Property | Type      | Purpose                                              |
|----------|-----------|------------------------------------------------------|
| Event    | title     | Human-readable event title (for legibility only)     |
| Key      | rich_text | The app's stable `calEventKey()` — the match key     |

One row = one checked event. Unchecking archives the row. The app manages all
rows; don't edit `Key` by hand.

## Activation (two manual steps)

1. **Share the DB with the internal integration.** In Notion, open **Cardiac
   Calendar Checks** → top-right **⋯** → **Connections** → add the same internal
   integration used by the Task Database and habits (the one behind
   `NOTION_TOKEN`). Without this, the app's token can't read or write the DB.

2. **Add the DB id to Vercel.** In the `cardiaccore` project → Settings →
   Environment Variables, add:

   ```
   NOTION_CAL_CHECKS_DB_ID = d6966f22ba3949b2b4fb228c1d280b07
   ```

   Then redeploy (any push to `main` auto-deploys).

That's it. `NOTION_TOKEN` is reused — no new token needed.

## How it works

- Endpoint: folded into `POST /api/calendar/events` (to stay within Vercel's
  Hobby-plan 12-function limit) via an `action` field:
  - `{action:'listChecks'}` → `{checks:[key,...], enabled}`
  - `{action:'setCheck', key, title, checked}` → create/archive a row
- Server logic: `api/_lib/calendar-checks.js`
- Client: `toggleCalendarEventCheck()` pushes optimistically; `syncCalChecks()`
  pulls the authoritative set on load, on a 45s interval, and on tab focus.
- If `NOTION_CAL_CHECKS_DB_ID` is unset, the endpoint returns `enabled:false`
  and the client falls back to the old localStorage-only behavior.
