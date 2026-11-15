# Emargy Mail

**Emargy Mail** is an open-source, local-first desktop email client for teams and people who manage many projects and email accounts.

**Emargy Mail** هو عميل بريد إلكتروني مفتوح المصدر، محلي أولاً، ومصمم لإدارة عدة مشاريع وعدة حسابات بريد من مكان واحد.

> Status: early planning and architecture. The Windows desktop version is the first milestone.

## Vision | الرؤية

- Separate workspaces for every project.
- A mailbox for every account and a unified inbox for every project.
- Always show which project and address received each message.
- Arabic and English interfaces with full RTL support.
- Local-first, encrypted storage and configurable offline caching.
- AI-assisted translation, summaries, prioritization, and draft replies.
- Human approval is required before an AI-created draft is sent.
- A permissioned local MCP server for Codex, Claude, and other compatible agents.
- Windows first, followed by macOS, Linux, cloud sync, and mobile clients.

## Planned account support

- Standard IMAP/SMTP hosting
- Gmail with OAuth
- Zoho Mail with OAuth or IMAP/SMTP
- Resend through its supported sending and inbound mechanisms

## Proposed stack

- Tauri 2 desktop shell
- Rust mail and synchronization core
- React + TypeScript user interface
- SQLite with full-text search
- Native OS credential storage
- Sandboxed and sanitized HTML email rendering

See [Architecture](docs/ARCHITECTURE.md) and [Roadmap](ROADMAP.md).

## Contributing

Emargy Mail is at an early stage. Product, security, email-protocol, Rust, TypeScript, Arabic localization, and UX contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a contribution.

## License

The project is intended to be licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). A canonical license file will be included in the initial public repository.

