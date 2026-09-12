import { serverSearchTerms } from './lib.mjs';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MESSAGE_ID_PATTERN = /^<[^<>\s]+>$/u;

function parseDateOnly(value, name) {
  const text = String(value ?? '').trim();
  if (!DATE_PATTERN.test(text)) throw new Error(`${name} must use YYYY-MM-DD`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`${name} is invalid`);
  }
  return date;
}

function normalizeTerms(value, config) {
  const input = value === undefined || value === null || value === ''
    ? []
    : Array.isArray(value) ? value : [value];
  if (input.length > config.maxTerms) throw new Error('too many terms');
  if (input.some((item) => typeof item !== 'string')) throw new Error('term is invalid');
  const terms = [...new Set(input.map((item) => item.trim()).filter(Boolean))];
  for (const term of terms) {
    if (term.length > config.maxTermChars || /[\u0000-\u001f\u007f]/u.test(term)) {
      throw new Error('term is invalid');
    }
  }
  return terms;
}

function normalizeMailbox(value, config) {
  const mailbox = String(value ?? '').trim();
  if (!config.allowedMailboxes.includes(mailbox)) throw new Error('mailbox is outside the allowlist');
  return mailbox;
}

function normalizeMessageId(value) {
  const text = String(value ?? '').trim();
  const normalized = text.startsWith('<') && text.endsWith('>') ? text : `<${text}>`;
  if (!MESSAGE_ID_PATTERN.test(normalized)) throw new Error('messageId is invalid');
  return normalized;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} is invalid`);
  return parsed;
}

export function normalizeQueryRequest(input, config, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('JSON body is invalid');
  if (input.version !== 1) throw new Error('version must be 1');
  const action = String(input.action ?? '').trim().toLowerCase();
  if (!['search', 'get', 'export'].includes(action)) throw new Error('action is invalid');

  if (action === 'search') {
    const rawMailboxes = input.mailboxes === undefined ? config.allowedMailboxes : input.mailboxes;
    if (!Array.isArray(rawMailboxes) || !rawMailboxes.length || rawMailboxes.length > config.allowedMailboxes.length) {
      throw new Error('mailboxes is invalid');
    }
    const mailboxes = [...new Set(rawMailboxes.map((mailbox) => normalizeMailbox(mailbox, config)))];
    const since = parseDateOnly(input.since, 'since');
    const before = input.before ? parseDateOnly(input.before, 'before') : undefined;
    if (before && before <= since) throw new Error('before must be after since');
    const terms = normalizeTerms(input.terms, config);
    const maxResultsPerMailbox = input.maxResultsPerMailbox === undefined
      ? config.defaultMaxResults
      : positiveInteger(input.maxResultsPerMailbox, 'maxResultsPerMailbox');
    if (maxResultsPerMailbox > config.maxResults) throw new Error('maxResultsPerMailbox exceeds the limit');

    const recentFloor = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - config.maxUnfilteredLookbackDays,
    ));
    if (!terms.length && since < recentFloor) {
      throw new Error('historical searches require at least one term');
    }
    return { version: 1, action, mailboxes, since, before, terms, maxResultsPerMailbox };
  }

  const mailbox = normalizeMailbox(input.mailbox, config);
  const uid = positiveInteger(input.uid, 'uid');
  const uidValidity = String(input.uidValidity ?? '').trim();
  if (!/^\d+$/u.test(uidValidity)) throw new Error('uidValidity is invalid');
  const messageId = normalizeMessageId(input.messageId);
  return { version: 1, action, mailbox, uid, uidValidity, messageId };
}

export function buildGatewaySearchQuery(request) {
  const query = { since: request.since };
  if (request.before) query.before = request.before;
  const terms = serverSearchTerms(request.terms);
  if (terms.length === 1) query.text = terms[0];
  else if (terms.length > 1) query.or = terms.map((term) => ({ text: term }));
  return query;
}

function publicAddresses(value) {
  return (value || []).map((entry) => ({
    name: String(entry.name || ''),
    address: String(entry.address || '').toLowerCase(),
  }));
}

export function publicEnvelope(message, mailbox, uidValidity) {
  const envelope = message.envelope || {};
  return {
    mailbox,
    uid: Number(message.uid),
    uidValidity: String(uidValidity),
    internalDate: message.internalDate instanceof Date ? message.internalDate.toISOString() : null,
    size: Number.isFinite(message.size) ? Number(message.size) : null,
    messageId: envelope.messageId || null,
    subject: envelope.subject || '',
    from: publicAddresses(envelope.from),
    to: publicAddresses(envelope.to),
    cc: publicAddresses(envelope.cc),
  };
}

export function messageIdMatches(actual, expected) {
  return String(actual ?? '').trim() === String(expected ?? '').trim();
}
