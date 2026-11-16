import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ImapFlow } = require('imapflow');
const { Vault } = require('../electron/vault.cjs');
const { Database } = require('../electron/db.cjs');
const { SyncManager } = require('../electron/sync.cjs');
const { Outbox } = require('../electron/outbox.cjs');
const { createApi } = require('../electron/api.cjs');
const { migrateLegacyStore } = require('../electron/migrate.cjs');
const { startMailServers, rawMessage } = require('./helpers/mailServers.cjs');

// Stand-in for Windows DPAPI: reversible, but proves the key file never holds the raw key.
const protect = (key) => Buffer.from(key.map((byte) => byte ^ 0x5a));
const unprotect = (data) => Buffer.from(data.map((byte) => byte ^ 0x5a));

const waitFor = async (check, timeout = 8000) => {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe('encrypted storage, sync and outbox against local mail servers', () => {
  let dir;
  let servers;
  let db;
  let sync;
  let outbox;
  let api;
  const events = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emargy-test-'));
    servers = await startMailServers({
      seed: [
        { from: 'Client <client@acme.test>', to: 'tester@emargy.test', subject: 'Secret quarterly invoice', body: 'Confidential amount 98765', id: 'm1' },
        { from: 'news@shop.test', to: 'tester@emargy.test', subject: 'Weekend offers', body: 'Hello there', id: 'm2', flags: ['\\Seen'] },
      ],
    });
    const vault = new Vault({ keyFile: path.join(dir, 'vault.key'), protect, unprotect });
    db = new Database({ file: path.join(dir, 'emargy.db'), vault });
    const emit = (channel, payload) => events.push({ channel, payload });
    sync = new SyncManager({ db, emit });
    outbox = new Outbox({ db, sync, emit });
    api = createApi({ db, sync, outbox, emit });
  });

  afterAll(async () => {
    outbox?.stop();
    await sync?.stop();
    db?.close();
    await servers?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const accountInput = (overrides = {}) => ({
    projectId: api.state().projects[0].id,
    provider: 'custom',
    displayName: 'Tester',
    email: servers.user,
    password: servers.password,
    imapHost: '127.0.0.1',
    imapPort: servers.imapPort,
    imapSecure: false,
    smtpHost: '127.0.0.1',
    smtpPort: servers.smtpPort,
    smtpSecure: false,
    ...overrides,
  });

  it('rejects an account with a wrong password before saving it', async () => {
    api.createProject({ name: 'Acme', color: '#15b886' });
    await expect(api.addAccount(accountInput({ password: 'wrong' }))).rejects.toThrow(/IMAP login failed/);
    expect(api.state().accounts).toHaveLength(0);
  });

  it('adds an account and synchronizes the inbox', async () => {
    const state = await api.addAccount(accountInput());
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0].password).toBeUndefined();
    const accountId = state.accounts[0].id;
    await api.syncAccount(accountId);
    const { messages, total } = api.listMessages({ folderRole: 'inbox' });
    expect(total).toBe(2);
    expect(messages[0]).toMatchObject({ accountId, projectId: state.projects[0].id });
    const invoice = messages.find((m) => m.subject === 'Secret quarterly invoice');
    expect(invoice.read).toBe(false);
    expect(invoice.important).toBe(true);
    expect(api.state().counts.total).toBe(1);
  });

  it('refuses to add the same mailbox twice', async () => {
    await expect(api.addAccount(accountInput({ displayName: 'Again' }))).rejects.toThrow(/DUPLICATE_ACCOUNT/);
    await expect(api.addAccount(accountInput({ email: servers.user.toUpperCase() }))).rejects.toThrow(/DUPLICATE_ACCOUNT/);
    expect(api.state().accounts).toHaveLength(1);
  });

  it('marks every unread message of a view as read, on the server too', async () => {
    const accountId = api.state().accounts[0].id;
    const result = await api.markAllRead({ folderRole: 'inbox' });
    expect(result.count).toBe(1);
    expect(result.state.counts.total).toBe(0);
    await api.syncAccount(accountId); // flags come back from the server
    expect(api.listMessages({ folderRole: 'inbox', filter: 'unread' }).total).toBe(0);
    const invoice = api.listMessages({ folderRole: 'inbox' }).messages.find((m) => m.subject === 'Secret quarterly invoice');
    await api.setRead([invoice.id], false);
    await api.syncAccount(accountId);
    expect(api.state().counts.total).toBe(1);
  });

  it('keeps the account order the reader chooses', () => {
    const ids = api.state().accounts.map((a) => a.id);
    expect(api.reorderAccounts([...ids].reverse()).accounts.map((a) => a.id)).toEqual([...ids].reverse());
    expect(() => api.reorderAccounts('nope')).toThrow(/Invalid order/);
  });

  it('never writes mail content, addresses or passwords to disk in clear text', async () => {
    db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const files = fs.readdirSync(dir).map((file) => fs.readFileSync(path.join(dir, file)));
    const everything = Buffer.concat(files).toString('latin1');
    for (const secret of ['Secret quarterly', 'Confidential amount', 'client@acme.test', servers.password, 'Acme', 'tester@emargy.test']) {
      expect(everything.includes(secret), `found "${secret}" on disk`).toBe(false);
    }
  });

  it('opens a conversation, caches it encrypted and marks it read on the server', async () => {
    const invoice = api.listMessages({ query: 'quarterly' }).messages[0];
    const { messages: [opened] } = await api.openThread(invoice.id);
    expect(opened.content.text).toContain('Confidential amount 98765');
    expect(opened.imagesTrusted).toBe(false);
    expect(db.getRaw(invoice.id)).not.toBeNull();
    await waitFor(() => servers.folder('INBOX').messages.find((m) => m.uid === invoice.uid)?.flags.includes('\\Seen'));
  });

  it('receives new mail instantly through IMAP IDLE', async () => {
    const before = events.filter((e) => e.channel === 'mail:changed').length;
    const client = new ImapFlow({ host: '127.0.0.1', port: servers.imapPort, secure: false, auth: { user: servers.user, pass: servers.password }, logger: false });
    await client.connect();
    await client.append('INBOX', rawMessage({ from: 'boss@acme.test', to: servers.user, subject: 'Urgent: contract', body: 'Please sign', id: 'm3' }));
    await client.logout();
    const event = await waitFor(() => events.filter((e) => e.channel === 'mail:changed').slice(before).find((e) => e.payload.newInbox.length));
    expect(event.payload.newInbox[0].subject).toBe('Urgent: contract');
    expect(api.listMessages({}).total).toBe(3);
  });

  it('lets the user undo a send during the undo window', async () => {
    const account = api.state().accounts[0];
    api.updateSettings({ undoSeconds: 10 });
    const { outboxId } = await api.approveAndSend({ accountId: account.id, to: 'partner@acme.test', subject: 'Oops', html: '<p>not yet</p>' });
    const { draft } = api.cancelSend(outboxId);
    expect(draft.subject).toBe('Oops');
    expect(draft.html).toBe('<p>not yet</p>');
    expect(db.listOutbox().some((item) => item.id === outboxId)).toBe(false);
    api.deleteDraft(draft.id);
    api.updateSettings({ undoSeconds: 0 });
    expect(servers.delivered).toHaveLength(0);
  });

  it('sends formatted mail with pasted images as inline attachments, then stores a copy in Sent', async () => {
    const account = api.state().accounts[0];
    const html = '<p dir="rtl">مرحباً <strong>بك</strong></p><p><img src="data:image/png;base64,iVBORw0KGgo="></p><div data-signature="true">— Tester</div>';
    const { outboxId } = await api.approveAndSend({ accountId: account.id, to: 'partner@acme.test', subject: 'Proposal', html });
    expect(servers.delivered).toHaveLength(1);
    const sent = servers.delivered[0].parsed;
    expect(sent.subject).toBe('Proposal');
    expect(sent.html).toContain('<strong>بك</strong>');
    expect(sent.text).toContain('مرحباً بك');
    expect(sent.attachments[0].contentDisposition).toBe('inline');
    expect(sent.attachments[0].cid).toMatch(/^img-.+@emargy$/);
    expect(servers.delivered[0].envelope.rcptTo[0].address).toBe('partner@acme.test');
    expect(db.listOutbox().find((item) => item.id === outboxId).status).toBe('sent');
    await waitFor(() => servers.folder('Sent').messages.length === 1);
    expect(db.listAudit().some((entry) => entry.action === 'message.approved_by_user')).toBe(true);
    expect(api.state().drafts).toHaveLength(0);
  });

  it('keeps a message in the outbox and schedules a retry when sending fails', async () => {
    const account = api.state().accounts[0];
    const smtpPort = servers.smtpPort;
    await new Promise((resolve) => servers.smtp.close(resolve));
    const { outboxId } = await api.approveAndSend({ accountId: account.id, to: 'partner@acme.test', subject: 'Offline test', body: 'x' });
    const item = db.listOutbox().find((entry) => entry.id === outboxId);
    expect(item.status).toBe('queued');
    expect(item.attempts).toBe(1);
    expect(item.lastError).toBeTruthy();
    expect(item.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(smtpPort).toBeGreaterThan(0);
  });

  it('moves deleted messages to Trash on the server', async () => {
    const offer = api.listMessages({ query: 'weekend' }).messages[0];
    await api.trash([offer.id]);
    expect(api.listMessages({ query: 'weekend', folderRole: 'inbox' }).total).toBe(0);
    expect(servers.folder('Trash').messages.length).toBe(1);
  });

  it('groups a reply into the same conversation', async () => {
    const client = new ImapFlow({ host: '127.0.0.1', port: servers.imapPort, secure: false, auth: { user: servers.user, pass: servers.password }, logger: false });
    await client.connect();
    await client.append('INBOX', ['From: boss@acme.test', `To: ${servers.user}`, 'Subject: Re: Urgent: contract', 'Message-ID: <m4@test.local>',
      'In-Reply-To: <m3@test.local>', 'References: <m3@test.local>', '', 'Signed it'].join('\r\n'));
    await client.logout();
    await api.syncAccount(api.state().accounts[0].id);
    const row = api.listMessages({ query: 'contract' }).messages[0];
    expect(row.threadCount).toBe(2);
    const { messages } = await api.openThread(row.id);
    expect(messages.map((m) => m.content.text.trim())).toEqual(['Please sign', 'Signed it']);
  });

  it('flags and archives on the server', async () => {
    const row = api.listMessages({ query: 'contract' }).messages[0];
    const thread = db.threadMessages(row.id).map((m) => m.id);
    await api.setFlagged(thread, true);
    expect(api.listMessages({ filter: 'flagged' }).total).toBe(1);
    await api.archive(thread);
    expect(api.listMessages({ query: 'contract', folderRole: 'inbox' }).total).toBe(0);
    await waitFor(() => servers.folder('Archive')?.messages.length === 2);
  });

  it('stores signatures encrypted and links them to accounts', async () => {
    let state = api.saveSignature({ name: 'Work', html: '<p>Sami · Emargy</p>' });
    const signature = state.signatures[0];
    state = await api.updateAccount(state.accounts[0].id, { signatureNew: signature.id, signatureReply: signature.id });
    expect(state.accounts[0].signatureNew).toBe(signature.id);
    state = api.deleteSignature(signature.id);
    expect(state.signatures).toHaveLength(0);
    expect(state.accounts[0].signatureNew).toBeNull();
  });

  it('suggests contacts from mail history', () => {
    expect(api.contacts('acme').map((c) => c.address)).toContain('client@acme.test');
  });

  it('remembers trusted image senders without storing their address', () => {
    api.trustImages('client@acme.test');
    expect(db.isTrustedImageSender('CLIENT@acme.test')).toBe(true);
    expect(db.isTrustedImageSender('other@acme.test')).toBe(false);
  });
});

