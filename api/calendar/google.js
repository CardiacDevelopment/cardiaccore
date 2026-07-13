// GET /api/calendar/google
// Read-only Google Calendar access, reusing the same Google OAuth token as the
// Gmail features. Two actions (kept in one function to respect Vercel's Hobby
// 12-function limit):
//
//   ?action=list
//       -> { calendars: [{ id, name, color, primary }] }
//       Lists the calendars in the connected Google account.
//
//   ?action=events&ids=<id1>,<id2>&tz=America/New_York
//       -> { events: [...app-shaped events...], errors: [...] }
//       Fetches events for the given calendar ids over the same
//       [-7d, +30d] window the iCal endpoint uses, mapped to the exact shape
//       the app's calendar rendering expects (matches api/_lib/ical.js).
//
// Requires the Calendar scope on GOOGLE_REFRESH_TOKEN — re-run /api/google/auth
// after this ships to grant it (see api/google/auth.js).

const { gmailFetch } = require('../_lib/google');

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const BACK_DAYS = 7;
const FWD_DAYS = 30;
const MAX_CALENDARS = 25;

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// Shift a 'YYYY-MM-DD' string by n days (used for all-day end handling).
function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Google event -> the app's event shape (see api/_lib/ical.js return values).
function toAppEvent(ev, calendarId) {
  if (ev.status === 'cancelled') return null;
  const uid = ev.id;
  const title = ev.summary || '(no title)';
  const location = ev.location || '';
  const url = ev.htmlLink || '';

  // All-day events use start.date / end.date; Google's end.date is exclusive
  // (the day AFTER the last day), so subtract one for an inclusive endDate.
  if (ev.start && ev.start.date) {
    const date = ev.start.date;
    let endDate = date;
    if (ev.end && ev.end.date) endDate = addDaysYmd(ev.end.date, -1);
    if (endDate < date) endDate = date;
    return { uid, title, location, url, allDay: true, date, endDate, start: null, end: null, calendarId };
  }

  // Timed events. We ask Google to return times in the user's tz (timeZone
  // param below), so start.dateTime looks like '2026-07-13T14:00:00-04:00' —
  // slice off the offset to get the local wall-clock string the app wants.
  if (ev.start && ev.start.dateTime) {
    const start = String(ev.start.dateTime).slice(0, 19);
    const end = ev.end && ev.end.dateTime ? String(ev.end.dateTime).slice(0, 19) : null;
    const date = start.slice(0, 10);
    return { uid, title, location, url, allDay: false, date, endDate: date, start, end, calendarId };
  }
  return null;
}

async function listCalendars() {
  const data = await gmailFetch(`${CAL_API}/users/me/calendarList?maxResults=250&minAccessRole=reader`);
  return (data.items || []).map(c => ({
    id: c.id,
    name: c.summaryOverride || c.summary || c.id,
    color: c.backgroundColor || null,
    primary: !!c.primary,
  }));
}

async function fetchEventsFor(ids, tz) {
  const timeMin = new Date(Date.now() - BACK_DAYS * 86400000).toISOString();
  const timeMax = new Date(Date.now() + FWD_DAYS * 86400000).toISOString();
  const events = [];
  const errors = [];

  const results = await Promise.allSettled(ids.map(async (id) => {
    const qs = new URLSearchParams({
      singleEvents: 'true',      // expand recurring events into instances
      orderBy: 'startTime',
      maxResults: '250',
      timeMin, timeMax,
      timeZone: tz,
    });
    const data = await gmailFetch(`${CAL_API}/calendars/${encodeURIComponent(id)}/events?${qs}`);
    return { id, items: data.items || [] };
  }));

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const ev of r.value.items) {
        const mapped = toAppEvent(ev, r.value.id);
        if (mapped) events.push(mapped);
      }
    } else {
      errors.push({ calendarId: ids[i], error: (r.reason && r.reason.message) || String(r.reason) });
    }
  });

  events.sort((a, b) => {
    if (a.allDay && !b.allDay) return -1;
    if (!a.allDay && b.allDay) return 1;
    if (a.allDay && b.allDay) return a.date.localeCompare(b.date);
    return String(a.start).localeCompare(String(b.start));
  });

  return { events, errors };
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const action = (req.query && req.query.action) || 'list';

  try {
    if (action === 'list') {
      const calendars = await listCalendars();
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
      res.status(200).json({ calendars });
      return;
    }

    if (action === 'events') {
      const ids = String((req.query && req.query.ids) || '')
        .split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_CALENDARS);
      const tz = (req.query && req.query.tz) || 'America/New_York';
      if (!ids.length) {
        res.status(200).json({ events: [], errors: [] });
        return;
      }
      const out = await fetchEventsFor(ids, tz);
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
      res.status(200).json(out);
      return;
    }

    res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};
