// Minimal iCal (RFC 5545) parser tailored for personal Google/Apple feeds.
//
// Handles:
//   - Line unfolding (continuation lines starting with space/tab)
//   - VEVENT extraction (skipping nested VALARM components)
//   - DTSTART/DTEND in DATE, DATETIME (UTC Z), DATETIME with TZID, and floating forms
//   - All-day events with inclusive endDate computed from DTEND (which is exclusive per spec)
//   - RRULE expansion for FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL, BYDAY
//   - EXDATE exclusions
//   - Fast-forward into the requested window for unbounded recurrences (no COUNT)
//
// Known limitations (documented for the personal version, accepted as trade-offs):
//   - TZID timezones treated as wall-clock local time (single-tz user assumed)
//   - RECURRENCE-ID overrides (modified single instances) are skipped
//   - Complex RRULE parts (BYSETPOS, BYWEEKNO, BYMONTHDAY, BYMONTH) ignored
//   - Multi-day timed events emit only on their start day
//
// Returned event shape:
//   {
//     uid, title, location, url,
//     allDay: bool,
//     date: "YYYY-MM-DD",                 // first day the event belongs to
//     endDate: "YYYY-MM-DD",              // inclusive last day (= date unless multi-day all-day)
//     start: "YYYY-MM-DDTHH:MM:SS" | null, // null for all-day
//     end:   "YYYY-MM-DDTHH:MM:SS" | null,
//   }

// ── Low-level parsing helpers ──────────────────────────────────────────

// Unfold per RFC 5545 §3.1: a line starting with space or tab is a
// continuation of the previous line, with the leading whitespace removed.
function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '');
}

// Parse "NAME[;PARAM=val;...]:VALUE" into { name, params, value }.
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.substring(0, colon);
  const value = line.substring(colon + 1);
  const semi = head.indexOf(';');
  const name = (semi < 0 ? head : head.substring(0, semi)).toUpperCase();
  const params = {};
  if (semi >= 0) {
    for (const part of head.substring(semi + 1).split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) params[part.substring(0, eq).toUpperCase()] = part.substring(eq + 1);
    }
  }
  return { name, params, value };
}

// Unescape iCal TEXT values per RFC 5545 §3.3.11.
function unescape(s) {
  if (!s) return '';
  return s
    .replace(/\\[nN]/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// Walk the unfolded calendar text and return raw VEVENT records.
// Each record is a plain object keyed by uppercase property name. EXDATE is
// special-cased to an array since it can repeat.
function parseRawEvents(text) {
  const lines = unfold(text).split(/\r?\n/);
  const events = [];
  let current = null;
  let nestedDepth = 0; // skip VALARM and other nested components

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      nestedDepth = 0;
    } else if (line === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
    } else if (current) {
      if (line.startsWith('BEGIN:')) { nestedDepth++; continue; }
      if (line.startsWith('END:'))   { if (nestedDepth > 0) nestedDepth--; continue; }
      if (nestedDepth > 0) continue;
      const parsed = parseLine(line);
      if (!parsed) continue;
      if (parsed.name === 'EXDATE') {
        if (!current.EXDATE) current.EXDATE = [];
        for (const v of parsed.value.split(',')) {
          current.EXDATE.push({ value: v, params: parsed.params });
        }
      } else {
        // Last-write-wins for non-repeating props. RECURRENCE-ID is silently
        // overridden by us picking the master VEVENT; modified instances of
        // recurrences are out of scope for v1.
        current[parsed.name] = { value: parsed.value, params: parsed.params };
      }
    }
  }
  return events;
}

// ── Date parsing ────────────────────────────────────────────────────────

// Parse an iCal date or datetime value into a structured object.
//   DATE        → { allDay: true,  year, month, day }
//   DATETIME Z  → { allDay: false, year, month, day, hour, minute, second, tz: 'utc' }
//   DATETIME    → { allDay: false, year, month, day, hour, minute, second, tz: 'local' }
function parseDateValue(value, params) {
  if (!value) return null;
  const dateOnly = (params && params.VALUE === 'DATE') || /^\d{8}$/.test(value);
  if (dateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!m) return null;
    return { allDay: true, year: +m[1], month: +m[2], day: +m[3] };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return null;
  return {
    allDay: false,
    year: +m[1], month: +m[2], day: +m[3],
    hour: +m[4], minute: +m[5], second: +m[6],
    tz: m[7] === 'Z' ? 'utc' : 'local',
  };
}

