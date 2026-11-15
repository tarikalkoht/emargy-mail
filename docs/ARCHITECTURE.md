# Architecture

## Design principles

1. Local-first: the desktop app remains useful without a cloud service.
2. Least privilege: agents receive explicit read, draft, or send permissions.
3. Human approval: AI-generated drafts cannot be sent without approval.
4. Account isolation: a failure or authentication problem in one account must not block other accounts.
5. Progressive synchronization: the app must remain responsive with many accounts and large mailboxes.
6. Provider neutrality: standard protocols are preferred, with provider adapters only when required.

## High-level components

### Desktop shell

Tauri 2 hosts the cross-platform UI and exposes a narrow command surface to the Rust core.

### Mail core

The Rust core owns IMAP, SMTP, OAuth token refresh, synchronization, MIME parsing, threading, search indexing, and the outbox. UI code never receives account passwords.

Each active account runs as an isolated worker supervised by a scheduler. Concurrency is bounded globally and per provider to avoid exhausting the device or triggering provider rate limits.

### Local data

- SQLite stores accounts, projects, folders, headers, message metadata, drafts, audit events, and search indexes.
- Credentials and refresh tokens are stored in Windows Credential Manager, macOS Keychain, or the Linux Secret Service.
- Message bodies and attachments use an encrypted local cache.
- All message headers are indexed. Bodies are cached for 90 days by default and older bodies are fetched on demand.
- Attachments are downloaded on demand unless the user changes the policy.

### User interface

The UI supports Arabic and English from the start, including RTL layout. Navigation is organized as:

`Project -> Account -> Folder -> Thread -> Message`

Every message row shows both its project and receiving account without requiring the message to be opened.

### Agent gateway

A local MCP server exposes audited, permissioned tools. Initial capabilities:

- Search and read allowed messages.
- Translate and summarize.
- Detect important messages, tasks, dates, and missing follow-ups.
- Create or update drafts.
- Request approval to send.

Sending is a separate privileged action and must validate an approval record created by the user.

## Synchronization policy

- Fetch folder structure and message headers first.
- Synchronize recent message bodies next.
- Fetch older bodies and attachments on demand.
- Use IMAP IDLE where supported and safe polling otherwise.
- Queue local actions immediately and retry remote actions with bounded exponential backoff.
- Preserve a durable outbox so a temporary network failure never loses an approved message.

## Cloud phase

Cloud synchronization is deliberately postponed until the Windows client is stable. The future service must use end-to-end encryption where practical and must not become a requirement for basic desktop use.

## Reference projects

- Thunderbird: mature mail protocol behavior and long-term compatibility.
- Mailspring: per-account sync isolation, progressive caching, and local MCP integration.
- Chithi: a modern Tauri-based mail client architecture.

Reference projects are design inputs only. Code reuse must be reviewed for license compatibility and security.

