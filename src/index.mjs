import { readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
  buildSearchQuery,
  detectSentMailbox,
  mailboxDirection,
  makeMessageMarkdown,
  parseBoolean,
  parsePositiveInt,
  parseTerms,
  parsedMessageMatches,
  sanitizeFileName,
  stableId,
} from './lib.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`);
}

function readSecret(valueName, fileName) {
  const direct = process.env[valueName];
  if (direct) return direct;
  const path = process.env[fileName];
  if (!path) return undefined;
  return readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
}

function loadConfig() {
  const mode = (process.env.MODE || 'discover').toLowerCase();
  if (!['discover', 'sync'].includes(mode)) throw new Error('MODE must be discover or sync');

  const config = {
    mode,
    imapHost: process.env.IMAP_HOST?.trim(),
    imapPort: parsePositiveInt(process.env.IMAP_PORT, 993, 'IMAP_PORT'),
    imapSecure: parseBoolean(process.env.IMAP_SECURE, true),
    imapUser: process.env.IMAP_USER?.trim(),
    imapPassword: readSecret('IMAP_PASSWORD', 'IMAP_PASSWORD_FILE'),
    mailboxes: String(process.env.MAILBOXES || '').split('|').map((value) => value.trim()).filter(Boolean),
    terms: parseTerms(process.env.FILTER_TERMS),
    since: new Date(`${process.env.SYNC_SINCE || ''}T00:00:00Z`),
    maxMatches: parsePositiveInt(process.env.MAX_MATCHES_PER_MAILBOX, 200, 'MAX_MATCHES_PER_MAILBOX'),
    maxAttachmentBytes: parsePositiveInt(process.env.MAX_ATTACHMENT_BYTES, 8 * 1024 * 1024, 'MAX_ATTACHMENT_BYTES'),
    includeInline: parseBoolean(process.env.INCLUDE_INLINE_ATTACHMENTS, false),
    pollSeconds: parsePositiveInt(process.env.POLL_INTERVAL_SECONDS, 900, 'POLL_INTERVAL_SECONDS'),
    webhookUrl: process.env.N8N_WEBHOOK_URL?.trim(),
    webhookHeaderName: process.env.N8N_HEADER_NAME?.trim() || 'X-DOCK-TOKEN',
    webhookHeaderValue: readSecret('N8N_HEADER_VALUE', 'N8N_HEADER_VALUE_FILE'),
    stateFile: process.env.STATE_FILE || '/app/data/state.json',
    heartbeatFile: process.env.HEARTBEAT_FILE || '/tmp/bridge-heartbeat',
  };

  if (!config.imapHost || !config.imapUser || !config.imapPassword) {
    throw new Error('IMAP_HOST, IMAP_USER and IMAP_PASSWORD are required');
  }
  if (config.mode === 'sync') {
    if (!config.terms.length) throw new Error('FILTER_TERMS is required in sync mode');
    if (Number.isNaN(config.since.valueOf())) throw new Error('SYNC_SINCE must use YYYY-MM-DD');
    if (!config.webhookUrl || !config.webhookHeaderValue) {
      throw new Error('N8N_WEBHOOK_URL and N8N_HEADER_VALUE are required in sync mode');
    }
  }
  return config;
}

async function loadState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return { version: 1, processedFiles: parsed.processedFiles || {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, processedFiles: {} };
    throw error;
  }
}

async function saveState(path, state) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function heartbeat(path) {
  await writeFile(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
}

function createClient(config) {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: { user: config.imapUser, pass: config.imapPassword },
    logger: false,
    disableAutoIdle: true,
    tls: { rejectUnauthorized: true, servername: config.imapHost },
  });
}

