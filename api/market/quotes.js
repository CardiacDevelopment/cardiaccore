// Vercel serverless function: /api/market/quotes
// Returns S&P 500, Dow Jones, and Nasdaq composite quotes.
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

const SYMBOLS = [
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: '^DJI',  name: 'Dow Jones' },
  { symbol: '^IXIC', name: 'Nasdaq' },
];

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
  };
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  try {
    const quotes = await Promise.all(
      SYMBOLS.map(async ({ symbol, name }) => {
        try {
          const q = await fetchQuote(symbol);
          const change = q.price - q.previousClose;
          const changePct = q.previousClose ? (change / q.previousClose) * 100 : 0;
          return { symbol, name, price: q.price, change, changePct };
        } catch (err) {
          return { symbol, name, price: null, change: 0, changePct: 0, error: err.message };
        }
      })
    );
    // Cache for 5 minutes on CDN, stale-while-revalidate for 15 minutes.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    res.status(200).json({ quotes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