describe('server auto-detection (DNS only)', () => {
  const { detectServers } = require('../electron/mail.cjs');
  const resolver = (mx = [], srv = {}) => ({
    resolveMx: async () => mx,
    resolveSrv: async (name) => srv[name] || [],
  });

  it('knows common providers without any lookup', async () => {
    expect(await detectServers('me@gmail.com', resolver())).toMatchObject({ imapHost: 'imap.gmail.com', smtpPort: 465 });
    expect(await detectServers('me@hotmail.com', resolver())).toMatchObject({ provider: 'outlook', needsOAuth: true });
  });

  it('recognises Google Workspace and Zoho from MX records', async () => {
    expect(await detectServers('a@company.test', resolver([{ exchange: 'aspmx.l.google.com' }]))).toMatchObject({ provider: 'gmail', source: 'mx' });
    expect(await detectServers('a@company.test', resolver([{ exchange: 'mx.zoho.eu' }]))).toMatchObject({ imapHost: 'imap.zoho.eu' });
  });

  it('uses SRV records, then falls back to mail.<domain>', async () => {
    const srv = { '_imaps._tcp.host.test': [{ name: 'imap.host.test', port: 993, priority: 0 }], '_submission._tcp.host.test': [{ name: 'smtp.host.test', port: 587, priority: 0 }] };
    expect(await detectServers('a@host.test', resolver([], srv))).toMatchObject({ imapHost: 'imap.host.test', smtpHost: 'smtp.host.test', smtpPort: 587, smtpSecure: false });
    expect(await detectServers('a@other.test', resolver(), async () => false)).toMatchObject({ imapHost: 'mail.other.test', source: 'guess' });
  });

  it('finds a shared-hosting server from the MX host when mail.<domain> is proxied', async () => {
    const live = new Set(['mx1.sharedhost.test:993', 'mx1.sharedhost.test:465']);
    const probe = async (host, port) => live.has(`${host}:${port}`);
    expect(await detectServers('info@shop.test', resolver([{ exchange: 'mx1.sharedhost.test', priority: 0 }]), probe))
      .toMatchObject({ imapHost: 'mx1.sharedhost.test', smtpHost: 'mx1.sharedhost.test', smtpPort: 465, smtpSecure: true, source: 'probe' });
    // No server answered with a valid certificate: suggest the MX host rather than a blind guess.
    expect(await detectServers('info@shop.test', resolver([{ exchange: 'mx.shop.test.' }]), async () => false))
      .toMatchObject({ imapHost: 'mx.shop.test', source: 'guess' });
  });
});

