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

## Done in 0.12.0 (owner's notes, November 2026)

- Account pictures; project order (arrows in Settings, drag in the side list).
- Smaller install; full messages kept 90 days by default, with "Free up space".
- The inbox stays under IMAP IDLE after work in other folders; Arabic-aware search.
- **Send later**: arrow next to Send; scheduled mail waits in the Outbox (send now, edit,
  cancel) and is dated when it actually goes.
- **Follow-up reminders**: "Remind me" when sending, or on a sent conversation. Cancelled
  by any reply (same thread, or same subject from a recipient); otherwise a notification
  and an entry in the new Reminders page.
- **Snooze** (B, the clock button or right-click): the conversation leaves the inbox and
  comes back unread, on top, with a notification.
- **Large mailboxes**: measured with `node scripts/bench-mailbox.cjs 100000`. Opening
  "All inboxes" went from 77 ms to 32 ms by building full rows only for the visible page;
  other views take 3-15 ms. Per-folder indexes were tried and dropped: they made every
  re-sort three times slower for no visible gain. Measure again past 250k messages.

## Phase 4: Optional cloud and mobile

- Encrypted multi-device synchronization.
- Team roles and shared projects.
- Android and iOS clients.