// Convert a parsed date/datetime to a UTC epoch ms value, used for arithmetic
// and window comparisons. "Local" times are pretended-UTC — the conversion is
// consistent inside the parser, and the rendered output keeps wall-clock form
// so the client localizes naturally.
function toUTCMs(p) {
  if (!p) return NaN;
  if (p.allDay) return Date.UTC(p.year, p.month - 1, p.day);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

const pad2 = n => String(n).padStart(2, '0');

function formatDate(p) {
  if (!p) return null;
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function formatDateTime(p) {
  if (!p || p.allDay) return null;
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

// Date math. All operations preserve the "allDay" flag and time components.
function addDays(p, n) {
  const ms = toUTCMs(p) + n * 86400000;
  const d = new Date(ms);
  return p.allDay
    ? { allDay: true, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
    : { allDay: false, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
        hour: p.hour, minute: p.minute, second: p.second, tz: p.tz };
}

function addMonths(p, n) {
  let m = p.month - 1 + n;
  let y = p.year + Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { ...p, year: y, month: m + 1, day: Math.min(p.day, lastDay) };
}

function addYears(p, n) {
  // Clamp Feb 29 → Feb 28 in non-leap years
  const lastDay = new Date(Date.UTC(p.year + n, p.month, 0)).getUTCDate();
  return { ...p, year: p.year + n, day: Math.min(p.day, lastDay) };
}

function dayOfWeek(p) {
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

const DOW_MAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// ── RRULE parsing ──────────────────────────────────────────────────────

function parseRRule(value) {
  const out = {};
  if (!value) return out;
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.substring(0, eq).toUpperCase()] = part.substring(eq + 1);
  }
  return out;
}

// Skip recurrence instances that are clearly before the window start, without
// iterating one step at a time. Only safe when there's no COUNT (since COUNT
// requires exact emission accounting). Returns the first instance >= window.
function fastForward(p, freq, interval, windowStartMs) {
  if (toUTCMs(p) >= windowStartMs) return p;
  if (freq === 'DAILY') {
    const days = Math.floor((windowStartMs - toUTCMs(p)) / 86400000);
    const units = Math.floor(days / interval);
    return units > 0 ? addDays(p, units * interval) : p;
  }
  if (freq === 'WEEKLY') {
    const weekMs = 7 * 86400000 * interval;
    const units = Math.floor((windowStartMs - toUTCMs(p)) / weekMs);
    return units > 0 ? addDays(p, units * 7 * interval) : p;
  }
  if (freq === 'MONTHLY') {
    const w = new Date(windowStartMs);
    const months = (w.getUTCFullYear() - p.year) * 12 + (w.getUTCMonth() + 1 - p.month);
    // Step one short so we don't overshoot; loop walks the rest.
    const units = Math.max(0, Math.floor(months / interval) - 1);
    return units > 0 ? addMonths(p, units * interval) : p;
  }
  if (freq === 'YEARLY') {
    const w = new Date(windowStartMs);
    const units = Math.max(0, Math.floor((w.getUTCFullYear() - p.year) / interval) - 1);
    return units > 0 ? addYears(p, units * interval) : p;
  }
  return p;
}

// ── Event expansion ────────────────────────────────────────────────────

// Expand one VEVENT into concrete event instances inside the given window.
// windowStartMs/windowEndMs are UTC epoch ms (treated as pretend-UTC for
// floating times, see toUTCMs).
function expandEvent(raw, windowStartMs, windowEndMs) {
  const dtstart = raw.DTSTART;
  if (!dtstart) return [];
  const startParsed = parseDateValue(dtstart.value, dtstart.params);
  if (!startParsed) return [];

  const endProp = raw.DTEND;
  const endParsed = endProp ? parseDateValue(endProp.value, endProp.params) : null;
  const durationMs = endParsed ? toUTCMs(endParsed) - toUTCMs(startParsed) : 0;

  const title = unescape(raw.SUMMARY && raw.SUMMARY.value) || '(No title)';
  const location = unescape(raw.LOCATION && raw.LOCATION.value);
  const url = (raw.URL && raw.URL.value) || '';
  const uid = (raw.UID && raw.UID.value) || '';

  // EXDATE keys: for all-day, format as date string; for timed, format with
  // time. Match comparison happens against the same formatter on each instance.
  const excluded = new Set();
  if (raw.EXDATE) {
    for (const ex of raw.EXDATE) {
      const p = parseDateValue(ex.value, ex.params);
      if (p) excluded.add(p.allDay ? formatDate(p) : formatDateTime(p));
    }
  }

  // Build a single event object from a concrete instance start (and computed end).
  // Returns null if the instance falls fully outside [windowStartMs, windowEndMs].
  const buildEvent = (instParsed) => {
    const instMs = toUTCMs(instParsed);

    // Compute the instance's end (preserving duration from DTSTART→DTEND).
    let instEndParsed = null;
    if (endParsed) {
      const endMs = instMs + durationMs;
      const d = new Date(endMs);
      instEndParsed = instParsed.allDay
        ? { allDay: true, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
        : { allDay: false, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
            hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), tz: instParsed.tz };
    }

    const date = formatDate(instParsed);
    let endDate = date;

    if (instParsed.allDay) {
      // DTEND is exclusive for all-day events. The inclusive last day is one
      // day prior to DTEND. If DTEND is missing, the event spans only DTSTART.
      if (instEndParsed) {
        const lastDay = addDays(instEndParsed, -1);
        endDate = formatDate(lastDay);
      }
      // Window filter for all-day: event overlaps window if its inclusive end
      // is on or after windowStart AND its start is on or before windowEnd.
      const endDayMs = Date.UTC(
        +endDate.substring(0, 4), +endDate.substring(5, 7) - 1, +endDate.substring(8, 10)
      );
      if (endDayMs < windowStartMs) return null;
      if (instMs > windowEndMs) return null;
      return { uid, title, location, url, allDay: true, date, endDate, start: null, end: null };
    }

    // Timed: emit only if start is inside window.
    if (instMs < windowStartMs || instMs > windowEndMs) return null;
    return {
      uid, title, location, url,
      allDay: false,
      date, endDate,
      start: formatDateTime(instParsed),
      end: instEndParsed ? formatDateTime(instEndParsed) : null,
    };
  };

  // Non-recurring: just one instance.
  if (!raw.RRULE) {
    const ev = buildEvent(startParsed);
    return ev ? [ev] : [];
  }

  const rrule = parseRRule(raw.RRULE.value);
  const freq = (rrule.FREQ || '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
    // Unsupported frequency — degrade gracefully by emitting just the master.
    const ev = buildEvent(startParsed);
    return ev ? [ev] : [];
  }

  const interval = Math.max(1, parseInt(rrule.INTERVAL, 10) || 1);
  const count = rrule.COUNT ? parseInt(rrule.COUNT, 10) : null;
  const untilParsed = rrule.UNTIL ? parseDateValue(rrule.UNTIL, {}) : null;
  const untilMs = untilParsed ? toUTCMs(untilParsed) : null;
  const byday = rrule.BYDAY
    ? rrule.BYDAY.split(',')
        .map(d => d.replace(/^[+-]?\d+/, '').toUpperCase())
        .map(d => DOW_MAP[d])
        .filter(n => n != null)
    : null;

  const instances = [];
  const HARD_CAP = 2000; // safety net; fast-forward keeps real walks short
  let emitted = 0;
  let stop = false;

  // Try to emit one instance. Updates emitted/stop. EXDATE matches count toward
  // COUNT but do not emit. Window overshoot stops the whole walk.
  const tryEmit = (instParsed) => {
    if (stop) return;
    if (count != null && emitted >= count) { stop = true; return; }
    const instMs = toUTCMs(instParsed);
    if (untilMs != null && instMs > untilMs) { stop = true; return; }
    if (instMs > windowEndMs) { stop = true; return; }

    const key = instParsed.allDay ? formatDate(instParsed) : formatDateTime(instParsed);
    if (excluded.has(key)) {
      emitted++;
      return;
    }

    const ev = buildEvent(instParsed);
    if (ev) instances.push(ev);
    emitted++;
  };

  // Fast-forward unbounded recurrences so a five-year-old "9am standup" doesn't
  // make us iterate thousands of times before reaching the window.
  const iterStart = (count == null)
    ? fastForward(startParsed, freq, interval, windowStartMs)
    : startParsed;

  if (freq === 'DAILY') {
    let cur = iterStart;
    for (let i = 0; i < HARD_CAP && !stop; i++) {
      tryEmit(cur);
      if (stop) break;
      cur = addDays(cur, interval);
    }
  } else if (freq === 'WEEKLY') {
    const days = (byday && byday.length) ? byday.slice().sort((a, b) => a - b) : [dayOfWeek(startParsed)];
    // Anchor: Sunday of the iterStart's week.
    let weekStart = addDays(iterStart, -dayOfWeek(iterStart));
    for (let i = 0; i < HARD_CAP && !stop; i++) {
      for (const dow of days) {
        if (stop) break;
        const candidate = addDays(weekStart, dow);
        // Don't emit before DTSTART (the iCal anchor) regardless of BYDAY.
        if (toUTCMs(candidate) < toUTCMs(startParsed)) continue;
        tryEmit(candidate);
      }
      weekStart = addDays(weekStart, 7 * interval);
    }
  } else if (freq === 'MONTHLY') {
    let cur = iterStart;
    for (let i = 0; i < HARD_CAP && !stop; i++) {
      tryEmit(cur);
      if (stop) break;
      cur = addMonths(cur, interval);
    }
  } else if (freq === 'YEARLY') {
    let cur = iterStart;
    for (let i = 0; i < HARD_CAP && !stop; i++) {
      tryEmit(cur);
      if (stop) break;
      cur = addYears(cur, interval);
    }
  }

  return instances;
}

// ── High-level fetch+expand ────────────────────────────────────────────

async function fetchAndExpand(url, windowStartMs, windowEndMs) {
  const res = await fetch(url, {
    headers: { 'Accept': 'text/calendar, text/plain, */*' },
  });
  if (!res.ok) {
    const err = new Error(`Feed fetch failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  const raws = parseRawEvents(text);
  const out = [];
  for (const raw of raws) {
    try {
      const expanded = expandEvent(raw, windowStartMs, windowEndMs);
      for (const ev of expanded) out.push(ev);
    } catch (e) {
      // One bad event shouldn't kill the feed. Log and move on.
      console.error('iCal: skipping malformed event:', e && e.message);
    }
  }
  return out;
}

module.exports = {
  // Public
  fetchAndExpand,
  parseRawEvents,
  expandEvent,
  // Exported for testing
  unfold,
  parseLine,
  unescape,
  parseDateValue,
  parseRRule,
  toUTCMs,
  formatDate,
  formatDateTime,
  addDays,
  addMonths,
  addYears,
};
