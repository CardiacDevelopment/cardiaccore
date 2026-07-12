const { notionFetch, applyCors } = require('../_lib/notion');
const { getHabitConfig, pageToHabit, pageToLog } = require('../_lib/habits');

// GET — pull all habit definitions plus recent logs (last 150 days).
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    const { token, habitsDbId, logsDbId } = getHabitConfig();

    // Habits (client decides what to do with archived ones).
    const habits = [];
    let cursor;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const data = await notionFetch(`/databases/${habitsDbId}/query`, {
        token, method: 'POST', body,
      });
      for (const p of data.results || []) habits.push(pageToHabit(p));
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);

    // Logs from the last 150 days, filtered on the real Day date.
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
      const data = await notionFetch(`/databases/${logsDbId}/query`, {
        token, method: 'POST', body,
      });
      for (const p of data.results || []) logs.push(pageToLog(p));
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);

    res.status(200).json({ habits, logs });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, notion: err.notion });
  }
};
