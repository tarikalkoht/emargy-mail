/**
 * Local demo mail server (IMAP 127.0.0.1:1143, SMTP 127.0.0.1:1025) with sample
 * messages, so Emargy Mail can be tried without touching a real mailbox.
 *
 *   npm run demo:server
 *
 * Account to add in the app (Custom provider, both "Use SSL/TLS" unchecked):
 *   email/user: demo@emargy.test   password: see DEMO_PASSWORD below
 */
const MailComposer = require('nodemailer/lib/mail-composer');
const { startMailServers } = require('../tests/helpers/mailServers.cjs');

const DEMO_USER = 'demo@emargy.test';
const DEMO_PASSWORD = 'emargy-demo-only';

function build(options) {
  return new MailComposer({ to: DEMO_USER, date: new Date(Date.now() - (options.ageMinutes || 0) * 60_000), ...options }).compile().build();
}

async function demoMessages() {
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  return Promise.all([
    build({
      from: 'أحمد من شركة النور <ahmad@alnoor.test>',
      subject: 'عاجل: عرض سعر مشروع الموقع الجديد',
      text: 'مرحباً،\n\nنرسل لكم عرض السعر المطلوب لمشروع الموقع الجديد. نرجو الرد قبل نهاية الأسبوع.\n\nمع التحية،\nأحمد',
      ageMinutes: 12,
    }),
    build({
      from: 'Newsletter <news@marketing-shop.test>',
      subject: 'Black Friday: 50% off everything',
      html: '<h2 style="color:#e11d48">Black Friday Sale</h2><p>Everything is <b>50% off</b> this week.</p>'
        + '<img src="https://tracker.marketing-shop.test/open.gif?id=8841" width="1" height="1">'
        + '<p><img src="https://cdn.marketing-shop.test/banner.jpg" alt="Banner" width="480"></p>'
        + '<p><a href="https://marketing-shop.test/deals">See the deals</a></p><img src="cid:logo@shop">',
      attachments: [{ filename: 'logo.png', content: pixel, cid: 'logo@shop' }],
      ageMinutes: 45,
    }),
    build({
      from: 'Finance <billing@acme-supplies.test>',
      subject: 'Invoice INV-2026-118 for November',
      text: 'Hello,\n\nPlease find attached the invoice for November. Payment is due in 14 days.\n\nThanks,\nAcme Supplies',
      attachments: [{ filename: 'INV-2026-118.txt', content: 'Invoice INV-2026-118\nAmount: 1,250.00 AED\n' }],
      ageMinutes: 180,
    }),
    build({
      from: 'Sara <sara@partner-agency.test>',
      subject: 'Meeting notes from Monday',
      text: 'Hi,\n\nSharing the notes from Monday. Next review is on Thursday at 10:00.\n\nSara',
      ageMinutes: 60 * 26,
    }),
  ]);
}

async function main({ imapPort = 1143, smtpPort = 1025 } = {}) {
  const raws = await demoMessages();
  const servers = await startMailServers({
    imapPort,
    smtpPort,
    user: DEMO_USER,
    password: DEMO_PASSWORD,
    seed: raws.map((raw, index) => ({ raw: raw.toString('utf8'), flags: index === 3 ? ['\\Seen'] : [] })),
  });
  return servers;
}

if (require.main === module) {
  main().then((servers) => {
    console.log(`Demo IMAP on 127.0.0.1:${servers.imapPort}, SMTP on 127.0.0.1:${servers.smtpPort}`);
    console.log(`Login: ${DEMO_USER}`);
    console.log('Press Ctrl+C to stop.');
  });
}

module.exports = { DEMO_PASSWORD, DEMO_USER, startDemoServers: main };
