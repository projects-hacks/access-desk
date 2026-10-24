import assert from 'node:assert/strict';
import { test } from 'node:test';
import { achCollection, achReturn, analysisFee, invoiceRemittance, wireIn, wireOut } from './format';
import { extractRefs, parseBankText } from './parse';

const chase = { name: 'JPMORGAN CHASE BANK NA', id: '021000021' };

test('references in every style payers use', () => {
  const cases: Array<[string, string[]]> = [
    ['INV1050 INV1051 INV1052', ['INV-1050', 'INV-1051', 'INV-1052']],
    ['INV-1050/1051/1052', ['INV-1050', 'INV-1051', 'INV-1052']],
    ['INVOICES 1050, 1051 & 1052', ['INV-1050', 'INV-1051', 'INV-1052']],
    ['PMT INV 1050-1052', ['INV-1050', 'INV-1051', 'INV-1052']],
    ['/INV/1802 1803/RFB/JAN26 FEES', ['INV-1802', 'INV-1803']],
    ['ORG90229 CATCH UP DEC JAN', ['ORG-90229']],
    ['REF ORG-90412 PER WIRE INSTRUCTIONS', ['ORG-90412']],
    ['LN-2140 PRINCIPAL REPAYMENT', ['LN-2140']],
    ['REFUND DUPLICATE PMT WI-5404', ['WI-5404']],
    ['JAN 2026 CUSTODY AND TRADING FEES - THANK YOU', []],
  ];
  for (const [text, refs] of cases) assert.deepEqual(extractRefs(text).refs, refs, text);
});

test('typos in invoice numbers are repaired and flagged', () => {
  const r = extractRefs('INV1O50 INV1051 INV1O52');
  assert.deepEqual(r.refs, ['INV-1050', 'INV-1051', 'INV-1052']);
  assert.equal(r.repaired, true);
  assert.deepEqual(extractRefs('INVOICES I776, 1777 & 1778').refs, ['INV-1776', 'INV-1777', 'INV-1778']);
  assert.equal(extractRefs('INVOICES 1776, 1777 & 1778').repaired, false);
});

test('formats round-trip through the parser', () => {
  const fed = parseBankText(wireIn({ trn: 'WI-5419', date: '2026-03-03', orig: 'Meridian Flow Partners LLC', origAccount: '5024543000011214', bank: chase, remittance: invoiceRemittance(['INV-1050', 'INV-1051'], 'words') }));
  assert.equal(fed.category, 'wire_in');
  assert.equal(fed.network, 'FEDWIRE');
  assert.equal(fed.bankRef, 'WI-5419');
  assert.equal(fed.counterpartyName, 'MERIDIAN FLOW PARTNERS LLC');
  assert.equal(fed.counterpartyAccount, '5024543000011214');
  assert.deepEqual(fed.refs, ['INV-1050', 'INV-1051']);

  const swift = parseBankText(wireIn({
    trn: 'WI-5418', date: '2026-03-03', orig: 'Ostrava Digital Assets LP', origAccount: '7999884381845054',
    bank: { name: 'CESKA SPORITELNA AS', id: 'GIBACZPX' }, remittance: '/INV/1802 1803/RFB/JAN26',
    international: { uetr: '0d1c2b3a-1111-4222-8333-444455556666', instructedCents: 4_052_000, chargeBearer: 'SHA', chargesCents: 2500 },
  }));
  assert.equal(swift.network, 'SWIFT');
  assert.equal(swift.instructedCents, 4_052_000);
  assert.equal(swift.chargesCents, 2500);
  assert.equal(swift.chargeBearer, 'SHA');

  const ach = parseBankText(achCollection({ trace: 'AC-7101', company: 'Quillon Systems Inc', account: '1234', individualId: 'ORG90689', addenda: 'INV-1769 JAN API USAGE' }));
  assert.deepEqual([ach.category, ach.bankRef, ach.refs[0]], ['ach_collection', 'AC-7101', 'INV-1769']);

  const ret = parseBankText(achReturn({ trace: 'AC-7102', originalTrace: 'AC-7101', code: 'R01', reason: 'Insufficient funds', company: 'Quillon Systems Inc', account: '1234' }));
  assert.deepEqual([ret.category, ret.returnCode, ret.reverses], ['ach_return', 'R01', 'AC-7101']);

  const fee = parseBankText(analysisFee({ trn: 'BF-2026-02', period: '2026-02', wires: 8, perWireCents: 1500 }));
  assert.deepEqual([fee.category, fee.bankRef], ['fee', 'BF-2026-02']);

  const out = parseBankText(wireOut({ trn: 'WI-5401', date: '2026-02-09', beneficiary: 'Halcyon Capital LLC', account: '99', bank: chase, remittance: 'LN-2201 DRAWDOWN' }));
  assert.deepEqual([out.category, out.counterpartyName, out.refs[0]], ['wire_out', 'HALCYON CAPITAL LLC', 'LN-2201']);
});

test('names are cut to 35 characters and unknown formats are flagged, not guessed', () => {
  const long = parseBankText(wireIn({ trn: 'WI-1', date: '2026-03-03', orig: 'Harbor and Pine Treasury Incorporated Holdings', origAccount: '1', bank: chase, remittance: '' }));
  assert.ok(long.counterpartyName!.length <= 35);
  const odd = parseBankText('DEPOSIT 12345 MISC');
  assert.equal(odd.category, 'unknown');
  assert.equal(odd.confidence, 0);
});
