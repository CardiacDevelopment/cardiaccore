// GET /api/calendar/events
// Fetches up to two iCal feeds in parallel (Google + Apple), expands recurring
// events inside a [-7 days, +30 days] window, returns a merged sorted list.
//
// Env vars (either may be missing — endpoint still works with one feed):
//   ICAL_FEED_GOOGLE   public iCal URL for the Google calendar
//   ICAL_FEED_APPLE    public iCal URL for the Apple/iCloud calendar
//
// Failure handling: one bad/down feed does not block the other. We return
// whatever succeeded, with a `errors` array listing per-feed failures.

const { fetchAndExpand } = require('../_lib/ical');
const { applyCors } = require('../_lib/notion');

// Window: a week back (for in-progress multi-day events) through 30 days
// forward (the day strip + week-ahead lookahead the UI uses).
const BACK_DAYS = 7;
const FWD_DAYS = 30;

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const now = new Date();
  // Anchor the window on UTC midnight so it's stable across requests within a day.
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const windowStart = todayMs - BACK_DAYS * 86400000;
  const windowEnd   = todayMs + FWD_DAYS * 86400000;

  const feeds = [
    { name: 'google', url: process.env.ICAL_FEED_GOOGLE },
    { name: 'apple',  url: process.env.ICAL_FEED_APPLE  },
  ].filter(f => f.url && f.url.trim());

  if (feeds.length === 0) {
    res.status(200).json({
      events: [],
      errors: [{ feed: 'config', error: 'No ICAL_FEED_* env vars set' }],
      window: { start: windowStart, end: windowEnd },
    });
    return;
  }

  const results = await Promise.allSettled(
    feeds.map(f => fetchAndExpand(f.url, windowStart, windowEnd))
  );

  const events = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const ev of r.value) events.push(ev);
    } else {
      errors.push({ feed: feeds[i].name, error: r.reason && r.reason.message || String(r.reason) });
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
