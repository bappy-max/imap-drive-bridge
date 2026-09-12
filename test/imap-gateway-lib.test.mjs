import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGatewaySearchQuery, messageIdMatches, normalizeQueryRequest, publicEnvelope } from '../src/imap-gateway-lib.mjs';

const config = {
  allowedMailboxes: ['INBOX', 'Objets envoyés'],
  defaultMaxResults: 20,
  maxResults: 50,
  maxTerms: 10,
  maxTermChars: 200,
  maxUnfilteredLookbackDays: 31,
};
const now = new Date('2026-09-12T18:00:00.000Z');

test('allows a bounded unfiltered recent search', () => {
  const value = normalizeQueryRequest({
    version: 1,
    action: 'search',
    since: '2026-09-01',
    maxResultsPerMailbox: 10,
  }, config, now);
  assert.deepEqual(value.mailboxes, ['INBOX', 'Objets envoyés']);
  assert.deepEqual(value.terms, []);
  assert.equal(value.maxResultsPerMailbox, 10);
  assert.deepEqual(buildGatewaySearchQuery(value), { since: new Date('2026-09-01T00:00:00.000Z') });
});

test('requires terms for historical searches and bounds result counts', () => {
  assert.throws(() => normalizeQueryRequest({
    version: 1,
    action: 'search',
    since: '2020-01-01',
  }, config, now), /historical searches require/);
  assert.throws(() => normalizeQueryRequest({
    version: 1,
    action: 'search',
    since: '2026-09-01',
    maxResultsPerMailbox: 51,
  }, config, now), /exceeds the limit/);
  assert.throws(() => normalizeQueryRequest({
    version: 1,
    action: 'search',
    since: '2026-09-01',
    terms: [{ text: 'not accepted' }],
  }, config, now), /term is invalid/);
});

test('allows a targeted historical search and expands accents', () => {
  const value = normalizeQueryRequest({
    version: 1,
    action: 'search',
    mailboxes: ['Objets envoyés'],
    since: '2020-01-01',
    before: '2026-09-13',
    terms: ['Épinettes'],
  }, config, now);
  assert.deepEqual(buildGatewaySearchQuery(value), {
    since: new Date('2020-01-01T00:00:00.000Z'),
    before: new Date('2026-09-13T00:00:00.000Z'),
    or: [{ text: 'Épinettes' }, { text: 'Epinettes' }],
  });
});

test('rejects mailboxes outside the two-folder allowlist', () => {
  assert.throws(() => normalizeQueryRequest({
    version: 1,
    action: 'search',
    mailboxes: ['Archives'],
    since: '2026-09-01',
  }, config, now), /outside the allowlist/);
});

test('binds get and export to uid validity and message id', () => {
  const get = normalizeQueryRequest({
    version: 1,
    action: 'get',
    mailbox: 'INBOX',
    uid: 42,
    uidValidity: '123456',
    messageId: 'message@example.com',
  }, config, now);
  assert.equal(get.messageId, '<message@example.com>');
  assert.equal(messageIdMatches('<message@example.com>', get.messageId), true);
  assert.equal(messageIdMatches('<MESSAGE@example.com>', get.messageId), false);
  assert.throws(() => normalizeQueryRequest({
    version: 1,
    action: 'export',
    mailbox: 'INBOX',
    uid: 42,
    uidValidity: 'bad',
    messageId: '<message@example.com>',
  }, config, now), /uidValidity/);
});

test('returns a minimal envelope without message content', () => {
  const result = publicEnvelope({
    uid: 9,
    internalDate: new Date('2026-09-12T12:00:00.000Z'),
    size: 1234,
    envelope: {
      messageId: '<id@example.com>',
      subject: 'Test',
      from: [{ name: 'Alice', address: 'ALICE@example.com' }],
      to: [{ address: 'bob@example.com' }],
      cc: [],
    },
  }, 'INBOX', '77');
  assert.equal(result.uid, 9);
  assert.equal(result.uidValidity, '77');
  assert.equal(result.size, 1234);
  assert.equal(result.from[0].address, 'alice@example.com');
  assert.equal(Object.hasOwn(result, 'text'), false);
});
