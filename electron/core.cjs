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

module.exports = {
  formatAddress,
  formatAddressList,
  isImportant,
  normalizeEnvelope,
  stripHtml,
};

