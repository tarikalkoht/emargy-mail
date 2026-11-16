/**
 * Important-mail alerts across every mailbox.
 *
 * When the reader turns it on, new inbox mail from the last few days is sent in small batches
 * (sender, subject and a short preview only — never attachments or full bodies) to the
 * reader's own assistant subscription, which answers which messages need attention.
 * Spam and suspicious mail is never sent. The answer can only mark a message as important;
 * it cannot move, delete, reply or open anything.
 */
const CATEGORIES = new Set(['offer', 'government', 'project', 'invoice', 'legal', 'meeting', 'other']);
const LOOKBACK = 3 * 24 * 60 * 60 * 1000;
const BATCH = 20;
const PAUSE_BETWEEN_RUNS = 60_000;

/** Pull the JSON array out of the assistant's answer and keep only well-formed entries for ids we asked about. */
function parseVerdicts(answer, askedIds) {
  const start = answer.indexOf('[');
  const end = answer.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('The assistant did not answer in the expected format.');
  const list = JSON.parse(answer.slice(start, end + 1));
  const asked = new Set(askedIds);
  const verdicts = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const id = String(item?.id || '');
    if (!asked.has(id) || verdicts.has(id)) continue;
    verdicts.set(id, {
      important: item.important === true,
      category: CATEGORIES.has(item.category) ? item.category : 'other',
      reason: String(item.reason || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  }
  return verdicts;
}

/** Short ids keep the prompt small and never reveal account or folder structure. */
function describe(messages) {
  return messages.map((m, i) => [
    `id: m${i + 1}`,
    `from: ${String(m.from || '').slice(0, 160)}`,
    `subject: ${String(m.subject || '').slice(0, 200)}`,
    `preview: ${String(m.preview || '').replace(/\s+/g, ' ').slice(0, 280)}`,
  ].join('\n')).join('\n\n');
}

class ImportanceWatcher {
  constructor({ db, ai, settings, language, emit, notify }) {
    Object.assign(this, { db, ai, settings, language, emit, notify });
    this.running = false;
    this.lastRun = 0;
    this.timer = null;
    this.lastError = null;
  }

  /** Called after every sync; runs at most once a minute and only when enabled. */
  poke() {
    if (!this.settings().aiAlerts || this.timer) return;
    const wait = Math.max(0, this.lastRun + PAUSE_BETWEEN_RUNS - Date.now());
    this.timer = setTimeout(() => { this.timer = null; this.runOnce().catch(() => {}); }, wait + 2000);
  }

  async runOnce() {
    if (this.running || !this.settings().aiAlerts || this.settings().aiProvider === 'off') return { checked: 0, important: [] };
    this.running = true;
    this.lastRun = Date.now();
    try {
      const batch = this.db.messagesForTriage(Date.now() - LOOKBACK, BATCH);
      if (!batch.length) return { checked: 0, important: [] };
      const shortIds = batch.map((_, i) => `m${i + 1}`);
      const result = await this.ai.run({ task: 'triage', text: describe(batch), language: this.language(), preference: this.settings().aiProvider });
      const verdicts = parseVerdicts(result.text, shortIds);
      const important = [];
      batch.forEach((message, i) => {
        const verdict = verdicts.get(shortIds[i]) || { important: false };
        this.db.setAiVerdict(message.id, verdict);
        if (verdict.important) important.push({ ...message, aiNote: verdict });
      });
      this.lastError = null;
      if (important.length) {
        this.emit('mail:changed', { important: important.length });
        this.notify(important);
      }
      // More waiting? Continue after the pause.
      if (this.db.messagesForTriage(Date.now() - LOOKBACK, 1).length) this.poke();
      return { checked: batch.length, important };
    } catch (error) {
      this.lastError = error.message;
      return { checked: 0, important: [], error: error.message };
    } finally {
      this.running = false;
    }
  }
}

module.exports = { ImportanceWatcher, parseVerdicts, describe };
