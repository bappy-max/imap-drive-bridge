import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSearchQuery,
  detectSentMailbox,
  mailboxDirection,
  parseTerms,
  parsedMessageMatches,
  sanitizeFileName,
  stableId,
} from '../src/lib.mjs';

test('parseTerms trims and deduplicates a narrow allowlist', () => {
  assert.deepEqual(parseTerms('Choisy | Épinettes | Choisy'), ['Choisy', 'Épinettes']);
});

test('buildSearchQuery adds an ASCII variant for accented terms', () => {
  const query = buildSearchQuery(['Épinettes'], new Date('2026-01-01T00:00:00Z'));
  assert.deepEqual(query.or, [{ text: 'Épinettes' }, { text: 'Epinettes' }]);
});

test('detectSentMailbox prefers the IMAP special-use flag', () => {
  const boxes = [
    { path: 'INBOX' },
    { path: 'Messages envoyés', specialUse: '\\Sent' },
    { path: 'Sent' },
  ];
  assert.equal(detectSentMailbox(boxes), 'Messages envoyés');
  assert.equal(mailboxDirection('Messages envoyés', 'Messages envoyés'), 'envoye');
});

test('parsed message matching is case- and accent-insensitive', () => {
  const parsed = { subject: 'Dossier EPINETTES', text: 'Suivi du chantier' };
  assert.equal(parsedMessageMatches(parsed, ['Épinettes']), true);
  assert.equal(parsedMessageMatches(parsed, ['Bordeaux']), false);
});

test('filenames are safe and identifiers are stable', () => {
  assert.equal(sanitizeFileName('../devis:final?.pdf'), '..-devis-final-.pdf');
  assert.equal(stableId('a', 'b'), stableId('a', 'b'));
  assert.notEqual(stableId('a', 'b'), stableId('ab'));
});
