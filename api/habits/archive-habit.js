const { notionFetch, applyCors } = require('../_lib/notion');
const { getHabitConfig } = require('../_lib/habits');

// POST — archive (soft-delete) a habit page so it stops coming back on sync.
// Reversible from the Notion UI, same as the task archive flow.
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { token } = getHabitConfig();
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    if (!body.notionId) {
      res.status(400).json({ error: 'notionId is required' });
      return;
    }

    await notionFetch(`/pages/${body.notionId}`, {
      token, method: 'PATCH', body: { archived: true },
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, notion: err.notion });
  }
};
