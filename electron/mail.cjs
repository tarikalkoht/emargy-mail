const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const { convert } = require('html-to-text');
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

/** Pasted images arrive as data: URLs; send them as proper inline (cid:) attachments. */
function extractInlineImages(html) {
  const inline = [];
  const rewritten = String(html || '').replace(/<img([^>]*?)src="data:(image\/[a-z0-9.+-]+);base64,([^"]+)"/gi, (_match, before, contentType, data) => {
    const cid = `img-${crypto.randomUUID()}@emargy`;
    inline.push({ cid, contentType, content: Buffer.from(data, 'base64'), filename: `image-${inline.length + 1}.${contentType.split('/')[1].replace('jpeg', 'jpg')}`, contentDisposition: 'inline' });
    return `<img${before}src="cid:${cid}"`;
  });
  return { html: rewritten, inline };
}

function htmlDocument(body) {
  return '<!doctype html><html><head><meta charset="utf-8"></head>'
    + `<body><div style="font-family:Segoe UI,Tahoma,Arial,sans-serif;font-size:14px;line-height:1.6">${body}</div></body></html>`;
}

/** Build the exact RFC 822 message once, so retries and the Sent copy are identical. */
async function buildRawMessage(account, payload) {
  const files = (payload.attachments || []).map((file) => ({ filename: file.filename, content: Buffer.from(file.content, 'base64'), contentType: file.contentType }));
  let html;
  let text = payload.body || '';
  if (payload.html) {
    const extracted = extractInlineImages(payload.html);
    html = htmlDocument(extracted.html);
    text = convert(extracted.html, { wordwrap: 78, selectors: [{ selector: 'img', format: 'skip' }] });
    files.push(...extracted.inline);
  }
  const mail = new MailComposer({
    from: senderHeader(account),
    to: payload.to,
    cc: payload.cc || undefined,
    bcc: payload.bcc || undefined,
    subject: payload.subject || '',
    text,
    html,
    inReplyTo: payload.inReplyTo || undefined,
    references: payload.references || undefined,
    attachments: files,
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

const PRESETS = {
  gmail: { provider: 'gmail', imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  outlook: { provider: 'outlook', imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false, needsOAuth: true },
  zoho: { provider: 'zoho', imapHost: 'imap.zoho.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.zoho.com', smtpPort: 465, smtpSecure: true },
  zohoEu: { provider: 'zoho', imapHost: 'imap.zoho.eu', imapPort: 993, imapSecure: true, smtpHost: 'smtp.zoho.eu', smtpPort: 465, smtpSecure: true },
  yahoo: { provider: 'custom', imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecure: true },
  icloud: { provider: 'custom', imapHost: 'imap.mail.me.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false },
  godaddy: { provider: 'custom', imapHost: 'imap.secureserver.net', imapPort: 993, imapSecure: true, smtpHost: 'smtpout.secureserver.net', smtpPort: 465, smtpSecure: true },
  hostinger: { provider: 'custom', imapHost: 'imap.hostinger.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.hostinger.com', smtpPort: 465, smtpSecure: true },
};

const DOMAINS = {
  'gmail.com': 'gmail', 'googlemail.com': 'gmail', 'outlook.com': 'outlook', 'hotmail.com': 'outlook', 'live.com': 'outlook',
  'msn.com': 'outlook', 'zoho.com': 'zoho', 'zohomail.com': 'zoho', 'zoho.eu': 'zohoEu', 'yahoo.com': 'yahoo', 'icloud.com': 'icloud',
  'me.com': 'icloud', 'mac.com': 'icloud',
};

const MX_RULES = [
  [/google(mail)?\.com\.?$/i, 'gmail'],
  [/(protection\.outlook\.com|outlook\.com)\.?$/i, 'outlook'],
  [/zoho\.eu\.?$/i, 'zohoEu'],
  [/zoho\.com\.?$/i, 'zoho'],
  [/secureserver\.net\.?$/i, 'godaddy'],
  [/hostinger\.com\.?$/i, 'hostinger'],
];

/**
 * Find IMAP/SMTP settings for an address using only DNS (MX and SRV records),
 * so the address is never sent to a third-party lookup service.
 */
async function detectServers(email, resolver = dns) {
  const domain = String(email).split('@')[1]?.toLowerCase().trim();
  if (!domain) throw new Error('Email address is not valid.');
  if (DOMAINS[domain]) return { ...PRESETS[DOMAINS[domain]], source: 'known' };
  const mx = await resolver.resolveMx(domain).catch(() => []);
  for (const record of mx) {
    const rule = MX_RULES.find(([pattern]) => pattern.test(record.exchange));
    if (rule) return { ...PRESETS[rule[1]], source: 'mx' };
  }
  const srv = async (name) => (await resolver.resolveSrv(`${name}.${domain}`).catch(() => []))
    .sort((a, b) => a.priority - b.priority).find((r) => r.name && r.name !== '.');
  const [imaps, submissions, submission] = await Promise.all([srv('_imaps._tcp'), srv('_submissions._tcp'), srv('_submission._tcp')]);
  if (imaps && (submissions || submission)) {
    const smtp = submissions || submission;
    return { provider: 'custom', imapHost: imaps.name, imapPort: imaps.port, imapSecure: true, smtpHost: smtp.name, smtpPort: smtp.port, smtpSecure: Boolean(submissions), source: 'srv' };
  }
  return { provider: 'custom', imapHost: `mail.${domain}`, imapPort: 993, imapSecure: true, smtpHost: `mail.${domain}`, smtpPort: 465, smtpSecure: true, source: 'guess' };
}

module.exports = {
  detectServers,
  extractInlineImages,
  buildRawMessage,
  extractAttachment,
  imapConfig,
  isLoopbackHost,
  parseRawMessage,
  sendRawMessage,
  summarizeFetched,
  verifySmtp,
};
