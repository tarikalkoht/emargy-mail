/**
 * Opens Emargy Mail in demo mode: a local demo mail server plus a separate demo
 * data folder, with a project and account already added. Real data is untouched.
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
  await page.waitForSelector('.app-shell');
  await page.getByRole('button', { name: 'العربية' }).click();
  await page.getByRole('button', { name: 'إضافة مشروع' }).last().click();
  await page.getByLabel('اسم المشروع').fill('مشروع تجريبي');
  await page.getByRole('button', { name: 'إنشاء المشروع' }).click();
  await page.getByRole('button', { name: 'إضافة حساب' }).last().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('اسم المرسل').fill('حساب تجريبي');
  await modal.getByLabel('عنوان البريد').fill(DEMO_USER);
  await modal.getByLabel('كلمة المرور أو كلمة مرور التطبيق').fill(DEMO_PASSWORD);
  await modal.getByLabel('خادم IMAP').fill('127.0.0.1');
  await modal.getByLabel('منفذ IMAP').fill(String(servers.imapPort));
  await modal.getByLabel('خادم SMTP').fill('127.0.0.1');
  await modal.getByLabel('منفذ SMTP').fill(String(servers.smtpPort));
  for (const box of await modal.getByRole('checkbox').all()) await box.uncheck();
  await modal.getByRole('button', { name: 'اختبار وحفظ الحساب' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 20000 });
  console.log('Demo is open. Close the Emargy Mail window to end the demo.');
  await new Promise((resolve) => app.on('close', resolve));
  await servers.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
