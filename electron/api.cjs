const { ImapFlow } = require('imapflow');
const { MICROSOFT } = require('./oauth.cjs');
const { buildRawMessage, detectServers, imapConfig, parseRawMessage, verifySmtp, extractAttachment } = require('./mail.cjs');
const { verifyResend } = require('./resend.cjs');
const { CATEGORIES } = require('./categorize.cjs');

const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;
const PROVIDERS = new Set(['custom', 'gmail', 'zoho', 'outlook']);
const LIST_FILTERS = new Set(['all', 'unread', 'important', 'flagged', 'attachments', 'spam']);
const FOLDER_ROLES = new Set(['inbox', 'sent', 'archive', 'trash', 'junk', 'drafts', 'all', 'custom', 'any']);

const DEFAULT_SETTINGS = {
  theme: 'system',
  density: 'comfortable',
  undoSeconds: 10,
  confirmBeforeSend: false,
  notifications: true,
  markReadOnOpen: true,
  aiProvider: 'auto',
  autoUpdate: true,
  aiAlerts: false,
  closeToTray: true,
  startAtLogin: false,
  inboxTabs: true,
  notifyPrimaryOnly: false,
  notifyMode: 'all',
  notifyPreview: true,
  notifySound: true,
  taskbarBadge: true,
  quietHours: { enabled: false, from: '22:00', to: '07:00' },
  mutedProjects: [],
  emptyScene: 'trays',
  bodyCacheDays: 90,
  spellCheck: true,
};
const SETTING_RULES = {
  theme: (v) => ['system', 'light', 'dark'].includes(v),
  density: (v) => ['comfortable', 'compact'].includes(v),
  undoSeconds: (v) => [0, 5, 10, 20, 30].includes(v),
  confirmBeforeSend: (v) => typeof v === 'boolean',
  notifications: (v) => typeof v === 'boolean',
  markReadOnOpen: (v) => typeof v === 'boolean',
  aiProvider: (v) => ['auto', 'claude', 'codex', 'off'].includes(v),
  autoUpdate: (v) => typeof v === 'boolean',
  aiAlerts: (v) => typeof v === 'boolean',
  closeToTray: (v) => typeof v === 'boolean',
  startAtLogin: (v) => typeof v === 'boolean',
  inboxTabs: (v) => typeof v === 'boolean',
  notifyPrimaryOnly: (v) => typeof v === 'boolean',
  notifyMode: (v) => ['all', 'important', 'off'].includes(v),
  notifyPreview: (v) => typeof v === 'boolean',
  notifySound: (v) => typeof v === 'boolean',
  taskbarBadge: (v) => typeof v === 'boolean',
  quietHours: (v) => v && typeof v.enabled === 'boolean' && /^\d{2}:\d{2}$/.test(v.from) && /^\d{2}:\d{2}$/.test(v.to),
  mutedProjects: (v) => Array.isArray(v) && v.length < 200 && v.every((id) => typeof id === 'string' && id.length < 80),
  emptyScene: (v) => ['trays', 'dawn', 'night', 'plain', 'custom'].includes(v),
  bodyCacheDays: (v) => [0, 30, 90, 365].includes(v),
  spellCheck: (v) => typeof v === 'boolean',
};

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function port(value, fallback) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('Port must be between 1 and 65535.');
  return number;
}

function hostName(value) {
  const host = text(value, 255);
  if (!/^[a-z0-9.-]+$/i.test(host) && !/^\[?[0-9a-f:]+\]?$/i.test(host)) throw new Error('Server address is not valid.');
  return host;
}

function emailAddress(value) {
  const email = text(value, 320);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('Email address is not valid.');
  return email;
}

const DAY_MS = 86_400_000;
const FOLLOW_UP_DAYS = new Set([1, 2, 3, 5, 7, 14, 30]);

/** A time chosen by the reader (send later, snooze, remind): in the future, within a year. */
function futureTime(value, now = Date.now()) {
  const at = Number(value);
  if (!Number.isFinite(at) || at < now + 30_000) throw new Error('Choose a time in the future.');
  if (at > now + 366 * DAY_MS) throw new Error('Choose a time within the next year.');
  return Math.round(at);
}

/**
 * An unsubscribe link may only reach the public internet: never this computer, the local
 * network or a bare IP address, so a hostile email cannot use it to poke at a router.
 */
function publicHttpsUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || /\.(local|localhost|internal|lan|home|arpa)$/.test(host)) return null;
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return null;
  return url;
}

/** mailto:a@b?subject=x&body=y -> { to, subject, body } (one address only). */
function parseMailto(value) {
  const match = String(value).match(/^mailto:([^?]+)(?:\?(.*))?$/i);
  if (!match) return null;
  let to;
  try { to = decodeURIComponent(match[1]).split(',')[0].trim(); } catch { return null; }
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) return null;
  const params = new URLSearchParams(match[2] || '');
  return { to, subject: (params.get('subject') || 'unsubscribe').slice(0, 200), body: (params.get('body') || 'unsubscribe').slice(0, 1000) };
}

