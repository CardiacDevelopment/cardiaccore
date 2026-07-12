const { notionFetch, applyCors } = require('../_lib/notion');
const { getHabitConfig, logToProperties, pageToLog } = require('../_lib/habits');

// POST — upsert a habit log for a given habit + period.
// Matches an existing row by notionId, else by (HabitId, Period) to avoid
// creating duplicate log pages when the client lost its notionId.
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { token, logsDbId } = getHabitConfig();
    let log = req.body || {};
    if (typeof log === 'string') {
      try { log = JSON.parse(log); } catch { log = {}; }
    }
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
      page = await notionFetch(`/pages/${targetId}`, {
        token, method: 'PATCH', body: { properties },
      });
    } else {
      page = await notionFetch('/pages', {
        token, method: 'POST',
        body: { parent: { database_id: logsDbId }, properties },
      });
    }

    res.status(200).json({ log: pageToLog(page) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, notion: err.notion });
  }
};
