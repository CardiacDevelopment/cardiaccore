const crypto = require('crypto');
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
        // Narrow shape. dueDate, project and url are still dropped — nothing
        // reads them. status and categories ARE read: taskToProperties needs
        // them to avoid clobbering a non-Done Status or dropping the extra
        // multi-select options Notion holds. lastEditedTime feeds the ETag.
        const t = pageToTask(page);
        tasks.push({
          id: t.id,
          title: t.title,
          completed: t.completed,
          category: t.category,
          categories: t.categories,
          status: t.status,
          dayOffset: t.dayOffset,
          lastEditedTime: t.lastEditedTime,
        });
      }

      cursor = data.has_more ? data.next_cursor : null;
      pages += 1;
    } while (cursor && pages < MAX_PAGES);

    const payload = JSON.stringify({
      tasks,
      count: tasks.length,
      truncated: pages >= MAX_PAGES && cursor,
    });

    // Conditional GET. The client polls this every 45s, on every focus and on
    // every visibilitychange; almost every one of those returns a body it
    // already has. dayOffset is derived from the server's clock so the hash
    // rotates at midnight on its own, and lastEditedTime makes any Notion edit
    // change it.
    const etag = '"' + crypto.createHash('sha1').update(payload).digest('hex') + '"';
    res.setHeader('ETag', etag);
    // Never shared-cache this: it is a two-way sync endpoint, and a CDN serving
    // a pre-push body after the client has pushed would make the merge revert
    // the local edit, which then pushes back. Explicit so no proxy decides.
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(payload);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      notion: err.notion,
    });
  }
};
