// Shared helpers for cross-device calendar-event check state.
//
// A "checked off" calendar event is stored as one row in a dedicated Notion
// database so the state follows the user across devices instead of living only
// in per-device localStorage. Reuses NOTION_TOKEN; the DB id comes from its own
// env var so it stays independent of the tasks database.
//
// Schema (created in Notion, shared with the internal integration):
//   Event : title      — the event's human-readable title (for legibility)
//   Key   : rich_text  — the client's stable calEventKey(); the match key
//
// Used only by api/calendar/events.js (folded in to stay within Vercel's
// Hobby-plan 12-function limit — this is a lib, not a serverless function).

const { notionFetch } = require('./notion');

function getCalChecksConfig() {
  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_CAL_CHECKS_DB_ID;
  if (!token) throw new Error('NOTION_TOKEN env var is not set');
  if (!databaseId) throw new Error('NOTION_CAL_CHECKS_DB_ID env var is not set');
  return { token, databaseId: databaseId.replace(/-/g, '') };
}

// Whether cross-device calendar checks are configured. Lets the endpoint (and
// client) treat this as an optional feature that silently no-ops until the
// Notion DB + env var are wired up — same activation model as habits.
function calChecksEnabled() {
  return !!(process.env.NOTION_TOKEN && process.env.NOTION_CAL_CHECKS_DB_ID);
}

function readKey(page) {
  const rt = page.properties?.['Key']?.rich_text || [];
  return rt.map(t => t.plain_text).join('').trim();
}

// Return the set of checked event keys as a plain array. Paginated with a
// safety cap; a checked-event set is small in practice.
async function listChecks({ token, databaseId }) {
  const keys = [];
  let cursor;
  let pages = 0;
  const MAX_PAGES = 10; // 100/page → 1000 checked events safety cap

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`/databases/${databaseId}/query`, {
      token,
      method: 'POST',
      body,
    });
    for (const page of data.results || []) {
      if (page.archived) continue;
      const key = readKey(page);
      if (key) keys.push(key);
    }
    cursor = data.has_more ? data.next_cursor : null;
    pages += 1;
  } while (cursor && pages < MAX_PAGES);

  return keys;
}

// Find every non-archived row whose Key equals `key`.
async function findRowsByKey({ token, databaseId }, key) {
  const data = await notionFetch(`/databases/${databaseId}/query`, {
    token,
    method: 'POST',
    body: {
      page_size: 100,
      filter: { property: 'Key', rich_text: { equals: key } },
    },
  });
  return (data.results || []).filter(p => !p.archived);
}

// Idempotently set the checked state for one event key.
//   checked=true  → ensure exactly one row exists (create if missing)
//   checked=false → archive every matching row
async function setCheck(cfg, { key, title, checked }) {
  const { token, databaseId } = cfg;
  if (!key) throw new Error('key is required');

  const existing = await findRowsByKey(cfg, key);

  if (checked) {
    if (existing.length > 0) return { key, checked: true, changed: false };
    await notionFetch('/pages', {
      token,
      method: 'POST',
      body: {
        parent: { database_id: databaseId },
        properties: {
          'Event': { title: [{ text: { content: String(title || key).slice(0, 200) } }] },
          'Key': { rich_text: [{ text: { content: String(key).slice(0, 200) } }] },
        },
      },
    });
    return { key, checked: true, changed: true };
  }

  // Uncheck: archive all matches (defensive against dupes).
  for (const page of existing) {
    await notionFetch(`/pages/${page.id}`, {
      token,
      method: 'PATCH',
      body: { archived: true },
    });
  }
  return { key, checked: false, changed: existing.length > 0 };
}

module.exports = {
  getCalChecksConfig,
  calChecksEnabled,
  listChecks,
  setCheck,
};
