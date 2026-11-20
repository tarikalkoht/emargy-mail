/**
 * Accounts on Resend (resend.com), through its REST API instead of IMAP/SMTP.
 *
 *   Inbox  ← GET /emails/receiving (mail Resend received for your domains)
 *   Sent   ← GET /emails            (mail sent with this API key)
 *   Send   → POST /emails
 *
 * Resend has no folders, read state or flags, so Archive, Trash, Junk, read and
 * flagged live only in this app's encrypted database. The API key is stored
 * encrypted like a password and is only ever sent to api.resend.com.
 */
const MailComposer = require('nodemailer/lib/mail-composer');
const { convert } = require('html-to-text');
const { parseRawMessage, extractInlineImages, htmlDocument } = require('./mail.cjs');
const { isImportant } = require('./core.cjs');
const { parseAddressList } = require('./db.cjs');

const API = 'https://api.resend.com';
const MIN_GAP_MS = 550; // Resend allows a few requests per second per team
const PAGE = 100;
const INITIAL_PAGES = 3;
const NEW_PAGES = 5;
const POLL_MS = 90_000;
const PREFETCH = 15;
const MAX_RAW_BYTES = 40 * 1024 * 1024;
const FOLDERS = [['INBOX', 'inbox', 'Inbox'], ['Sent', 'sent', 'Sent'], ['Archive', 'archive', 'Archive'], ['Junk', 'junk', 'Junk'], ['Trash', 'trash', 'Trash']];

class ResendError extends Error {
  constructor(message, { status = 0, name = '' } = {}) {
    super(message);
    this.status = status;
    this.code = name;
  }
}

/** One request at a time per key, spaced out, with a retry when Resend says "slow down". */
class ResendClient {
  constructor(apiKey, { fetchImpl = fetch, gap = MIN_GAP_MS } = {}) {
    if (!/^re_[A-Za-z0-9_-]{8,}$/.test(String(apiKey || ''))) throw new ResendError('This does not look like a Resend API key (it starts with re_).', { name: 'invalid_api_key' });
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.gap = gap;
    this.queue = Promise.resolve();
    this.last = 0;
  }

