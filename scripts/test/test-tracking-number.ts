/**
 * Test: shipment tracking-number generation.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free: the acronym derivation and the number format are pure —
 * only `TrackingNumberGenerator.generate` touches Mongo, and it is exercised
 * here only through the pieces it composes.
 *
 * Run: npm run test:tracking-number
 */
import {
  agencyAcronym,
  formatTrackingNumber,
  TRACKING_NUMBER_PATTERN,
} from '../../src/modules/shipments/utils/tracking-number.generator';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok = false;
  try {
    ok = fn();
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

function main(): void {
  console.log('\n▶ Agency acronym — the ownership segment');

  assert('3+ words → one initial each', () => agencyAcronym('FastShip Douala Express') === 'FDE');
  assert('more than 3 words → only the first three', () =>
    agencyAcronym('Union Des Transporteurs Rapides Du Littoral') === 'UDT');
  assert('2 words → initial + first two of the second', () =>
    agencyAcronym('FastShip Douala') === 'FDO');
  assert('1 word → its first three letters', () => agencyAcronym('Jovilog') === 'JOV');
  assert('diacritics folded, not treated as separators', () =>
    agencyAcronym('Sécurité Livraison') === 'SLI');
  // Digits survive the filter — "Trans 24 Express" is a real kind of name and
  // the 24 is the distinguishing part of it.
  assert('digits are part of a name', () => agencyAcronym('Trans 24 Express') === 'T2E');
  assert('digits survive the two-word rule too', () => agencyAcronym('Express 24') === 'E24');
  assert('punctuation is a separator, never a character', () =>
    agencyAcronym('Go-Fast & Sons') === 'GFS');
  assert('short result is padded to 3', () => agencyAcronym('A B') === 'ABX');
  assert('single short word is padded to 3', () => agencyAcronym('Go') === 'GOX');

  console.log('\n▶ Acronym — degenerate input never throws and never leaks');

  assert('no Latin characters → generic prefix', () => agencyAcronym('四海快递') === 'AGY');
  assert('empty name → generic prefix', () => agencyAcronym('') === 'AGY');
  assert('whitespace only → generic prefix', () => agencyAcronym('   ') === 'AGY');
  assert('null (no magazin provisioned) → generic prefix', () => agencyAcronym(null) === 'AGY');
  assert('undefined → generic prefix', () => agencyAcronym(undefined) === 'AGY');
  assert('always exactly 3 characters', () =>
    ['FastShip Douala Express', 'Jovilog', 'A B', '四海快递', '', null].every(
      (name) => agencyAcronym(name).length === 3
    ));

  console.log('\n▶ Acronym — deterministic (the number must stay recognisable)');

  assert('same name → same acronym', () =>
    agencyAcronym('FastShip Douala') === agencyAcronym('FastShip Douala'));
  assert('case-insensitive', () => agencyAcronym('fastship douala') === agencyAcronym('FASTSHIP DOUALA'));

  console.log('\n▶ Number format — ACR-YYMMDD-HHMMSS-XXXXX');

  // 2026-07-30T14:23:09Z — asserted in UTC on purpose: the format is UTC so the
  // same shipment reads the same in Douala and in Lisbon.
  const at = new Date(Date.UTC(2026, 6, 30, 14, 23, 9));

  assert('carries the acronym, date and time', () =>
    formatTrackingNumber('FDO', at).startsWith('FDO-260730-142309-'));
  assert('matches the exported pattern', () =>
    TRACKING_NUMBER_PATTERN.test(formatTrackingNumber('FDO', at)));
  assert('total length is 23', () => formatTrackingNumber('FDO', at).length === 23);
  assert('month and day are zero-padded', () =>
    formatTrackingNumber('FDO', new Date(Date.UTC(2026, 0, 5, 3, 4, 5))).startsWith('FDO-260105-030405-'));
  assert('a generic-prefix number is still well-formed', () =>
    TRACKING_NUMBER_PATTERN.test(formatTrackingNumber(agencyAcronym(null), at)));

  console.log('\n▶ Uniqueness — the random suffix');

  const numbers = new Set<string>();
  for (let i = 0; i < 2000; i++) numbers.add(formatTrackingNumber('FDO', at));
  assert('2000 draws in the same second collide at most once', () => numbers.size >= 1999);
  assert('every draw is well-formed', () =>
    [...numbers].every((n) => TRACKING_NUMBER_PATTERN.test(n)));
  // I/L/O/U are excluded so nobody has to guess whether a label says 1 or I.
  assert('suffix never uses the ambiguous letters I, L, O, U', () =>
    [...numbers].every((n) => !/[ILOU]/.test(n.split('-')[3])));

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
