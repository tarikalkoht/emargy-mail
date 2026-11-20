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

/** Crop a picture to a centered square and shrink it, so an account picture stays a few KB. */
export function squarePicture(dataUrl, size = 128) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      if (!side) { reject(new Error('This picture could not be read.')); return; }
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      resolve(canvas.toDataURL('image/webp', 0.9));
    };
    image.onerror = () => reject(new Error('This picture could not be read.'));
    image.src = dataUrl;
  });
}

function atHour(base, days, hour) {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

/**
 * Ready-made times for send later and snooze. The week starts on Sunday for Arabic readers
 * and on Monday otherwise.
 */
export function quickTimes(language, now = Date.now()) {
  const today = new Date(now);
  const options = [];
  const later = new Date(now + 3 * 60 * 60_000);
  later.setMinutes(0, 0, 0);
  if (later.getDate() === today.getDate() && later.getHours() <= 20) options.push({ key: 'laterToday', at: later.getTime() + 60 * 60_000 });
  options.push({ key: 'tomorrowMorning', at: atHour(now, 1, 8) });
  options.push({ key: 'tomorrowAfternoon', at: atHour(now, 1, 13) });
  const weekStart = language === 'ar' ? 0 : 1;
  const ahead = ((weekStart - today.getDay() + 7) % 7) || 7;
  options.push({ key: 'nextWeek', at: atHour(now, ahead, 8) });
  return options;
}

/** "Tue 08:00", or "21 Nov, 08:00" when more than a week away. */
export function formatWhen(value, language) {
  const date = new Date(value);
  const locale = language === 'ar' ? 'ar' : 'en-GB';
  const days = (date - Date.now()) / 86_400_000;
  const options = days < 6 && days > -1 ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/** Value for <input type="datetime-local"> in local time. */
export function localInputValue(value) {
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
