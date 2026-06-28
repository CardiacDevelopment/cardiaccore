## Calendar Integration & Time-Blocked Day View

The day view now supports per-task start times and read-only Google/Apple
calendar events, rendered together on a single chronological timeline.

### Task start times
- Each task can have an optional `startTime` (`"HH:MM"`, 24h), set via the edit
  modal's time picker (15-minute increments).
- Timed tasks anchor chronologically; untimed ("floating") tasks keep their
  manual drag order and slot into the gaps between timed items.
- `startTime` is **local-only** and is never pushed to Notion. The existing
  `dayOffset` ↔ Notion `Due Date` behavior is unchanged: rescheduling a task to
  another day still syncs to Notion, but giving it a time of day does not.

### Calendar feeds (iCal)
- Read-only integration via public iCal (`.ics`) URLs from Google Calendar and
  Apple/iCloud. No OAuth.
- Managed entirely in-app under **Settings → Calendars** (no redeploy to add or
  change calendars):
  - Add a calendar with a name, iCal URL, and color
  - Rename, recolor, enable/disable, or remove any calendar
  - Per-feed error messages surface inline if a feed fails to load
- Calendar list is stored in `localStorage` under `cardiacCalendars`. The client
  owns the list and sends it to the backend on each fetch.
- Events refresh on app load and every 5 minutes.

### Rendering
- **Timed events** are interleaved with timed tasks in chronological order.
  They're read-only: no checkbox, no swipe, no drag. Tapping an event opens it
  in its source calendar.
- **All-day events** appear in a pinned banner above the task list. Multi-day
  events show a "Day N/total" badge. The banner takes no space when empty.
- Each event is colored and labeled by its source calendar.

### Backend (`/api/calendar/events`)
- `POST` endpoint. Body: `{ feeds: [{ id, url }], tz }`.
- Fetches each feed in parallel, expands recurring events, and returns a merged,
  sorted list with per-event `calendarId` tags and a per-feed `errors` array.
- `webcal://` URLs are normalized to `https://`; only `https` is allowed.
- Window: 7 days back through 30 days forward. Max 20 feeds per request.

### iCal parser (`api/_lib/ical.js`)
Dependency-free RFC 5545 parser supporting:
- Line unfolding, `VALARM` skipping, escaped text
- `DATE`, UTC `DATETIME` (`Z`), and floating `DATETIME` values
- All-day and multi-day events (inclusive end-date handling)
- `RRULE` expansion (`DAILY`/`WEEKLY`/`MONTHLY`/`YEARLY` with `INTERVAL`,
  `COUNT`, `UNTIL`, `BYDAY`), `EXDATE` exclusions, and fast-forward for old
  unbounded recurrences

**Timezone handling:** UTC (`Z`) event times are converted to the user's local
wall-clock time using the browser's IANA timezone (sent with each request,
falling back to `America/New_York`). Conversion is DST-aware via `Intl` and
shifts the event's date when a UTC instant lands on a different local day.

### Removed
- Pull-to-refresh on the day view (unreliable and easy to trigger by accident).
  Data refreshes via the 5-minute calendar poll, the Notion auto-sync on load,
  and the "Pull from Notion" button in Settings.

### Environment variables
The previous `ICAL_FEED_GOOGLE` / `ICAL_FEED_APPLE` env vars are **no longer
used** — calendars are now configured in-app. They can be removed from the
deployment.

### Files
| File | Change |
|------|--------|
| `index.html` | Time picker, calendar manager UI, merged timeline rendering, timezone-aware fetch |
| `api/calendar/events.js` | New: POST endpoint, feed validation, per-event tagging |
| `api/_lib/ical.js` | New: RFC 5545 parser with recurrence + timezone conversion |
