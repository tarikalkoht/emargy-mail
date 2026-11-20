const { buildRawMessage, sendRawMessage } = require('./mail.cjs');
const { freshAccount } = require('./oauth.cjs');
const { sendWithResend } = require('./resend.cjs');

const RETRY_DELAYS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;
const TICK_MS = 30_000;

/** Providers that already store a copy of SMTP-sent mail in the Sent folder. */
function providerSavesSentCopy(account) {
  return /(^|\.)gmail\.com$|(^|\.)googlemail\.com$|office365\.com$|outlook\.com$/i.test(account.smtpHost || '');
}

class Outbox {
  constructor({ db, sync, emit = () => {}, send = sendRawMessage, sendApi = sendWithResend }) {
    this.db = db;
    this.sync = sync;
    this.emit = emit;
    this.send = send;
    this.sendApi = sendApi;
    this.running = false;
    this.timer = null;
  }

  start() {
    // A message interrupted mid-send (app closed or crashed) is queued again.
    this.db.db.prepare(`UPDATE outbox SET status = 'queued' WHERE status = 'sending'`).run();
    this.timer = setInterval(() => this.process().catch(() => {}), TICK_MS);
    this.process().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    for (const timer of this.scheduled || []) clearTimeout(timer);
  }

  /** Run the queue again after a delay (used for the undo-send window). */
  schedule(delayMs) {
    this.scheduled ||= new Set();
    const timer = setTimeout(() => {
      this.scheduled.delete(timer);
      this.process().catch(() => {});
    }, delayMs);
    this.scheduled.add(timer);
  }

  async process() {
    if (this.running) return;
    this.running = true;
    try {
      for (const item of this.db.dueOutbox()) await this.deliver(item);
    } finally {
      this.running = false;
    }
  }

  async deliver(item) {
    const account = await freshAccount(this.db, item.accountId);
    let raw = Buffer.from(item.raw, 'base64');
    let { envelope } = item;
    if (item.scheduled && item.draft && account.authType !== 'resend') {
      // Written earlier, sent now: date it now (it may be late if the computer was off),
      // keeping its Message-ID so a follow-up reminder still recognises the replies.
      const built = await buildRawMessage(account, { ...item.draft, date: new Date(), messageId: item.messageId });
      raw = built.raw;
      envelope = built.envelope;
    }
    this.db.updateOutbox(item.id, { status: 'sending', attempts: item.attempts, nextAttemptAt: item.nextAttemptAt });
    this.emit('outbox:changed', {});
    try {
      // Resend accounts send through its API; everything else through SMTP.
      const result = account.authType === 'resend' ? await this.sendApi(account, item) : await this.send(account, raw, envelope);
      this.db.updateOutbox(item.id, { status: 'sent', attempts: item.attempts + 1, nextAttemptAt: 0, sentAt: Date.now() });
      this.db.audit('message.sent', { outboxId: item.id, accountId: account.id, to: item.envelope.to, messageId: result.messageId });
      if (account.authType !== 'resend' && !providerSavesSentCopy(account)) {
        await this.sync.worker(account.id).appendSent(raw).catch((error) => this.db.audit('message.sent_copy_failed', { outboxId: item.id, error: error.message }));
      }
      this.sync.worker(account.id).syncNow(['sent']).catch(() => {});
      // Resend reports delivery a few seconds later; look again so the Sent folder shows it.
      if (account.authType === 'resend') setTimeout(() => this.sync.worker(account.id).syncNow(['sent']).catch(() => {}), 20_000).unref?.();
      this.emit('outbox:changed', { sent: item.id });
    } catch (error) {
      const attempts = item.attempts + 1;
      const permanent = attempts >= MAX_ATTEMPTS || /EAUTH|Invalid login|authentication|invalid_api_key|restricted_api_key|validation_error|invalid_from_address/i.test(`${error.code} ${error.message}`);
      const nextAttemptAt = Date.now() + RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)];
      this.db.updateOutbox(item.id, { status: permanent ? 'failed' : 'queued', attempts, nextAttemptAt, lastError: error.message });
      this.db.audit(permanent ? 'message.send_failed' : 'message.send_retry_scheduled', { outboxId: item.id, accountId: account.id, attempts, error: error.message });
      this.emit('outbox:changed', { failed: item.id });
    }
  }

  retry(id) {
    const item = this.db.listOutbox().find((entry) => entry.id === id);
    if (!item || item.status !== 'failed') throw new Error('Only failed messages can be retried.');
    this.db.updateOutbox(id, { status: 'queued', attempts: 0, nextAttemptAt: Date.now(), lastError: item.lastError });
    this.process().catch(() => {});
  }
}

module.exports = { Outbox, providerSavesSentCopy };
