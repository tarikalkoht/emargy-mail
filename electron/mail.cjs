const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const { isImportant, normalizeEnvelope, stripHtml } = require('./core.cjs');

function imapConfig(account, password) {
  return {
    host: account.imapHost,
    port: Number(account.imapPort || 993),
    secure: account.imapSecure !== false,
    auth: { user: account.email, pass: password },
    logger: false,
  };
}

async function withImap(account, password, operation) {
  const client = new ImapFlow(imapConfig(account, password));
  try {
    await client.connect();
    return await operation(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // The connection may already be closed after a network error.
    }
  }
}

async function syncInbox(account, password, limit = 100) {
  return withImap(account, password, async (client) => {
    const lock = await client.getMailboxLock(account.inboxPath || 'INBOX');
    try {
      const exists = client.mailbox.exists || 0;
      if (!exists) return [];
      const start = Math.max(1, exists - limit + 1);
      const messages = [];
      for await (const item of client.fetch(`${start}:*`, {
        uid: true,
        envelope: true,
        flags: true,
        size: true,
      })) {
        const envelope = normalizeEnvelope(item.envelope);
        messages.push({
          id: `${account.id}:${item.uid}`,
          accountId: account.id,
          projectId: account.projectId,
          uid: item.uid,
          folder: account.inboxPath || 'INBOX',
          ...envelope,
          preview: '',
          size: item.size || 0,
          read: item.flags?.has('\\Seen') || false,
          flagged: item.flags?.has('\\Flagged') || false,
          important: isImportant(envelope.subject, ''),
          syncedAt: new Date().toISOString(),
        });
      }
      return messages.sort((a, b) => new Date(b.date) - new Date(a.date));
    } finally {
      lock.release();
    }
  });
}

async function fetchMessage(account, password, uid, folder = 'INBOX') {
  return withImap(account, password, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const item = await client.fetchOne(Number(uid), { source: true }, { uid: true });
      if (!item?.source) throw new Error('Message was not found on the server.');
      const parsed = await simpleParser(item.source);
      const html = typeof parsed.html === 'string' ? parsed.html : '';
      return {
        subject: parsed.subject || '(No subject)',
        from: parsed.from?.text || '',
        to: parsed.to?.text || '',
        cc: parsed.cc?.text || '',
        date: parsed.date?.toISOString() || new Date().toISOString(),
        text: parsed.text || stripHtml(html),
        html,
        attachments: (parsed.attachments || []).map((attachment, index) => ({
          id: String(index),
          filename: attachment.filename || `attachment-${index + 1}`,
          contentType: attachment.contentType,
          size: attachment.size,
          content: attachment.content.toString('base64'),
        })),
      };
    } finally {
      lock.release();
    }
  });
}

async function sendMessage(account, password, draft) {
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: Number(account.smtpPort || 465),
    secure: account.smtpSecure !== false,
    auth: { user: account.email, pass: password },
  });
  const result = await transporter.sendMail({
    from: account.displayName ? `${account.displayName} <${account.email}>` : account.email,
    to: draft.to,
    cc: draft.cc || undefined,
    bcc: draft.bcc || undefined,
    subject: draft.subject || '',
    text: draft.body || '',
    replyTo: account.replyTo || undefined,
  });
  return { messageId: result.messageId, accepted: result.accepted, rejected: result.rejected };
}

module.exports = { fetchMessage, sendMessage, syncInbox };

