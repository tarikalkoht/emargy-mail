import { describe, expect, it } from 'vitest';

const { selectNotifications, notificationText, inQuietHours } = require('../electron/notify.cjs');

const at = (hh, mm = 0) => new Date(2026, 10, 17, hh, mm);
const mail = (id, projectId, extra = {}) => ({ id, projectId, from: `Person ${id} <p${id}@x.test>`, subject: `Subject ${id}`, trust: '', important: false, ...extra });

describe('notification rules', () => {
  const inbox = [
    mail('1', 'p1'),
    mail('2', 'p1', { important: true }),
    mail('3', 'p2'),
    mail('4', 'p2', { trust: 'spam', important: true }),
    mail('5', 'p3', { trust: 'suspicious' }),
  ];

  it('never notifies spam or suspicious mail, and groups the rest per project', () => {
    const groups = selectNotifications(inbox, { notifyMode: 'all' }, at(12));
    expect(groups.map((g) => [g.projectId, g.items.map((m) => m.id)])).toEqual([['p1', ['1', '2']], ['p2', ['3']]]);
  });

  it('can notify only important mail, or nothing', () => {
    expect(selectNotifications(inbox, { notifyMode: 'important' }, at(12)).flatMap((g) => g.items.map((m) => m.id))).toEqual(['2']);
    expect(selectNotifications(inbox, { notifyMode: 'off' }, at(12))).toEqual([]);
    expect(selectNotifications(inbox, { notifications: false }, at(12))).toEqual([]); // older setting
  });

  it('keeps muted projects silent', () => {
    expect(selectNotifications(inbox, { notifyMode: 'all', mutedProjects: ['p1'] }, at(12)).map((g) => g.projectId)).toEqual(['p2']);
  });

  it('lets only important mail through during quiet hours, also across midnight', () => {
    const prefs = { notifyMode: 'all', quietHours: { enabled: true, from: '22:00', to: '07:00' } };
    expect(selectNotifications(inbox, prefs, at(23, 30)).flatMap((g) => g.items.map((m) => m.id))).toEqual(['2']);
    expect(selectNotifications(inbox, prefs, at(6, 59)).flatMap((g) => g.items.map((m) => m.id))).toEqual(['2']);
    expect(selectNotifications(inbox, prefs, at(7, 0)).flatMap((g) => g.items.map((m) => m.id))).toEqual(['1', '2', '3']);
    expect(inQuietHours({ enabled: true, from: '13:00', to: '14:00' }, at(13, 30))).toBe(true);
    expect(inQuietHours({ enabled: false, from: '00:00', to: '23:59' }, at(13, 30))).toBe(false);
  });

  it('writes one clear notification per project, and hides content when asked', () => {
    const [group] = selectNotifications(inbox, { notifyMode: 'all' }, at(12));
    expect(notificationText(group, { projectName: 'Emargy', arabic: true })).toEqual({ title: '2 رسائل جديدة · Emargy', body: 'Person 1، Person 2' });
    expect(notificationText({ items: [inbox[0]] }, { projectName: 'Emargy' })).toEqual({ title: 'Person 1', body: 'Subject 1\nEmargy' });
    expect(notificationText({ items: [inbox[0]] }, { projectName: 'Emargy', preview: false })).toEqual({ title: 'New message · Emargy', body: '' });
  });
});
