// GET /api/gmail/newsletters
// Returns the most recent message (within the last ~2 days) from each
// whitelisted newsletter sender. No summarization — subject and Gmail's
// auto-generated snippet come straight from message metadata.
//
// Response shape:
//   {
//     items:      [{ senderName, senderAddr, category, badge, subject,
//                    snippet, gmailUrl, receivedAt, messageId, threadId }],
//     byCategory: { "Finance": [...], "AI & Tech": [...], ... },
//     errors:     [{ senderAddr, senderName, error }],
//     fetchedAt:  ISO timestamp
//   }
//
// Cached 15 min at the CDN so a page open doesn't spam Gmail. Manual refresh
// endpoint can be added later if needed (append ?fresh=1 support in v2).

const { gmailFetch } = require('../_lib/google');

// Sender whitelist + category assignment. To add or remove a newsletter,
// edit this list and redeploy. Categories are the section headers rendered
// in the Briefing tab; badges are the small pill on each card.
const NEWSLETTERS = [
  // ── Finance ────────────────────────────────────────────
  { addr: 'crew@morningbrew.com',                  name: 'Morning Brew',       category: 'Finance',       badge: 'Business & Finance' },
  { addr: 'joe@readthejoe.com',                    name: 'The Average Joe',    category: 'Finance',       badge: 'Investing' },
  { addr: 'marketing@valueline.com',               name: 'Value Line',         category: 'Finance',       badge: 'Stock Analysis' },
  { addr: 'editors@newsletters.plansponsor.com',   name: 'PLANSPONSOR',        category: 'Finance',       badge: 'Retirement & Policy' },
  // ── AI & Tech ──────────────────────────────────────────
  { addr: 'news@daily.therundown.ai',              name: 'The Rundown AI',     category: 'AI & Tech',     badge: 'Artificial Intelligence' },
  { addr: 'dan@tldrnewsletter.com',                name: 'TLDR Data',          category: 'AI & Tech',     badge: 'Data & Tech' },
  { addr: 'superhumancode@news.codenewsletter.ai', name: 'The Code',           category: 'AI & Tech',     badge: 'Code' },
  // ── Faith ──────────────────────────────────────────────
  { addr: 'hi@thepourover.org',                    name: 'The Pour Over',      category: 'Faith',         badge: 'Faith & News' },
  // ── Daily & Life ───────────────────────────────────────
  { addr: 'dailydigest@email.join1440.com',        name: '1440 Daily Digest',  category: 'Daily & Life',  badge: 'Daily Brief' },
  { addr: 'tim@fourhourbody.com',                  name: 'Tim Ferriss',        category: 'Daily & Life',  badge: 'Life & Work' },
  { addr: 'james@jamesclear.com',                  name: 'James Clear',        category: 'Daily & Life',  badge: 'Habits' },
  // ── Sports News ────────────────────────────────────────
  { addr: 'newsletter@baseball-reference.com',     name: 'Baseball Reference', category: 'Sports News',   badge: 'Baseball' },
];

// Category display order in the response's byCategory keys. Categories not
// listed here fall to the end in insertion order.
const CATEGORY_ORDER = ['Finance', 'AI & Tech', 'Faith', 'Daily & Life', 'Sports News'];

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// Fetch the latest message from one sender. Returns null if no recent match.
async function fetchLatestForSender(entry) {
  // newer_than:2d catches "sent overnight but not delivered yet" and covers
  // weekends for newsletters that don't send every day. Widen if a source
  // sends less often than every 2 days.
  const q = encodeURIComponent(`from:${entry.addr} newer_than:2d`);
  const list = await gmailFetch(`/users/me/messages?maxResults=1&q=${q}`);
  const first = list.messages?.[0];
  if (!first) return null;

  const msg = await gmailFetch(
    `/users/me/messages/${first.id}?format=metadata` +
    `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
  );

  const headers = Object.fromEntries(
    (msg.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value])
  );

  // Deep link that works whether the message is in Inbox or archived.
  const gmailUrl = `https://mail.google.com/mail/u/0/#all/${first.id}`;

  return {
    senderName: entry.name,
    senderAddr: entry.addr,
    category: entry.category,
    badge: entry.badge,
    subject: headers.subject || '(no subject)',
    snippet: msg.snippet || '',
    gmailUrl,
    receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
    messageId: first.id,
    threadId: first.threadId || null,
  };
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Fetch all senders in parallel. One failure doesn't take down the others.
    const settled = await Promise.all(NEWSLETTERS.map(async (entry) => {
      try {
        const item = await fetchLatestForSender(entry);
        return { ok: true, item, entry };
      } catch (err) {
        return { ok: false, entry, error: err.message };
      }
    }));

    const items = [];
    const errors = [];
    for (const r of settled) {
      if (r.ok && r.item) items.push(r.item);
      else if (!r.ok) errors.push({
        senderAddr: r.entry.addr,
        senderName: r.entry.name,
        error: r.error,
      });
    }

    // Group by category, preserving CATEGORY_ORDER first.
    const byCategory = {};
    for (const cat of CATEGORY_ORDER) byCategory[cat] = [];
    for (const item of items) {
      if (!byCategory[item.category]) byCategory[item.category] = [];
      byCategory[item.category].push(item);
    }
    // Sort each category by receivedAt desc so freshest appears first.
    for (const cat of Object.keys(byCategory)) {
      byCategory[cat].sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));
    }

    // 15 min CDN cache, 1 hr SWR. Fresh reads don't cost much but Gmail's
    // per-user quota is generous, not infinite.
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
    res.status(200).json({
      items,
      byCategory,
      errors,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      google: err.google,
    });
  }
};
