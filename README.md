# Emargy Mail

**Emargy Mail** is an open-source, local-first desktop email client for people and teams who manage many projects and many mailboxes.

**إيمارجي ميل** عميل بريد إلكتروني مفتوح المصدر، يحفظ بريدك على جهازك أولاً، ومصمم لإدارة عدة مشاريع وعدة حسابات بريد من مكان واحد.

> **Status:** in active use, version 0.12. Built with Electron, Node.js and React.
> Windows (installer, portable, Microsoft Store), Linux (AppImage, deb) and macOS (dmg, not yet signed by Apple).
>
> **الحالة:** قيد الاستخدام الفعلي، الإصدار 0.12. مبني بـ Electron وNode.js وReact، ويعمل على ويندوز ولينكس وماك.

## What it does | ماذا يفعل

**Projects and accounts**
- Group mailboxes into projects (one per client or business), each with its own unified inbox, plus one inbox for everything.
- Every message shows which project and which address received it.
- Order projects and accounts the way you like; give each account a picture.

**Reading and writing**
- Conversations, inbox tabs (primary, promotions, social, updates), drafts, attachments, signatures per account.
- Rich editor with pasted images; undo send; **send later**; outbox with automatic retries.
- **Follow-up reminders** ("remind me if nobody replies in N days") and **snooze**.
- Search on the device (Arabic-aware: hamza forms, taa marbuta, diacritics…) and on the mail server.

**Privacy and safety**
- Everything stored on the device is encrypted (AES-256-GCM); the key is protected by the operating system.
- Remote images blocked by default; emails render in a sandboxed frame.
- Spam, suspicious and verified-sender badges (server verdicts, DKIM/SPF/DMARC results).
- Updates are signed by the maintainer and checked before they install.

**Notifications and assistant**
- New mail, important-only mode, quiet hours, per-project mute, taskbar badge, tray.
- Optional assistant (translate, summarize, suggest a reply, find important mail) through the Claude Code or Codex app you already have; no API keys, nothing sent without you.

**Arabic and English** interfaces, full right-to-left layout, light and dark themes.

## Accounts | الحسابات

| Provider | How it connects |
|---|---|
| Any IMAP/SMTP host (cPanel, Plesk, hosting companies) | Password; servers detected from DNS |
| Gmail / Google Workspace | App password (IMAP/SMTP) |
| Outlook, Hotmail, Live, Microsoft 365 | Sign in with Microsoft (OAuth 2.0) |
| Zoho Mail | App password (IMAP/SMTP) |
| Resend | API key (sending, and receiving where enabled) |

## Build and run | التشغيل والبناء

Requires Node.js 22.5 or newer (for the built-in SQLite module).

```bash
npm ci
npm run dev          # the app with live reload
npm test             # unit and integration tests (local test mail servers, no real mail)
npm run test:app     # end-to-end test of the built app
npm run dist:win     # or dist:linux, dist:mac, dist:store
```

Releases are built on GitHub Actions and signed locally with `scripts/sign-release.cjs`; see `.github/workflows/build.yml`.

## Documents

- [Architecture](docs/ARCHITECTURE.md): how it is built, and where it is heading
- [Roadmap](ROADMAP.md): what is done and what is next
- [Security](SECURITY.md) · [Privacy](PRIVACY.md) · [Contributing](CONTRIBUTING.md)

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).
