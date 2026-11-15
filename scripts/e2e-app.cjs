/**
 * Drives the real Electron app against the local demo mail server:
 * create project → add account → read mail → reply with approval → check security.
 *
 *   npm run build && node scripts/e2e-app.cjs <screenshot-dir>
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { startDemoServers, DEMO_USER, DEMO_PASSWORD } = require('./demo-mail-server.cjs');

const shotsDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'emargy-shots'));
const step = (name) => console.log(`✔ ${name}`);

async function main() {
  fs.mkdirSync(shotsDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emargy-e2e-'));
  const servers = await startDemoServers({ imapPort: 0, smtpPort: 0 });
  // EMARGY_EXE=release/win-unpacked/Emargy Mail.exe tests the packaged build instead of the sources.
  const packaged = process.env.EMARGY_EXE;
  const app = await electron.launch({
    executablePath: packaged ? path.resolve(packaged) : require('electron'),
    args: packaged ? [] : [path.join(__dirname, '..')],
    env: { ...process.env, EMARGY_DATA_DIR: dataDir, EMARGY_USE_DIST: '1' },
  });
  const blockedRequests = [];
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
    page.on('requestfailed', (request) => blockedRequests.push(request.url()));
    await page.waitForSelector('.app-shell');
    const shot = (name) => page.screenshot({ path: path.join(shotsDir, `${name}.png`) });

    await page.getByRole('button', { name: 'Add project' }).last().click();
    await page.getByLabel('Project name').fill('Emargy Demo');
    await page.getByRole('button', { name: 'Create project' }).click();
    step('project created');

    await page.getByRole('button', { name: 'Add account' }).last().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Sender name').fill('Demo');
    await modal.getByLabel('Email address').fill(DEMO_USER);
    await modal.getByLabel('Password or app password').fill(DEMO_PASSWORD);
    await modal.getByLabel('IMAP host').fill('127.0.0.1');
    await modal.getByLabel('IMAP port').fill(String(servers.imapPort));
    await modal.getByLabel('SMTP host').fill('127.0.0.1');
    await modal.getByLabel('SMTP port').fill(String(servers.smtpPort));
    for (const box of await modal.getByRole('checkbox').all()) await box.uncheck();
    await shot('01-add-account');
    await modal.getByRole('button', { name: 'Test and save account' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 20000 });
    step('account verified and saved');

    await page.locator('.message-row').nth(3).waitFor({ timeout: 20000 });
    await shot('02-inbox');
    step(`inbox synced (${await page.locator('.message-row').count()} messages)`);

    await page.locator('.message-row', { hasText: 'Black Friday' }).click();
    await page.locator('.privacy-banner').waitFor();
    await shot('03-images-blocked');
    step('remote images and tracker blocked');

    await page.locator('.message-row', { hasText: 'عرض سعر' }).click();
    await page.locator('.reader h1', { hasText: 'عرض سعر' }).waitFor();
    await page.getByRole('button', { name: 'العربية' }).click();
    await page.waitForFunction(() => document.documentElement.dir === 'rtl');
    await shot('04-arabic-rtl');
    step('Arabic interface (RTL)');

    await page.getByTitle('رد', { exact: true }).click();
    await page.locator('.compose-body').fill('شكراً أحمد، استلمنا العرض وسنرد قريباً.\n\n' + await page.locator('.compose-body').inputValue());
    await page.getByRole('button', { name: 'إرسال', exact: true }).click();
    await page.getByRole('dialog', { name: 'هل توافق على إرسال هذه الرسالة؟' }).waitFor();
    await page.waitForTimeout(500);
    await shot('05-approval');
    await page.getByRole('button', { name: 'موافقة وإرسال' }).click();
    await page.locator('.toast').waitFor();
    for (let i = 0; i < 50 && !servers.delivered.length; i += 1) await page.waitForTimeout(100);
    if (!servers.delivered.length) throw new Error('Reply was not delivered.');
    step(`reply delivered to SMTP: "${servers.delivered[0].parsed.subject}" → ${servers.delivered[0].envelope.rcptTo.map((r) => r.address)}`);

    await page.getByRole('button', { name: 'الإعدادات والأمان' }).click();
    await page.locator('.security-card').waitFor();
    await shot('06-security-settings');

    await page.getByRole('button', { name: 'English' }).click();
    await page.getByRole('button', { name: 'Activity' }).click();
    await page.locator('.audit-row').first().waitFor();
    await shot('07-activity-log');
    step('activity log recorded');

    const files = fs.readdirSync(dataDir).filter((f) => /emargy\.db/.test(f)).map((f) => fs.readFileSync(path.join(dataDir, f)).toString('latin1')).join('');
    const leaks = ['Black Friday', 'alnoor', DEMO_USER, DEMO_PASSWORD, 'Emargy Demo', 'INV-2026-118'].filter((s) => files.includes(s));
    if (leaks.length) throw new Error(`Plaintext found in database: ${leaks.join(', ')}`);
    step('database contains no readable mail, addresses, project names or passwords');
    const leakedOut = blockedRequests.filter((url) => /marketing-shop/.test(url));
    step(`tracker/image requests that left the app: ${leakedOut.length}`);
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
