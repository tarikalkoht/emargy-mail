const IMPORTANT_PATTERNS = [
  /urgent|important|asap|action required|deadline|overdue/i,
  /عاجل|مهم|مطلوب إجراء|الموعد النهائي|متأخر/i,
  /invoice|payment|contract|proposal|quotation/i,
  /فاتورة|دفعة|عقد|عرض سعر|مقترح/i,
];

function isImportant(subject = '', preview = '') {
  const text = `${subject} ${preview}`;
  return IMPORTANT_PATTERNS.some((pattern) => pattern.test(text));
}

function formatAddress(address) {
  if (!address) return '';
  if (typeof address === 'string') return address;
  if (address.name && address.address) return `${address.name} <${address.address}>`;
  return address.address || address.name || '';
}

function formatAddressList(list) {
  if (!list) return '';
  const values = Array.isArray(list) ? list : list.value || [];
  return values.map(formatAddress).filter(Boolean).join(', ');
}

function normalizeEnvelope(envelope = {}) {
  return {
    subject: envelope.subject || '(No subject)',
    from: formatAddressList(envelope.from),
    to: formatAddressList(envelope.to),
    cc: formatAddressList(envelope.cc),
    messageId: envelope.messageId || '',
    inReplyTo: envelope.inReplyTo || '',
    date: envelope.date ? new Date(envelope.date).toISOString() : new Date().toISOString(),
  };
}

function stripHtml(html = '') {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Names that phishing mails like to borrow in the display name.
const BRANDS = /paypal|apple|microsoft|office ?365|outlook|google|gmail|amazon|netflix|facebook|meta(mask)?|instagram|whatsapp|dhl|fedex|aramex|cpanel|webmail|bank|binance|coinbase|wallet|support team|security team|admin(istrator)?|mail ?server|it department/i;

/** The first header with this name from a raw header block (unfolded). */
function headerValue(headers, name) {
  const text = String(headers || '').replace(/\r?\n[ \t]+/g, ' ');
  const match = text.match(new RegExp(`^${name}:[ \t]*(.*)$`, 'im'));
  return match ? match[1].trim() : '';
}

function domainOf(address = '') {
  return String(address).toLowerCase().split('@')[1]?.replace(/[>\s]/g, '') || '';
}

/** "mail.example.co.uk" and "example.co.uk" belong together; so do "a.example.com" and "example.com". */
function aligned(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Trust verdict for a message, from the receiving server's own checks:
 *   'spam'       the server's spam filter flagged it, or it sits in Junk
 *   'suspicious' sender authentication failed, or the name imitates a brand the domain does not belong to
 *   'verified'   DKIM passed for the sender's own domain (and DMARC did not fail)
 *   ''           nothing to say
 * Only the topmost Authentication-Results header is used: it is the one added by the
 * receiving server; lower ones could have been written by the sender.
 */
function classifyTrust({ subject = '', from = '', fromAddress = '', folderRole = '', headers = '' } = {}) {
  const spamFlag = headerValue(headers, 'x-spam-flag');
  const spamStatus = headerValue(headers, 'x-spam-status');
  const spam = headerValue(headers, 'x-spam');
  const scl = Number.parseInt(headerValue(headers, 'x-ms-exchange-organization-scl'), 10);
  if (folderRole === 'junk' || /^\s*(\*{3}\s*spam\s*\*{3}|\[spam\]|\{spam\})/i.test(subject)
    || /^yes/i.test(spamFlag) || /^yes/i.test(spamStatus) || /^yes/i.test(spam) || scl >= 5) return 'spam';

  const results = headerValue(headers, 'authentication-results').toLowerCase();
  const senderDomain = domainOf(fromAddress || from);
  const displayName = String(from).replace(/<[^>]*>/g, '').replace(/"/g, '').trim();
  const nameAddress = displayName.match(/[^\s@<>"]+@[^\s@<>"]+/);
  if (/dmarc=fail/.test(results) || (/spf=(fail|softfail)/.test(results) && !/dkim=pass/.test(results))) return 'suspicious';
  if (nameAddress && domainOf(nameAddress[0]) && !aligned(domainOf(nameAddress[0]), senderDomain)) return 'suspicious';
  if (BRANDS.test(displayName) && senderDomain) {
    const brand = displayName.toLowerCase().match(BRANDS)[0].replace(/\s+/g, '');
    if (!senderDomain.includes(brand) && !/admin|support|security|mail ?server|it department|webmail|cpanel|bank|wallet/.test(brand)) return 'suspicious';
  }
  const dkimDomains = [...results.matchAll(/dkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/g)].map((m) => m[1]);
  if (dkimDomains.some((d) => aligned(d, senderDomain)) && !/dmarc=fail/.test(results)) return 'verified';
  return '';
}

module.exports = {
  classifyTrust,
  headerValue,
  formatAddress,
  formatAddressList,
  isImportant,
  normalizeEnvelope,
  stripHtml,
};

