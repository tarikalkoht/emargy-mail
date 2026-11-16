export function classNames(...values) {
  return values.filter(Boolean).join(' ');
}

export function formatListDate(value, language) {
  if (!value) return '';
  const date = new Date(value);
  const now = new Date();
  const locale = language === 'ar' ? 'ar' : 'en-GB';
  if (date.toDateString() === now.toDateString()) return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
  const days = (now - date) / 86_400_000;
  if (days < 6) return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
  if (date.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

export function formatFullDate(value, language) {
  if (!value) return '';
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en-GB', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(value));
}

export function formatSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Split an address list on commas/semicolons that are outside quotes and <…>. */
export function parseAddresses(value = '') {
  const parts = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const char of String(value)) {
    if (char === '"') quoted = !quoted;
    else if (char === '<' && !quoted) angle = true;
    else if (char === '>' && !quoted) angle = false;
    if ((char === ',' || char === ';') && !quoted && !angle) { parts.push(current); current = ''; } else current += char;
  }
  parts.push(current);
  return parts.map((part) => {
    const text = part.trim();
    const bracket = text.match(/^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
    if (bracket) return { name: bracket[1].trim().replace(/^"|"$/g, '').trim(), address: bracket[2] };
    const bare = text.match(/[^\s<>"]+@[^\s<>"]+/);
    return bare ? { name: '', address: bare[0] } : null;
  }).filter(Boolean);
}

export function displayName(value = '') {
  const [first] = parseAddresses(value);
  if (!first) return value;
  return first.name || first.address;
}

export function initial(value = '') {
  const name = displayName(value).replace(/^[^\p{L}\p{N}]+/u, '');
  return (name[0] || '?').toUpperCase();
}

/** A calm, stable avatar tint per sender. */
export function senderHue(value = '') {
  let hash = 0;
  for (const char of displayName(value).toLowerCase()) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return hash;
}

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function textToHtml(value = '') {
  return String(value).split(/\r?\n/).map((line) => `<p dir="auto">${escapeHtml(line) || '<br>'}</p>`).join('');
}

/** Plain text with blank-line paragraphs (as written by the assistant) to editor HTML. */
export function paragraphsToHtml(value = '') {
  return String(value).trim().split(/\n\s*\n/).map((block) => `<p dir="auto">${block.split('\n').map(escapeHtml).join('<br>')}</p>`).join('');
}
