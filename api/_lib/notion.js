// Shared Notion API helpers. Single-user mode: token comes from env vars.
// Used by all /api/notion/* serverless functions.

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function getConfig() {
  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!token) throw new Error('NOTION_TOKEN env var is not set');
  if (!databaseId) throw new Error('NOTION_DATABASE_ID env var is not set');
  // Strip dashes — Notion accepts both, but the canonical form is no-dash.
  return { token, databaseId: databaseId.replace(/-/g, '') };
}

async function notionFetch(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(data.message || `Notion API ${res.status}`);
    err.status = res.status;
    err.notion = data;
    throw err;
  }
  return data;
}

// Read-side canonicalization only. Notion's "Aquisitions" typo has since been
// corrected to "Acquisitions", so the old write-side alias was translating a
// correct name INTO a misspelling that no longer exists as an option — every
// edit to one of those tasks made Notion mint a duplicate. Writing now uses
// the app's name verbatim, which is exactly what Notion offers.
//
// The other two entries migrate categories Notion has since split: "Cardiac"
// became Ops / Products-Projects, and "Property Management" became Home /
// Rentals. Mapping on read means a legacy row lands on the new name, and the
// next edit writes the new name back, retiring the old option naturally.
const CATEGORY_FROM_NOTION = {
  'Aquisitions': 'Acquisitions',
  'Cardiac': 'Cardiac Ops',
  'Property Management': 'Property Management: Home',
};
const CATEGORY_TO_NOTION = {};
const canonicalCategory = name => CATEGORY_FROM_NOTION[name] || name;
const notionCategoryName = name => CATEGORY_TO_NOTION[name] || name;

// Convert a Notion page object into our task shape.
// Property names match the schema in user memory: Task, Due Date, Status, Select, Project.
function pageToTask(page) {
  const props = page.properties || {};

  const title = (props['Task']?.title || [])
    .map(t => t.plain_text)
    .join('')
    .trim();

  const dueDate = props['Due Date']?.date?.start || null;

  const status = props['Status']?.status?.name || 'Not started';
  const completed = status === 'Done';

  // "Select" in user's schema is actually multi-select (categories).
  const categories = (props['Select']?.multi_select || []).map(s => canonicalCategory(s.name));
  const category = categories[0] || 'Brain Dump';

  const project = props['Project']?.select?.name || null;

  return {
    id: page.id,
    title,
    completed,
    status,
    dueDate,
    category,
    categories,
    project,
    dayOffset: dueDateToDayOffset(dueDate),
    lastEditedTime: page.last_edited_time,
    url: page.url,
  };
}

// Days between today (local midnight) and the due date. null -> 999 (Someday).
function dueDateToDayOffset(dueDate) {
  if (!dueDate) return 999;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  return Math.round((due - today) / (1000 * 60 * 60 * 24));
}

// Build property payload for create/update.
function taskToProperties(task) {
  const props = {};
  if (task.text != null) {
    props['Task'] = { title: [{ text: { content: String(task.text) } }] };
  }
  if (task.completed != null) {
    // The app only models done/not-done, but Notion's Status has five options.
    // Writing "Not started" for anything unchecked used to erase Backburner /
    // Up Next / In progress — and not just on a toggle: the daily rollover
    // pushes every overdue task, so an Up Next task lost its status simply by
    // sitting there. Leave Status alone when the task is already in one of
    // those open states; only Done and a genuine un-complete are written.
    if (task.completed) {
      props['Status'] = { status: { name: 'Done' } };
    } else if (!task.status || task.status === 'Done') {
      props['Status'] = { status: { name: 'Not started' } };
    }
  }
  if (task.category) {
    // "Select" is a multi-select and some tasks carry two or three options.
    // The app manages the first one; everything after it is Notion-side data
    // it knows nothing about, so preserve it instead of writing a 1-item array
    // and silently dropping the rest.
    const primary = notionCategoryName(task.category);
    const extras = Array.isArray(task.categories)
      ? task.categories.slice(1).map(notionCategoryName).filter(n => n !== primary)
      : [];
    props['Select'] = { multi_select: [primary, ...extras].map(name => ({ name })) };
  }
  if (task.dayOffset != null && task.dayOffset !== 999) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + task.dayOffset);
    props['Due Date'] = { date: { start: d.toISOString().slice(0, 10) } };
  } else if (task.dayOffset === 999) {
    props['Due Date'] = { date: null };
  }
  return props;
}

// Tiny CORS helper. Same-origin in production, but keeps local dev painless.
function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

module.exports = {
  getConfig,
  notionFetch,
  pageToTask,
  taskToProperties,
  applyCors,
};
