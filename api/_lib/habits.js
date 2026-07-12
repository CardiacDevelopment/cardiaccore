// Shared helpers for the habit tracker Notion integration.
// Reuses notionFetch / applyCors from ./notion. Two databases:
//   Habits      — habit definitions
//   Habit Logs  — one row per habit per period (day or week)
// Env vars: NOTION_TOKEN (shared), NOTION_HABITS_DB_ID, NOTION_HABIT_LOGS_DB_ID.

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getHabitConfig() {
  const token = process.env.NOTION_TOKEN;
  const habitsDbId = process.env.NOTION_HABITS_DB_ID;
  const logsDbId = process.env.NOTION_HABIT_LOGS_DB_ID;
  if (!token) throw new Error('NOTION_TOKEN env var is not set');
  if (!habitsDbId) throw new Error('NOTION_HABITS_DB_ID env var is not set');
  if (!logsDbId) throw new Error('NOTION_HABIT_LOGS_DB_ID env var is not set');
  return {
    token,
    habitsDbId: habitsDbId.replace(/-/g, ''),
    logsDbId: logsDbId.replace(/-/g, ''),
  };
}

function richText(prop) {
  return (prop?.rich_text || []).map(t => t.plain_text).join('');
}

// ---- Habits -----------------------------------------------------------
function pageToHabit(page) {
  const p = page.properties || {};
  return {
    notionId: page.id,
    name: (p['Name']?.title || []).map(t => t.plain_text).join('').trim(),
    icon: richText(p['Icon']) || '✅',
    color: richText(p['Color']) || '#378ADD',
    type: p['Type']?.select?.name || 'count',
    goal: p['Goal']?.number != null ? p['Goal'].number : 1,
    unit: richText(p['Unit']) || 'x',
    section: p['Section']?.select?.name || 'daily',
    frequency: p['Frequency']?.select?.name || 'daily',
    days: (p['Days']?.multi_select || [])
      .map(s => DOW.indexOf(s.name))
      .filter(i => i >= 0),
    order: p['Order']?.number != null ? p['Order'].number : 0,
    archived: !!(p['Archived']?.checkbox),
  };
}

function habitToProperties(h) {
  const props = {};
  if (h.name != null) props['Name'] = { title: [{ text: { content: String(h.name) } }] };
  if (h.icon != null) props['Icon'] = { rich_text: [{ text: { content: String(h.icon) } }] };
  if (h.color != null) props['Color'] = { rich_text: [{ text: { content: String(h.color) } }] };
  if (h.type != null) props['Type'] = { select: { name: String(h.type) } };
  if (h.goal != null) props['Goal'] = { number: Number(h.goal) };
  if (h.unit != null) props['Unit'] = { rich_text: [{ text: { content: String(h.unit) } }] };
  if (h.section != null) props['Section'] = { select: { name: String(h.section) } };
  if (h.frequency != null) props['Frequency'] = { select: { name: String(h.frequency) } };
  if (Array.isArray(h.days)) {
    props['Days'] = { multi_select: h.days.map(i => ({ name: DOW[i] })).filter(x => x.name) };
  }
  if (h.order != null) props['Order'] = { number: Number(h.order) };
  if (h.archived != null) props['Archived'] = { checkbox: !!h.archived };
  return props;
}

// ---- Logs -------------------------------------------------------------
function pageToLog(page) {
  const p = page.properties || {};
  return {
    notionId: page.id,
    habitNotionId: richText(p['HabitId']),
    date: richText(p['Period']),
    value: p['Value']?.number != null ? p['Value'].number : 0,
    completed: !!(p['Completed']?.checkbox),
  };
}

function logToProperties(log) {
  const props = {};
  const period = String(log.date || '');
  props['Name'] = { title: [{ text: { content: period || 'log' } }] };
  if (log.habitNotionId != null) {
    props['HabitId'] = { rich_text: [{ text: { content: String(log.habitNotionId) } }] };
  }
  if (log.date != null) props['Period'] = { rich_text: [{ text: { content: period } }] };
  // A weekly period key looks like "W2026-07-06"; strip the W for the real date.
  const day = period.startsWith('W') ? period.slice(1) : period;
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) props['Day'] = { date: { start: day } };
  if (log.value != null) props['Value'] = { number: Number(log.value) };
  if (log.completed != null) props['Completed'] = { checkbox: !!log.completed };
  return props;
}

module.exports = {
  DOW,
  getHabitConfig,
  pageToHabit,
  habitToProperties,
  pageToLog,
  logToProperties,
};
