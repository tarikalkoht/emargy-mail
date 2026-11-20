import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MailComposer = require('nodemailer/lib/mail-composer');
const { Vault } = require('../electron/vault.cjs');
const { Database } = require('../electron/db.cjs');
const { SyncManager } = require('../electron/sync.cjs');
const { Outbox } = require('../electron/outbox.cjs');
const { createApi } = require('../electron/api.cjs');
const { verifyResend, sendWithResend, parseDate } = require('../electron/resend.cjs');
const { categorize } = require('../electron/categorize.cjs');

const protect = (key) => Buffer.from(key.map((byte) => byte ^ 0x5a));
const unprotect = (data) => Buffer.from(data.map((byte) => byte ^ 0x5a));
const KEY = 're_test_1234567890';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A tiny stand-in for api.resend.com and its raw-message download links. */
function fakeResend() {
  const sent = [];
  const received = [
    { id: 'r3', to: ['hello@brand.test'], from: 'Client <client@acme.test>', created_at: '2026-11-20 08:00:00.000000+00', subject: 'Project brief', cc: null, bcc: null, reply_to: null, received_for: ['hello@brand.test'], message_id: '<r3@acme.test>', attachments: [] },
    { id: 'r2', to: ['other@brand.test'], from: 'x@else.test', created_at: '2026-11-19 08:00:00+00', subject: 'For someone else', cc: null, bcc: null, reply_to: null, received_for: ['other@brand.test'], message_id: '<r2@else.test>', attachments: [] },
    { id: 'r1', to: ['hello@brand.test'], from: 'Shop <news@shop.test>', created_at: '2026-11-18T08:00:00Z', subject: 'Big sale 50% off', cc: null, bcc: null, reply_to: null, received_for: ['hello@brand.test'], message_id: '<r1@shop.test>', attachments: [] },
  ];
  const outgoing = [
    { id: 's1', to: ['client@acme.test'], from: 'Me <hello@brand.test>', created_at: '2026-11-19T10:00:00Z', subject: 'Re: Project brief', cc: null, bcc: null, reply_to: null, message_id: '<s1@brand.test>', last_event: 'delivered' },
  ];
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    calls.push(`${options.method || 'GET'} ${target.pathname}`);
    if (target.hostname === 'files.resend.test') {
      const raw = await new MailComposer({ from: 'Client <client@acme.test>', to: 'hello@brand.test', subject: 'Project brief', text: 'The full brief is here.', messageId: '<r3@acme.test>' }).compile().build();
      return new Response(raw, { status: 200 });
    }
    if (options.headers?.Authorization !== `Bearer ${KEY}`) return json(401, { statusCode: 401, name: 'invalid_api_key', message: 'API key is invalid' });
    if (target.pathname === '/domains') return json(200, { object: 'list', has_more: false, data: [{ id: 'd1', name: 'brand.test', status: 'verified', capabilities: { sending: 'enabled', receiving: 'enabled' } }] });
    if (target.pathname === '/emails/receiving') return json(200, { object: 'list', has_more: false, data: received });
    if (target.pathname === '/emails/receiving/r3') return json(200, { ...received[0], object: 'email', html: null, text: 'short', headers: {}, raw: { download_url: 'https://files.resend.test/r3.eml', expires_at: '' } });
    if (target.pathname === '/emails/receiving/r1') return json(200, { ...received[2], object: 'email', html: '<p>Sale!</p>', text: 'Sale!', headers: { 'List-Unsubscribe': '<mailto:u@shop.test>' }, raw: null });
    if (target.pathname === '/emails' && options.method === 'POST') {
      sent.push({ body: JSON.parse(options.body), idempotency: options.headers['Idempotency-Key'] });
      return json(200, { id: 'new-1' });
    }
    if (target.pathname === '/emails') return json(200, { object: 'list', has_more: false, data: outgoing });
    if (target.pathname === '/emails/s1') return json(200, { ...outgoing[0], object: 'email', html: '<p>Thanks</p>', text: 'Thanks' });
    return json(404, { statusCode: 404, name: 'not_found', message: 'Not found' });
  };
  return { fetchImpl, sent, calls, outgoing };
}

