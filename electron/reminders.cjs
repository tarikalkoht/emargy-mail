/**
 * Follow-up reminders and snooze.
 *
 * - Follow-up: "remind me if nobody replies in N days". Cancelled by itself as soon as a
 *   reply arrives; otherwise it becomes due, notifies, and waits in the Reminders page.
 * - Snooze: a conversation leaves the inbox until a chosen time, then comes back unread
 *   at the top of the inbox with a notification.
 *
 * Everything is local (encrypted in the database); nothing is stored on the mail server.
 */
const { parseAddressList, replySubject } = require('./db.cjs');

const TICK_MS = 60_000;
const DAY = 86_400_000;
const KEEP_DONE_MS = 30 * DAY;
const KEEP_RETURNED_MS = 14 * DAY;

class ReminderWatcher {
  constructor({ db, sync, emit = () => {}, notify = () => {} }) {
    this.db = db;
    this.sync = sync;
    this.emit = emit;
    this.notify = notify;
    this.timer = null;
  }

  /** The first round waits for the start-up sync, so replies that came while the app was closed are seen first. */
  start(firstDelay = 2 * 60_000) {
    this.first = setTimeout(() => {
      this.check();
      this.timer = setInterval(() => this.check(), TICK_MS);
      this.timer.unref?.();
    }, firstDelay);
    this.first.unref?.();
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  ownAddresses() {
    return new Set(this.db.listAccounts().map((a) => String(a.email).toLowerCase()));
  }

  /** One round: returns how many reminders changed. */
  check(now = Date.now()) {
    let changed = 0;
    try {
      const reminders = this.db.listReminders();
      const followUps = reminders.filter((r) => r.kind === 'followup' && ['waiting', 'due'].includes(r.status));
      const replied = this.db.repliedReminders(followUps.map((r) => ({
        id: r.id,
        threadKey: r.threadKey,
        since: r.sentAt || r.createdAt,
        recipients: new Set(parseAddressList(r.to).map((a) => a.address)),
        subject: replySubject(r.subject),
      })), this.ownAddresses());
      const outbox = new Map(this.db.listOutbox().map((item) => [item.id, item]));

      for (const reminder of reminders) {
        if (reminder.kind === 'followup') changed += this.followUp(reminder, { now, replied, outbox });
        else if (reminder.kind === 'snooze') changed += this.snooze(reminder, now);
      }
    } catch (error) {
      this.db.audit('reminders.check_failed', { error: error.message });
    }
    if (changed) this.emit('mail:changed', { newInbox: [] });
    return changed;
  }

  followUp(reminder, { now, replied, outbox }) {
    if (reminder.status === 'done') {
      if (now - reminder.dueAt > KEEP_DONE_MS) { this.db.removeReminder(reminder.id); return 1; }
      return 0;
    }
    if (replied.has(reminder.id)) {
      this.db.updateReminder(reminder.id, { status: 'done', data: { replied: true } });
      this.db.audit('reminder.replied', { reminderId: reminder.id, subject: reminder.subject });
      return 1;
    }
    if (reminder.status !== 'waiting' || reminder.dueAt > now) return 0;
    const out = reminder.outboxId && outbox.get(reminder.outboxId);
    if (out?.status === 'failed') {
      // The message never left: there is nothing to wait for.
      this.db.removeReminder(reminder.id);
      return 1;
    }
    if (out && out.status !== 'sent') {
      this.db.updateReminder(reminder.id, { dueAt: now + 60 * 60_000 });
      return 1;
    }
    this.db.updateReminder(reminder.id, { status: 'due' });
    this.db.audit('reminder.due', { reminderId: reminder.id, subject: reminder.subject, to: reminder.to });
    const message = this.db.latestInThread(reminder.accountId, reminder.threadKey);
    this.notify({ kind: 'followup', subject: reminder.subject, to: reminder.to, days: reminder.days, messageId: message?.id || null });
    return 1;
  }

  snooze(reminder, now) {
    if (reminder.status === 'returned') {
      if (now - reminder.dueAt > KEEP_RETURNED_MS) { this.db.removeReminder(reminder.id); return 1; }
      return 0;
    }
    if (reminder.status !== 'waiting' || reminder.dueAt > now) return 0;
    // Back in the inbox, unread, at the top (by the time it came back).
    const inbox = this.db.sorted.filter((m) => m.accountId === reminder.accountId && m.threadKey === reminder.threadKey && m.folderRole === 'inbox');
    const newest = inbox[0];
    if (newest?.read) {
      this.db.setSeen(newest.id, false);
      this.sync?.worker(newest.accountId).setSeen(newest, false).catch(() => {});
    }
    this.db.updateReminder(reminder.id, { status: 'returned', dueAt: now });
    this.db.audit('snooze.returned', { reminderId: reminder.id, subject: reminder.subject });
    const message = newest || this.db.latestInThread(reminder.accountId, reminder.threadKey);
    this.notify({ kind: 'snooze', subject: reminder.subject, from: reminder.from, projectId: message?.projectId, messageId: message?.id || null });
    return 1;
  }
}

module.exports = { ReminderWatcher, DAY };
