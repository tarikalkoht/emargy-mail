/**
 * Which new messages deserve a desktop notification, and how to group them.
 * Pure functions (no Electron) so the rules are easy to test.
 */

function minutes(value) {
  const [h, m] = String(value || '0:0').split(':').map((n) => Number.parseInt(n, 10) || 0);
  return (h % 24) * 60 + (m % 60);
}

/** Quiet hours may cross midnight (22:00 → 07:00). */
function inQuietHours(quiet, now = new Date()) {
  if (!quiet?.enabled) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const from = minutes(quiet.from);
  const to = minutes(quiet.to);
  if (from === to) return false;
  return from < to ? current >= from && current < to : current >= from || current < to;
}

function isUntrusted(message) {
  return ['spam', 'suspicious'].includes(message.trust);
}

function isImportant(message) {
  return !isUntrusted(message) && Boolean(message.important || message.aiImportant);
}

/**
 * Filter by the reader's preferences, then group per project.
 *   mode 'all'        every new inbox message (never spam)
 *   mode 'important'  only important ones
 *   mode 'off'        nothing
 * Quiet hours let only important mail through. Muted projects stay silent.
 */
function selectNotifications(messages, prefs, now = new Date()) {
  const mode = prefs.notifyMode || (prefs.notifications === false ? 'off' : 'all');
  if (mode === 'off') return [];
  const muted = new Set(prefs.mutedProjects || []);
  const quiet = inQuietHours(prefs.quietHours, now);
  const chosen = messages.filter((m) => !isUntrusted(m) && !muted.has(m.projectId)
    && (mode === 'all' ? (!quiet || isImportant(m)) : isImportant(m)));
  const groups = new Map();
  for (const message of chosen) {
    if (!groups.has(message.projectId)) groups.set(message.projectId, []);
    groups.get(message.projectId).push(message);
  }
  return [...groups.entries()].map(([projectId, items]) => ({ projectId, items }));
}

function senderName(from = '') {
  const match = String(from).match(/^\s*"?([^"<]+?)"?\s*</);
  return (match ? match[1] : String(from).replace(/[<>]/g, '')).trim();
}

/** Title and body of one notification, in the reader's language. */
function notificationText(group, { projectName = '', arabic = false, preview = true } = {}) {
  const [first] = group.items;
  const count = group.items.length;
  if (count === 1) {
    if (!preview) return { title: arabic ? `رسالة جديدة · ${projectName}` : `New message · ${projectName}`, body: '' };
    return { title: senderName(first.from) || first.from, body: `${first.subject || ''}\n${projectName}`.trim() };
  }
  const title = arabic ? `${count} رسائل جديدة · ${projectName}` : `${count} new messages · ${projectName}`;
  if (!preview) return { title, body: '' };
  const names = [...new Set(group.items.map((m) => senderName(m.from)).filter(Boolean))];
  const shown = names.slice(0, 3).join(arabic ? '، ' : ', ');
  const more = names.length > 3 ? (arabic ? ` و${names.length - 3} آخرين` : ` and ${names.length - 3} more`) : '';
  return { title, body: shown + more };
}

module.exports = { selectNotifications, notificationText, inQuietHours, isImportant, senderName };
