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
 *   'verified'   this app verified a DKIM signature of the sender's own domain (see dkim.cjs)
 *   ''           nothing to say
 * Only the topmost Authentication-Results header is used, and only when its authserv-id
 * belongs to the reader's own mail provider (`authServers`). Any other one could have been
 * written by the sender, so it is ignored: no "verified" badge without a trusted server.
 */
function classifyTrust({ subject = '', from = '', fromAddress = '', folderRole = '', headers = '', authServers = [], dkimDomains = [] } = {}) {
  const spamFlag = headerValue(headers, 'x-spam-flag');
  const spamStatus = headerValue(headers, 'x-spam-status');
  const spam = headerValue(headers, 'x-spam');
  const scl = Number.parseInt(headerValue(headers, 'x-ms-exchange-organization-scl'), 10);
  if (folderRole === 'junk' || /^\s*(\*{3}\s*spam\s*\*{3}|\[spam\]|\{spam\})/i.test(subject)
    || /^yes/i.test(spamFlag) || /^yes/i.test(spamStatus) || /^yes/i.test(spam) || scl >= 5) return 'spam';

  const topmost = headerValue(headers, 'authentication-results').toLowerCase();
  const authservId = topmost.split(';')[0].trim().split(/\s+/)[0] || '';
  const trusted = authservId && authServers.some((suffix) => authservId === suffix || authservId.endsWith(`.${suffix}`));
  const results = trusted ? topmost : '';
  const senderDomain = domainOf(fromAddress || from);
  const displayName = String(from).replace(/<[^>]*>/g, '').replace(/"/g, '').trim();
  const nameAddress = displayName.match(/[^\s@<>"]+@[^\s@<>"]+/);
  if (/dmarc=fail/.test(results) || (/spf=(fail|softfail)/.test(results) && !/dkim=pass/.test(results))) return 'suspicious';
  if (nameAddress && domainOf(nameAddress[0]) && !aligned(domainOf(nameAddress[0]), senderDomain)) return 'suspicious';
  if (BRANDS.test(displayName) && senderDomain) {
    const brand = displayName.toLowerCase().match(BRANDS)[0].replace(/\s+/g, '');
    if (!senderDomain.includes(brand) && !/admin|support|security|mail ?server|it department|webmail|cpanel|bank|wallet/.test(brand)) return 'suspicious';
  }
  // "Verified" only from a DKIM signature this app checked itself (never from a header text).
  if (dkimDomains.some((d) => aligned(String(d).toLowerCase(), senderDomain))) return 'verified';
  return '';
}

/**
 * Which authserv-ids may speak for this account: the reader's own IMAP server (and its
 * parent domain, e.g. "hostns.io" for "paloma.hostns.io"), plus the known receiving
 * servers of big providers whose IMAP host has a different name.
 */
function trustedAuthServers(account = {}) {
  const host = String(account.imapHost || '').toLowerCase().replace(/\.$/, '');
  const servers = new Set();
  if (host && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && host.includes('.')) {
    servers.add(host);
    const labels = host.split('.');
    if (labels.length > 2) servers.add(labels.slice(-2).join('.'));
  }
  if (/(^|\.)gmail\.com$|(^|\.)google\.com$/.test(host)) servers.add('google.com');
  if (/office365\.com$|outlook\.com$/.test(host)) { servers.add('outlook.com'); servers.add('office365.com'); }
  if (/zoho\.(com|eu)$/.test(host)) servers.add('zoho.com').add('zoho.eu');
  if (/yahoo\.com$/.test(host)) servers.add('yahoo.com');
  if (/(mail\.me|icloud)\.com$/.test(host)) servers.add('icloud.com').add('apple.com');
  return [...servers];
}

/**
 * The Windows taskbar identity (AppUserModelID). It must equal the one on the shortcut the
 * reader pinned or launched, otherwise Windows shows the pinned icon and the running window
 * as two separate taskbar buttons.
 * - Installer copy: the installer stamps shortcuts with the appId (com.emargy.mail).
 * - Store copy: Windows uses <PackageFamilyName>!<ApplicationId>; the family name is read
 *   from the install folder (WindowsApps\<Name>_<Version>_<Arch>__<PublisherId>\...).
 * Returns null when nothing should be set (other systems, or a Store path we cannot read).
 */
function appUserModelId({ platform = process.platform, store = false, execPath = process.execPath, appId = 'com.emargy.mail', storeAppId = 'EmargyMail' } = {}) {
  if (platform !== 'win32') return null;
  if (!store) return appId;
  const match = String(execPath).match(/WindowsApps[\\/]([^\\/_]+)_[^\\/]*?__([a-z0-9]+)[\\/]/i);
  return match ? `${match[1]}_${match[2]}!${storeAppId}` : null;
}

module.exports = {
  appUserModelId,
  classifyTrust,
  trustedAuthServers,
  headerValue,
  formatAddress,
  formatAddressList,
  isImportant,
  normalizeEnvelope,
  stripHtml,
};