/** An account picture: a small image the app already resized, or null to remove it. */
function accountPicture(value) {
  if (value === null || value === '') return null;
  const dataUrl = String(value);
  if (!/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(dataUrl) || dataUrl.length > 200_000) throw new Error('Choose a PNG, JPG or WebP picture.');
  return dataUrl;
}

function ids(value) {
  const list = (Array.isArray(value) ? value : [value]).map((id) => text(id, 200)).filter(Boolean);
  if (!list.length) throw new Error('No messages selected.');
  return list.slice(0, 1000);
}

function sanitizeDraft(input) {
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const total = attachments.reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (total > MAX_ATTACHMENTS_BYTES) throw new Error('Attachments are larger than 25 MB.');
  return {
    id: input.id ? text(input.id, 64) : undefined,
    accountId: text(input.accountId, 64),
    to: text(input.to, 4000),
    cc: text(input.cc, 4000),
    bcc: text(input.bcc, 4000),
    subject: text(input.subject, 998),
    body: String(input.body ?? '').slice(0, 2_000_000),
    html: input.html ? String(input.html).slice(0, 15_000_000) : '',
    inReplyTo: text(input.inReplyTo, 998),
    references: text(input.references, 8000),
    attachments: attachments.map((file) => ({
      filename: text(file.filename, 255) || 'attachment',
      contentType: text(file.contentType, 255) || 'application/octet-stream',
      size: Number(file.size || 0),
      content: String(file.content || ''),
    })),
  };
}