async function postFile(config, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [config.webhookHeaderName]: config.webhookHeaderValue,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`n8n upload failed with HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

function attachmentPlan(parsed, config, baseName) {
  const exported = [];
  const skipped = [];
  for (let index = 0; index < (parsed.attachments || []).length; index += 1) {
    const attachment = parsed.attachments[index];
    const fileName = sanitizeFileName(attachment.filename, `attachment-${index + 1}`);
    const isInline = String(attachment.contentDisposition || '').toLowerCase() === 'inline';
    if (isInline && !config.includeInline) {
      skipped.push({ fileName, reason: 'contenu intégré' });
      continue;
    }
    if (!attachment.content || attachment.content.length > config.maxAttachmentBytes) {
      skipped.push({ fileName, reason: 'taille supérieure à la limite' });
      continue;
    }
    exported.push({
      fileName: `${baseName}__${fileName}`,
      mimeType: attachment.contentType || 'application/octet-stream',
      content: attachment.content,
    });
  }
  return { exported, skipped };
}

async function uploadOnce(config, state, stateKey, file) {
  const idempotencyKey = stableId(stateKey, file.fileName);
  if (state.processedFiles[idempotencyKey]) return false;

  await postFile(config, {
    version: 1,
    idempotencyKey,
    fileName: file.fileName,
    mimeType: file.mimeType,
    contentBase64: file.content.toString('base64'),
  });
  state.processedFiles[idempotencyKey] = new Date().toISOString();
  await saveState(config.stateFile, state);
  return true;
}

async function syncMailbox({ client, config, state, mailbox, sentMailbox }) {
  const lock = await client.getMailboxLock(mailbox, { readOnly: true, acquireTimeout: 30_000 });
  try {
    const uidValidity = String(client.mailbox?.uidValidity ?? 'unknown');
    const query = buildSearchQuery(config.terms, config.since);
    const result = await client.search(query, { uid: true });
    const uids = Array.isArray(result) ? result.slice(-config.maxMatches) : [];
    let matched = 0;
    let uploaded = 0;

    for (const uid of uids) {
      const stateKey = `${mailbox}:${uidValidity}:${uid}`;
      const completeKey = stableId(stateKey, 'complete');
      if (state.processedFiles[completeKey]) continue;

      const message = await client.fetchOne(
        uid,
        { uid: true, source: true, envelope: true, internalDate: true },
        { uid: true },
      );
      if (!message?.source) continue;

      const parsed = await simpleParser(message.source, { skipHtmlToText: false });
      if (!parsedMessageMatches(parsed, config.terms)) continue;
      matched += 1;

      const direction = mailboxDirection(mailbox, sentMailbox);
      const date = parsed.date instanceof Date && !Number.isNaN(parsed.date.valueOf())
        ? parsed.date
        : message.internalDate || new Date();
      const shortId = stableId(parsed.messageId || '', stateKey).slice(0, 12);
      const baseName = `${date.toISOString().slice(0, 10)}__${direction}__${shortId}`;
      const plan = attachmentPlan(parsed, config, baseName);
      const markdown = makeMessageMarkdown({
        parsed,
        mailbox,
        direction,
        exportedAttachments: plan.exported,
        skippedAttachments: plan.skipped,
      });

      if (await uploadOnce(config, state, stateKey, {
        fileName: `${baseName}.md`,
        mimeType: 'text/markdown; charset=utf-8',
        content: Buffer.from(markdown, 'utf8'),
      })) uploaded += 1;

      for (const attachment of plan.exported) {
        if (await uploadOnce(config, state, stateKey, attachment)) uploaded += 1;
      }

      state.processedFiles[completeKey] = new Date().toISOString();
      await saveState(config.stateFile, state);
    }

    log('mailbox_sync_complete', { mailbox, candidates: uids.length, matched, uploaded });
  } finally {
    lock.release();
  }
}

async function discover(config) {
  const client = createClient(config);
  try {
    await client.connect();
    const mailboxes = await client.list();
    const sentMailbox = detectSentMailbox(mailboxes);
    log('mailbox_discovery_complete', {
      mailboxes: mailboxes.map((box) => ({ path: box.path, specialUse: box.specialUse || null })),
      detectedSentMailbox: sentMailbox || null,
      messageContentRead: false,
    });
  } finally {
    if (client.usable) await client.logout();
  }
}

async function sync(config) {
  const client = createClient(config);
  const state = await loadState(config.stateFile);
  try {
    await client.connect();
    const discovered = await client.list();
    const sentMailbox = detectSentMailbox(discovered);
    const mailboxes = config.mailboxes.length
      ? config.mailboxes
      : ['INBOX', sentMailbox].filter(Boolean);
    if (!mailboxes.includes('INBOX') || !sentMailbox || !mailboxes.includes(sentMailbox)) {
      throw new Error('MAILBOXES must include INBOX and the verified Sent mailbox');
    }
    for (const mailbox of [...new Set(mailboxes)]) {
      await syncMailbox({ client, config, state, mailbox, sentMailbox });
    }
  } finally {
    if (client.usable) await client.logout();
  }
}

async function main() {
  const config = loadConfig();
  log('bridge_started', { mode: config.mode });

  if (config.mode === 'discover') {
    await discover(config);
    await heartbeat(config.heartbeatFile);
    log('discover_mode_idle');
    while (true) {
      await sleep(60_000);
      await heartbeat(config.heartbeatFile);
    }
  }

  while (true) {
    try {
      await sync(config);
      await heartbeat(config.heartbeatFile);
      log('sync_cycle_complete');
    } catch (error) {
      log('sync_cycle_failed', { error: error instanceof Error ? error.message : String(error) });
    }
    await sleep(config.pollSeconds * 1000);
  }
}

main().catch((error) => {
  log('bridge_fatal', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