describe('Resend accounts', () => {
  let dir;
  let db;
  let sync;
  let api;
  let fake;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    fake = fakeResend();
    globalThis.fetch = fake.fetchImpl;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emargy-resend-'));
    db = new Database({ file: path.join(dir, 'emargy.db'), vault: new Vault({ keyFile: path.join(dir, 'vault.key'), protect, unprotect }) });
    sync = new SyncManager({ db, emit: () => {} });
    sync.resendGap = 0;
    api = createApi({ db, sync, outbox: new Outbox({ db, sync }), emit: () => {} });
    api.createProject({ name: 'Brand', color: '#017b66' });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await sync.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads Resend dates with a short time-zone offset', () => {
    expect(new Date(parseDate('2026-11-20 08:00:00.000000+00')).toISOString()).toBe('2026-11-20T08:00:00.000Z');
  });

  it('checks the key and the domain before saving', async () => {
    await expect(verifyResend({ apiKey: 're_wrong_key_123', email: 'hello@brand.test' }, { fetchImpl: fake.fetchImpl })).rejects.toThrow(/did not accept/);
    await expect(verifyResend({ apiKey: KEY, email: 'hello@nope.test' }, { fetchImpl: fake.fetchImpl })).rejects.toThrow(/not a domain/);
    await expect(verifyResend({ apiKey: KEY, email: 'hello@brand.test' }, { fetchImpl: fake.fetchImpl })).resolves.toMatchObject({ mode: 'full', receiving: true });
    const restricted = async () => json(401, { statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails' });
    await expect(verifyResend({ apiKey: KEY, email: 'hello@brand.test' }, { fetchImpl: restricted })).resolves.toMatchObject({ mode: 'send' });
  });

  it('adds the account, keeps the key out of the interface, and syncs only its own mail', async () => {
    const state = await api.addAccount({ authType: 'resend', projectId: api.state().projects[0].id, email: 'hello@brand.test', apiKey: KEY, displayName: 'Me' });
    const account = state.accounts[0];
    expect(account.provider).toBe('resend');
    expect(JSON.stringify(state)).not.toContain(KEY);
    await sync.worker(account.id).syncNow();
    const inbox = api.listMessages({ accountId: account.id, folderRole: 'inbox', threaded: false }).messages;
    expect(inbox.map((m) => m.subject).sort()).toEqual(['Big sale 50% off', 'Project brief']);
    const sent = api.listMessages({ accountId: account.id, folderRole: 'sent', threaded: false }).messages;
    expect(sent.map((m) => m.subject)).toEqual(['Re: Project brief']);
    // A second sync adds nothing twice.
    expect(await sync.worker(account.id).syncNow()).toBe(0);
  });

  it('shows what Resend reported for sent mail, and updates it later', async () => {
    const account = api.state().accounts[0];
    const sentNow = () => api.listMessages({ accountId: account.id, folderRole: 'sent', threaded: false }).messages[0].delivery;
    expect(sentNow()).toBe('delivered');
    fake.outgoing[0].last_event = 'bounced';
    await sync.worker(account.id).syncNow();
    expect(sentNow()).toBe('bounced');
  });

  it('opens a received message from its raw download and moves it between local folders', async () => {
    const account = api.state().accounts[0];
    const brief = api.listMessages({ accountId: account.id, folderRole: 'inbox', threaded: false }).messages.find((m) => m.subject === 'Project brief');
    const opened = await api.openThread(brief.id);
    expect(opened.messages[0].content.text).toContain('The full brief is here.');
    const archive = api.state().folders.find((f) => f.accountId === account.id && f.role === 'archive');
    await api.moveTo([brief.id], archive.id);
    expect(api.listMessages({ accountId: account.id, folderRole: 'archive', threaded: false }).messages.map((m) => m.subject)).toEqual(['Project brief']);
    // Deleting from Trash forgets it for good: the next sync does not bring it back.
    const moved = api.listMessages({ accountId: account.id, folderRole: 'archive', threaded: false }).messages[0];
    await api.trash([moved.id]);
    const trashed = api.listMessages({ accountId: account.id, folderRole: 'trash', threaded: false }).messages[0];
    await api.trash([trashed.id]);
    await sync.worker(account.id).syncNow();
    expect(api.listMessages({ accountId: account.id, folderRole: 'any', query: 'brief', threaded: false }).messages.map((m) => m.subject)).toEqual(['Re: Project brief']);
  });

  it('sends through the API with an idempotency key and the reply headers', async () => {
    const account = db.getAccount(api.state().accounts[0].id, { withSecrets: true });
    const result = await sendWithResend(account, {
      id: 'out-1',
      draft: { to: 'Client <client@acme.test>, b@x.test', cc: '', bcc: '', subject: 'Hi', html: '<p>Hello <img src="data:image/png;base64,iVBORw0KGgo="></p>', inReplyTo: '<r3@acme.test>', references: '<r3@acme.test>', attachments: [{ filename: 'a.txt', contentType: 'text/plain', size: 2, content: 'aGk=' }] },
    }, { fetchImpl: fake.fetchImpl });
    expect(result.messageId).toBe('new-1');
    const { body, idempotency } = fake.sent[0];
    expect(idempotency).toBe('emargy-out-1');
    expect(body.from).toBe('Me <hello@brand.test>');
    expect(body.to).toEqual(['Client <client@acme.test>', 'b@x.test']);
    expect(body.headers['In-Reply-To']).toBe('<r3@acme.test>');
    expect(body.attachments.map((a) => a.filename)).toEqual(['a.txt', 'image-1.png']);
    expect(body.attachments[1].content_id).toMatch(/@emargy$/);
    expect(body.html).toContain('cid:');
  });
});

