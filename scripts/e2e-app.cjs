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
    env: { ...process.env, EMARGY_DATA_DIR: dataDir, EMARGY_USE_DIST: '1', EMARGY_INITIAL_WINDOW: '3' },
  });
  const outgoing = [];
  try {
    const page = await app.firstWindow();
    page.on('request', (request) => { if (/^https?:/.test(request.url())) outgoing.push(request.url()); });
    const window = await app.browserWindow(page);
    await window.evaluate((w) => { w.setSize(1440, 900); w.center(); });
    const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(shotsDir, `${name}.png`) }); };

    await page.waitForSelector('.welcome');
    await setupAccount(page, servers, { projectName: 'Emargy', name: 'Sami' });
    await shot('01-welcome');
    await page.getByRole('button', { name: /Connect account|ربط الحساب/ }).click();
    await page.waitForSelector('.app .row', { timeout: 30000 });
    await page.locator('.row').nth(3).waitFor();
    step(`first-run setup connected the account (${await page.locator('.row').count()} conversations)`);
    // Only the newest 3 were synced first; reaching the end of the list loads the older ones from the server.
    await page.waitForFunction(() => document.querySelectorAll('.row').length === 5 && !document.querySelector('.load-older'), null, { timeout: 20000 });
    step('older mail loads from the server when the end of the list is reached');
    await page.locator('.list-search input').fill('Thursday');
    await page.locator('.server-search.done').waitFor({ timeout: 20000 });
    if (!(await page.locator('.row', { hasText: 'Meeting notes' }).count())) throw new Error('Search did not find the message by its text.');
    await shot('01c-server-search');
    await page.locator('.list-search input').fill('');
    step('search also asks the server and finds words inside messages');
    await page.locator('.empty-scene.trays .scene-card h2').waitFor();
    await shot('01b-empty-scene');
    step('empty reading pane shows the picture and a greeting');

    await page.locator('.row', { hasText: 'Black Friday' }).click();
    await page.locator('.privacy-note').waitFor();
    await page.waitForTimeout(400);
    const frame = await page.locator('.message-frame').evaluate((f) => ({ sandbox: f.getAttribute('sandbox'), height: f.clientHeight, reachable: (() => { try { return Boolean(f.contentDocument); } catch { return false; } })() }));
    if (/allow-same-origin/.test(frame.sandbox) || frame.reachable) throw new Error(`Email frame is not isolated: ${JSON.stringify(frame)}`);
    if (frame.height < 150) throw new Error(`Email frame too short (height reporter blocked?): ${frame.height}px`);
    step(`email frame isolated (opaque origin; only the hashed height reporter runs) and sized to content (${frame.height}px)`);
    await shot('02-inbox-and-privacy');
    step('newsletter opened; images and tracker blocked');

    const spamRow = page.locator('.row', { hasText: 'Unrecognized Login Attempt' });
    await spamRow.locator('.trust-badge.spam').waitFor();
    await spamRow.click();
    await page.locator('.trust-warning.spam').waitFor();
    await shot('02b-spam-warning');
    step('spam is labelled in the list and warned about when opened');

    await page.locator('.sidebar').getByRole('button', { name: /^Important/ }).click();
    await page.locator('.list-title h1', { hasText: 'Important' }).waitFor();
    await page.locator('.ai-cta').waitFor();
    await page.waitForFunction(() => !/Unrecognized|Black Friday/.test(document.querySelector('.rows')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
    const importantRows = await page.locator('.row').allInnerTexts();
    if (process.env.E2E_DEBUG) console.log(JSON.stringify(await page.evaluate(() => window.emargy.listMessages({ folderRole: 'inbox', filter: 'important' }).then((r) => r.messages.map((m) => [m.subject, m.trust, m.important, m.aiImportant])))));
    if (importantRows.some((r) => /Unrecognized|Black Friday/.test(r)) || !importantRows.some((r) => /INV-2026-118/.test(r))) throw new Error(`Important view is wrong: ${importantRows.join(' | ')}`);
    step(`important view lists ${importantRows.length} messages, without spam, and offers assistant alerts`);

    await page.locator('.row').first().click();
    await page.locator('.list-head').getByRole('button', { name: 'Select messages' }).click();
    await page.locator('.list-head.bulk').getByRole('button', { name: 'Mark as read' }).click();
    await page.locator('.list-head.bulk').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'All inboxes' }).click();
    await page.locator('.list-head').getByRole('button', { name: 'Mark all as read' }).click();
    await page.locator('.toast', { hasText: /marked as read|Nothing unread/ }).waitFor();
    if (await page.locator('.row.unread').count()) throw new Error('Messages still unread after "Mark all as read".');
    step('select-all, bulk mark-read and mark-all-read work');

    await page.getByRole('button', { name: 'Activity' }).click();
    await page.locator('.back-button').click();
    await page.locator('.list-pane').waitFor();
    await page.getByRole('button', { name: 'Activity' }).click();
    await page.keyboard.press('Escape');
    await page.locator('.list-pane').waitFor();
    step('pages have a way back (button and Esc)');

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Notifications' }).click();
    await page.getByRole('radio', { name: 'Important only' }).click();
    await page.locator('.quiet-controls input[type="checkbox"]').click();
    await page.waitForFunction(() => document.querySelector('.quiet-controls input[type="checkbox"]')?.checked);
    const prefs = await page.evaluate(() => window.emargy.getState().then((s) => s.settings));
    if (prefs.notifyMode !== 'important' || !prefs.quietHours.enabled) throw new Error(`Notification settings not saved: ${JSON.stringify(prefs)}`);
    await shot('03d-notification-settings');
    await page.getByRole('radio', { name: 'All new mail' }).click();
    step('notification settings: mode, quiet hours, per-project switches');

    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByRole('radio', { name: 'Night' }).click();
    await page.locator('.back-button').click();
    await page.getByRole('button', { name: 'All inboxes' }).click();
    await page.locator('.empty-scene.night').waitFor();
    await shot('03e-night-scene');
    step('empty-screen picture can be changed (Night)');

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Signatures' }).click();
    await page.getByRole('button', { name: 'New signature' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Work');
    const sigEditor = page.locator('.signature-editor .rich-content');
    await sigEditor.click();
    await page.keyboard.type('Sami Haddad');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Emargy · +1 555 0100');
    await shot('03-signature-editor');
    await page.getByRole('button', { name: 'Save signature' }).click();
    await page.getByRole('tab', { name: 'Accounts' }).click();
    const toggle = page.locator('.settings-card .card-toggle');
    await toggle.click();
    if (await page.getByLabel('Signature for new messages').count()) throw new Error('Account card did not collapse.');
    await toggle.click();
    step('account card collapses and expands');
    await page.getByLabel('Signature for new messages').selectOption({ label: 'Work' });
    await page.getByLabel('Signature for replies and forwards').selectOption({ label: 'Work' });
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.locator('.toast').waitFor();
    step('signature created and assigned to the account');

    await page.getByRole('button', { name: 'Add account' }).last().click();
    await page.locator('form.setup').getByLabel(/Email address/).fill('someone@gmail.com');
    await page.locator('form.setup').getByLabel(/Your name/).click(); // leaving the field detects the provider
    await page.locator('.provider-guide').waitFor();
    if (!(await page.getByLabel('Google app password').count())) throw new Error('Google app password field missing.');
    await shot('03b-google-guide');
    step('Gmail address shows the guided app-password setup');
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Adding from a project only asks for that project's account, and refuses a mailbox that already exists.
    await page.locator('.sidebar .add-account-line').first().click();
    await page.locator('.modal', { hasText: 'Add an account to Emargy' }).waitFor();
    if (await page.locator('.modal form.setup').getByLabel('Project', { exact: true }).count()) throw new Error('Project picker shown inside a project.');
    await page.locator('.modal form.setup').getByLabel(/Email address/).fill(DEMO_USER);
    await page.locator('.modal form.setup').getByLabel(/^Password$/).fill(DEMO_PASSWORD);
    await page.locator('.modal').getByRole('button', { name: 'Connect account' }).click();
    await page.locator('.modal .form-error', { hasText: 'already added' }).waitFor({ timeout: 20000 });
    await shot('03c-duplicate');
    await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
    step('adding from a project hides other projects and refuses a duplicate mailbox');
    await page.getByRole('tab', { name: 'General' }).click();
    await page.getByRole('button', { name: 'Check now' }).waitFor();
    await page.locator('.setting-row strong', { hasText: /^Version \d+\.\d+\.\d+$/ }).waitFor({ timeout: 5000 });
    step('update settings show the version and a check button');

    await page.getByRole('button', { name: 'All inboxes' }).click();
    await page.locator('.row', { hasText: 'عرض سعر' }).click();
    await page.locator('.thread-head h1', { hasText: 'عرض سعر' }).waitFor();
    await page.locator('.thread-toolbar').getByRole('button', { name: 'Reply', exact: true }).click();
    const editor = page.locator('.composer .rich-content');
    await editor.waitFor();
    await page.locator('.composer .signature-block', { hasText: 'Sami Haddad' }).waitFor();
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
    if (!/<strong>عرض السعر<\/strong>/.test(sent.html) || !/Sami Haddad/.test(sent.html)) throw new Error('Sent HTML is missing formatting or signature.');
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
    await page.getByRole('tab', { name: 'المظهر' }).click();
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

    // Uses the Claude/Codex tool signed in on this computer (the reader's subscription).
    if (process.env.EMARGY_E2E_AI) {
      await page.locator('.composer .rich-content > p').first().click(); // above the signature
      await page.keyboard.type('hi ahmed, i will sent you the price tomorow becuse the manager is not here today');
      await page.locator('.composer').getByRole('button', { name: 'المساعد' }).click();
      await page.getByRole('button', { name: 'تحسين الصياغة' }).click();
      await page.locator('.toast').waitFor({ timeout: 150000 });
      const toastText = await page.locator('.toast').innerText();
      if (!/تم عبر/.test(toastText)) throw new Error(`Assistant failed: ${toastText}`);
      const improved = await page.locator('.composer .rich-content').innerText();
      if (/tomorow|becuse/.test(improved)) throw new Error(`Draft was not improved: ${improved}`);
      await shot('09-ai-improve');
      step(`assistant improved the draft: "${improved.split('\n')[0].slice(0, 70)}…"`);
      await page.locator('.composer-head .icon-button').click();

      await page.getByRole('button', { name: 'كل الوارد' }).click();
      await page.locator('.row', { hasText: 'Invoice' }).click();
      await page.locator('.thread-toolbar').getByRole('button', { name: 'المساعد' }).click();
      await page.getByRole('button', { name: 'ترجمة إلى العربية' }).click();
      const result = page.locator('.ai-result');
      await result.waitFor({ timeout: 150000 });
      const translated = await result.innerText();
      if (!/[؀-ۿ]{3}/.test(translated) || !/INV-2026-118|14/.test(translated)) throw new Error(`Bad translation: ${translated}`);
      await shot('10-ai-translate');
      step('assistant translated the message to Arabic, keeping the invoice number');

      await page.locator('.thread-toolbar').getByRole('button', { name: 'المساعد' }).click();
      await page.getByRole('button', { name: 'اقتراح رد' }).click();
      await page.locator('.ai-panel', { hasText: 'رد مقترح' }).locator('.ai-result').waitFor({ timeout: 150000 });
      await page.getByRole('button', { name: 'استخدمه في الرد' }).click();
      await page.locator('.composer.inline .rich-content').waitFor();
      const replyText = await page.locator('.composer.inline .rich-content').innerText();
      if (replyText.trim().length < 20) throw new Error('Suggested reply was not placed in the composer.');
      await shot('11-ai-reply');
      step('suggested reply placed in the reply editor, above the quote');
    }

    await app.evaluate(() => {});
    const files = fs.readdirSync(dataDir).filter((f) => /emargy\.db/.test(f)).map((f) => fs.readFileSync(path.join(dataDir, f)).toString('latin1')).join('');
    const leaks = ['Black Friday', 'alnoor', DEMO_USER, DEMO_PASSWORD, 'Sami Haddad', 'INV-2026-118'].filter((s) => files.includes(s));
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
