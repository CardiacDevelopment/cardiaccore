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

// The "Select" option in the user's Notion DB is misspelled "Aquisitions".
// The app (and its category colors) uses the correct "Acquisitions". Map
// between the two at the API boundary so the typo in Notion doesn't render a
// second, near-identical category group on the board. Reading canonicalizes
// to the app's spelling; writing translates back to Notion's existing option
// name so we reuse it instead of creating a new "Acquisitions" option.
const CATEGORY_FROM_NOTION = { 'Aquisitions': 'Acquisitions' };
const CATEGORY_TO_NOTION = { 'Acquisitions': 'Aquisitions' };
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
    props['Status'] = { status: { name: task.completed ? 'Done' : 'Not started' } };
  }
  if (task.category) {
    props['Select'] = { multi_select: [{ name: notionCategoryName(task.category) }] };
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
