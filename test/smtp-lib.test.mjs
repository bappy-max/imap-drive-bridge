import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSendRequest, publicSendResult, secureTokenEqual } from '../src/smtp-lib.mjs';

const config = {
  fromName: 'Cabinet Hemmès',
  fromAddress: 'baptiste.cadosch@cabinethemmes.com',
  maxRecipients: 10,
  maxSubjectChars: 200,
  maxBodyChars: 50_000,
  maxAttachmentCount: 10,
  maxAttachmentBytes: 8 * 1024 * 1024,
  maxTotalAttachmentBytes: 12 * 1024 * 1024,
};

test('normalizes a text reply while keeping the sender fixed', () => {
  const result = normalizeSendRequest({
    version: 1,
    requestId: 'dock-test-0001',
    to: ['Client@Example.com'],
    subject: 'Re: Pièces du dossier',
    text: 'Bonjour,\n\nVoici notre réponse.\n',
    inReplyTo: 'original@example.com',
    references: ['first@example.com', '<original@example.com>'],
  }, config);

  assert.deepEqual(result.mail.from, {
    name: 'Cabinet Hemmès',
    address: 'baptiste.cadosch@cabinethemmes.com',
  });
  assert.deepEqual(result.mail.to, ['client@example.com']);
  assert.equal(result.mail.inReplyTo, '<original@example.com>');
  assert.deepEqual(result.mail.references, ['<first@example.com>', '<original@example.com>']);
  assert.equal(result.mail.text, 'Bonjour,\n\nVoici notre réponse.\n');
  assert.equal(result.recipientCount, 1);
});

test('rejects header injection and excessive recipient counts', () => {
  assert.throws(() => normalizeSendRequest({
    version: 1,
    requestId: 'dock-test-0002',
    to: ['client@example.com'],
    subject: 'Sujet\r\nBcc: attacker@example.com',
    text: 'Test',
  }, config), /subject is invalid/);

  assert.throws(() => normalizeSendRequest({
    version: 1,
    requestId: 'dock-test-0003',
    to: Array.from({ length: 11 }, (_, index) => `client${index}@example.com`),
    subject: 'Sujet',
    text: 'Test',
  }, config), /too many recipients/);
});

test('accepts bounded attachments and hashes content into the request digest', () => {
  const first = normalizeSendRequest({
    version: 1,
    requestId: 'dock-test-0004',
    to: 'client@example.com',
    subject: 'Document',
    text: 'Pièce jointe.',
    attachments: [{ fileName: '../devis:final.pdf', mimeType: 'application/pdf', contentBase64: 'dGVzdA==' }],
  }, config);
  const second = normalizeSendRequest({
    version: 1,
    requestId: 'dock-test-0004',
    to: 'client@example.com',
    subject: 'Document',
    text: 'Pièce jointe.',
    attachments: [{ fileName: '../devis:final.pdf', mimeType: 'application/pdf', contentBase64: 'YXV0cmU=' }],
  }, config);

  assert.equal(first.mail.attachments[0].filename, '..-devis-final.pdf');
  assert.notEqual(first.digest, second.digest);
});

test('compares gateway tokens without exposing their length or value', () => {
  assert.equal(secureTokenEqual('same-token', 'same-token'), true);
  assert.equal(secureTokenEqual('wrong', 'same-token'), false);
  assert.equal(secureTokenEqual('', 'same-token'), false);
});

test('reports SMTP delivery and sent-folder archival independently', () => {
  assert.deepEqual(publicSendResult({
    status: 'sent',
    archiveStatus: 'failed',
    requestId: 'dock-test-0005',
    messageId: '<message@example.com>',
    sentAt: '2026-09-12T18:00:00.000Z',
  }), {
    ok: true,
    status: 'sent',
    archiveStatus: 'failed',
    duplicate: false,
    requestId: 'dock-test-0005',
    messageId: '<message@example.com>',
    sentAt: '2026-09-12T18:00:00.000Z',
  });
});
