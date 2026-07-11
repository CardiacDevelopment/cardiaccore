// GET /api/google/callback
// Google redirects here after consent with ?code=... Exchanges the code for a
// refresh_token and displays it in a plain HTML page so the user can copy it
// into Vercel env vars as GOOGLE_REFRESH_TOKEN.
//
// This is only used during the one-time setup. Safe to leave deployed —
// exchanging a code without matching client credentials fails, and the code
// itself is single-use with a very short TTL.

const { redirectUriFor } = require('../_lib/google');

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, ch => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

module.exports = async function handler(req, res) {
  const code = req.query?.code;
  const err = req.query?.error;
  if (err) {
    res.status(400).send(`Google returned an error: ${escapeHtml(err)}`);
    return;
  }
  if (!code) {
    res.status(400).send('Missing ?code parameter. Start at /api/google/auth.');
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).send('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not set on the server.');
    return;
  }

  const redirectUri = redirectUriFor(req);
  const body = new URLSearchParams({
    code: String(code),
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      const msg = data.error_description || data.error || `HTTP ${tokenRes.status}`;
      res.status(500).send(`Token exchange failed: ${escapeHtml(msg)}`);
      return;
    }

    const refresh = data.refresh_token;
    if (!refresh) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(`<!doctype html><html><body style="font-family:sans-serif;background:#0a0a0a;color:#eee;padding:40px;max-width:720px;margin:0 auto;">
        <h1 style="color:#e05050;">No refresh_token returned</h1>
        <p>This usually happens if you've already granted consent before and Google is silently skipping the consent screen. Try again from <code>/api/google/auth</code> — the flow forces <code>prompt=consent</code> so this should be rare.</p>
        <p>If it keeps happening, revoke access at <a style="color:#97c459;" href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and start over.</p>
      </body></html>`);
      return;
    }

    const safe = escapeHtml(refresh);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Cardiac Core Google OAuth</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0a0a0a; color: #f0f5e8; padding: 40px; max-width: 720px; margin: 0 auto; line-height: 1.6; }
  h1 { color: #97c459; font-size: 22px; margin-bottom: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
  p { color: #aaa; }
  code, pre { background: #1a2213; border: 1px solid rgba(151,196,89,0.3); padding: 12px 14px; border-radius: 6px; word-break: break-all; font-size: 13px; color: #f0f5e8; }
  pre { display: block; margin: 16px 0; }
  code { display: inline; padding: 2px 6px; }
  ol { color: #aaa; margin-top: 20px; padding-left: 20px; }
  ol li { margin-bottom: 8px; }
  strong { color: #f0f5e8; }
  button { background: #639922; color: #fff; border: none; padding: 10px 16px; border-radius: 6px; font-weight: 600; cursor: pointer; letter-spacing: 0.08em; text-transform: uppercase; font-size: 12px; }
  button:hover { background: #97c459; }
</style></head>
<body>
  <h1>Refresh Token Ready</h1>
  <p>Copy the value below and add it to Vercel as <code>GOOGLE_REFRESH_TOKEN</code>, then redeploy.</p>
  <pre id="tok">${safe}</pre>
  <button onclick="navigator.clipboard.writeText(document.getElementById('tok').innerText).then(() => this.innerText = 'Copied ✓')">Copy to clipboard</button>
  <ol>
    <li>Open Vercel → Project Settings → Environment Variables.</li>
    <li>Add <strong>GOOGLE_REFRESH_TOKEN</strong> with the value above (Production + Preview + Development).</li>
    <li>Redeploy the project so the env var takes effect.</li>
    <li>Close this tab. You never need to visit this URL again unless you revoke access.</li>
  </ol>
</body></html>`);
  } catch (e) {
    res.status(500).send(`Callback error: ${escapeHtml(e.message)}`);
  }
};
