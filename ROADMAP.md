# Roadmap

## Phase 0: Foundation

- Finalize architecture and threat model.
- Establish contribution, security, formatting, test, and release policies.
- Create a bilingual design system with RTL support.
- Build provider test fixtures without using real production mailboxes.

## Phase 1: Windows MVP

- Projects, accounts, folders, and per-project unified inboxes.
- Generic IMAP/SMTP account setup.
- Gmail and Zoho OAuth.
- Message list, reading, search, attachments, drafts, replies, and sending.
- Clear project and receiving-address labels on every message.
- Configurable local cache and native credential storage.
- Arabic and English UI.

## Phase 2: Safe AI assistance

- Translation and summaries.
- Importance, task, date, and follow-up detection.
- Suggested replies and draft generation.
- Approval workflow and audit trail.
- Permissioned local MCP server.

## Phase 3: Reliability and ecosystem

- Import/export and backup tools.
- Resend integration.
- Rules, templates, signatures, notifications, and delayed send.
- Signed Windows installer and automatic updates.
- macOS and Linux releases.

## Next up (owner's notes, November 2026)

Done in 0.12.0: account pictures, project order (arrows in Settings, drag in the side list),
a smaller install, a body-cache retention period with "Free up space", the inbox kept under
IMAP IDLE after work in other folders, and Arabic-aware search.

Planned, in this order:

1. **Follow-up reminders.** When sending, choose "remind me if nobody replies in N days"
   (1, 3, 5, 7 days or a date). The reminder is cancelled by any message in the same thread
   from someone else; otherwise the conversation comes back to the top of the inbox with a
   "no reply yet" label and a notification. Stored locally per thread key.
2. **Send later.** A date/time picker next to Send. The outbox already has
   `next_attempt_at`, so a scheduled message is a queued item whose first attempt is in
   the future; it can be edited or cancelled from the Outbox page until it goes.
3. **Snooze.** Hide a conversation until a chosen time, then return it to the inbox as
   unread with a notification. Local only at first (no server folder needed).
4. **Ready-made indexes for large mailboxes.** Keep in-memory buckets by project, account,
   folder and sender, updated as headers change, so opening a view stops scanning every
   header. Worth doing before mailboxes reach 50–100k messages; measure first.

## Phase 4: Optional cloud and mobile

- Encrypted multi-device synchronization.
- Team roles and shared projects.
- Android and iOS clients.

