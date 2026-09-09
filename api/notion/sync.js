const { getConfig, notionFetch, pageToTask, applyCors } = require('../_lib/notion');

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { token, databaseId } = getConfig();

    // Pull non-archived pages, sorted by last edit so freshest changes come first.
    const tasks = [];
    let cursor;
    let pages = 0;
    const MAX_PAGES = 10; // 100 results/page → 1000 task safety cap

    do {
      const body = {
        page_size: 100,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      };
      if (cursor) body.start_cursor = cursor;

      const data = await notionFetch(`/databases/${databaseId}/query`, {
        token,
        method: 'POST',
        body,
      });

      for (const page of data.results || []) {
        if (page.archived) continue;
        // Narrow shape: the client merge reads only id/title/completed/
        // category/dayOffset. pageToTask also emits status, dueDate,
        // categories, project and url — roughly half the payload, never read
        // on this route. lastEditedTime is kept because the ETag hashes it.
        const t = pageToTask(page);
        tasks.push({
          id: t.id,
          title: t.title,
          completed: t.completed,
          category: t.category,
          dayOffset: t.dayOffset,
          lastEditedTime: t.lastEditedTime,
        });
      }

      cursor = data.has_more ? data.next_cursor : null;
      pages += 1;
    } while (cursor && pages < MAX_PAGES);

    res.status(200).json({ tasks, count: tasks.length, truncated: pages >= MAX_PAGES && cursor });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      notion: err.notion,
    });
  }
};
