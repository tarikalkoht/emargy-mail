const { ImapFlow } = require('imapflow');
const { buildRawMessage, imapConfig, parseRawMessage, verifySmtp, extractAttachment } = require('./mail.cjs');

const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;
const PROVIDERS = new Set(['custom', 'gmail', 'zoho', 'outlook']);
const LIST_FILTERS = new Set(['all', 'unread', 'important', 'flagged']);
const FOLDER_ROLES = new Set(['inbox', 'sent']);

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

function createApi({ db, sync, outbox, emit = () => {} }) {
  const api = {
    state() {
      const statuses = sync.statuses();
      return {
        language: db.getSetting('language', 'en'),
        projects: db.listProjects(),
        accounts: db.listAccounts().map((account) => ({ ...account, sync: statuses[account.id] || { status: 'idle', error: null } })),
        counts: db.unreadCounts(),
        drafts: db.listDrafts().map(({ attachments, ...draft }) => ({ ...draft, attachmentCount: attachments?.length || 0 })),
        outbox: db.listOutbox().map(({ raw, envelope, attachments, ...item }) => item),
      };
    },

    setLanguage(language) {
      db.setSetting('language', language === 'ar' ? 'ar' : 'en');
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
      const client = new ImapFlow(imapConfig(account));
      client.on('error', () => {});
      try {
        await client.connect();
      } catch (error) {
        throw new Error(error.authenticationFailed ? 'IMAP login failed. Check the email and password (or app password).' : `IMAP connection failed: ${error.message}`);
      } finally {
        await client.logout().catch(() => client.close());
      }
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

    listMessages(params = {}) {
      return db.listMessages({
        projectId: text(params.projectId, 64) || 'all',
        accountId: text(params.accountId, 64) || 'all',
        folderRole: FOLDER_ROLES.has(params.folderRole) ? params.folderRole : 'inbox',
        filter: LIST_FILTERS.has(params.filter) ? params.filter : 'all',
        query: text(params.query, 200),
        offset: Math.max(0, Number(params.offset) || 0),
        limit: Math.min(500, Math.max(1, Number(params.limit) || 200)),
      });
    },

    async loadRaw(message) {
      let raw = db.getRaw(message.id);
      if (!raw) {
        raw = await sync.worker(message.accountId).fetchRaw(message);
        const parsed = await parseRawMessage(raw);
        db.setRaw(message.id, raw, parsed.preview);
      }
      return raw;
    },

    async openMessage(id) {
      const message = db.getMessage(text(id, 200));
      const content = await parseRawMessage(await api.loadRaw(message));
      if (!message.read) {
        db.setSeen(message.id, true);
        sync.worker(message.accountId).setSeen(message, true).catch(() => {});
        emit('mail:changed', { accountId: message.accountId, newInbox: [] });
      }
      const { search, dateValue, ...header } = db.getMessage(message.id);
      return { ...header, content, imagesTrusted: db.isTrustedImageSender(content.fromAddress || header.fromAddress) };
    },

    async setRead(id, read) {
      const message = db.getMessage(text(id, 200));
      db.setSeen(message.id, Boolean(read));
      await sync.worker(message.accountId).setSeen(message, Boolean(read)).catch(() => {});
      return { ok: true };
    },

    async deleteMessage(id) {
      const message = db.getMessage(text(id, 200));
      await sync.worker(message.accountId).moveToTrash(message);
      db.deleteMessage(message.id);
      db.audit('message.deleted', { accountId: message.accountId });
      return { ok: true };
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
      return extractAttachment(await api.loadRaw(message), Number(index));
    },

    saveDraft(input) {
      const draft = sanitizeDraft(input || {});
      db.getAccount(draft.accountId);
      const saved = db.saveDraft(draft);
      return { state: api.state(), draft: { ...saved, attachments: draft.attachments.map(({ content, ...file }) => file) } };
    },

    getDraft(id) {
      return db.getDraft(text(id, 64));
    },

    deleteDraft(id) {
      db.deleteDraft(text(id, 64));
      return api.state();
    },

    /** Called only from the explicit "Approve and send" button. */
    async approveAndSend(input) {
      const draft = sanitizeDraft(input || {});
      if (!draft.to) throw new Error('Add at least one recipient.');
      const account = db.getAccount(draft.accountId);
      const saved = db.saveDraft(draft);
      const { raw, envelope, messageId } = await buildRawMessage(account, draft);
      const outboxId = db.enqueueOutbox(account.id, {
        draftId: saved.id, to: draft.to, subject: draft.subject, messageId, envelope, raw: raw.toString('base64'),
      });
      db.audit('message.approved_by_user', { outboxId, accountId: account.id, to: draft.to, subject: draft.subject });
      await outbox.process();
      return { state: api.state(), outboxId };
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

module.exports = { createApi, sanitizeDraft };
