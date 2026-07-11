## Hub Tab & Editorial Dashboard

The desktop dashboard now has a **Hub** tab that pulls the day together in one
screen: weather, markets, sports scores, calendar count, task count, and a
categorized digest of newsletter emails. The whole desktop app was also
re-skinned to a muted "editorial dark green" palette with Barlow Condensed
display type. **Mobile is untouched** — it keeps its original neon green
identity.

### The Hub

A new sidebar tab in `body.desktop-mode` between Dashboard and Today. Sections:

- **Hero** — day and date in Barlow Condensed, plus live counts of today's
  incomplete tasks and calendar events.
- **Weather + Markets row** — bridges to the existing dashboard globals
  (`weatherData`, `marketQuotes`), so no duplicate fetches.
- **Sports** — Braves (MLB), UGA (NCAAF), Ravens (NFL) scorecards fetched
  client-side from ESPN's public JSON. Shows last game result and next game.
  One team failing does not block the others.
- **News** — newsletters from a whitelist of senders, categorized into
  Finance / AI & Tech / Faith / Daily & Life / Sports News. Each card shows
  subject, receipt time, Gmail's auto-generated snippet, and a "View in
  Gmail" deep link.
- **Sources bar** — live list of senders that delivered today, plus dimmed
  entries for any that errored.
- **Footer** — cross message.

Auto-refresh: newsletters every 15 min, sports every 10 min. Weather and
markets ride the existing dashboard timers.

### Gmail integration

Read-only Gmail access via Google OAuth. Single-user, refresh-token-based
(same pattern as Notion — long-lived token stored on Vercel).

Whitelist of newsletter senders lives in `api/gmail/newsletters.js`:

| Category | Senders |
|---|---|
| Finance | Morning Brew, The Average Joe, Value Line, PLANSPONSOR |
| AI & Tech | The Rundown AI, TLDR Data, The Code |
| Faith | The Pour Over |
| Daily & Life | 1440 Daily Digest, Tim Ferriss, James Clear |
| Sports News | Baseball Reference |

The endpoint fetches the most recent message (within `newer_than:2d`) per
sender in parallel, using Gmail's metadata format (subject, from, date,
snippet). **No summarization** — cards render Gmail's snippet directly.

Backend layer:
- **`api/_lib/google.js`** — OAuth helper. Refreshes access tokens on demand
  from the stored refresh token. In-module cache to save round-trips on
  warm Vercel invocations. No new dependencies.
- **`api/google/auth.js`** — one-time OAuth start route. Redirects to Google
  consent screen with `gmail.readonly` scope and `prompt=consent` to
  guarantee a `refresh_token`.
- **`api/google/callback.js`** — one-time OAuth callback. Exchanges the
  authorization code and displays the resulting `refresh_token` in an HTML
  page with a copy button.
- **`api/gmail/newsletters.js`** — `GET`, returns
  `{ items, byCategory, errors, fetchedAt }`. CDN-cached 15 min with 1h SWR.

### One-time OAuth setup

1. Google Cloud Console → new project → enable Gmail API
2. OAuth consent screen → External → add your Gmail as a Test User
3. Credentials → OAuth 2.0 Client ID → Web app → authorized redirect URI:
   `https://cardiaccore.vercel.app/api/google/callback`
4. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to Vercel and redeploy
5. Visit `/api/google/auth`, click through consent, copy the refresh token
   from the callback page
6. Add `GOOGLE_REFRESH_TOKEN` to Vercel and redeploy once more

### Editorial theme override

All desktop styling flows through CSS variables. A single `body.desktop-mode`
override block flips the whole dashboard to the editorial palette without
touching the mobile view:

| Variable | Mobile | Desktop |
|---|---|---|
| `--bg-primary` | `#1a1a1a` | `#141a0f` |
| `--bg-secondary` | `#0a0a0a` | `#0d1008` |
| `--text-primary` | `#ffffff` | `#f0f5e8` |
| `--text-secondary` | `#888888` | `#8aab60` |
| `--border-color` | `#333333` | `rgba(99,153,34,0.18)` |
| `--task-bg` | `#252525` | `#1a2213` |
| `--accent-green` | `#00ff66` (neon) | `#97c459` (editorial) |
| `--accent-green-dark` | `#00cc52` | `#639922` |

Typography overrides layer on top: Barlow for body copy, Barlow Condensed
with letterspacing for display type (logo, sidebar nav, dashboard day
heading, tab titles, widget titles, settings labels).

### Environment variables

Added:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

### Files

| File | Change |
|------|--------|
| `index.html` | Hub tab HTML + scoped CSS + render module; editorial theme override for `body.desktop-mode`; Barlow font links in head; sidebar Hub button; localStorage migration for old `briefing` tab id |
| `api/_lib/google.js` | New: Google OAuth token refresh + Gmail fetch wrapper |
| `api/google/auth.js` | New: OAuth start redirect (`gmail.readonly` scope) |
| `api/google/callback.js` | New: OAuth callback with refresh-token copy page |
| `api/gmail/newsletters.js` | New: `GET`, returns whitelisted senders' latest messages grouped by category |

---

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