  request(method, path, { body, headers = {} } = {}) {
    const work = async () => {
      for (let attempt = 0; ; attempt += 1) {
        const wait = this.last + this.gap - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.last = Date.now();
        const response = await this.fetch(`${API}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'emargy-mail', ...headers },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
        if (response.status === 429 && attempt < 3) {
          const seconds = Number(response.headers.get('retry-after')) || 2 ** attempt;
          await new Promise((r) => setTimeout(r, Math.min(30, seconds) * 1000));
          continue;
        }
        const text = await response.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        if (!response.ok) {
          throw new ResendError(json?.message || `Resend answered ${response.status}.`, { status: response.status, name: json?.name || '' });
        }
        return json;
      }
    };
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
}

function lower(value) {
  return String(value || '').toLowerCase().trim();
}

function addressesIn(values) {
  return (Array.isArray(values) ? values : [values]).flatMap((v) => parseAddressList(String(v || ''))).map((a) => a.address);
}

function formatList(values) {
  return (Array.isArray(values) ? values : values ? [values] : []).filter(Boolean).join(', ');
}

/** "2023-04-03 22:13:42.674981+00" and ISO dates alike. */
function parseDate(value) {
  if (!value) return Date.now();
  let text = String(value).trim().replace(' ', 'T');
  if (/[+-]\d{2}$/.test(text)) text += ':00';
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : Date.now();
}

function domainOf(email) {
  return lower(email).split('@')[1] || '';
}

/**
 * Check the key before saving the account: the address must be on a domain of this
 * Resend team. A "sending access" key cannot list anything; it is accepted for
 * sending only, and the inbox stays empty.
 */
async function verifyResend({ apiKey, email }, { fetchImpl = fetch } = {}) {
  const client = new ResendClient(apiKey, { fetchImpl, gap: 0 });
  let domains;
  try {
    domains = (await client.request('GET', '/domains'))?.data || [];
  } catch (error) {
    if (error.code === 'restricted_api_key') return { mode: 'send', receiving: false };
    if (error.status === 401 || error.status === 403 || ['invalid_api_key', 'missing_api_key'].includes(error.code)) throw new Error('Resend did not accept this API key.');
    throw new Error(`Could not reach Resend: ${error.message}`);
  }
  const domain = domainOf(email);
  const match = domains.find((d) => lower(d.name) === domain);
  if (!match) {
    const names = domains.map((d) => d.name).join(', ') || '—';
    throw new Error(`${domain} is not a domain of this Resend account (domains: ${names}).`);
  }
  if (!['verified', 'partially_verified'].includes(match.status)) throw new Error(`${domain} is not verified in Resend yet (status: ${match.status}).`);
  return { mode: 'full', receiving: match.capabilities ? match.capabilities.receiving === 'enabled' : true };
}

/** A real RFC 822 message for something Resend only gave as fields. */
async function composeRaw(email, { folderRole }) {
  const headers = {};
  for (const [name, value] of Object.entries(email.headers || {})) {
    if (/^(in-reply-to|references|list-unsubscribe|list-id|precedence|auto-submitted|authentication-results|x-spam-[a-z]+)$/i.test(name)) headers[name] = String(value);
  }
  const mail = new MailComposer({
    from: email.from,
    to: formatList(email.to) || undefined,
    cc: formatList(email.cc) || undefined,
    bcc: folderRole === 'sent' ? formatList(email.bcc) || undefined : undefined,
    replyTo: formatList(email.reply_to) || undefined,
    subject: email.subject || '',
    text: email.text || (email.html ? convert(email.html, { wordwrap: 78 }) : ''),
    html: email.html || undefined,
    messageId: email.message_id || undefined,
    date: new Date(parseDate(email.created_at)),
    headers,
  });
  const compiled = mail.compile();
  compiled.keepBcc = true;
  return compiled.build();
}

class ResendWorker {
  constructor(manager, accountId) {
    this.manager = manager;
    this.accountId = accountId;
    this.status = 'idle';
    this.error = null;
    this.stopped = false;
    this.queue = Promise.resolve();
    this.pollTimer = null;
    this.initialSyncDone = false;
  }

  get db() {
    return this.manager.db;
  }

  account() {
    return this.db.getAccount(this.accountId, { withSecrets: true });
  }

  client() {
    const account = this.account();
    if (!this.api || this.api.apiKey !== account.apiKey) this.api = new ResendClient(account.apiKey, { gap: this.manager.resendGap ?? MIN_GAP_MS });
    return this.api;
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.manager.emit('sync:status', { accountId: this.accountId, status, error });
  }

  run(work) {
    const next = this.queue.then(() => {
      if (this.stopped) throw new Error('Account sync is stopped.');
      return work();
    });
    this.queue = next.catch(() => {});
    return next;
  }

  ensureFolders() {
    for (const [path, role, name] of FOLDERS) this.db.upsertFolder(this.accountId, path, role, name);
    return this.db.listFolders(this.accountId);
  }

  folder(role) {
    return this.db.listFolders(this.accountId).find((f) => f.role === role);
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.stopped) this.pollTimer = setTimeout(() => this.syncNow().catch(() => {}), POLL_MS);
  }

  /** Is this message for this account? (One API key sees every address of the team.) */
  mine(email, kind) {
    const account = this.account();
    if (account.allAddresses) return true;
    const me = lower(account.email);
    if (kind === 'sent') return addressesIn(email.from).includes(me);
    return [...addressesIn(email.to), ...addressesIn(email.cc), ...addressesIn(email.bcc), ...addressesIn(email.received_for)].includes(me);
  }

  summary(email, kind, account) {
    const from = String(email.from || '');
    const fromAddress = addressesIn(from)[0] || lower(from);
    const subject = email.subject || '(No subject)';
    return {
      remoteId: `${kind}:${email.id}`,
      projectId: account.projectId,
      subject,
      from,
      fromAddress,
      to: formatList(email.to),
      cc: formatList(email.cc),
      messageId: email.message_id || '',
      inReplyTo: '',
      date: new Date(parseDate(email.created_at)).toISOString(),
      dateValue: parseDate(email.created_at),
      read: kind === 'sent',
      flagged: false,
      important: isImportant(subject, ''),
      hasAttachments: Array.isArray(email.attachments) && email.attachments.some((a) => a.content_disposition !== 'inline'),
      size: 0,
      trust: '',
    };
  }

  /** Walk a list endpoint newest-first until a known message, or `pages` pages. */
  async collect(path, kind, { pages, after, known }) {
    const found = [];
    let cursor = after;
    let done = false;
    for (let page = 0; page < pages; page += 1) {
      const query = new URLSearchParams({ limit: String(PAGE) });
      if (cursor) query.set('after', cursor);
      const result = await this.client().request('GET', `${path}?${query}`);
      const items = result?.data || [];
      let reachedKnown = false;
      for (const email of items) {
        if (known.has(`${kind}:${email.id}`)) { reachedKnown = true; continue; }
        if (this.mine(email, kind)) found.push(email);
      }
      if (!result?.has_more || !items.length) { done = true; break; }
      cursor = items[items.length - 1].id;
      if (reachedKnown && !after) break;
    }
    return { found, done, cursor };
  }

  store(folder, emails, kind) {
    if (!emails.length) return [];
    const account = this.account();
    let uid = this.db.nextUid(folder.id);
    // Oldest first, so UIDs grow with time like on an IMAP server.
    const sorted = emails.map((e) => this.summary(e, kind, account)).sort((a, b) => a.dateValue - b.dateValue);
    return this.db.insertMessages(folder, sorted.map((m) => ({ ...m, uid: uid++ })));
  }

  syncNow() {
    return this.run(async () => {
      this.setStatus('syncing');
      const account = this.account();
      this.ensureFolders();
      const known = this.db.knownRemoteIds(this.accountId);
      const first = !this.db.listFolders(this.accountId).some((f) => this.db.oldestUid(f.id));
      const pages = first ? INITIAL_PAGES : NEW_PAGES;
      let added = [];
      const inbox = this.folder('inbox');
      const sent = this.folder('sent');
      if (account.resendMode !== 'send') {
        const received = await this.collect('/emails/receiving', 'in', { pages, known });
        added = added.concat(this.store(inbox, received.found, 'in'));
        if (first) this.db.setFolderOlderDone(inbox.id, received.done);
        const outgoing = await this.collect('/emails', 'sent', { pages, known });
        added = added.concat(this.store(sent, outgoing.found, 'sent'));
        if (first) this.db.setFolderOlderDone(sent.id, outgoing.done);
      } else {
        this.db.setFolderOlderDone(inbox.id, true);
        this.db.setFolderOlderDone(sent.id, true);
      }
      const wasInitial = !this.initialSyncDone;
      this.initialSyncDone = true;
      this.setStatus('idle');
      this.manager.emit('mail:changed', {
        accountId: this.accountId,
        newInbox: wasInitial ? [] : added.filter((m) => m.folderRole === 'inbox' && !m.read).map((m) => ({
          id: m.id, projectId: m.projectId, accountId: m.accountId, subject: m.subject, from: m.from, trust: m.trust, important: m.important, category: m.category,
        })),
      });
      this.prefetch().catch(() => {});
      return added.length;
    }).catch((error) => {
      const message = error.code === 'restricted_api_key' ? 'This Resend key can only send. Use a full access key to see received mail.' : error.message;
      this.setStatus('error', message);
      throw new Error(message);
    }).finally(() => this.schedulePoll());
  }

  /** Bring in the next page of older mail for Inbox or Sent. */
  loadOlder(folderId) {
    return this.run(async () => {
      const folder = this.db.getFolder(folderId);
      if (!folder || !['inbox', 'sent'].includes(folder.role)) return { added: 0, done: true };
      const kind = folder.role === 'inbox' ? 'in' : 'sent';
      const oldest = this.db.sorted.filter((m) => m.accountId === this.accountId && m.remoteId?.startsWith(`${kind}:`)).at(-1);
      const known = this.db.knownRemoteIds(this.accountId);
      const result = await this.collect(kind === 'in' ? '/emails/receiving' : '/emails', kind, { pages: 2, after: oldest?.remoteId.slice(kind.length + 1), known });
      const added = this.store(folder, result.found, kind);
      this.db.setFolderOlderDone(folder.id, result.done);
      return { added: added.length, done: result.done };
    });
  }

  /** Search stays on this computer (Resend's API has no search). */
  async searchFolder() {
    return [];
  }

  async downloadRaw(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Unsafe download address.');
    const response = await fetch(parsed, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RAW_BYTES) throw new Error('The message is too large.');
    return buffer;
  }

  async rawFor(message) {
    const [kind, id] = String(message.remoteId || '').split(/:(.*)/s);
    if (!id) throw new Error('Message was not found on Resend.');
    if (kind === 'in') {
      const email = await this.client().request('GET', `/emails/receiving/${encodeURIComponent(id)}`);
      if (email?.raw?.download_url) {
        try { return await this.downloadRaw(email.raw.download_url); } catch { /* fall back to the fields */ }
      }
      return composeRaw(email, { folderRole: 'inbox' });
    }
    const email = await this.client().request('GET', `/emails/${encodeURIComponent(id)}`);
    return composeRaw(email, { folderRole: 'sent' });
  }

  fetchRaw(message) {
    return this.run(() => this.rawFor(message));
  }

  async prefetch() {
    const pending = this.db.messagesToPrefetch(this.accountId, PREFETCH).filter((m) => m.remoteId);
    for (const message of pending) {
      if (this.stopped) return;
      try {
        const raw = await this.fetchRaw(message);
        const parsed = await parseRawMessage(raw);
        if (!this.db.headers.has(message.id)) continue;
        this.db.setRaw(message.id, raw, parsed.preview);
        this.db.refreshTrust(message.id, raw);
      } catch { /* try again next time */ }
    }
    if (pending.length) this.manager.emit('mail:changed', { accountId: this.accountId, newInbox: [] });
  }

  // Read and flagged state are kept locally by the caller (api.cjs); nothing to tell Resend.
  async setSeen() {}

  async setSeenMany() {}

  async setFlagged() {}

  moveToTrash(message) {
    return this.run(async () => {
      const trash = this.folder('trash') || this.ensureFolders().find((f) => f.role === 'trash');
      if (message.folderId === trash.id) {
        this.db.forgetRemote(this.accountId, message.remoteId);
        this.db.deleteMessage(message.id);
      } else {
        this.db.moveLocal(message.id, trash.id);
      }
    });
  }

  archive(message) {
    return this.run(async () => {
      const archive = this.folder('archive') || this.ensureFolders().find((f) => f.role === 'archive');
      if (message.folderId !== archive.id) this.db.moveLocal(message.id, archive.id);
    });
  }

  moveTo(message, folderId) {
    return this.run(async () => {
      if (message.folderId === Number(folderId)) throw new Error('Choose another folder in the same account.');
      this.db.moveLocal(message.id, Number(folderId));
    });
  }

  /** A message copied in from another account is kept on this computer. */
  importRaw(folderId, raw, { seen = true, flagged = false } = {}) {
    return this.run(async () => {
      const folder = this.db.getFolder(folderId);
      if (!folder || folder.account_id !== this.accountId) throw new Error('Folder not found.');
      const parsed = await parseRawMessage(raw);
      const account = this.account();
      this.db.insertMessages(folder, [{
        uid: this.db.nextUid(folder.id), projectId: account.projectId, subject: parsed.subject, from: parsed.from, fromAddress: parsed.fromAddress,
        to: parsed.to, cc: parsed.cc, messageId: parsed.messageId, inReplyTo: '', references: parsed.references, preview: parsed.preview,
        date: parsed.date, dateValue: Date.parse(parsed.date) || Date.now(), read: seen, flagged, important: isImportant(parsed.subject, parsed.preview),
        hasAttachments: parsed.attachments.length > 0, size: raw.length, trust: '', raw,
      }]);
      this.manager.emit('mail:changed', { accountId: this.accountId, newInbox: [] });
    });
  }

  removePermanently(message) {
    return this.run(async () => {
      this.db.forgetRemote(this.accountId, message.remoteId);
      this.db.deleteMessage(message.id);
    });
  }

  /** Resend lists sent mail itself; the next sync shows it in Sent. */
  async appendSent() {
    return false;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
  }
}

/** Send one queued message through the API. The outbox id makes a retry safe (no duplicates). */
async function sendWithResend(account, item, { fetchImpl = fetch } = {}) {
  const draft = item.draft || {};
  const list = (value) => parseAddressList(value).map((a) => (a.name ? `${a.name.replace(/[<>"]/g, '')} <${a.address}>` : a.address));
  const attachments = (draft.attachments || []).map((file) => ({ filename: file.filename, content: file.content, content_type: file.contentType }));
  let html;
  let text = draft.body || '';
  if (draft.html) {
    const extracted = extractInlineImages(draft.html);
    html = htmlDocument(extracted.html);
    text = convert(extracted.html, { wordwrap: 78, selectors: [{ selector: 'img', format: 'skip' }] });
    for (const image of extracted.inline) {
      attachments.push({ filename: image.filename, content: image.content.toString('base64'), content_type: image.contentType, content_id: image.cid });
    }
  }
  const headers = {};
  if (draft.inReplyTo) headers['In-Reply-To'] = draft.inReplyTo;
  if (draft.references) headers.References = draft.references;
  const name = String(account.displayName || '').replace(/[<>"]/g, '').trim();
  const body = {
    from: name ? `${name} <${account.email}>` : account.email,
    to: list(draft.to),
    cc: list(draft.cc),
    bcc: list(draft.bcc),
    subject: draft.subject || '',
    html,
    text,
    headers: Object.keys(headers).length ? headers : undefined,
    attachments: attachments.length ? attachments : undefined,
  };
  if (!body.cc.length) delete body.cc;
  if (!body.bcc.length) delete body.bcc;
  const client = new ResendClient(account.apiKey, { fetchImpl, gap: 0 });
  const result = await client.request('POST', '/emails', { body, headers: { 'Idempotency-Key': `emargy-${item.id}` } });
  return { messageId: result?.id || '' };
}

module.exports = { ResendClient, ResendWorker, verifyResend, sendWithResend, composeRaw, parseDate };
