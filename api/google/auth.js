// GET /api/google/auth
// One-time setup route. Redirects the browser to Google's OAuth consent
// screen requesting read-only Gmail + Calendar access. After consent, Google
// sends the browser to /api/google/callback with an authorization code.
//
// Re-run this whenever the requested scopes change (e.g. Calendar was added):
// the existing refresh token only carries the scopes it was granted with, so
// a new token must be minted to pick up the new scope.
//
// Safe to leave deployed. Anyone hitting this URL just kicks off consent for
// YOUR Google account; they'd need your client credentials AND your account
// login to actually get a token.

const { redirectUriFor } = require('../_lib/google');

module.exports = async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('GOOGLE_CLIENT_ID is not set on the server.');
    return;
  }

  const redirectUri = redirectUriFor(req);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ].join(' '),
    access_type: 'offline',   // required to get a refresh_token
    prompt: 'consent',        // force refresh_token every run (Google withholds it if user already consented)
    include_granted_scopes: 'true',
  });

  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  res.end();
};
