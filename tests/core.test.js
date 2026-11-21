import { describe, expect, it } from 'vitest';
import core from '../electron/core.cjs';

describe('mail core helpers', () => {
  it('detects important messages in English and Arabic', () => {
    expect(core.isImportant('Action required: invoice overdue', '')).toBe(true);
    expect(core.isImportant('مطلوب إجراء عاجل', '')).toBe(true);
    expect(core.isImportant('Weekend photos', 'Hello')).toBe(false);
  });

  it('normalizes message envelopes', () => {
    const result = core.normalizeEnvelope({
      subject: 'Hello',
      from: [{ name: 'Jane', address: 'jane@example.com' }],
      to: [{ address: 'team@example.com' }],
      date: new Date('2026-01-02T03:04:05Z'),
    });
    expect(result.subject).toBe('Hello');
    expect(result.from).toContain('jane@example.com');
    expect(result.to).toBe('team@example.com');
  });

  it('strips unsafe and visual HTML for previews', () => {
    expect(core.stripHtml('<style>x</style><p>Hello <b>world</b></p><script>x</script>')).toBe('Hello world');
  });
});


describe('Windows taskbar identity', () => {
  it('matches the installer shortcut, so the pinned icon and the window are one button', () => {
    expect(core.appUserModelId({ platform: 'win32', store: false })).toBe('com.emargy.mail');
    expect(core.appUserModelId({ platform: 'linux' })).toBe(null);
  });

  it('uses the package identity for the Store copy', () => {
    const execPath = 'C:\\Program Files\\WindowsApps\\Emargy.EmargyMail_0.12.0.0_x64__3k1g6v2x5mq7a\\app\\Emargy Mail.exe';
    expect(core.appUserModelId({ platform: 'win32', store: true, execPath })).toBe('Emargy.EmargyMail_3k1g6v2x5mq7a!EmargyMail');
    expect(core.appUserModelId({ platform: 'win32', store: true, execPath: 'C:\\Apps\\Emargy Mail.exe' })).toBe(null);
  });
});
