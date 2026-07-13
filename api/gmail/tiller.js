// GET /api/gmail/tiller
// Parses net worth out of Tiller's daily "Hello, Money" email
// (from hello@tiller.com). Returns the "Net Balances" figure plus the
// Total Assets / Total Liabilities that make it up.
//
// Response shape:
//   { netWorth: 214661.83, totalAssets: 214661.83, totalLiabilities: 0,
//     asOf: ISO, fetchedAt: ISO }
//   or { error: string } (e.g. no recent email, or Gmail not configured).
//
// Cached 30 min at the CDN — the email only arrives once a day.

const { gmailFetch } = require('../_lib/google');

const TILLER_FROM = 'hello@tiller.com';

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// Recursively find the first body part of a given MIME type.
function findBody(payload, mime) {
  if (!payload) return null;
  if (payload.mimeType === mime && payload.body && payload.body.data) return payload.body.data;
  for (const p of payload.parts || []) {
    const r = findBody(p, mime);
    if (r) return r;
  }
  return null;
}

function decode(data) {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

// Find the first "$1,234.56"-style amount that appears after `label`.
function amountAfter(text, label) {
  const idx = text.indexOf(label);
  if (idx < 0) return null;
  const m = text.slice(idx + label.length).match(/\$\s*([\d,]+\.\d{2})/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Newest Tiller digest in the last ~3 days (covers a missed day or two).
    const q = encodeURIComponent(`from:${TILLER_FROM} subject:"Hello, Money" newer_than:3d`);
    const list = await gmailFetch(`/users/me/messages?maxResults=1&q=${q}`);
    const first = list.messages && list.messages[0];
    if (!first) {
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      res.status(200).json({ netWorth: null, error: 'No recent Tiller email found.' });
      return;
    }

    const msg = await gmailFetch(`/users/me/messages/${first.id}?format=full`);

    // Prefer the plain-text part; fall back to tag-stripped HTML.
    let text = decode(findBody(msg.payload, 'text/plain'));
    if (!text) {
      const html = decode(findBody(msg.payload, 'text/html'));
      text = html.replace(/<[^>]+>/g, ' ');
    }

    const netWorth = amountAfter(text, 'Net Balances');
    const totalAssets = amountAfter(text, 'Total Assets');
    const totalLiabilities = amountAfter(text, 'Total Liabilities');

    // Net Balances is the canonical figure; if absent, derive it.
    const net = netWorth != null
      ? netWorth
      : (totalAssets != null ? totalAssets - (totalLiabilities || 0) : null);

    if (net == null) {
      res.status(200).json({ netWorth: null, error: 'Could not parse net worth from the latest Tiller email.' });
      return;
    }

    const asOf = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;

    // 30 min CDN cache — the digest only lands once a day.
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json({
      netWorth: net,
      totalAssets,
      totalLiabilities,
      asOf,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};