describe('vault', () => {
  it('refuses to decrypt data that was tampered with', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emargy-vault-'));
    const vault = new Vault({ keyFile: path.join(dir, 'vault.key'), protect, unprotect });
    const blob = vault.encrypt('hello');
    expect(vault.decryptText(blob)).toBe('hello');
    blob[blob.length - 1] ^= 1;
    expect(() => vault.decrypt(blob)).toThrow();
    const reopened = new Vault({ keyFile: path.join(dir, 'vault.key'), protect, unprotect });
    expect(reopened.decryptText(vault.encrypt('same key'))).toBe('same key');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('legacy prototype migration', () => {
  it('imports projects, accounts and drafts, then wipes the plaintext file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emargy-migrate-'));
    const legacyFile = path.join(dir, 'emargy-mail.json');
    fs.writeFileSync(legacyFile, JSON.stringify({
      language: 'ar',
      projects: [{ id: 'p1', name: 'Old project', color: '#ff6b4a', createdAt: '2026-11-01T00:00:00Z' }],
      accounts: [{ id: 'a1', projectId: 'p1', email: 'old@x.test', imapHost: 'imap.x.test', smtpHost: 'smtp.x.test', encryptedPassword: 'c2VjcmV0' }],
      messages: [{ id: 'a1:1', subject: 'plaintext body' }],
      drafts: [{ id: 'd1', accountId: 'a1', to: 'x@y.test', subject: 'Hi', body: 'draft', status: 'draft' }],
    }));
    const vault = new Vault({ keyFile: path.join(dir, 'vault.key'), protect, unprotect });
    const db = new Database({ file: path.join(dir, 'emargy.db'), vault });
    const result = migrateLegacyStore({ db, legacyFile, decryptLegacySecret: (s) => Buffer.from(s, 'base64').toString() });
    expect(result).toEqual({ migrated: true, accounts: 1 });
    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(db.getSetting('language')).toBe('ar');
    expect(db.getAccount('a1', { withSecrets: true }).password).toBe('secret');
    expect(db.listDrafts()[0].subject).toBe('Hi');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