async function testImapLogin(account) {
  const client = new ImapFlow(imapConfig(account));
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (error) {
    throw new Error(error.authenticationFailed ? 'IMAP login failed. Check the email and password (or app password).' : `IMAP connection failed: ${error.message}`);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

const { verifiedDkimDomains } = require('./dkim.cjs');

function createApi({ db, sync, outbox, emit = () => {}, fetchImpl = globalThis.fetch }) {
  const settings = () => {
    const saved = db.getSetting('preferences', {});
    const merged = { ...DEFAULT_SETTINGS, ...saved };
    if (saved.notifications === false && !saved.notifyMode) merged.notifyMode = 'off';
    return merged;
  };

  async function openOne(message) {
    let raw = db.getRaw(message.id);
    if (!raw) {
      raw = await sync.worker(message.accountId).fetchRaw(message);
      const parsed = await parseRawMessage(raw);
      db.setRaw(message.id, raw, parsed.preview);
      db.refreshTrust(message.id, raw);
      db.verifyTrustLater(message.id, raw, verifiedDkimDomains);
      return parsed;
    }
    return parseRawMessage(raw);
  }

  async function markSeen(messageIds, seen) {
    const groups = new Map();
    for (const id of messageIds) {
      const message = db.getMessage(id);
      db.setSeen(message.id, seen);
      const key = `${message.accountId}|${message.folderId}`;
      if (!groups.has(key)) groups.set(key, { accountId: message.accountId, folderId: message.folderId, uids: [] });
      groups.get(key).uids.push(message.uid);
    }
    await Promise.all([...groups.values()].map(async (group) => {
      for (let i = 0; i < group.uids.length; i += 500) {
        await sync.worker(group.accountId).setSeenMany(group.folderId, group.uids.slice(i, i + 500), seen).catch(() => {});
      }
    }));
  }

  /** A message that will not go out needs no reply reminder. */
  function dropFollowUps(outboxId) {
    for (const r of db.listReminders()) if (r.kind === 'followup' && r.outboxId === outboxId) db.removeReminder(r.id);
  }

  function each(messageIds, work) {
    return Promise.all(ids(messageIds).map(async (id) => work(db.getMessage(id))));
  }

  const api = {
    state() {
      const statuses = sync.statuses();
      return {
        language: db.getSetting('language', 'en'),
        settings: settings(),
        projects: db.listProjects(),
        accounts: db.listAccounts().map((account) => ({ ...account, sync: statuses[account.id] || { status: 'idle', error: null } })),
        folders: db.listAllFolders(),
        counts: db.unreadCounts(),
        signatures: db.listSignatures(),
        drafts: db.listDrafts().map(({ attachments, html, body, ...draft }) => ({ ...draft, attachmentCount: attachments?.length || 0 })),
        outbox: db.listOutbox().map(({ raw, envelope, draft, ...item }) => item),
        reminders: api.reminders(),
      };
    },

    setLanguage(language) {
      db.setSetting('language', language === 'ar' ? 'ar' : 'en');
      return api.state();
    },

    updateSettings(changes = {}) {
      const next = settings();
      for (const [key, value] of Object.entries(changes)) {
        if (SETTING_RULES[key]?.(value)) next[key] = value;
      }
      db.setSetting('preferences', next);
      return api.state();
    },

    createProject(input) {
      const name = text(input?.name, 80);
      if (!name) throw new Error('Project name is required.');
      const color = /^#[0-9a-f]{6}$/i.test(input?.color) ? input.color : '#2d8cff';
      const id = db.createProject({ name, color });
      db.audit('project.created', { projectId: id, name });
      return api.state();
    },

    deleteProject(id) {
      db.deleteProject(text(id, 64));
      db.audit('project.deleted', { projectId: id });
      return api.state();
    },

    detectServers(email) {
      return detectServers(emailAddress(email));
    },

    /** Called by the main process after a completed Microsoft sign-in (never from the interface directly). */
    async addOAuthAccount(input, signed) {
      const projectId = text(input?.projectId, 64);
      if (!db.listProjects().some((project) => project.id === projectId)) throw new Error('Choose a valid project.');
      const email = emailAddress(signed.email);
      const existing = db.listAccounts().find((a) => a.email.toLowerCase() === email);
      if (existing) {
        const where = db.listProjects().find((p) => p.id === existing.projectId)?.name || '';
        throw new Error(`DUPLICATE_ACCOUNT:${existing.email}:${where}`);
      }
      const account = {
        projectId, provider: 'outlook', authType: 'microsoft', displayName: text(input.displayName, 120) || text(signed.name, 120),
        email, ...MICROSOFT.servers, oauth: signed.oauth,
      };
      await testImapLogin(account);
      try {
        await verifySmtp(account);
      } catch (error) {
        // Some Microsoft 365 tenants switch SMTP sign-in off; reading mail still works.
        db.audit('account.smtpWarning', { email, error: error.message.slice(0, 200) });
      }
      const id = db.createAccount(account);
      db.audit('account.created', { accountId: id, projectId, email, via: 'microsoft' });
      sync.worker(id).syncNow().catch(() => {});
      return api.state();
    },

    /** New tokens after "sign in again" (password changed, access revoked…). */
    async renewOAuth(accountId, signed) {
      const account = db.getAccount(text(accountId, 64));
      if (account.authType !== 'microsoft') throw new Error('This account does not sign in with Microsoft.');
      if (signed.email && signed.email.toLowerCase() !== account.email.toLowerCase()) throw new Error(`Sign in as ${account.email}.`);
      db.updateAccount(account.id, { oauth: signed.oauth });
      await sync.removeAccount(account.id);
      sync.worker(account.id).syncNow().catch(() => {});
      return api.state();
    },

    /** An address on Resend: mail goes in and out through the Resend API with one key. */
    async addResendAccount(input) {
      const projectId = text(input?.projectId, 64);
      if (!db.listProjects().some((project) => project.id === projectId)) throw new Error('Choose a valid project.');
      const email = emailAddress(input?.email).toLowerCase();
      const apiKey = text(input?.apiKey, 200);
      const existing = db.listAccounts().find((a) => a.email.toLowerCase() === email);
      if (existing) {
        const where = db.listProjects().find((p) => p.id === existing.projectId)?.name || '';
        throw new Error(`DUPLICATE_ACCOUNT:${existing.email}:${where}`);
      }
      const checked = await verifyResend({ apiKey, email });
      const account = {
        projectId, provider: 'resend', authType: 'resend', displayName: text(input.displayName, 120), email, apiKey,
        resendMode: checked.mode, allAddresses: Boolean(input.allAddresses),
      };
      const id = db.createAccount(account);
      db.audit('account.created', { accountId: id, projectId, email, via: 'resend', mode: checked.mode });
      sync.worker(id).syncNow().catch(() => {});
      return { ...api.state(), resend: checked };
    },

    async addAccount(input) {
      if (input?.authType === 'resend') return api.addResendAccount(input);
      if (input?.authType || input?.oauth) throw new Error('Use Sign in with Microsoft for this account.');
      const projectId = text(input?.projectId, 64);
      if (!db.listProjects().some((project) => project.id === projectId)) throw new Error('Choose a valid project.');
      const password = String(input?.password || '');
      if (!password) throw new Error('Password is required.');
      const account = {
        projectId,
        provider: PROVIDERS.has(input.provider) ? input.provider : 'custom',
        displayName: text(input.displayName, 120),
        email: emailAddress(input.email),
        username: text(input.username, 320) || undefined,
        imapHost: hostName(input.imapHost),
        imapPort: port(input.imapPort, 993),
        imapSecure: input.imapSecure !== false,
        smtpHost: hostName(input.smtpHost),
        smtpPort: port(input.smtpPort, 465),
        smtpSecure: input.smtpSecure !== false,
        password,
      };
      const login = (a) => `${(a.username || a.email).toLowerCase()}@${String(a.imapHost).toLowerCase()}`;
      const existing = db.listAccounts().find((a) => a.email.toLowerCase() === account.email.toLowerCase() || login(a) === login(account));
      if (existing) {
        const where = db.listProjects().find((p) => p.id === existing.projectId)?.name || '';
        throw new Error(`DUPLICATE_ACCOUNT:${existing.email}:${where}`);
      }
      // Check both servers before saving so a typo never ends up stored.
      await testImapLogin(account);
      try {
        await verifySmtp(account);
      } catch (error) {
        throw new Error(`SMTP check failed: ${error.message}`);
      }
      const id = db.createAccount(account);
      db.audit('account.created', { accountId: id, projectId, email: account.email });
      sync.worker(id).syncNow().catch(() => {});
      return api.state();
    },

    async updateAccount(id, changes = {}) {
      const account = db.getAccount(text(id, 64), { withSecrets: true });
      const next = { ...account };
      if (changes.displayName !== undefined) next.displayName = text(changes.displayName, 120);
      if (changes.projectId && db.listProjects().some((p) => p.id === changes.projectId)) next.projectId = changes.projectId;
      for (const key of ['signatureNew', 'signatureReply']) {
        if (changes[key] !== undefined) next[key] = changes[key] ? text(changes[key], 64) : null;
      }
      if (changes.picture !== undefined) next.picture = accountPicture(changes.picture);
      if (changes.allAddresses !== undefined && account.authType === 'resend') next.allAddresses = Boolean(changes.allAddresses);
      const reconnect = Boolean(changes.password);
      if (changes.password && account.authType === 'resend') {
        // For Resend the "password" is the API key.
        next.apiKey = text(changes.password, 200);
        next.resendMode = (await verifyResend({ apiKey: next.apiKey, email: account.email })).mode;
      } else if (changes.password) {
        next.password = String(changes.password);
        await testImapLogin(next);
      }
      db.updateAccount(account.id, next);
      db.audit('account.updated', { accountId: account.id, passwordChanged: reconnect });
      if (reconnect) {
        await sync.removeAccount(account.id);
        sync.worker(account.id).syncNow().catch(() => {});
      }
      return api.state();
    },

    async deleteAccount(id) {
      const accountId = text(id, 64);
      const email = db.listAccounts().find((a) => a.id === accountId)?.email;
      await sync.removeAccount(accountId);
      db.deleteAccount(accountId);
      db.audit('account.deleted', { accountId, email });
      return api.state();
    },

    /** The reader's own picture for empty screens, stored encrypted. */
    sceneImage() {
      return db.getSecret('sceneImage');
    },

    setSceneImage(dataUrl) {
      if (dataUrl === null) {
        db.setSecret('sceneImage', null);
      } else {
        if (!/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(String(dataUrl)) || dataUrl.length > 7_000_000) throw new Error('Choose a PNG, JPG, GIF or WebP image under 5 MB.');
        db.setSecret('sceneImage', dataUrl);
      }
      return api.updateSettings({ emptyScene: dataUrl === null ? 'trays' : 'custom' });
    },

    /** Folders that make up a view (used to load older mail and to search the server). */
    foldersForScope(params = {}, { forSearch = false } = {}) {
      const folders = db.listAllFolders();
      if (params.folderId) return folders.filter((f) => f.id === Number(params.folderId));
      const accounts = db.listAccounts().filter((a) => (!params.accountId || params.accountId === 'all' || a.id === params.accountId)
        && (!params.projectId || params.projectId === 'all' || a.projectId === params.projectId));
      return accounts.flatMap((account) => {
        const own = folders.filter((f) => f.accountId === account.id);
        if (forSearch) {
          // Gmail's "All Mail" already holds everything; elsewhere search the main folders.
          const all = own.find((f) => f.role === 'all');
          return all ? [all] : own.filter((f) => ['inbox', 'sent', 'archive'].includes(f.role));
        }
        const role = ['sent', 'archive', 'trash', 'junk', 'drafts', 'all'].includes(params.folderRole) ? params.folderRole : 'inbox';
        return own.filter((f) => f.role === role);
      });
    },

    async loadOlder(params = {}) {
      const folders = api.foldersForScope(params).filter((f) => !f.olderDone);
      const results = await Promise.all(folders.map((f) => sync.worker(f.accountId).loadOlder(f.id).catch(() => ({ added: 0, done: false, failed: true }))));
      const added = results.reduce((sum, r) => sum + r.added, 0);
      return { state: api.state(), added, done: api.foldersForScope(params).every((f) => f.olderDone), failed: results.some((r) => r.failed) };
    },

    async searchServer(params = {}) {
      const query = text(params.query, 200);
      if (query.length < 2) return { found: 0, added: 0 };
      const before = db.listMessages({ folderRole: 'any', query, threaded: false, limit: 1e6 }).total;
      const folders = api.foldersForScope(params, { forSearch: true });
      const hits = await Promise.all(folders.map((f) => sync.worker(f.accountId).searchFolder(f.id, query).catch(() => [])));
      db.rememberSearch(query, hits.flat());
      const after = db.listMessages({ folderRole: 'any', query, threaded: false, limit: 1e6 }).total;
      return { found: hits.flat().length, added: Math.max(0, after - before) };
    },

    /** How much room the local mail copy takes. */
    storage() {
      return db.storageInfo();
    },

    /**
     * Drop full copies of mail older than the retention period (they are fetched again on open).
     * Resend mail is kept: the provider may not hand an old message back.
     */
    freeOldBodies() {
      const accountIds = db.listAccounts().filter((a) => a.authType !== 'resend').map((a) => a.id);
      return db.freeOldBodies(accountIds);
    },

    /** Routine upkeep (at start and once a day): quick, never rebuilds the whole file. */
    maintainStorage() {
      const freed = api.freeOldBodies();
      db.compact();
      if (freed) db.audit('storage.trimmed', { messages: freed });
      return freed;
    },

    /** The reader asked for room back now: trim, then rebuild the file. */
    freeSpace() {
      const before = db.storageInfo().fileBytes;
      const freed = api.freeOldBodies();
      db.compact({ full: true });
      const after = db.storageInfo();
      db.audit('storage.compacted', { messages: freed, before, after: after.fileBytes });
      return { freed, saved: Math.max(0, before - after.fileBytes), storage: after };
    },

    reorderProjects(ids) {
      if (!Array.isArray(ids)) throw new Error('Invalid order.');
      db.reorderProjects(ids.slice(0, 500).map((id) => text(id, 64)));
      return api.state();
    },

    reorderAccounts(ids) {
      if (!Array.isArray(ids)) throw new Error('Invalid order.');
      db.reorderAccounts(ids.slice(0, 500).map((id) => text(id, 64)));
      return api.state();
    },

    async syncAccount(id) {
      await sync.worker(text(id, 64)).syncNow();
      return api.state();
    },

    async syncAll() {
      await sync.syncAll();
      return api.state();
    },

    async syncFolder(folderId) {
      const folder = db.getFolder(Number(folderId));
      if (!folder) throw new Error('Folder not found.');
      await sync.worker(folder.account_id).syncNow([folder.id]);
      return api.state();
    },

    listMessages(params = {}, maxLimit = 500) {
      return db.listMessages({
        projectId: text(params.projectId, 64) || 'all',
        accountId: text(params.accountId, 64) || 'all',
        folderId: params.folderId ? Number(params.folderId) : null,
        folderRole: FOLDER_ROLES.has(params.folderRole) ? params.folderRole : 'inbox',
        filter: LIST_FILTERS.has(params.filter) ? params.filter : 'all',
        query: text(params.query, 200),
        offset: Math.max(0, Number(params.offset) || 0),
        limit: Math.min(maxLimit, Math.max(1, Number(params.limit) || (maxLimit > 500 ? maxLimit : 200))),
        threaded: params.threaded !== false,
        category: settings().inboxTabs && CATEGORIES.includes(params.category) ? params.category : '',
      });
    },

    /** Message ids of a conversation; sameFolder keeps only those in the anchor's folder. */
    threadIds(id, sameFolder = false) {
      const anchor = db.getMessage(text(id, 200));
      return db.threadMessages(anchor.id).filter((m) => !sameFolder || m.folderId === anchor.folderId).map((m) => m.id);
    },

    /** Open a whole conversation: every message, decrypted and parsed, oldest first. */
    async openThread(id) {
      const messages = db.threadMessages(text(id, 200));
      if (messages[0] && db.clearReturned(messages[0].accountId, messages[0].threadKey)) emit('mail:changed', { newInbox: [] });
      const opened = [];
      for (const message of messages) {
        const content = await openOne(message);
        const { search, dateValue, ...header } = db.getMessage(message.id);
        opened.push({ ...header, content, imagesTrusted: db.isTrustedImageSender(content.fromAddress || header.fromAddress) });
      }
      if (settings().markReadOnOpen) {
        const unread = messages.filter((m) => !m.read);
        for (const message of unread) {
          db.setSeen(message.id, true);
          sync.worker(message.accountId).setSeen(message, true).catch(() => {});
        }
        if (unread.length) emit('mail:changed', { accountId: messages[0].accountId, newInbox: [] });
      }
      return { messages: opened };
    },

    async setRead(messageIds, read) {
      await markSeen(ids(messageIds), Boolean(read));
      return api.state();
    },

    /** Mark every unread message of the current view as read (not only the loaded page). */
    async markAllRead(params = {}) {
      const unread = api.listMessages({ ...params, filter: 'unread', threaded: false, query: '' }, Number.MAX_SAFE_INTEGER).messages.map((m) => m.id);
      if (unread.length) await markSeen(unread, true);
      return { state: api.state(), count: unread.length };
    },

    async setFlagged(messageIds, flagged) {
      await each(messageIds, async (message) => {
        db.setFlagged(message.id, Boolean(flagged));
        await sync.worker(message.accountId).setFlagged(message, Boolean(flagged)).catch(() => {});
      });
      return api.state();
    },

    async archive(messageIds) {
      await each(messageIds, async (message) => {
        await sync.worker(message.accountId).archive(message);
        db.deleteMessage(message.id);
      });
      db.audit('message.archived', { count: ids(messageIds).length });
      return api.state();
    },

    async trash(messageIds) {
      await each(messageIds, async (message) => {
        await sync.worker(message.accountId).moveToTrash(message);
        db.deleteMessage(message.id);
      });
      db.audit('message.deleted', { count: ids(messageIds).length });
      return api.state();
    },

    /**
     * Move to any folder. Inside one account the server moves it; to another account the
     * message is copied there first and removed from the old place only after that worked.
     */
    async moveTo(messageIds, folderId) {
      const target = db.getFolder(Number(folderId));
      if (!target) throw new Error('Folder not found.');
      await each(messageIds, async (message) => {
        if (message.folderId === target.id) return;
        if (message.accountId === target.account_id) {
          await sync.worker(message.accountId).moveTo(message, target.id);
        } else {
          let raw = db.getRaw(message.id);
          if (!raw) raw = await sync.worker(message.accountId).fetchRaw(message);
          await sync.worker(target.account_id).importRaw(target.id, raw, { seen: message.read, flagged: message.flagged });
          await sync.worker(message.accountId).removePermanently(message);
          db.audit('message.moved_between_accounts', { from: message.accountId, to: target.account_id });
        }
        if (db.headers.has(message.id)) db.deleteMessage(message.id);
      });
      return api.state();
    },

    /** Not spam: trust this sender from now on and bring the mail back to the inbox. */
    async markNotSpam(messageIds) {
      const list = ids(messageIds).map((id) => db.getMessage(id));
      for (const message of list) db.setSenderRule(message.fromAddress, { verdict: 'safe' });
      for (const message of list) {
        if (message.folderRole !== 'junk') continue;
        const inbox = db.listAllFolders().find((f) => f.accountId === message.accountId && f.role === 'inbox');
        if (inbox) {
          await sync.worker(message.accountId).moveTo(message, inbox.id);
          if (db.headers.has(message.id)) db.deleteMessage(message.id);
        }
      }
      db.audit('message.not_spam', { count: list.length });
      return api.state();
    },

    /** Spam: move to Junk (where the account has one) and treat the sender as spam from now on. */
    async markSpam(messageIds) {
      const list = ids(messageIds).map((id) => db.getMessage(id));
      for (const message of list) db.setSenderRule(message.fromAddress, { verdict: 'spam' });
      for (const message of list) {
        const junk = db.listAllFolders().find((f) => f.accountId === message.accountId && f.role === 'junk');
        if (junk && message.folderId !== junk.id) {
          await sync.worker(message.accountId).moveTo(message, junk.id);
          if (db.headers.has(message.id)) db.deleteMessage(message.id);
        }
      }
      db.audit('message.spam', { count: list.length });
      return api.state();
    },

    /** Put a sender's mail in another inbox tab, now and in future ('' = automatic again). */
    setCategory(messageIds, category) {
      if (category !== '' && !CATEGORIES.includes(category)) throw new Error('Unknown tab.');
      const senders = new Set(ids(messageIds).map((id) => db.getMessage(id).fromAddress).filter(Boolean));
      for (const sender of senders) db.setSenderRule(sender, { category });
      return api.state();
    },

    trustImages(address) {
      const sender = text(address, 320);
      if (!sender) throw new Error('Sender address is missing.');
      db.trustImageSender(sender);
      db.audit('images.sender_trusted', { sender });
      return { ok: true };
    },

    async attachment(messageId, index) {
      const message = db.getMessage(text(messageId, 200));
      let raw = db.getRaw(message.id);
      if (!raw) raw = await sync.worker(message.accountId).fetchRaw(message);
      return extractAttachment(raw, Number(index));
    },

    /** Original attachments, so a forwarded message keeps its files. */
    async forwardAttachments(messageId) {
      const message = db.getMessage(text(messageId, 200));
      let raw = db.getRaw(message.id);
      if (!raw) raw = await sync.worker(message.accountId).fetchRaw(message);
      const parsed = await parseRawMessage(raw);
      const files = [];
      for (const attachment of parsed.attachments) {
        const file = await extractAttachment(raw, attachment.index);
        files.push({ filename: file.filename, contentType: attachment.contentType, size: file.content.length, content: file.content.toString('base64') });
      }
      return files;
    },

    contacts(query) {
      return db.searchContacts(text(query, 100));
    },

    saveSignature(input = {}) {
      const name = text(input.name, 80);
      if (!name) throw new Error('Signature name is required.');
      db.saveSignature({ id: input.id ? text(input.id, 64) : undefined, name, html: String(input.html || '').slice(0, 2_000_000) });
      return api.state();
    },

    deleteSignature(id) {
      const signatureId = text(id, 64);
      db.deleteSignature(signatureId);
      for (const account of db.listAccounts({ withSecrets: true })) {
        if (account.signatureNew === signatureId || account.signatureReply === signatureId) {
          db.updateAccount(account.id, {
            signatureNew: account.signatureNew === signatureId ? null : account.signatureNew,
            signatureReply: account.signatureReply === signatureId ? null : account.signatureReply,
          });
        }
      }
      return api.state();
    },

    saveDraft(input) {
      const draft = sanitizeDraft(input || {});
      db.getAccount(draft.accountId);
      const saved = db.saveDraft(draft);
      return { state: api.state(), draft: { id: saved.id } };
    },

    getDraft(id) {
      return db.getDraft(text(id, 64));
    },

    deleteDraft(id) {
      db.deleteDraft(text(id, 64));
      return api.state();
    },

    /**
     * Called only when the user presses Send (and confirms, if that setting is on).
     * The message waits in the encrypted outbox for the undo window, then goes out.
     */
    async approveAndSend(input) {
      const draft = sanitizeDraft(input || {});
      if (!draft.to && !draft.cc && !draft.bcc) throw new Error('Add at least one recipient.');
      const account = db.getAccount(draft.accountId);
      const now = Date.now();
      // Send later: the message waits in the outbox until its time (and can be cancelled).
      const scheduledAt = input?.sendAt ? futureTime(input.sendAt, now) : null;
      const followUpDays = input?.followUpDays ? Number(input.followUpDays) : 0;
      if (followUpDays && !FOLLOW_UP_DAYS.has(followUpDays)) throw new Error('Choose when to be reminded.');
      const { raw, envelope, messageId } = await buildRawMessage(account, scheduledAt ? { ...draft, date: new Date(scheduledAt) } : draft);
      const sendAt = scheduledAt || now + settings().undoSeconds * 1000;
      const outboxId = db.enqueueOutbox(account.id, {
        to: draft.to, subject: draft.subject, messageId, envelope, raw: raw.toString('base64'), draft, scheduled: Boolean(scheduledAt),
      }, sendAt);
      if (draft.id) db.deleteDraft(draft.id);
      if (followUpDays) {
        db.addReminder({
          kind: 'followup',
          accountId: account.id,
          threadKey: db.threadKeyFor({ references: draft.references, inReplyTo: draft.inReplyTo, messageId }),
          dueAt: sendAt + followUpDays * DAY_MS,
          data: { outboxId, subject: draft.subject, to: [draft.to, draft.cc].filter(Boolean).join(', '), messageId, sentAt: sendAt, days: followUpDays },
        });
      }
      db.audit(scheduledAt ? 'message.scheduled' : 'message.approved_by_user', { outboxId, accountId: account.id, to: draft.to, subject: draft.subject, sendAt: scheduledAt || undefined, followUpDays: followUpDays || undefined });
      const delay = sendAt - now;
      if (!delay) await outbox.process();
      else if (delay < 6 * 60 * 60_000) outbox.schedule(delay + 250); // later ones are picked up by the outbox's own round
      return { state: api.state(), outboxId, sendAt, scheduled: Boolean(scheduledAt) };
    },

    /** Undo send (or cancel a scheduled one): only while the message is still waiting in the outbox. */
    cancelSend(outboxId) {
      const item = db.listOutbox().find((entry) => entry.id === outboxId);
      if (!item || item.status !== 'queued' || item.attempts > 0) throw new Error('The message was already sent.');
      db.removeOutbox(item.id);
      dropFollowUps(item.id);
      const saved = db.saveDraft({ ...item.draft, id: undefined });
      db.audit('message.send_undone', { outboxId: item.id });
      return { state: api.state(), draft: db.getDraft(saved.id) };
    },

    /** A scheduled message the reader wants to go right away. */
    async sendNow(outboxId) {
      const item = db.listOutbox().find((entry) => entry.id === text(outboxId, 64));
      if (!item || item.status !== 'queued') throw new Error('This message is not waiting to be sent.');
      const now = Date.now();
      db.updateOutbox(item.id, { status: 'queued', attempts: item.attempts, nextAttemptAt: now, lastError: item.lastError });
      for (const reminder of db.listReminders().filter((r) => r.kind === 'followup' && r.outboxId === item.id && r.status === 'waiting')) {
        db.updateReminder(reminder.id, { dueAt: now + reminder.days * DAY_MS, data: { sentAt: now } });
      }
      await outbox.process();
      return api.state();
    },

    /**
     * Leave a newsletter. The way out is read again from the stored message (never taken
     * from the interface): a silent one-click request when the sender supports it, else an
     * email to the sender's unsubscribe address, else its page in the browser.
     */
    async unsubscribe(messageId) {
      const message = db.getMessage(text(messageId, 200));
      if (['spam', 'suspicious'].includes(message.trust)) throw new Error('This looks like spam: report it as spam instead of unsubscribing.');
      const content = await openOne(message);
      const way = content.unsubscribe;
      if (!way) throw new Error('This sender does not offer a way to unsubscribe.');
      const sender = content.fromAddress || message.fromAddress;
      const url = way.https && publicHttpsUrl(way.https);
      if (way.oneClick && url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetchImpl(url.href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Emargy-Mail' },
            body: 'List-Unsubscribe=One-Click',
            redirect: 'manual', // a redirect is not followed: it could point anywhere
            signal: controller.signal,
          });
          if (!response.ok && !(response.status >= 300 && response.status < 400)) throw new Error(`The sender answered ${response.status}.`);
        } catch (error) {
          throw new Error(error.name === 'AbortError' ? 'The sender did not answer. Try again later.' : `Could not unsubscribe: ${error.message}`);
        } finally {
          clearTimeout(timer);
        }
        db.audit('newsletter.unsubscribed', { sender, method: 'one-click' });
        return { method: 'oneClick', sender, state: api.state() };
      }
      const mail = way.mailto && parseMailto(way.mailto);
      if (mail) {
        const result = await api.approveAndSend({ accountId: message.accountId, to: mail.to, subject: mail.subject, body: mail.body });
        db.audit('newsletter.unsubscribed', { sender, method: 'email', to: mail.to });
        return { method: 'email', sender, to: mail.to, outboxId: result.outboxId, sendAt: result.sendAt, state: result.state };
      }
      if (url) {
        db.audit('newsletter.unsubscribed', { sender, method: 'page' });
        return { method: 'page', sender, url: url.href, state: api.state() };
      }
      throw new Error('This sender does not offer a safe way to unsubscribe.');
    },

    // Reminders and snooze --------------------------------------------------------
    /** What the Reminders page shows (finished ones are left out). */
    reminders() {
      return db.listReminders()
        .filter((r) => ['waiting', 'due'].includes(r.status))
        .map(({ threadKey, ...r }) => ({ ...r, openId: db.latestInThread(r.accountId, threadKey)?.id || null }));
    },

    /** Hide a conversation until `until`; it then comes back to the inbox, unread. */
    snooze(messageId, until) {
      const anchor = db.getMessage(text(messageId, 200));
      const dueAt = futureTime(until);
      for (const r of db.listReminders()) {
        if (r.kind === 'snooze' && r.accountId === anchor.accountId && r.threadKey === anchor.threadKey) db.removeReminder(r.id);
      }
      db.addReminder({ kind: 'snooze', accountId: anchor.accountId, threadKey: anchor.threadKey, dueAt, data: { subject: anchor.subject, from: anchor.from } });
      db.audit('snooze.set', { subject: anchor.subject, until: new Date(dueAt).toISOString() });
      emit('mail:changed', { accountId: anchor.accountId, newInbox: [] });
      return api.state();
    },

    /** Add a follow-up reminder to mail already sent (from the conversation view). */
    remindIfNoReply(messageId, days) {
      const anchor = db.getMessage(text(messageId, 200));
      const count = Number(days);
      if (!FOLLOW_UP_DAYS.has(count)) throw new Error('Choose when to be reminded.');
      const now = Date.now();
      for (const r of db.listReminders()) {
        if (r.kind === 'followup' && r.status === 'waiting' && r.accountId === anchor.accountId && r.threadKey === anchor.threadKey) db.removeReminder(r.id);
      }
      db.addReminder({
        kind: 'followup', accountId: anchor.accountId, threadKey: anchor.threadKey, dueAt: now + count * DAY_MS,
        data: { subject: anchor.subject, to: anchor.folderRole === 'sent' ? [anchor.to, anchor.cc].filter(Boolean).join(', ') : anchor.from, sentAt: now, days: count },
      });
      db.audit('reminder.set', { subject: anchor.subject, days: count });
      return api.state();
    },

    /** Remind again later (a due follow-up), or move a snooze to another time. */
    postponeReminder(id, until) {
      const reminder = db.getReminder(text(id, 64));
      db.updateReminder(reminder.id, { status: 'waiting', dueAt: futureTime(until) });
      emit('mail:changed', { newInbox: [] });
      return api.state();
    },

    /** Finished with it: a follow-up the reader handled, or a snooze ended early. */
    dismissReminder(id) {
      const reminder = db.getReminder(text(id, 64));
      db.removeReminder(reminder.id);
      db.audit(reminder.kind === 'snooze' ? 'snooze.cancelled' : 'reminder.dismissed', { subject: reminder.subject });
      emit('mail:changed', { newInbox: [] });
      return api.state();
    },

    retryOutbox(id) {
      outbox.retry(text(id, 64));
      return api.state();
    },

    removeOutbox(id) {
      const item = db.listOutbox().find((entry) => entry.id === id);
      if (!item) throw new Error('Outbox item not found.');
      if (item.status === 'sending') throw new Error('This message is being sent right now.');
      db.removeOutbox(item.id);
      if (item.status !== 'sent') dropFollowUps(item.id);
      db.audit('outbox.removed', { outboxId: item.id, status: item.status });
      return api.state();
    },

    audit() {
      return db.listAudit();
    },
  };
  return api;
}

module.exports = { createApi, sanitizeDraft, DEFAULT_SETTINGS };
