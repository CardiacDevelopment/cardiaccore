// Shared Google OAuth helpers for Gmail (and any future Google APIs).
// Single-user mode: reads client id, secret, and refresh token from env vars.
// Used by /api/google/* and /api/gmail/* serverless functions.
//
// Design notes:
// - We never store the access token anywhere but process memory.
// - Vercel invocations may reuse warm isolates, so we cache the access token
//   in-module until it's within 60s of expiry, then refresh.
// - No new dependencies: uses global fetch (Node 18+ / Vercel default).

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

let cachedToken = null;
let cachedExpiry = 0;

function getConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID env var is not set');
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET env var is not set');
  if (!refreshToken) throw new Error('GOOGLE_REFRESH_TOKEN env var is not set');
  return { clientId, clientSecret, refreshToken };
}

// Returns a valid access token, refreshing if needed. Throws on failure.
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpiry - 60_000) return cachedToken;

  const { clientId, clientSecret, refreshToken } = getConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `Google token refresh ${res.status}`);
    err.status = res.status;
    err.google = data;
    // Clear cache on failure so we don't get stuck on a stale token.
    cachedToken = null;
    cachedExpiry = 0;
    throw err;
  }
  cachedToken = data.access_token;
  cachedExpiry = now + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

// Fetch wrapper for Gmail API. Path is relative (e.g. '/users/me/messages').
async function gmailFetch(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const url = path.startsWith('http') ? path : `${GMAIL_API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data.error?.message || `Gmail API ${res.status}`);
    err.status = res.status;
    err.gmail = data;
    throw err;
  }
  return data;
}

// Redirect URI derived from the incoming request. Same host as the deployment.
function redirectUriFor(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${protocol}://${host}/api/google/callback`;
}

module.exports = { getConfig, getAccessToken, gmailFetch, redirectUriFor };
