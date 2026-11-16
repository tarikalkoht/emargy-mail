/**
 * Opens Emargy Mail in demo mode: a local demo mail server plus a separate demo
 * data folder, with a project, an account and a signature already set up.
 * Real data is untouched. Close the window to end the demo.
 *
 *   node scripts/demo-app.cjs [path-to-Emargy Mail.exe]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { startDemoServers, DEMO_USER, DEMO_PASSWORD } = require('./demo-mail-server.cjs');

async function main() {
  const exe = process.argv[2];
  const dataDir = path.join(os.tmpdir(), 'emargy-demo-data');
  fs.rmSync(dataDir, { recursive: true, force: true });
  const servers = await startDemoServers({ imapPort: 0, smtpPort: 0 });
  const app = await electron.launch({
    executablePath: exe ? path.resolve(exe) : require('electron'),
    args: exe ? [] : [path.join(__dirname, '..')],
    env: { ...process.env, EMARGY_DATA_DIR: dataDir, EMARGY_USE_DIST: '1' },
  });
  const page = await app.firstWindow();
  const window = await app.browserWindow(page);
  await window.evaluate((w) => { w.setSize(1440, 900); w.center(); });
  await page.waitForSelector('.welcome');
  await page.getByRole('button', { name: 'العربية' }).click();
  await page.getByLabel('اسم المشروع').fill('إيمارجي');
  await page.getByLabel(/اسمك/).fill('سامي');
  await page.getByLabel('عنوان البريد').fill(DEMO_USER);
  await page.getByLabel('كلمة المرور', { exact: true }).fill(DEMO_PASSWORD);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'إعدادات الخادم' }).click();
  await page.getByLabel('خادم الوارد (IMAP)').fill('127.0.0.1');
  await page.getByLabel('خادم الصادر (SMTP)').fill('127.0.0.1');
  const ports = page.getByLabel('المنفذ', { exact: true });
  await ports.nth(0).fill(String(servers.imapPort));
  await ports.nth(1).fill(String(servers.smtpPort));
  for (const box of await page.getByRole('checkbox', { name: 'SSL/TLS' }).all()) await box.uncheck();
  await page.getByRole('button', { name: 'ربط الحساب' }).click();
  await page.waitForSelector('.app .row', { timeout: 30000 });
  const state = await page.evaluate(async () => {
    await window.emargy.saveSignature({ name: 'توقيع العمل', html: '<p><strong>سامي</strong></p><p>إيمارجي — +971 50 000 0000</p>' });
    const s = await window.emargy.getState();
    return window.emargy.updateAccount(s.accounts[0].id, { signatureNew: s.signatures[0].id, signatureReply: s.signatures[0].id });
  });
  await page.reload();
  await page.waitForSelector('.app .row');
  console.log(`Demo is open (${state.accounts.length} account). Close the Emargy Mail window to end the demo.`);
  await new Promise((resolve) => app.on('close', resolve));
  await servers.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