describe('inbox tabs and sender rules', () => {
  it('sorts mail into tabs from the sender and list headers', () => {
    expect(categorize({ fromAddress: 'notification@facebookmail.com', subject: 'New comment' })).toBe('social');
    expect(categorize({ fromAddress: 'deals@shop.test', subject: 'Black Friday', headers: 'List-Unsubscribe: <mailto:x@shop.test>' })).toBe('promotions');
    expect(categorize({ fromAddress: 'billing@shop.test', subject: 'Your receipt #123', headers: 'List-Unsubscribe: <mailto:x@shop.test>' })).toBe('updates');
    expect(categorize({ fromAddress: 'no-reply@bank.test', subject: 'Transaction alert' })).toBe('updates');
    // A person (even at info@) stays in Primary.
    expect(categorize({ fromAddress: 'info@client.test', subject: 'Contract draft' })).toBe('primary');
    expect(categorize({ fromAddress: 'sara@partner.test', subject: 'Meeting notes' })).toBe('primary');
  });

  it('remembers "not spam" and a chosen tab for a sender', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emargy-rules-'));
    const db = new Database({ file: path.join(dir, 'emargy.db'), vault: new Vault({ keyFile: path.join(dir, 'vault.key'), protect, unprotect }) });
    try {
      const projectId = db.createProject({ name: 'P', color: '#000000' });
      const accountId = db.createAccount({ projectId, email: 'me@x.test', imapHost: 'imap.x.test' });
      const inbox = db.upsertFolder(accountId, 'INBOX', 'inbox', 'Inbox');
      db.insertMessages(inbox, [
        { uid: 1, projectId, subject: '[SPAM] hello', from: 'Friend <friend@y.test>', fromAddress: 'friend@y.test', dateValue: 1, trust: 'spam' },
        { uid: 2, projectId, subject: 'Weekly deals 30% off', from: 'news@shop.test', fromAddress: 'news@shop.test', dateValue: 2, category: 'promotions' },
      ]);
      const list = (category) => db.listMessages({ category, threaded: false }).messages.map((m) => m.subject);
      expect(list('promotions')).toEqual(['Weekly deals 30% off']);
      db.setSenderRule('news@shop.test', { category: 'primary' });
      db.setSenderRule('friend@y.test', { verdict: 'safe' });
      expect(list('primary')).toEqual(['Weekly deals 30% off', '[SPAM] hello']);
      expect(db.listMessages({ filter: 'spam', threaded: false }).total).toBe(0);
      // A forged From address cannot hide a failed sender check.
      db.insertMessages(inbox, [{ uid: 3, projectId, subject: 'Verify now', from: 'friend@y.test', fromAddress: 'friend@y.test', dateValue: 3, trust: 'suspicious' }]);
      expect(db.listMessages({ filter: 'spam', threaded: false }).messages.map((m) => m.trust)).toEqual(['suspicious']);
      db.deleteMessage(`${accountId}:${inbox.id}:3`);
      // Rules are stored, so they survive a restart.
      const again = new Database({ file: path.join(dir, 'emargy.db'), vault: db.vault });
      expect(again.listMessages({ category: 'primary', threaded: false }).total).toBe(2);
      expect(again.listMessages({ filter: 'spam', threaded: false }).total).toBe(0);
      again.close();
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
