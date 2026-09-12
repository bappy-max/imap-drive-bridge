import { readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import nodemailer from 'nodemailer';
import { parseBoolean, parsePositiveInt } from './lib.mjs';
import { normalizeSendRequest, publicSendResult, secureTokenEqual } from './smtp-lib.mjs';

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
  const smtpUser = process.env.SMTP_USER?.trim();
  const fromAddress = (process.env.SMTP_FROM || smtpUser)?.trim().toLowerCase();
  const config = {
    host: process.env.SMTP_HOST?.trim() || 'smtp.ionos.fr',
    port: parsePositiveInt(process.env.SMTP_PORT, 465, 'SMTP_PORT'),
    secure: parseBoolean(process.env.SMTP_SECURE, true),
    user: smtpUser,
    password: readSecret('SMTP_PASSWORD', 'SMTP_PASSWORD_FILE'),
    fromAddress,
    fromName: String(process.env.SMTP_FROM_NAME || 'Cabinet Hemmès').trim(),
    listenPort: parsePositiveInt(process.env.SMTP_GATEWAY_PORT, 3000, 'SMTP_GATEWAY_PORT'),
    authHeaderName: String(process.env.SMTP_GATEWAY_HEADER_NAME || 'X-DOCK-TOKEN').trim().toLowerCase(),
    authToken: readSecret('SMTP_GATEWAY_TOKEN', 'SMTP_GATEWAY_TOKEN_FILE'),
    stateFile: process.env.SMTP_STATE_FILE || '/app/smtp-data/state.json',
    maxRecipients: parsePositiveInt(process.env.SMTP_MAX_RECIPIENTS, 10, 'SMTP_MAX_RECIPIENTS'),
    maxSubjectChars: parsePositiveInt(process.env.SMTP_MAX_SUBJECT_CHARS, 200, 'SMTP_MAX_SUBJECT_CHARS'),
    maxBodyChars: parsePositiveInt(process.env.SMTP_MAX_BODY_CHARS, 50_000, 'SMTP_MAX_BODY_CHARS'),
    maxAttachmentCount: parsePositiveInt(process.env.SMTP_MAX_ATTACHMENT_COUNT, 10, 'SMTP_MAX_ATTACHMENT_COUNT'),
    maxAttachmentBytes: parsePositiveInt(process.env.SMTP_MAX_ATTACHMENT_BYTES, 8 * 1024 * 1024, 'SMTP_MAX_ATTACHMENT_BYTES'),
    maxTotalAttachmentBytes: parsePositiveInt(process.env.SMTP_MAX_TOTAL_ATTACHMENT_BYTES, 12 * 1024 * 1024, 'SMTP_MAX_TOTAL_ATTACHMENT_BYTES'),
    maxRequestBytes: parsePositiveInt(process.env.SMTP_MAX_REQUEST_BYTES, 18 * 1024 * 1024, 'SMTP_MAX_REQUEST_BYTES'),
  };

  if (!config.user || !config.password || !config.fromAddress || !config.authToken) {
    throw new Error('SMTP_USER, SMTP_PASSWORD, SMTP_FROM and SMTP_GATEWAY_TOKEN are required');
  }
  if (config.fromAddress !== config.user.toLowerCase()) {
    throw new Error('SMTP_FROM must equal SMTP_USER');
  }
  if (!config.fromName || /[\r\n]/u.test(config.fromName)) throw new Error('SMTP_FROM_NAME is invalid');
  return config;
}

async function loadState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return { version: 1, requests: parsed.requests || {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, requests: {} };
    throw error;
  }
}

async function saveState(path, state) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
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

async function main() {
  const config = loadConfig();
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    tls: { rejectUnauthorized: true, servername: config.host },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
  const state = await loadState(config.stateFile);
  let stateQueue = Promise.resolve();
  const rateWindow = [];

  const withStateLock = (operation) => {
    const result = stateQueue.then(operation, operation);
    stateQueue = result.catch(() => {});
    return result;
  };

  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        respond(response, 200, { ok: true });
        return;
      }

      const providedToken = request.headers[config.authHeaderName];
      if (Array.isArray(providedToken) || !secureTokenEqual(providedToken, config.authToken)) {
        respond(response, 403, { ok: false, error: 'forbidden' });
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/verify') {
        await transport.verify();
        log('smtp_verify_ok');
        respond(response, 200, { ok: true, smtpAccount: config.fromAddress });
        return;
      }

      if (request.method !== 'POST' || request.url !== '/v1/send') {
        respond(response, 404, { ok: false, error: 'not_found' });
        return;
      }

      const now = Date.now();
      while (rateWindow.length && rateWindow[0] <= now - 60_000) rateWindow.shift();
      if (rateWindow.length >= 10) {
        respond(response, 429, { ok: false, error: 'rate_limited' });
        return;
      }

      const input = await readJson(request, config.maxRequestBytes);
      const normalized = normalizeSendRequest(input, config);
      const reservation = await withStateLock(async () => {
        const existing = state.requests[normalized.requestId];
        if (existing) {
          if (existing.digest !== normalized.digest) return { kind: 'mismatch', record: existing };
          return { kind: 'duplicate', record: existing };
        }
        const record = {
          requestId: normalized.requestId,
          digest: normalized.digest,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        state.requests[normalized.requestId] = record;
        await saveState(config.stateFile, state);
        return { kind: 'new', record };
      });

      if (reservation.kind === 'mismatch') {
        respond(response, 409, { ok: false, error: 'request_id_reused' });
        return;
      }
      if (reservation.kind === 'duplicate') {
        const code = reservation.record.status === 'sent' ? 200 : 409;
        respond(response, code, publicSendResult(reservation.record, true));
        return;
      }

      rateWindow.push(now);
      try {
        const info = await transport.sendMail(normalized.mail);
        await withStateLock(async () => {
          Object.assign(reservation.record, {
            status: 'sent',
            messageId: info.messageId || null,
            sentAt: new Date().toISOString(),
          });
          await saveState(config.stateFile, state);
        });
        log('smtp_send_complete', {
          requestId: normalized.requestId,
          recipientCount: normalized.recipientCount,
          attachmentCount: normalized.attachmentCount,
        });
        respond(response, 200, publicSendResult(reservation.record));
      } catch (error) {
        await withStateLock(async () => {
          Object.assign(reservation.record, { status: 'failed', failedAt: new Date().toISOString() });
          await saveState(config.stateFile, state);
        });
        log('smtp_send_failed', { requestId: normalized.requestId });
        respond(response, 502, { ok: false, error: 'smtp_send_failed', requestId: normalized.requestId });
      }
    } catch (error) {
      const message = error instanceof SyntaxError ? 'JSON body is invalid' : error.message;
      log('smtp_request_rejected', { error: message });
      respond(response, 400, { ok: false, error: message });
    }
  });

  server.requestTimeout = 75_000;
  server.headersTimeout = 15_000;
  server.listen(config.listenPort, '0.0.0.0', () => {
    log('smtp_gateway_started', { port: config.listenPort, smtpHost: config.host });
  });
}

main().catch((error) => {
  log('smtp_gateway_fatal', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
