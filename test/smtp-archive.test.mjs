import assert from 'node:assert/strict';
import test from 'node:test';
import { simpleParser } from 'mailparser';
import { appendSentCopy, compileMessage, createMessageCompiler } from '../src/smtp-archive.mjs';

test('compiles a reply once with stable thread headers and body', async () => {
  const compiler = createMessageCompiler();
  const compiled = await compileMessage(compiler, {
    from: { name: 'Cabinet Hemmès', address: 'baptiste.cadosch@cabinethemmes.com' },
    to: ['client@example.com'],
    subject: 'Re: Dossier',
    text: 'Réponse contrôlée.',
    inReplyTo: '<original@example.com>',
    references: ['<first@example.com>', '<original@example.com>'],
    envelope: {
      from: 'baptiste.cadosch@cabinethemmes.com',
      to: ['client@example.com'],
    },
  }, {
    messageId: '<stable@cabinethemmes.com>',
    sentAt: '2026-09-12T18:00:00.000Z',
  });

  const raw = compiled.raw.toString('utf8');
  assert.equal(compiled.messageId, '<stable@cabinethemmes.com>');
  assert.match(raw, /Message-ID: <stable@cabinethemmes\.com>/i);
  assert.match(raw, /In-Reply-To: <original@example\.com>/i);
  assert.match(raw, /References: <first@example\.com> <original@example\.com>/i);
  const parsed = await simpleParser(compiled.raw);
  assert.equal(parsed.text?.trim(), 'Réponse contrôlée.');
});

test('archives one sent copy after checking the Message-ID', async () => {
  const calls = [];
  const client = {
    usable: true,
    async connect() { calls.push(['connect']); },
    async mailboxOpen(path, options) { calls.push(['mailboxOpen', path, options]); },
    async search(query, options) { calls.push(['search', query, options]); return []; },
    async append(path, raw, flags, date) {
      calls.push(['append', path, raw, flags, date]);
      return { uid: 400 };
    },
    async logout() { calls.push(['logout']); },
  };

  const raw = Buffer.from('Message-ID: <new@example.com>\r\n\r\nTest');
  const result = await appendSentCopy({ sentMailbox: 'Objets envoyés' }, raw,
    '<new@example.com>', '2026-09-12T18:00:00.000Z', () => client);

  assert.deepEqual(result, { alreadyPresent: false });
  assert.deepEqual(calls[1], ['mailboxOpen', 'Objets envoyés', { readOnly: true }]);
  assert.deepEqual(calls[2], [
    'search',
    { header: { 'message-id': '<new@example.com>' } },
    { uid: true },
  ]);
  assert.equal(calls[3][0], 'append');
  assert.equal(calls[3][1], 'Objets envoyés');
  assert.equal(calls[3][2], raw);
  assert.deepEqual(calls[3][3], ['\\Seen']);
  assert.equal(calls[3][4].toISOString(), '2026-09-12T18:00:00.000Z');
  assert.deepEqual(calls[4], ['logout']);
});

test('does not append a duplicate Message-ID', async () => {
  let appended = false;
  let loggedOut = false;
  const client = {
    usable: true,
    async connect() {},
    async mailboxOpen() {},
    async search() { return [399]; },
    async append() { appended = true; },
    async logout() { loggedOut = true; },
  };

  const result = await appendSentCopy({ sentMailbox: 'Objets envoyés' }, Buffer.from('test'),
    '<existing@example.com>', '2026-09-12T18:00:00.000Z', () => client);

  assert.deepEqual(result, { alreadyPresent: true });
  assert.equal(appended, false);
  assert.equal(loggedOut, true);
});
