/**
 * Drives the real Electron app against the local demo mail server:
 * first-run setup → read a conversation → create a signature → reply with the
 * rich editor → undo window → delivery → Arabic/RTL → dark mode → storage check.
 *
 *   npm run build && node scripts/e2e-app.cjs <screenshot-dir>
 *   EMARGY_EXE="release/win-unpacked/Emargy Mail.exe" node scripts/e2e-app.cjs <dir>
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { startDemoServers, DEMO_USER, DEMO_PASSWORD } = require('./demo-mail-server.cjs');

const shotsDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'emargy-shots'));
const step = (name) => console.log(`✔ ${name}`);

async function setupAccount(page, servers, { projectName, name }) {
  await page.getByLabel(/Project name|اسم المشروع/).fill(projectName);
  await page.getByLabel(/Your name|اسمك/).fill(name);
  await page.getByLabel(/Email address|عنوان البريد/).fill(DEMO_USER);
  await page.getByLabel(/^Password$|^كلمة المرور$/).fill(DEMO_PASSWORD);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /Server settings|إعدادات الخادم/ }).click();
  await page.getByLabel(/Incoming server|خادم الوارد/).fill('127.0.0.1');
  await page.getByLabel(/Outgoing server|خادم الصادر/).fill('127.0.0.1');
  const ports = page.getByLabel(/^Port$|^المنفذ$/);
  await ports.nth(0).fill(String(servers.imapPort));
  await ports.nth(1).fill(String(servers.smtpPort));
  for (const box of await page.getByRole('checkbox', { name: 'SSL/TLS' }).all()) await box.uncheck();
}

async function main() {
  fs.mkdirSync(shotsDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emargy-e2e-'));
  const servers = await startDemoServers({ imapPort: 0, smtpPort: 0 });
  const packaged = process.env.EMARGY_EXE;
  const app = await electron.launch({
    executablePath: packaged ? path.resolve(packaged) : require('electron'),
    args: packaged ? [] : [path.join(__dirname, '..')],
    env: { ...process.env, EMARGY_DATA_DIR: dataDir, EMARGY_USE_DIST: '1' },
  });
  const outgoing = [];
  try {
    const page = await app.firstWindow();
    page.on('request', (request) => { if (/^https?:/.test(request.url())) outgoing.push(request.url()); });
    const window = await app.browserWindow(page);
    await window.evaluate((w) => { w.setSize(1440, 900); w.center(); });
    const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(shotsDir, `${name}.png`) }); };

    await page.waitForSelector('.welcome');
    await setupAccount(page, servers, { projectName: 'Emargy', name: 'Tarek' });
    await shot('01-welcome');
    await page.getByRole('button', { name: /Connect account|ربط الحساب/ }).click();
    await page.waitForSelector('.app .row', { timeout: 30000 });
    await page.locator('.row').nth(3).waitFor();
    step(`first-run setup connected the account (${await page.locator('.row').count()} conversations)`);

    await page.locator('.row', { hasText: 'Black Friday' }).click();
    await page.locator('.privacy-note').waitFor();
    await shot('02-inbox-and-privacy');
    step('newsletter opened; images and tracker blocked');

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Signatures' }).click();
    await page.getByRole('button', { name: 'New signature' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Work');
    const sigEditor = page.locator('.signature-editor .rich-content');
    await sigEditor.click();
    await page.keyboard.type('Tarek Alkoht');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Emargy · +971 50 000 0000');
    await shot('03-signature-editor');
    await page.getByRole('button', { name: 'Save signature' }).click();
    await page.getByRole('tab', { name: 'Accounts' }).click();
    await page.getByLabel('Signature for new messages').selectOption({ label: 'Work' });
    await page.getByLabel('Signature for replies and forwards').selectOption({ label: 'Work' });
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.locator('.toast').waitFor();
    step('signature created and assigned to the account');

    await page.getByRole('button', { name: 'All inboxes' }).click();
    await page.locator('.row', { hasText: 'عرض سعر' }).click();
    await page.locator('.thread-head h1', { hasText: 'عرض سعر' }).waitFor();
    await page.locator('.thread-toolbar').getByRole('button', { name: 'Reply', exact: true }).click();
    const editor = page.locator('.composer .rich-content');
    await editor.waitFor();
    await page.locator('.composer .signature-block', { hasText: 'Tarek Alkoht' }).waitFor();
    await page.keyboard.type('شكراً أحمد، استلمنا ');
    await page.keyboard.press('Control+b');
    await page.keyboard.type('عرض السعر');
    await page.keyboard.press('Control+b');
    await page.keyboard.type(' وسنرد قبل الخميس.');
    await shot('04-reply-editor');
    step('reply composer: formatting, Arabic text, signature inserted automatically');

    await page.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('.toast', { hasText: 'Sending' }).waitFor();
    await shot('05-undo-send');
    for (let i = 0; i < 150 && !servers.delivered.length; i += 1) await page.waitForTimeout(100);
    if (!servers.delivered.length) throw new Error('Reply was not delivered.');
    const sent = servers.delivered[0].parsed;
    if (!/<strong>عرض السعر<\/strong>/.test(sent.html) || !/Tarek Alkoht/.test(sent.html)) throw new Error('Sent HTML is missing formatting or signature.');
    step(`after the undo window, delivered "${sent.subject}" with formatting and signature`);
    await page.waitForTimeout(500);
    const draftsLeft = await app.evaluate(() => null).then(() => page.evaluate(() => window.emargy.getState().then((s) => s.drafts.length)));
    if (draftsLeft) throw new Error(`${draftsLeft} draft(s) left behind after sending.`);
    step('no leftover draft after sending');

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'العربية' }).click();
    await page.waitForFunction(() => document.documentElement.dir === 'rtl');
    await page.getByRole('button', { name: 'كل الوارد' }).click();
    await page.locator('.row', { hasText: 'عرض سعر' }).click();
    await page.locator('.thread-message').last().waitFor();
    await shot('06-arabic-rtl');
    step('Arabic interface, right-to-left');

    await page.getByRole('button', { name: 'الإعدادات' }).click();
    await page.getByRole('radio', { name: 'داكن' }).click();
    await page.getByRole('button', { name: 'كل الوارد' }).click();
    await page.locator('.row', { hasText: 'Invoice' }).click();
    await page.locator('.thread-message').waitFor();
    await shot('07-dark');
    step('dark mode');

    await page.getByRole('button', { name: 'رسالة جديدة' }).click();
    await page.locator('.composer:not(.inline)').waitFor();
    await page.getByLabel('إلى').fill('sa');
    await page.locator('.suggestions li').first().waitFor();
    await shot('08-new-message');
    step('new message with contact suggestions');

    await app.evaluate(() => {});
    const files = fs.readdirSync(dataDir).filter((f) => /emargy\.db/.test(f)).map((f) => fs.readFileSync(path.join(dataDir, f)).toString('latin1')).join('');
    const leaks = ['Black Friday', 'alnoor', DEMO_USER, DEMO_PASSWORD, 'Tarek Alkoht', 'INV-2026-118'].filter((s) => files.includes(s));
    if (leaks.length) throw new Error(`Plaintext found in database: ${leaks.join(', ')}`);
    step('database holds no readable mail, addresses, signature or password');
    const external = outgoing.filter((url) => !/^https?:\/\/127\.0\.0\.1/.test(url));
    if (external.length) throw new Error(`The interface contacted the internet: ${external.join(', ')}`);
    step('the interface made no internet requests');
  } finally {
    await app.close();
    await servers.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`Screenshots: ${shotsDir}`);
}

main().catch((error) => {
  console.error('✘', error);
  process.exit(1);
});
