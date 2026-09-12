import { createHash, timingSafeEqual } from 'node:crypto';
import { sanitizeFileName } from './lib.mjs';

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function assertPlainHeader(value, name, maxLength) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength || /[\r\n]/u.test(text)) {
    throw new Error(`${name} is invalid`);
  }
  return text;
}

function normalizeAddress(value, name) {
  const address = assertPlainHeader(value, name, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(address)) throw new Error(`${name} is invalid`);
  return address;
}

function normalizeAddressList(value, name, { required = false } = {}) {
  const entries = value === undefined || value === null || value === ''
    ? []
    : Array.isArray(value) ? value : String(value).split(/[;,]/u);
  const normalized = [...new Set(entries.map((item) => normalizeAddress(item, name)))];
  if (required && !normalized.length) throw new Error(`${name} is required`);
  return normalized;
}

function normalizeMessageId(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = assertPlainHeader(value, name, 998);
  const inner = text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : text;
  if (!inner || /[<>\s]/u.test(inner)) throw new Error(`${name} is invalid`);
  return `<${inner}>`;
}

function decodeBase64(value, name) {
  const text = String(value ?? '').replace(/\s+/gu, '');
  if (!text || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text) || text.length % 4 === 1) {
    throw new Error(`${name} is not valid base64`);
  }
  const content = Buffer.from(text, 'base64');
  if (!content.length) throw new Error(`${name} is empty`);
  return content;
}

function normalizeAttachments(value, limits) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > limits.maxAttachmentCount) {
    throw new Error('attachments is invalid');
  }

  let totalBytes = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`attachments[${index}] is invalid`);
    }
    const content = decodeBase64(item.contentBase64, `attachments[${index}].contentBase64`);
    if (content.length > limits.maxAttachmentBytes) {
      throw new Error(`attachments[${index}] exceeds the per-file limit`);
    }
    totalBytes += content.length;
    if (totalBytes > limits.maxTotalAttachmentBytes) {
      throw new Error('attachments exceed the total limit');
    }
    return {
      filename: sanitizeFileName(item.fileName, `attachment-${index + 1}`),
      contentType: assertPlainHeader(item.mimeType || 'application/octet-stream', `attachments[${index}].mimeType`, 200),
      content,
    };
  });
}

export function secureTokenEqual(provided, expected) {
  if (!provided || !expected) return false;
  const left = createHash('sha256').update(String(provided)).digest();
  const right = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(left, right);
}

export function normalizeSendRequest(input, config) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('JSON body is invalid');
  if (input.version !== 1) throw new Error('version must be 1');

  const requestId = String(input.requestId ?? '').trim();
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error('requestId is invalid');

  const to = normalizeAddressList(input.to, 'to', { required: true });
  const cc = normalizeAddressList(input.cc, 'cc').filter((address) => !to.includes(address));
  const recipientCount = new Set([...to, ...cc]).size;
  if (recipientCount > config.maxRecipients) throw new Error('too many recipients');

  const subject = assertPlainHeader(input.subject, 'subject', config.maxSubjectChars);
  const text = String(input.text ?? '');
  if (!text.trim() || text.length > config.maxBodyChars) throw new Error('text is invalid');

  const inReplyTo = normalizeMessageId(input.inReplyTo, 'inReplyTo');
  const referencesInput = input.references === undefined || input.references === null
    ? []
    : Array.isArray(input.references) ? input.references : [input.references];
  if (referencesInput.length > 50) throw new Error('too many references');
  const references = referencesInput.map((value, index) => normalizeMessageId(value, `references[${index}]`));
  const attachments = normalizeAttachments(input.attachments, config);

  const normalizedForDigest = {
    version: 1,
    requestId,
    to,
    cc,
    subject,
    text,
    inReplyTo: inReplyTo || null,
    references,
    attachments: attachments.map((item) => ({
      fileName: item.filename,
      mimeType: item.contentType,
      contentSha256: createHash('sha256').update(item.content).digest('hex'),
    })),
  };
  const digest = createHash('sha256').update(JSON.stringify(normalizedForDigest)).digest('hex');

  return {
    requestId,
    digest,
    recipientCount,
    attachmentCount: attachments.length,
    mail: {
      from: { name: config.fromName, address: config.fromAddress },
      to,
      cc,
      subject,
      text,
      inReplyTo,
      references: references.length ? references : undefined,
      attachments,
      envelope: { from: config.fromAddress, to: [...new Set([...to, ...cc])] },
    },
  };
}

export function publicSendResult(record, duplicate = false) {
  return {
    ok: record.status === 'sent',
    status: record.status,
    duplicate,
    requestId: record.requestId,
    messageId: record.messageId || null,
    sentAt: record.sentAt || null,
  };
}
