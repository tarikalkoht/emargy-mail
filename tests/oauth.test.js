import { describe, expect, it } from 'vitest';

const crypto = require('node:crypto');
const http = require('node:http');
const { signIn, freshAccount, createPkce, authorizeUrl, startRedirectListener, MICROSOFT } = require('../electron/oauth.cjs');

const provider = { ...MICROSOFT, clientId: 'test-client-id' };
const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

/** A stand-in for Microsoft's token endpoint that checks the PKCE proof like the real one. */
function fakeTokenEndpoint({ challenges }) {
  const calls = [];
  const fetchImpl = async (url, { body }) => {
    const params = Object.fromEntries(new URLSearchParams(body));
    calls.push(params);
    if (params.grant_type === 'authorization_code') {
      const expected = challenges.get(params.code);
      const proof = crypto.createHash('sha256').update(params.code_verifier).digest('base64url');
      if (proof !== expected) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'PKCE check failed' }) };
      return { ok: true, status: 200, json: async () => ({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, id_token: idToken({ email: 'Me@Outlook.com', name: 'Me' }) }) };
    }
    if (params.refresh_token === 'revoked') return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
    return { ok: true, status: 200, json: async () => ({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }) };
  };
  return { fetchImpl, calls };
}

/** A stand-in for the browser: Microsoft's page "approves" and redirects to our loopback listener. */
function fakeBrowser(challenges, { tamperState = false } = {}) {
  return async (url) => {
    const query = new URL(url).searchParams;
    expect(query.get('code_challenge_method')).toBe('S256');
    expect(query.get('scope')).toContain('IMAP.AccessAsUser.All');
    expect(query.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/$/);
    const code = `code-${Math.random()}`;
    challenges.set(code, query.get('code_challenge'));
    const back = new URL(query.get('redirect_uri').replace('localhost', '127.0.0.1'));
    back.search = new URLSearchParams({ code, state: tamperState ? 'forged' : query.get('state') }).toString();
    setTimeout(() => http.get(back, (res) => res.resume()).on('error', () => {}), 20);
  };
}

describe('Sign in with Microsoft', () => {
  it('builds a PKCE request for mail access only', () => {
    const { verifier, challenge } = createPkce();
    expect(crypto.createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    const url = new URL(authorizeUrl(provider, { redirectUri: 'http://localhost:5000/', state: 's', challenge, loginHint: 'me@outlook.com' }));
    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('scope').split(' ')).toEqual(expect.arrayContaining(['offline_access', 'https://outlook.office.com/SMTP.Send']));
    expect(url.searchParams.has('client_secret')).toBe(false);
  });

  it('completes sign-in through the browser and returns the address and tokens', async () => {
    const challenges = new Map();
    const { fetchImpl, calls } = fakeTokenEndpoint({ challenges });
    const result = await signIn({ provider, loginHint: 'me@outlook.com', openBrowser: fakeBrowser(challenges), fetchImpl, timeout: 5000 });
    expect(result.email).toBe('me@outlook.com');
    expect(result.oauth).toMatchObject({ provider: 'microsoft', accessToken: 'access-1', refreshToken: 'refresh-1' });
    expect(calls[0]).not.toHaveProperty('client_secret');
  });

  it('ignores a redirect that does not carry our state, then times out', async () => {
    const challenges = new Map();
    const { fetchImpl } = fakeTokenEndpoint({ challenges });
    await expect(signIn({ provider, openBrowser: fakeBrowser(challenges, { tamperState: true }), fetchImpl, timeout: 600 })).rejects.toThrow(/timed out/);
  });

  it('only listens on this computer', async () => {
    const listener = await startRedirectListener('s', 1000);
    await expect(new Promise((resolve, reject) => http.get(`http://127.0.0.1:${listener.port}/?state=s&code=c`, resolve).on('error', reject))).resolves.toBeTruthy();
    expect(await listener.result).toBe('c');
  });

  it('refuses to start without a registered client ID', async () => {
    await expect(signIn({ provider: { ...MICROSOFT, clientId: '' }, openBrowser: async () => {} })).rejects.toThrow('MICROSOFT_NOT_CONFIGURED');
  });

  it('refreshes an expiring token and saves the new one; asks to sign in again when access was removed', async () => {
    const saved = {};
    let stored = { id: 'a1', authType: 'microsoft', email: 'me@outlook.com', oauth: { provider: 'microsoft', accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() + 60_000 } };
    const db = { getAccount: () => stored, updateAccount: (id, changes) => { Object.assign(saved, changes); stored = { ...stored, ...changes }; } };
    const { fetchImpl } = fakeTokenEndpoint({ challenges: new Map() });
    const account = await freshAccount(db, 'a1', { fetchImpl });
    expect(account.oauth.accessToken).toBe('access-2');
    expect(saved.oauth.refreshToken).toBe('refresh-2');
    // Still fresh: no second request.
    expect((await freshAccount(db, 'a1', { fetchImpl: () => { throw new Error('should not refresh'); } })).oauth.accessToken).toBe('access-2');
    stored = { ...stored, oauth: { ...stored.oauth, refreshToken: 'revoked', expiresAt: 0 } };
    await expect(freshAccount(db, 'a1', { fetchImpl })).rejects.toThrow('MICROSOFT_SIGN_IN_AGAIN');
  });

  it('keeps password accounts as they are', async () => {
    const db = { getAccount: () => ({ id: 'p', email: 'x@y.test', password: 'secret' }) };
    expect(await freshAccount(db, 'p')).toMatchObject({ password: 'secret' });
  });
});

describe('Microsoft accounts on IMAP and SMTP', () => {
  const { imapConfig } = require('../electron/mail.cjs');
  it('sign in to IMAP with the token (XOAUTH2), never with a password', () => {
    const config = imapConfig({ authType: 'microsoft', email: 'me@outlook.com', imapHost: 'outlook.office365.com', oauth: { accessToken: 'tok' } });
    expect(config.auth).toEqual({ user: 'me@outlook.com', accessToken: 'tok' });
    expect(config.secure).toBe(true);
  });
});
