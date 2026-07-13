// Vercel serverless function: /api/market/quotes
// Returns quotes for a set of tickers. Defaults to Vanguard ETFs, but the
// client can pass its own via ?symbols=VTI,AAPL,^GSPC (comma-separated).
// Proxies Yahoo Finance server-to-server to avoid browser CORS issues.
// No API key required.

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// Default set (Vanguard ETFs) when the client doesn't specify symbols.
// Names are curated so they fit the widget rows.
const DEFAULT_SYMBOLS = [
  { symbol: 'VTI',  name: 'Total Stock Market' },
  { symbol: 'VOO',  name: 'S&P 500' },
  { symbol: 'VXUS', name: 'Total International' },
  { symbol: 'BND',  name: 'Total Bond Market' },
];

const MAX_SYMBOLS = 12;

// Parse + sanitize a ?symbols= list. Allows letters, digits, and the few
// punctuation chars Yahoo uses for indices/classes (^ . - =).
function parseSymbols(raw) {
  if (!raw) return null;
  const list = String(raw)
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => /^[A-Z0-9.^=-]{1,12}$/.test(s));
  // De-dupe while preserving order.
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ symbol: s, name: null }); // name resolved from Yahoo below
  }
  return out.length ? out.slice(0, MAX_SYMBOLS) : null;
}

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${symbol}`);
  const data = await res.json();
  const meta = data.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`No data for ${symbol}`);
  return {
    price: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose || meta.previousClose,
    shortName: meta.shortName || meta.longName || null,
  };
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  const symbols = parseSymbols(req.query && req.query.symbols) || DEFAULT_SYMBOLS;

  try {
    const quotes = await Promise.all(
      symbols.map(async ({ symbol, name }) => {
        try {
          const q = await fetchQuote(symbol);
          const change = q.price - q.previousClose;
          const changePct = q.previousClose ? (change / q.previousClose) * 100 : 0;
          // Curated name wins; otherwise use Yahoo's short name, then the symbol.
          return { symbol, name: name || q.shortName || symbol, price: q.price, change, changePct };
        } catch (err) {
          return { symbol, name: name || symbol, price: null, change: 0, changePct: 0, error: err.message };
        }
      })
    );
    // Cache for 5 minutes on CDN, stale-while-revalidate for 15 minutes.
    // Varies with the symbols query string automatically.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    res.status(200).json({ quotes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
