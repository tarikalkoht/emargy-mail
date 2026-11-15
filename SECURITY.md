# Security Policy

Emargy Mail handles credentials and private communications. Please do not report security vulnerabilities in public issues.

Until a private reporting address is published, prepare a minimal report without real credentials, messages, attachments, or personal information and contact the repository owner privately through GitHub.

## Security invariants

- Passwords and tokens must never be logged.
- Remote email content must be treated as untrusted.
- HTML messages must be sanitized and rendered in a sandbox.
- Remote images are blocked by default.
- Agent actions are permissioned and audited.
- AI-created drafts require human approval before sending.

