const { notionFetch, applyCors } = require('../_lib/notion');
const { getHabitConfig, habitToProperties, pageToHabit } = require('../_lib/habits');

// POST — create (no notionId) or update (with notionId) a habit definition.
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { token, habitsDbId } = getHabitConfig();
    let habit = req.body || {};
    if (typeof habit === 'string') {
      try { habit = JSON.parse(habit); } catch { habit = {}; }
    }
    if (!habit.name || !String(habit.name).trim()) {
      res.status(400).json({ error: 'habit.name is required' });
      return;
    }

    const properties = habitToProperties(habit);
    let page;
    if (habit.notionId) {
      page = await notionFetch(`/pages/${habit.notionId}`, {
        token, method: 'PATCH', body: { properties },
      });
    } else {
      page = await notionFetch('/pages', {
        token, method: 'POST',
        body: { parent: { database_id: habitsDbId }, properties },
      });
    }

    res.status(200).json({ habit: pageToHabit(page) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, notion: err.notion });
  }
};
