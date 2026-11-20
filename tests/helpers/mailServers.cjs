const hoodiecrow = require('hoodiecrow-imap');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

function rawMessage({ from, to, subject, body, id }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${id}@test.local>`,
    `Date: ${new Date().toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
}

/** Local IMAP + SMTP servers for tests and demos. Nothing leaves this computer. */
async function startMailServers({ imapPort = 0, smtpPort = 0, user = 'tester@emargy.test', password = 'test-password', seed = [] } = {}) {
  const imap = hoodiecrow({
    plugins: ['ID', 'IDLE', 'UIDPLUS', 'SPECIAL-USE', 'ENABLE', 'CONDSTORE', 'LITERALPLUS', 'MOVE'],
    storage: {
      INBOX: { messages: seed.map((message) => ({ raw: message.raw || rawMessage(message), flags: message.flags || [] })) },
      '': {
        separator: '/',
        folders: {
          Sent: { 'special-use': '\\Sent', messages: [] },
          Trash: { 'special-use': '\\Trash', messages: [] },
          Junk: { 'special-use': '\\Junk', messages: [] },
        },
      },
    },
    users: { [user]: { password } },
  });
  await new Promise((resolve) => imap.listen(imapPort, '127.0.0.1', resolve));

  const delivered = [];
  const smtp = new SMTPServer({
    secure: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    onAuth(auth, _session, callback) {
      if (auth.username === user && auth.password === password) return callback(null, { user });
      return callback(new Error('Invalid login'));
    },
    onData(stream, session, callback) {
      simpleParser(stream).then((parsed) => {
        delivered.push({ envelope: session.envelope, parsed });
        callback();
      }, callback);
    },
  });
  await new Promise((resolve) => smtp.listen(smtpPort, '127.0.0.1', resolve));

  return {
    user,
    password,
    imap,
    smtp,
    delivered,
    imapPort: imap.address().port,
    smtpPort: smtp.server.address().port,
    folder(path) {
      return imap.getMailbox(path);
    },
    async stop() {
      await new Promise((resolve) => smtp.close(resolve));
      await new Promise((resolve) => imap.close(resolve));
    },
  };
}

module.exports = { rawMessage, startMailServers };
