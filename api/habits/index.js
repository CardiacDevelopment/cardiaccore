const { notionFetch, applyCors } = require('../_lib/notion');
const {
  getHabitConfig, pageToHabit, habitToProperties, pageToLog, logToProperties,
} = require('../_lib/habits');

// Consolidated habit endpoint — a single serverless function so the project
// stays within Vercel's Hobby-plan 12-function limit. Routes:
//   GET  /api/habits                              -> sync (habits + recent logs)
//   POST /api/habits {action:'push', habit}       -> create/update a habit
//   POST /api/habits {action:'log', log}          -> upsert a habit log
//   POST /api/habits {action:'archive', notionId} -> archive a habit
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  try {
    const cfg = getHabitConfig();

    if (req.method === 'GET') {
      return await handleSync(cfg, res);
    }

    if (req.method === 'POST') {
      let body = req.body || {};
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      switch (body.action) {
        case 'push': return await handlePush(cfg, body.habit || {}, res);
        case 'log': return await handleLog(cfg, body.log || {}, res);
        case 'archive': return await handleArchive(cfg, body.notionId, res);
        default:
          res.status(400).json({ error: 'Unknown or missing action' });
          return;
      }
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, notion: err.notion });
  }
};

// GET — all habit definitions plus logs from the last 150 days.
async function handleSync({ token, habitsDbId, logsDbId }, res) {
  const habits = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`/databases/${habitsDbId}/query`, { token, method: 'POST', body });
    for (const p of data.results || []) habits.push(pageToHabit(p));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  const since = new Date();
  since.setDate(since.getDate() - 150);
  const sinceStr = since.toISOString().slice(0, 10);

  const logs = [];
  cursor = undefined;
  do {
    const body = {
      filter: { property: 'Day', date: { on_or_after: sinceStr } },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`/databases/${logsDbId}/query`, { token, method: 'POST', body });
    for (const p of data.results || []) logs.push(pageToLog(p));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  res.status(200).json({ habits, logs });
}

// POST push — create (no notionId) or update (with notionId) a habit.
async function handlePush({ token, habitsDbId }, habit, res) {
  if (!habit.name || !String(habit.name).trim()) {
    res.status(400).json({ error: 'habit.name is required' });
    return;
  }
  const properties = habitToProperties(habit);
  let page;
  if (habit.notionId) {
    page = await notionFetch(`/pages/${habit.notionId}`, { token, method: 'PATCH', body: { properties } });
  } else {
    page = await notionFetch('/pages', {
      token, method: 'POST',
      body: { parent: { database_id: habitsDbId }, properties },
    });
  }
  res.status(200).json({ habit: pageToHabit(page) });
}

// POST log — upsert a habit log by notionId, else by (HabitId, Period).
async function handleLog({ token, logsDbId }, log, res) {
  if (!log.habitNotionId || !log.date) {
    res.status(400).json({ error: 'habitNotionId and date are required' });
    return;
  }
  const properties = logToProperties(log);
  let targetId = log.notionId;

  if (!targetId) {
    const q = await notionFetch(`/databases/${logsDbId}/query`, {
      token, method: 'POST',
      body: {
        filter: {
          and: [
            { property: 'HabitId', rich_text: { equals: String(log.habitNotionId) } },
            { property: 'Period', rich_text: { equals: String(log.date) } },
          ],
        },
        page_size: 1,
      },
    });
    if (q.results && q.results[0]) targetId = q.results[0].id;
  }

  let page;
  if (targetId) {
    page = await notionFetch(`/pages/${targetId}`, { token, method: 'PATCH', body: { properties } });
  } else {
    page = await notionFetch('/pages', {
      token, method: 'POST',
      body: { parent: { database_id: logsDbId }, properties },
    });
  }
  res.status(200).json({ log: pageToLog(page) });
}

// POST archive — soft-delete a habit page.
async function handleArchive({ token }, notionId, res) {
  if (!notionId) {
    res.status(400).json({ error: 'notionId is required' });
    return;
  }
  await notionFetch(`/pages/${notionId}`, { token, method: 'PATCH', body: { archived: true } });
  res.status(200).json({ ok: true });
}
