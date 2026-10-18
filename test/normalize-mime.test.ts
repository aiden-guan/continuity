// RFC 2047 encoded-words in headers. Seen live on 2026-10-18: Primitive stored the subjects of messages sent with a
// Cc still encoded (6 of 85 rows), split across two words, sometimes mid-character.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMimeWords, fromPrimitiveEmailDetail } from '../src/ingest/normalize.ts';

test('subjects Primitive stored encoded decode to what was sent', () => {
  assert.equal(decodeMimeWords('=?UTF-8?Q?Re=3A_RFQ=3A_500_x_AX-200_=E2=80=94_PO-4?=\n =?UTF-8?Q?817?='), 'Re: RFQ: 500 x AX-200 — PO-4817');
  assert.equal(decodeMimeWords('=?UTF-8?Q?Shipment_status_=E2=80=94_PO-4817_=28boo?= =?UTF-8?Q?king_FF-18606=29?='), 'Shipment status — PO-4817 (booking FF-18606)');
  assert.equal(decodeMimeWords('=?UTF-8?Q?RFQ=3A_500_x_AX-200_=E2=80=94_PO-4817?='), 'RFQ: 500 x AX-200 — PO-4817');
});

test('a character split across two encoded-words survives; base64, other charsets and plain text', () => {
  assert.equal(decodeMimeWords('=?UTF-8?Q?a_=E2=80?= =?UTF-8?Q?=94_b?='), 'a — b');
  assert.equal(decodeMimeWords(`=?utf-8?B?${Buffer.from('Angebot für Ihre Anfrage').toString('base64')}?=`), 'Angebot für Ihre Anfrage');
  assert.equal(decodeMimeWords('=?ISO-8859-1?Q?Caf=E9?= menu'), 'Café menu');
  assert.equal(decodeMimeWords('Re: =?UTF-8?Q?=E2=80=94?= done'), 'Re: — done');
  assert.equal(decodeMimeWords('Plain subject with =? in it'), 'Plain subject with =? in it');
  assert.equal(decodeMimeWords('=?x-unknown?Q?abc?='), 'abc');
});

test('ingestion decodes the subject and the display name, never the address', () => {
  const input = fromPrimitiveEmailDetail({
    id: 'em_1', subject: '=?UTF-8?Q?Re=3A_RFQ_=E2=80=94_PO-4?= =?UTF-8?Q?817?=', from_header: '=?UTF-8?Q?Dana_R=C3=BAiz?= <dana@x.example>',
    to_email: 'agent@y.example', received_at: '2026-10-18T03:30:00Z', parsed: {}, auth: {},
  });
  assert.equal(input.subject, 'Re: RFQ — PO-4817');
  assert.equal(input.from_name, 'Dana Rúiz');
  assert.equal(input.from, 'dana@x.example');
});
