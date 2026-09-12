import { createHash } from 'node:crypto';

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

export function parsePositiveInt(value, fallback, name) {
  const parsed = value === undefined || value === '' ? fallback : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseTerms(value) {
  const terms = String(value ?? '')
    .split('|')
    .map((term) => term.trim())
    .filter(Boolean);
  return [...new Set(terms)];
}

export function normalizeForMatch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr-FR');
}

export function serverSearchTerms(terms) {
  const expanded = [];
  for (const term of terms) {
    expanded.push(term);
    const ascii = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (ascii !== term) expanded.push(ascii);
  }
  return [...new Set(expanded)];
}

export function buildSearchQuery(terms, since) {
  const expanded = serverSearchTerms(terms);
  if (!expanded.length) throw new Error('At least one filter term is required');

  const query = { since };
  if (expanded.length === 1) query.text = expanded[0];
  else query.or = expanded.map((term) => ({ text: term }));
  return query;
}

export function sanitizeFileName(value, fallback = 'file') {
  const sanitized = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return sanitized || fallback;
}

export function stableId(...parts) {
  return createHash('sha256').update(parts.map(String).join('\u001f')).digest('hex');
}

export function detectSentMailbox(mailboxes) {
  const bySpecialUse = mailboxes.find((box) => String(box.specialUse ?? '').toLowerCase() === '\\sent');
  if (bySpecialUse) return bySpecialUse.path;

  const candidates = new Set([
    'sent',
    'sent items',
    'sent messages',
    'envoyes',
    'elements envoyes',
    'messages envoyes',
  ]);
  return mailboxes.find((box) => candidates.has(normalizeForMatch(box.path)))?.path;
}

export function mailboxDirection(mailbox, sentMailbox) {
  return mailbox === sentMailbox ? 'envoye' : 'recu';
}

function addressText(addressObject) {
  return (addressObject?.value ?? [])
    .map((entry) => [entry.name, entry.address].filter(Boolean).join(' <').replace(/<([^>]*)$/, '<$1>'))
    .join(', ');
}

export function parsedMessageMatches(parsed, terms) {
  const haystack = normalizeForMatch([
    parsed.subject,
    addressText(parsed.from),
    addressText(parsed.to),
    addressText(parsed.cc),
    parsed.text,
    parsed.html,
  ].filter(Boolean).join('\n'));
  return terms.some((term) => haystack.includes(normalizeForMatch(term)));
}

export function makeMessageMarkdown({ parsed, mailbox, direction, exportedAttachments, skippedAttachments }) {
  const receivedAt = parsed.date instanceof Date && !Number.isNaN(parsed.date.valueOf())
    ? parsed.date.toISOString()
    : 'NON VÉRIFIÉ';
  const lines = [
    '# Message IONOS — dossier autorisé',
    '',
    `- Direction : ${direction}`,
    `- Dossier IONOS : ${mailbox}`,
    `- Date : ${receivedAt}`,
    `- De : ${addressText(parsed.from) || 'NON VÉRIFIÉ'}`,
    `- À : ${addressText(parsed.to) || 'NON VÉRIFIÉ'}`,
    `- Cc : ${addressText(parsed.cc) || '—'}`,
    `- Objet : ${parsed.subject || '(sans objet)'}`,
    `- Message-ID : ${parsed.messageId || 'NON VÉRIFIÉ'}`,
    '',
    '## Contenu',
    '',
    parsed.text?.trim() || '(aucun contenu texte exploitable)',
    '',
    '## Pièces jointes',
    '',
  ];

  if (!exportedAttachments.length && !skippedAttachments.length) lines.push('- Aucune');
  for (const item of exportedAttachments) lines.push(`- Exportée : ${item.fileName}`);
  for (const item of skippedAttachments) lines.push(`- Non exportée (${item.reason}) : ${item.fileName}`);
  lines.push('');
  return lines.join('\n');
}
