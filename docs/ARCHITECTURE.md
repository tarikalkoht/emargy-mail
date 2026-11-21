# Architecture

This describes Emargy Mail as it is built today (0.12), then where it may go next.

## Design principles

1. **Local-first:** the app is fully useful without any cloud service of ours.
2. **Encrypted at rest:** nothing readable is written to disk; the key is held by the operating system.
3. **Human approval:** nothing is sent, and no AI output is used, without the reader pressing a button.
4. **Account isolation:** a failing or slow account never blocks the others.
5. **Responsive with large mailboxes:** headers first, bodies on demand, bounded work per account.
6. **Standard protocols first:** IMAP/SMTP everywhere, provider APIs only where needed (Microsoft sign-in, Resend).

## Components

```
┌──────────────────────── Electron ─────────────────────────┐
│ Renderer (sandboxed, React)        Main process (Node.js)  │
│  src/App.jsx, components/  ──IPC──▶ electron/main.cjs      │
│  window.emargy (preload.cjs)        └▶ api.cjs (one entry) │
│                                        ├ sync.cjs   IMAP   │
│                                        ├ outbox.cjs SMTP   │
│                                        ├ resend.cjs API    │
│                                        ├ reminders.cjs     │
│                                        ├ importance.cjs AI │
│                                        └ db.cjs ─ vault.cjs│
└────────────────────────────────────────────────────────────┘
```

### Desktop shell: Electron

- `electron/main.cjs` creates the window, tray, notifications, taskbar badge and menus, and
  registers the IPC handlers. Each handler checks that the call comes from the app's own
  main frame.
- The renderer runs with `sandbox`, `contextIsolation` and no Node integration. It only sees
  the narrow `window.emargy` API from `preload.cjs` and never receives passwords, tokens
  or API keys.
- A strict Content Security Policy (see `vite.config.mjs`) allows only the app's own files.

### Interface: React

- `src/App.jsx` holds the views (mail, drafts, outbox, reminders, settings, activity);
  `src/components/` the pieces (sidebar, message list, conversation, composer, pickers).
- `src/i18n.js`: English and Arabic, with Arabic plural forms; the layout is RTL-aware.
- Emails are rendered in a sandboxed `iframe` with no same-origin access. Their scripts are
  removed and blocked, and remote images load only after the reader trusts the sender
  (`src/emailHtml.js`).

### Mail core: Node.js

| File | Role |
|---|---|
| `api.cjs` | The single entry point the interface calls; validates every input. |
| `sync.cjs` | One worker and one IMAP connection per account (imapflow), at most 3 syncing at once. Discovers folders, fetches headers first, prefetches recent bodies, loads older mail and searches the server on demand. Keeps the inbox selected so **IMAP IDLE** delivers new mail at once; a 5-minute round is the safety net. Reconnects with back-off. |
| `outbox.cjs` | Durable, encrypted outbox: undo window, **send later**, retries with back-off (1 min to 3 h), copy to Sent. |
| `resend.cjs` | Accounts on Resend, through its HTTP API instead of IMAP/SMTP. |
| `oauth.cjs` | Sign in with Microsoft (OAuth 2.0 + PKCE in the system browser), XOAUTH2, token refresh. |
| `mail.cjs` | Building and parsing MIME (nodemailer, mailparser), server auto-detection from DNS. |
| `core.cjs`, `dkim.cjs`, `categorize.cjs` | Trust verdicts (server spam flags, authentication results, DKIM via mailauth), inbox tabs. |
| `reminders.cjs` | Follow-up reminders (no reply after N days) and snooze; checks once a minute. |
| `importance.cjs`, `ai.cjs` | Optional assistant through the Claude Code or Codex command-line tool the reader already uses: no API keys, text passed on stdin, tools disabled, empty working folder. |
| `notify.cjs` | Notification rules: important-only, quiet hours, muted projects, grouping. |
| `updater.cjs` | Updates from GitHub Releases, accepted only with the maintainer's Ed25519 signature and the exact size and SHA-256. The Store copy updates through the Store. |

### Local data

- **SQLite** through Node's built-in `node:sqlite`, in WAL mode with `secure_delete`.
- **Vault** (`vault.cjs`): a random 256-bit key encrypts headers, bodies, drafts, outbox,
  credentials, reminders and the audit log with AES-256-GCM. The key file is wrapped by the
  operating system through Electron `safeStorage`: Windows data protection, the macOS
  Keychain, or GNOME Keyring/KWallet. Linux without a keyring is refused rather than
  storing secrets under a fixed password.
- Conversation keys and sender rules are keyed by an HMAC fingerprint, never the address.
- **Headers in memory:** all headers are decrypted once at start and kept sorted, so lists,
  counts and search do not touch the disk. Measured with `scripts/bench-mailbox.cjs`:
  100,000 messages open "All inboxes" in about 32 ms and other views in 3–15 ms.
- **Bodies:** full messages are kept for 90 days by default (30, 90, 365 or all); older
  ones keep their header and preview and are fetched again when opened. Starred and
  Resend mail is kept. "Free up space" compacts the file.
- An audit log (Activity page) records sends, deletions, account and storage changes, reminders and snoozes.

## Synchronization policy

- Folder list and headers first, then recent bodies (40 per round, under 5 MB each).
- Older mail and server search only when the reader asks.
- Local changes (read, flag, move, delete) apply at once and go to the server in the background.
- Sending goes through the durable outbox, so a network failure never loses an approved message.

## Packaging and release

- electron-builder: NSIS installer and portable `.exe`, `.appx` for the Microsoft Store,
  AppImage and `.deb`, universal `.dmg`. Only English and Arabic Chromium locales are shipped.
- GitHub Actions builds and tests every platform (`.github/workflows/build.yml`); the update
  manifests are signed on the maintainer's computer (`scripts/sign-release.cjs`).
- Tests: Vitest against local IMAP/SMTP servers (`tests/`), plus an end-to-end run of the
  built app with Playwright (`scripts/e2e-app.cjs`).

## Under consideration: a smaller shell (Tauri)

Electron ships its own Chromium. Of the roughly 105 MB installer (about 145 MB from the
Store), almost all is Chromium; the app's own code is about 14 MB. A Tauri shell would use
the WebView already in Windows 10/11 (WebView2, also Chromium-based, so emails render the
same way).

The option being considered is **Tauri + the existing Node core as a sidecar process**:

- The React interface stays as it is; `window.emargy` becomes a thin layer over Tauri commands.
- The Node core (`electron/*.cjs`, minus the Electron-specific parts) runs as a bundled
  child process and talks to the shell over stdin/stdout.
- Electron-only services move to Tauri plugins: tray, notifications, window, single
  instance, autostart, updater. Key protection moves to the OS keychain through Rust.
- Estimated download: 35–45 MB instead of 105–150 MB. Parts of the core could later move to
  Rust one at a time, down to about 10–15 MB.
- Open questions: rendering on macOS/Linux (WebKit instead of Chromium), Store packaging,
  and keeping the signed-update chain. A small prototype comes first, to measure the real
  size before anything is moved.

## Reference projects

Thunderbird (protocol behavior), Mailspring (per-account sync isolation), and Tauri-based
clients are design references only; any code reuse must be checked for license compatibility.
