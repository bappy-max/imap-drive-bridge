import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { makeMessageMarkdown, mailboxDirection, parseBoolean, parsePositiveInt, sanitizeFileName, stableId } from './lib.mjs';
import { buildGatewaySearchQuery, messageIdMatches, normalizeQueryRequest, publicEnvelope } from './imap-gateway-lib.mjs';

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

function tokenEqual(provided, expected) {
  if (!provided || !expected) return false;
  const left = createHash('sha256').update(String(provided)).digest();
  const right = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(left, right);
}

function loadConfig() {
  const config = {
    imapHost: process.env.IMAP_HOST?.trim(),
    imapPort: parsePositiveInt(process.env.IMAP_PORT, 993, 'IMAP_PORT'),
    imapSecure: parseBoolean(process.env.IMAP_SECURE, true),
    imapUser: process.env.IMAP_USER?.trim(),
    imapPassword: readSecret('IMAP_PASSWORD', 'IMAP_PASSWORD_FILE'),
    allowedMailboxes: String(process.env.IMAP_GATEWAY_MAILBOXES || 'INBOX|Objets envoyés')
      .split('|').map((value) => value.trim()).filter(Boolean),
    sentMailbox: String(process.env.IMAP_SENT_MAILBOX || process.env.SMTP_SENT_MAILBOX || 'Objets envoyés').trim(),
    listenPort: parsePositiveInt(process.env.IMAP_GATEWAY_PORT, 3100, 'IMAP_GATEWAY_PORT'),
    authHeaderName: String(process.env.IMAP_GATEWAY_HEADER_NAME || 'X-DOCK-TOKEN').trim().toLowerCase(),
    authToken: readSecret('IMAP_GATEWAY_TOKEN', 'IMAP_GATEWAY_TOKEN_FILE')
      || readSecret('N8N_HEADER_VALUE', 'N8N_HEADER_VALUE_FILE'),
    maxRequestBytes: parsePositiveInt(process.env.IMAP_GATEWAY_MAX_REQUEST_BYTES, 65_536, 'IMAP_GATEWAY_MAX_REQUEST_BYTES'),
    maxResults: parsePositiveInt(process.env.IMAP_GATEWAY_MAX_RESULTS, 50, 'IMAP_GATEWAY_MAX_RESULTS'),
    defaultMaxResults: parsePositiveInt(process.env.IMAP_GATEWAY_DEFAULT_RESULTS, 20, 'IMAP_GATEWAY_DEFAULT_RESULTS'),
    maxTerms: parsePositiveInt(process.env.IMAP_GATEWAY_MAX_TERMS, 10, 'IMAP_GATEWAY_MAX_TERMS'),
    maxTermChars: parsePositiveInt(process.env.IMAP_GATEWAY_MAX_TERM_CHARS, 200, 'IMAP_GATEWAY_MAX_TERM_CHARS'),
    maxUnfilteredLookbackDays: parsePositiveInt(process.env.IMAP_GATEWAY_UNFILTERED_DAYS, 31, 'IMAP_GATEWAY_UNFILTERED_DAYS'),
    maxBodyChars: parsePositiveInt(process.env.IMAP_GATEWAY_MAX_BODY_CHARS, 100_000, 'IMAP_GATEWAY_MAX_BODY_CHARS'),
    maxSourceBytes: parsePositiveInt(process.env.IMAP_GATEWAY_MAX_SOURCE_BYTES, 20 * 1024 * 1024, 'IMAP_GATEWAY_MAX_SOURCE_BYTES'),
    maxAttachmentBytes: parsePositiveInt(process.env.MAX_ATTACHMENT_BYTES, 8 * 1024 * 1024, 'MAX_ATTACHMENT_BYTES'),
    includeInline: parseBoolean(process.env.INCLUDE_INLINE_ATTACHMENTS, false),
    webhookUrl: process.env.N8N_WEBHOOK_URL?.trim(),
    webhookHeaderName: process.env.N8N_HEADER_NAME?.trim() || 'X-DOCK-TOKEN',
    webhookHeaderValue: readSecret('N8N_HEADER_VALUE', 'N8N_HEADER_VALUE_FILE'),
    stateFile: process.env.STATE_FILE || '/app/data/state.json',
  };

  if (!config.imapHost || !config.imapUser || !config.imapPassword || !config.authToken) {
    throw new Error('IMAP and gateway authentication settings are required');
  }
  if (config.allowedMailboxes.length !== 2 || !config.allowedMailboxes.includes('INBOX') || !config.allowedMailboxes.includes(config.sentMailbox)) {
    throw new Error('IMAP_GATEWAY_MAILBOXES must contain only INBOX and the sent mailbox');
  }
  if (config.defaultMaxResults > config.maxResults) throw new Error('default result limit exceeds maximum');
  if (!config.webhookUrl || !config.webhookHeaderValue) throw new Error('n8n export settings are required');
  return config;
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

function respond(response, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request, maxBytes) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new Error('content-type must be application/json');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function searchMailbox(client, request, mailbox, config) {
  const lock = await client.getMailboxLock(mailbox, { readOnly: true, acquireTimeout: 30_000 });
  try {
    const uidValidity = String(client.mailbox?.uidValidity ?? '');
    const found = await client.search(
      buildGatewaySearchQuery(request, mailbox, config.sentMailbox),
      { uid: true },
    );
    const uids = (Array.isArray(found) ? found : []).slice(-request.maxResultsPerMailbox).reverse();
    const messages = [];
    for (const uid of uids) {
      const message = await client.fetchOne(uid, { uid: true, envelope: true, internalDate: true, size: true }, { uid: true });
      if (message) messages.push(publicEnvelope(message, mailbox, uidValidity));
    }
    return { mailbox, candidateCount: Array.isArray(found) ? found.length : 0, returnedCount: messages.length, messages };
  } finally {
    lock.release();
  }
}

async function fetchVerifiedMessage(client, request, config) {
  const lock = await client.getMailboxLock(request.mailbox, { readOnly: true, acquireTimeout: 30_000 });
  try {
    const uidValidity = String(client.mailbox?.uidValidity ?? '');
    if (uidValidity !== request.uidValidity) throw new Error('uidValidity changed; run search again');
    const metadata = await client.fetchOne(
      request.uid,
      { uid: true, envelope: true, internalDate: true, size: true },
      { uid: true },
    );
    if (!metadata) throw new Error('message not found');
    const sourceSize = Number(metadata.size);
    if (!Number.isSafeInteger(sourceSize) || sourceSize <= 0) throw new Error('message size is unavailable');
    if (sourceSize > config.maxSourceBytes) throw new Error('message exceeds the source size limit');
    const message = await client.fetchOne(
      request.uid,
      { uid: true, source: true, envelope: true, internalDate: true },
      { uid: true },
    );
    if (!message?.source) throw new Error('message not found');
    const parsed = await simpleParser(message.source, { skipHtmlToText: false });
    const actualMessageId = parsed.messageId || message.envelope?.messageId;
    if (!messageIdMatches(actualMessageId, request.messageId)) throw new Error('messageId mismatch; run search again');
    return { message, parsed, uidValidity };
  } finally {
    lock.release();
  }
}

function planAttachments(parsed, config, baseName) {
  const exported = [];
  const skipped = [];
  for (let index = 0; index < (parsed.attachments || []).length; index += 1) {
    const item = parsed.attachments[index];
    const fileName = sanitizeFileName(item.filename, `attachment-${index + 1}`);
    const inline = String(item.contentDisposition || '').toLowerCase() === 'inline';
    if (inline && !config.includeInline) {
      skipped.push({ fileName, reason: 'contenu intégré', size: Number(item.size || item.content?.length || 0) });
      continue;
    }
    if (!item.content || item.content.length > config.maxAttachmentBytes) {
      skipped.push({ fileName, reason: 'taille supérieure à la limite', size: Number(item.size || item.content?.length || 0) });
      continue;
    }
    exported.push({
      fileName: `${baseName}__${fileName}`,
      originalFileName: fileName,
      mimeType: item.contentType || 'application/octet-stream',
      size: item.content.length,
      content: item.content,
    });
  }
  return { exported, skipped };
}

function publicMessage(request, fetched, config) {
  const { message, parsed, uidValidity } = fetched;
  const date = parsed.date instanceof Date && !Number.isNaN(parsed.date.valueOf())
    ? parsed.date
    : message.internalDate || new Date(0);
  const shortId = stableId(parsed.messageId || '', request.mailbox, uidValidity, request.uid).slice(0, 12);
  const baseName = `${date.toISOString().slice(0, 10)}__${mailboxDirection(request.mailbox, config.sentMailbox)}__${shortId}`;
  const plan = planAttachments(parsed, config, baseName);
  const text = String(parsed.text || '');
  return {
    message: {
      ...publicEnvelope(message, request.mailbox, uidValidity),
      text: text.slice(0, config.maxBodyChars),
      bodyTruncated: text.length > config.maxBodyChars,
      attachments: [
        ...plan.exported.map((item) => ({ fileName: item.originalFileName, mimeType: item.mimeType, size: item.size, exportable: true })),
        ...plan.skipped.map((item) => ({ fileName: item.fileName, size: item.size, exportable: false, reason: item.reason })),
      ],
    },
    baseName,
    plan,
    parsed,
    date,
  };
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

async function postFile(config, payload) {
  const response = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [config.webhookHeaderName]: config.webhookHeaderValue },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`n8n upload failed with HTTP ${response.status}`);
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

async function exportMessage(request, fetched, publicResult, config) {
  const state = await loadState(config.stateFile);
  const stateKey = `${request.mailbox}:${fetched.uidValidity}:${request.uid}`;
  const completeKey = stableId(stateKey, 'complete');
  if (state.processedFiles[completeKey]) return { status: 'already_exported', uploaded: 0, fileNames: [] };
  const markdown = makeMessageMarkdown({
    parsed: publicResult.parsed,
    mailbox: request.mailbox,
    direction: mailboxDirection(request.mailbox, config.sentMailbox),
    exportedAttachments: publicResult.plan.exported,
    skippedAttachments: publicResult.plan.skipped,
  });
  const files = [{
    fileName: `${publicResult.baseName}.md`,
    mimeType: 'text/markdown; charset=utf-8',
    content: Buffer.from(markdown, 'utf8'),
  }, ...publicResult.plan.exported];
  const fileNames = [];
  for (const file of files) {
    if (await uploadOnce(config, state, stateKey, file)) fileNames.push(file.fileName);
  }
  state.processedFiles[completeKey] = new Date().toISOString();
  await saveState(config.stateFile, state);
  return { status: 'exported', uploaded: fileNames.length, fileNames };
}

async function execute(config, request) {
  const client = createClient(config);
  try {
    await client.connect();
    if (request.action === 'search') {
      const mailboxes = [];
      for (const mailbox of request.mailboxes) {
        mailboxes.push(await searchMailbox(client, request, mailbox, config));
      }
      return { ok: true, action: 'search', bodyRead: false, attachmentsRead: false, mailboxes };
    }
    const fetched = await fetchVerifiedMessage(client, request, config);
    const result = publicMessage(request, fetched, config);
    if (request.action === 'get') return { ok: true, action: 'get', message: result.message };
    const exported = await exportMessage(request, fetched, result, config);
    return { ok: true, action: 'export', message: result.message, export: exported };
  } finally {
    if (client.usable) await client.logout();
  }
}

async function main() {
  const config = loadConfig();
  const rateWindow = [];
  let exportQueue = Promise.resolve();
  const withExportLock = (operation) => {
    const result = exportQueue.then(operation, operation);
    exportQueue = result.catch(() => {});
    return result;
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') return respond(response, 200, { ok: true });
      const token = request.headers[config.authHeaderName];
      if (Array.isArray(token) || !tokenEqual(token, config.authToken)) return respond(response, 403, { ok: false, error: 'forbidden' });
      if (request.method !== 'POST' || request.url !== '/v1/query') return respond(response, 404, { ok: false, error: 'not_found' });
      const now = Date.now();
      while (rateWindow.length && rateWindow[0] <= now - 60_000) rateWindow.shift();
      if (rateWindow.length >= 30) return respond(response, 429, { ok: false, error: 'rate_limited' });
      rateWindow.push(now);
      const input = await readJson(request, config.maxRequestBytes);
      const normalized = normalizeQueryRequest(input, config);
      const output = normalized.action === 'export'
        ? await withExportLock(() => execute(config, normalized))
        : await execute(config, normalized);
      log('imap_query_complete', {
        action: normalized.action,
        mailboxCount: normalized.mailboxes?.length || 1,
        resultCount: output.mailboxes?.reduce((sum, item) => sum + item.returnedCount, 0) || 1,
      });
      respond(response, 200, output);
    } catch (error) {
      log('imap_query_failed');
      respond(response, 400, { ok: false, error: error instanceof Error ? error.message : 'query failed' });
    }
  });
  server.listen(config.listenPort, '0.0.0.0', () => log('imap_gateway_ready', { port: config.listenPort }));
}

main().catch(() => {
  log('imap_gateway_fatal');
  process.exit(1);
});
