# Roadmap

✅ done · 🔶 partly done · ⬜ not started

## Done (up to 0.12)

**Foundation and desktop app**
- ✅ Projects, accounts, folders, a unified inbox per project and for everything.
- ✅ Project and receiving address shown on every message; projects and accounts in your own order; account pictures.
- ✅ Generic IMAP/SMTP with server auto-detection; Gmail, Zoho and others by app password; Sign in with Microsoft (OAuth); Resend.
- ✅ Conversations, inbox tabs, attachments, drafts, signatures, rich editor, undo send.
- ✅ Encrypted local storage with the key held by the operating system; body-cache retention and "Free up space".
- ✅ IMAP IDLE on the inbox; older mail and server search on demand.
- ✅ Search on the device (Arabic-aware) and on the server.
- ✅ Arabic and English, RTL, light and dark themes.

**Reliability and everyday tools**
- ✅ Durable outbox with retries; **send later**.
- ✅ **Follow-up reminders** (no reply after N days) and **snooze**, with a Reminders page.
- ✅ Notifications: important-only, quiet hours, per-project mute, taskbar badge, tray.
- ✅ Spam / suspicious / verified-sender badges; "not spam" and "always in this tab" rules per sender.
- ✅ Signed automatic updates; Windows installer, portable and Microsoft Store; Linux AppImage and deb; macOS dmg.
- ✅ Large mailboxes measured (`scripts/bench-mailbox.cjs`): 100k messages, every view under about 35 ms.

**Assistant**
- ✅ Translate, summarize, suggest a reply, improve a draft, flag important mail, through the reader's own Claude Code or Codex.
- ✅ Nothing sent without the reader; activity log.

## Next

1. ⬜ **Decide the shell:** a small Tauri + Node-sidecar prototype to measure the real download size and check rendering, then move or stay. See [Architecture](docs/ARCHITECTURE.md#under-consideration-a-smaller-shell-tauri).
2. ⬜ **macOS signing and notarization** (the build supports it once the Apple certificates are added).
3. 🔶 **Rules:** today per sender (spam verdict, inbox tab). Next: conditions → move, label, mark read, forward.
4. ⬜ **Templates** (canned replies), insertable from the composer.
5. ⬜ **Import / export and backup** of settings, accounts (without passwords) and local mail.
6. ⬜ **Gmail and Zoho sign-in with OAuth** instead of app passwords.
7. 🔶 **Assistant:** detect tasks and dates in mail; suggest follow-ups automatically.
8. ⬜ **Local MCP server** with explicit read / draft / send permissions for agents.

## Later

- Encrypted multi-device synchronization (optional; the app stays fully local without it).
- Team roles and shared projects.
- Android and iOS clients.
