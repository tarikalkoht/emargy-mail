/**
 * Sign in with Microsoft (Outlook.com, Hotmail, Live, Microsoft 365) the way Microsoft
 * requires for mail apps: OAuth 2.0 authorization code + PKCE, in the reader's own browser.
 *
 * - The password is typed on Microsoft's page, never in this app.
 * - No client secret exists (public client); the client ID is public by design.
 * - The redirect goes to a one-shot listener on this computer's loopback address only,
 *   and is accepted only with the random `state` we generated.
 * - Tokens are stored encrypted with the account; the access token is refreshed before use.
 */
const crypto = require('node:crypto');
const http = require('node:http');

// Application (client) ID of Emargy Mail's app registration in Microsoft Entra.
// It is public by design (a desktop app cannot keep secrets) and identifies the app, not a user.
const MICROSOFT_CLIENT_ID = '401eb5eb-a881-4bf8-83b1-cfb6aa0db352';

const MICROSOFT = {
  id: 'microsoft',
  clientId: process.env.EMARGY_MS_CLIENT_ID || MICROSOFT_CLIENT_ID,
  authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scopes: ['offline_access', 'openid', 'email', 'profile', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send'],
  servers: { imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false },
};

const SIGN_IN_TIMEOUT = 5 * 60_000;
const REFRESH_MARGIN = 5 * 60_000;

const base64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function createPkce() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function authorizeUrl(provider, { redirectUri, state, challenge, loginHint }) {
  const url = new URL(provider.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: provider.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri,
    scope: provider.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();
  return url.toString();
}

function page(title, text) {
  return `<!doctype html><meta charset="utf-8"><title>Emargy Mail</title><body style="font-family:Segoe UI,Tahoma,sans-serif;display:grid;place-items:center;height:90vh;margin:0;background:#e9faf4;color:#0b2b25">`
    + `<div style="text-align:center;max-width:420px"><h2>${title}</h2><p>${text}</p></div></body>`;
}

/**
 * Listen on the loopback address (IPv4, and IPv6 when available) for the single redirect
 * carrying our `state`. Resolves to { port, result } once listening; `result` settles with the code.
 */
function startRedirectListener(state, timeout) {
  let settle;
  const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  result.catch(() => {});
  const servers = [];
  let finished = false;
  let timer = null;
  const finish = (error, value) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    servers.forEach((s) => s.close());
    if (error) settle.reject(error); else settle.resolve(value);
  };
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/') { res.writeHead(404).end(); return; }
    if (url.searchParams.get('state') !== state) { res.writeHead(400).end(); return; }
    const error = url.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (error) {
      res.end(page('لم يكتمل تسجيل الدخول · Sign-in was not completed', 'يمكنك إغلاق هذه الصفحة والعودة إلى إيمارجي. You can close this page.'));
      finish(new Error(url.searchParams.get('error_description') || error));
      return;
    }
    res.end(page('تم تسجيل الدخول · Signed in', 'عُد إلى إيمارجي ميل، يمكنك إغلاق هذه الصفحة. Return to Emargy Mail; you can close this page.'));
    finish(null, url.searchParams.get('code'));
  };
  return new Promise((resolve, reject) => {
    const v4 = http.createServer(handler);
    servers.push(v4);
    v4.once('error', reject);
    v4.listen(0, '127.0.0.1', () => {
      const { port } = v4.address();
      timer = setTimeout(() => finish(new Error('Sign-in timed out. Try again.')), timeout);
      // Browsers may resolve "localhost" to ::1; listen there too when available.
      const v6 = http.createServer(handler);
      v6.on('error', () => {});
      v6.listen(port, '::1', () => { if (finished) v6.close(); else servers.push(v6); });
      resolve({ port, result, cancel: () => finish(new Error('Cancelled.')) });
    });
  });
}

async function tokenRequest(provider, params, fetchImpl = fetch) {
  const response = await fetchImpl(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: provider.clientId, scope: provider.scopes.join(' '), ...params }).toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const error = new Error(data.error_description?.split('\r\n')[0] || data.error || `Sign-in failed (${response.status}).`);
    error.code = data.error;
    throw error;
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || params.refresh_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    idToken: data.id_token,
  };
}

/** Claims of the ID token we just received over TLS from Microsoft's token endpoint. */
function idClaims(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** The whole sign-in: browser → redirect → tokens. Returns the account's address and tokens. */
async function signIn({ provider = MICROSOFT, loginHint, openBrowser, timeout = SIGN_IN_TIMEOUT, fetchImpl = fetch }) {
  if (!provider.clientId) throw new Error('MICROSOFT_NOT_CONFIGURED');
  const { verifier, challenge } = createPkce();
  const state = base64url(crypto.randomBytes(24));
  const listener = await startRedirectListener(state, timeout);
  const redirectUri = `http://localhost:${listener.port}/`;
  try {
    await openBrowser(authorizeUrl(provider, { redirectUri, state, challenge, loginHint }));
  } catch (error) {
    listener.cancel();
    throw error;
  }
  const code = await listener.result;
  const tokens = await tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, fetchImpl);
  const claims = idClaims(tokens.idToken);
  const email = String(claims.email || claims.preferred_username || loginHint || '').toLowerCase();
  return { email, name: claims.name || '', oauth: { provider: provider.id, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt } };
}

function refresh(oauth, { provider = MICROSOFT, fetchImpl = fetch } = {}) {
  return tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: oauth.refreshToken }, fetchImpl)
    .then(({ idToken, ...tokens }) => ({ provider: oauth.provider, ...tokens }));
}

/**
 * The account with a usable access token, refreshing (and saving) it when it is about to expire.
 * Password accounts are returned unchanged.
 */
async function freshAccount(db, accountId, { fetchImpl = fetch } = {}) {
  const account = db.getAccount(accountId, { withSecrets: true });
  if (account.authType !== 'microsoft') return account;
  if (account.oauth?.accessToken && account.oauth.expiresAt - REFRESH_MARGIN > Date.now()) return account;
  if (!account.oauth?.refreshToken) throw new Error('MICROSOFT_SIGN_IN_AGAIN');
  try {
    const oauth = await refresh(account.oauth, { fetchImpl });
    db.updateAccount(accountId, { oauth });
    return { ...account, oauth };
  } catch (error) {
    if (['invalid_grant', 'interaction_required', 'consent_required'].includes(error.code)) throw new Error('MICROSOFT_SIGN_IN_AGAIN');
    throw error;
  }
}

module.exports = { MICROSOFT, signIn, refresh, freshAccount, createPkce, authorizeUrl, startRedirectListener, idClaims };
