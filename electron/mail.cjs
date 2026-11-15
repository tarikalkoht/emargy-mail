const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { simpleParser } = require('mailparser');
const { isImportant, normalizeEnvelope, stripHtml } = require('./core.cjs');

const MAX_INLINE_IMAGE = 2 * 1024 * 1024;

function isLoopbackHost(host = '') {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
}

/** Never send a password over an unencrypted connection unless the server is on this computer. */
function imapConfig(account) {
  const secure = account.imapSecure !== false;
  return {
    host: account.imapHost,
    port: Number(account.imapPort || 993),
    secure,
    doSTARTTLS: secure ? undefined : (isLoopbackHost(account.imapHost) ? undefined : true),
    auth: { user: account.username || account.email, pass: account.password },
    logger: false,
    emitLogs: false,
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    socketTimeout: 5 * 60_000,
    maxIdleTime: 4 * 60_000,
    autoIdleDelay: 1000,
    tls: { minVersion: 'TLSv1.2' },
  };
}

function smtpTransport(account) {
  const secure = account.smtpSecure !== false;
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: Number(account.smtpPort || 465),
    secure,
    requireTLS: !secure && !isLoopbackHost(account.smtpHost),
    auth: { user: account.username || account.email, pass: account.password },
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    tls: { minVersion: 'TLSv1.2' },
  });
}

function senderHeader(account) {
  return account.displayName ? { name: account.displayName, address: account.email } : account.email;
}

/** Build the exact RFC 822 message once, so retries and the Sent copy are identical. */
async function buildRawMessage(account, payload) {
  const mail = new MailComposer({
    from: senderHeader(account),
    to: payload.to,
    cc: payload.cc || undefined,
    bcc: payload.bcc || undefined,
    subject: payload.subject || '',
    text: payload.body || '',
    inReplyTo: payload.inReplyTo || undefined,
    references: payload.references || undefined,
    attachments: (payload.attachments || []).map((file) => ({ filename: file.filename, content: Buffer.from(file.content, 'base64'), contentType: file.contentType })),
  });
  const compiled = mail.compile();
  compiled.keepBcc = false;
  const raw = await compiled.build();
  return { raw, envelope: compiled.getEnvelope(), messageId: compiled.messageId() };
}

async function sendRawMessage(account, raw, envelope) {
  const transport = smtpTransport(account);
  try {
    const result = await transport.sendMail({ envelope, raw });
    return { messageId: result.messageId, accepted: result.accepted, rejected: result.rejected };
  } finally {
    transport.close();
  }
}

async function verifySmtp(account) {
  const transport = smtpTransport(account);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

function firstAddress(list) {
  const value = Array.isArray(list) ? list[0] : list?.value?.[0];
  return value?.address ? String(value.address).toLowerCase() : '';
}

function hasAttachmentParts(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  if (node.dispositionParameters?.filename && node.disposition !== 'inline') return true;
  return (node.childNodes || []).some(hasAttachmentParts);
}

function summarizeFetched(item, account) {
  const envelope = normalizeEnvelope(item.envelope || {});
  return {
    uid: item.uid,
    projectId: account.projectId,
    ...envelope,
    fromAddress: firstAddress(item.envelope?.from),
    dateValue: new Date(envelope.date).getTime() || Date.now(),
    read: item.flags?.has('\\Seen') || false,
    flagged: item.flags?.has('\\Flagged') || false,
    important: isImportant(envelope.subject, ''),
    hasAttachments: hasAttachmentParts(item.bodyStructure),
    size: item.size || 0,
  };
}

async function parseRawMessage(raw) {
  const parsed = await simpleParser(raw, { skipImageLinks: true });
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const inlineImages = {};
  const attachments = [];
  (parsed.attachments || []).forEach((attachment, index) => {
    const isInlineImage = attachment.contentId && /^image\//i.test(attachment.contentType || '') && attachment.size <= MAX_INLINE_IMAGE;
    if (isInlineImage) {
      const cid = attachment.contentId.replace(/^<|>$/g, '');
      inlineImages[cid] = `data:${attachment.contentType};base64,${attachment.content.toString('base64')}`;
    }
    if (!isInlineImage || attachment.contentDisposition === 'attachment') {
      attachments.push({ index, filename: attachment.filename || `attachment-${index + 1}`, contentType: attachment.contentType, size: attachment.size });
    }
  });
  const text = parsed.text || stripHtml(html);
  return {
    subject: parsed.subject || '(No subject)',
    from: parsed.from?.text || '',
    fromAddress: firstAddress(parsed.from),
    to: parsed.to?.text || '',
    cc: parsed.cc?.text || '',
    replyTo: parsed.replyTo?.text || '',
    date: parsed.date?.toISOString() || new Date().toISOString(),
    messageId: parsed.messageId || '',
    references: Array.isArray(parsed.references) ? parsed.references.join(' ') : (parsed.references || ''),
    text,
    html,
    inlineImages,
    attachments,
    preview: text.replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

async function extractAttachment(raw, index) {
  const parsed = await simpleParser(raw);
  const attachment = parsed.attachments?.[index];
  if (!attachment) throw new Error('Attachment not found.');
  return { filename: attachment.filename || `attachment-${index + 1}`, content: attachment.content };
}

module.exports = {
  buildRawMessage,
  extractAttachment,
  imapConfig,
  isLoopbackHost,
  parseRawMessage,
  sendRawMessage,
  summarizeFetched,
  verifySmtp,
};
