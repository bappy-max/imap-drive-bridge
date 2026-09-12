import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

export function createMessageCompiler() {
  return nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  });
}

export async function compileMessage(compiler, mail, record = {}) {
  const prepared = {
    ...mail,
    messageId: record.messageId || mail.messageId,
    date: record.sentAt ? new Date(record.sentAt) : mail.date,
  };
  const info = await compiler.sendMail(prepared);
  if (!Buffer.isBuffer(info.message) || !info.message.length || !info.messageId) {
    throw new Error('message compilation failed');
  }
  return { raw: info.message, messageId: info.messageId };
}

function createArchiveClient(config) {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: { user: config.user, pass: config.password },
    logger: false,
    disableAutoIdle: true,
    tls: { rejectUnauthorized: true, servername: config.imapHost },
  });
}

export async function appendSentCopy(
  config,
  raw,
  messageId,
  sentAt,
  clientFactory = createArchiveClient,
) {
  const client = clientFactory(config);
  try {
    await client.connect();
    await client.mailboxOpen(config.sentMailbox, { readOnly: true });
    const existing = await client.search({ header: { 'message-id': messageId } }, { uid: true });
    if (existing.length) return { alreadyPresent: true };

    const appended = await client.append(config.sentMailbox, raw, ['\\Seen'], new Date(sentAt));
    if (!appended) throw new Error('IMAP append returned no result');
    return { alreadyPresent: false };
  } finally {
    if (client.usable) await client.logout();
  }
}
