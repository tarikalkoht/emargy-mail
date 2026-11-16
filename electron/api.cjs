const { ImapFlow } = require('imapflow');
const { buildRawMessage, detectServers, imapConfig, parseRawMessage, verifySmtp, extractAttachment } = require('./mail.cjs');

const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;
const PROVIDERS = new Set(['custom', 'gmail', 'zoho', 'outlook']);
const LIST_FILTERS = new Set(['all', 'unread', 'important', 'flagged', 'attachments']);
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

function createApi({ db, sync, outbox, emit = () => {} }) {
  const settings = () => ({ ...DEFAULT_SETTINGS, ...db.getSetting('preferences', {}) });

  async function openOne(message) {
    let raw = db.getRaw(message.id);
    if (!raw) {
      raw = await sync.worker(message.accountId).fetchRaw(message);
      const parsed = await parseRawMessage(raw);
      db.setRaw(message.id, raw, parsed.preview);
      return parsed;
    }
    return parseRawMessage(raw);
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

    async addAccount(input) {
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
      const reconnect = Boolean(changes.password);
      if (reconnect) {
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
      await sync.removeAccount(accountId);
      db.deleteAccount(accountId);
      db.audit('account.deleted', { accountId });
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

    listMessages(params = {}) {
      return db.listMessages({
        projectId: text(params.projectId, 64) || 'all',
        accountId: text(params.accountId, 64) || 'all',
        folderId: params.folderId ? Number(params.folderId) : null,
        folderRole: FOLDER_ROLES.has(params.folderRole) ? params.folderRole : 'inbox',
        filter: LIST_FILTERS.has(params.filter) ? params.filter : 'all',
        query: text(params.query, 200),
        offset: Math.max(0, Number(params.offset) || 0),
        limit: Math.min(500, Math.max(1, Number(params.limit) || 200)),
        threaded: params.threaded !== false,
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
      await each(messageIds, async (message) => {
        db.setSeen(message.id, Boolean(read));
        await sync.worker(message.accountId).setSeen(message, Boolean(read)).catch(() => {});
      });
      return api.state();
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

    async moveTo(messageIds, folderId) {
      await each(messageIds, async (message) => {
        await sync.worker(message.accountId).moveTo(message, Number(folderId));
        db.deleteMessage(message.id);
      });
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
      const { raw, envelope, messageId } = await buildRawMessage(account, draft);
      const delay = settings().undoSeconds * 1000;
      const outboxId = db.enqueueOutbox(account.id, {
        to: draft.to, subject: draft.subject, messageId, envelope, raw: raw.toString('base64'), draft,
      }, Date.now() + delay);
      if (draft.id) db.deleteDraft(draft.id);
      db.audit('message.approved_by_user', { outboxId, accountId: account.id, to: draft.to, subject: draft.subject });
      if (delay) outbox.schedule(delay + 250);
      else await outbox.process();
      return { state: api.state(), outboxId, sendAt: Date.now() + delay };
    },

    /** Undo send: only possible while the message is still waiting in the outbox. */
    cancelSend(outboxId) {
      const item = db.listOutbox().find((entry) => entry.id === outboxId);
      if (!item || item.status !== 'queued' || item.attempts > 0) throw new Error('The message was already sent.');
      db.removeOutbox(item.id);
      const saved = db.saveDraft({ ...item.draft, id: undefined });
      db.audit('message.send_undone', { outboxId: item.id });
      return { state: api.state(), draft: db.getDraft(saved.id) };
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
