// POST /api/calendar/events
// Body: { feeds: [{ id, url }, ...] }
//
// Fetches each iCal feed in parallel, expands recurring events inside a
// [-7 days, +30 days] window, tags every event with its source `calendarId`,
// and returns a merged sorted list.
//
// This endpoint is URL-param driven (not env-var driven): the client owns the
// calendar list (stored in localStorage) and sends it on each request. This is
// a single-user personal app, so the implied "fetch whatever URL you're given"
// behavior is an accepted trade-off. We restrict schemes to https/webcal and
// cap the number of feeds to keep one request bounded.
//
// Failure handling: one bad/down feed does not block the others. We return
// whatever succeeded, with an `errors` array listing per-feed failures keyed
// by calendar id.

const { fetchAndExpand } = require('../_lib/ical');
const { applyCors } = require('../_lib/notion');
const {
  getCalChecksConfig, calChecksEnabled, listChecks, setCheck,
} = require('../_lib/calendar-checks');

// Window: a week back (for in-progress multi-day events) through 30 days
// forward (the day strip + week-ahead lookahead the UI uses).
const BACK_DAYS = 7;
const FWD_DAYS = 30;

// Safety cap: a single request won't fan out to more than this many feeds.
const MAX_FEEDS = 20;

// Normalize and validate a feed URL. Returns a fetchable https URL or null.
//   - webcal:// -> https:// (Apple/iCloud publish webcal links)
//   - http://   -> rejected (avoid mixed-content / downgrade; feeds are https)
//   - anything not http(s)/webcal -> rejected
function normalizeFeedUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url = raw.trim();
  if (!url) return null;
  if (url.startsWith('webcal://')) url = 'https://' + url.slice('webcal://'.length);
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. POST { feeds: [{id,url}] }.' });
    return;
  }

  // Vercel usually parses JSON bodies; fall back to manual parse if needed.
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  // Cross-device calendar-event check state is folded into this endpoint (see
  // api/_lib/calendar-checks.js) to stay within Vercel's 12-function limit.
  // Requests carry an `action`; the original feed-fetch path has none and is
  // left untouched below. When the feature isn't configured yet, list returns
  // an empty set and set is a no-op, so the client degrades to per-device.
  if (body.action === 'listChecks' || body.action === 'setCheck') {
    try {
      if (!calChecksEnabled()) {
        res.status(200).json({ checks: [], enabled: false });
        return;
      }
      const cfg = getCalChecksConfig();
      if (body.action === 'listChecks') {
        const checks = await listChecks(cfg);
        res.status(200).json({ checks, enabled: true });
        return;
      }
      const result = await setCheck(cfg, {
        key: body.key,
        title: body.title,
        checked: !!body.checked,
      });
      res.status(200).json({ ok: true, enabled: true, ...result });
      return;
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, notion: err.notion });
      return;
    }
  }

  const rawFeeds = Array.isArray(body.feeds) ? body.feeds : [];
  // Client sends its IANA timezone so UTC event times convert to the user's
  // wall clock. Falls back to the parser's DEFAULT_TZ if absent/invalid.
  const tz = (body.tz && typeof body.tz === 'string') ? body.tz : undefined;

  const now = new Date();
  // Anchor the window on UTC midnight so it's stable across requests within a day.
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const windowStart = todayMs - BACK_DAYS * 86400000;
  const windowEnd   = todayMs + FWD_DAYS * 86400000;

  // Validate + normalize each feed. Bad URLs become immediate per-feed errors
  // rather than silent drops, so the user can see why a calendar isn't showing.
  const errors = [];
  const validFeeds = [];
  for (const f of rawFeeds.slice(0, MAX_FEEDS)) {
    const id = f && f.id != null ? String(f.id) : '';
    const url = normalizeFeedUrl(f && f.url);
    if (!url) {
      errors.push({ calendarId: id, error: 'Invalid or unsupported feed URL (must be https or webcal)' });
      continue;
    }
    validFeeds.push({ id, url });
  }

  if (validFeeds.length === 0) {
    res.status(200).json({
      events: [],
      errors: errors.length ? errors : [{ calendarId: '', error: 'No feeds provided' }],
      window: { start: windowStart, end: windowEnd },
      count: 0,
    });
    return;
  }

  const results = await Promise.allSettled(
    validFeeds.map(f => fetchAndExpand(f.url, windowStart, windowEnd, tz))
  );

  const events = [];
  results.forEach((r, i) => {
    const feed = validFeeds[i];
    if (r.status === 'fulfilled') {
      for (const ev of r.value) {
        // Tag each event with its source calendar so the client can color and
        // label it. The parser doesn't know about calendars; we stamp here.
        ev.calendarId = feed.id;
        events.push(ev);
      }
    } else {
      errors.push({
        calendarId: feed.id,
        error: (r.reason && r.reason.message) || String(r.reason),
      });
    }
  });

  // Stable sort: all-day events first (they'll be banners), then timed by start.
  // Within all-day, sort by date for consistent banner order.
  events.sort((a, b) => {
    if (a.allDay && !b.allDay) return -1;
    if (!a.allDay && b.allDay) return 1;
    if (a.allDay && b.allDay) return a.date.localeCompare(b.date);
    return String(a.start).localeCompare(String(b.start));
  });

  res.status(200).json({
    events,
    errors,
    window: { start: windowStart, end: windowEnd },
    count: events.length,
  });
};
