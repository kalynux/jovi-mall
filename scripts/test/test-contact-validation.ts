/**
 * Test: the platform-wide phone and email validation rules.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free: `core/validation/phone` and `core/validation/email` are
 * pure, and so are the Zod schemas built on them.
 *
 * This suite exists because the rules are now shared by ~15 request schemas
 * across every role, plus the outbound mail and WhatsApp boundaries — a
 * loosened regex would no longer fail in one obvious place, it would quietly
 * widen what the whole backend accepts. The last group is the important one:
 * it asserts that OPTIONALITY did not change anywhere, which is the property
 * this refactor most easily breaks.
 *
 * Run: npm run test:contact-validation
 */
import {
  ClearableEmailAddressSchema,
  EmailAddressSchema,
  isEmailAddress,
  normalizeEmailAddress,
  OptionalEmailAddressSchema,
  toEmailAddress,
} from '../../src/core/validation/email';
import {
  ClearablePhoneNumberSchema,
  isE164,
  normalizePhoneNumber,
  OptionalPhoneNumberSchema,
  PhoneNumberSchema,
  toE164,
} from '../../src/core/validation/phone';
import { RegisterSchema, LoginSchema } from '../../src/modules/auth/auth.schemas';
import { isPayoutMethodEnabled, PayoutDetailsZodSchema } from '../../src/core/types/payout.types';
import { PaymentChannelSchema } from '../../src/modules/payments/validators/payment.validators';
import { UpdateStoreProfileSchema } from '../../src/modules/store/validators/store.validator';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
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

/** True when the schema REJECTS the value — the assertion most of this file makes. */
function rejects(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown): boolean {
  return !schema.safeParse(value).success;
}

/** The parsed output, or a sentinel that can never equal an expected value. */
function output(schema: { safeParse: (v: unknown) => any }, value: unknown): unknown {
  const result = schema.safeParse(value);
  return result.success ? result.data : Symbol('rejected');
}

function main(): void {
  console.log('\n▶ Phone — E.164 is the whole rule');

  assert('a plain international number passes', () => isE164('+237670000000'));
  assert('the shortest real international number passes', () => isE164('+6834002'));
  assert('the longest legal number (15 digits) passes', () => isE164('+123456789012345'));

  assert('16 digits is past the E.164 ceiling', () => !isE164('+1234567890123456'));
  assert('a country code cannot start with 0', () => !isE164('+0237670000'));
  assert('no leading + is rejected', () => !isE164('237670000000'));
  assert('a national number is rejected, not guessed', () => !isE164('670000000'));
  assert('00-prefixed dialling is not E.164', () => !isE164('00237670000000'));
  assert('letters are rejected', () => !isE164('+23767OOOOOO'));
  assert('an empty string is rejected', () => !isE164(''));
  assert('a lone + is rejected', () => !isE164('+'));
  assert('an incomplete number is rejected', () => !isE164('+237'));

  console.log('\n▶ Phone — normalisation strips formatting and nothing else');

  assert('spaces are formatting', () => normalizePhoneNumber('+237 670 00 00 00') === '+237670000000');
  assert('dashes are formatting', () => normalizePhoneNumber('+1-555-010-9999') === '+15550109999');
  assert('parentheses and dots are formatting', () =>
    normalizePhoneNumber('+1 (555).010.9999') === '+15550109999');
  assert('a no-break space (pasted from a contact card) is formatting', () =>
    normalizePhoneNumber('+237 670 000 000') === '+237670000000');
  assert('normalisation never invents a country code', () =>
    normalizePhoneNumber('670 000 000') === '670000000');
  assert('an already-canonical number is unchanged', () =>
    normalizePhoneNumber('+237670000000') === '+237670000000');

  console.log('\n▶ Phone — the schema normalises on the way through');

  assert('a formatted number parses to canonical E.164', () =>
    PhoneNumberSchema.parse('  +237 (670) 00-00-00  ') === '+237670000000');
  assert('a national number is rejected by the schema', () => rejects(PhoneNumberSchema, '670000000'));
  assert('a non-string is rejected by the schema', () => rejects(PhoneNumberSchema, 237670000000));
  assert('null is rejected by the required schema', () => rejects(PhoneNumberSchema, null));
  assert('toE164 returns null rather than throwing on junk', () => toE164('not a number') === null);
  assert('toE164 handles a missing value', () => toE164(undefined) === null && toE164(null) === null);

  console.log('\n▶ Email — RFC-shaped, and deliverable-shaped');

  assert('an ordinary address passes', () => isEmailAddress('name@example.com'));
  assert('subdomains pass', () => isEmailAddress('name@mail.example.co.uk'));
  assert('atext specials in the local part pass', () => isEmailAddress("o'brien+tag_1@example.com"));
  assert('a hyphenated domain passes', () => isEmailAddress('name@my-shop.example'));

  assert('no domain dot / no TLD is rejected', () => !isEmailAddress('name@example'));
  assert('a bare host is rejected', () => !isEmailAddress('root@localhost'));
  assert('a numeric TLD is rejected', () => !isEmailAddress('name@example.123'));
  assert('a trailing dot is rejected', () => !isEmailAddress('name@example.com.'));
  assert('a leading dot in the local part is rejected', () => !isEmailAddress('.name@example.com'));
  assert('a trailing dot in the local part is rejected', () => !isEmailAddress('name.@example.com'));
  assert('consecutive dots are rejected', () => !isEmailAddress('na..me@example.com'));
  assert('a missing local part is rejected', () => !isEmailAddress('@example.com'));
  assert('a missing domain is rejected', () => !isEmailAddress('name@'));
  assert('no @ at all is rejected', () => !isEmailAddress('name.example.com'));
  assert('an internal space is rejected', () => !isEmailAddress('na me@example.com'));
  assert('a quoted local part is rejected (legal on paper, undeliverable here)', () =>
    !isEmailAddress('"john doe"@example.com'));
  assert('an IP-literal domain is rejected', () => !isEmailAddress('user@[192.168.0.1]'));
  assert('a domain label may not start with a hyphen', () => !isEmailAddress('name@-example.com'));

  console.log('\n▶ Email — RFC 5321 length limits');

  assert('a 64-character local part passes', () =>
    isEmailAddress(`${'a'.repeat(64)}@example.com`));
  assert('a 65-character local part is rejected', () =>
    !isEmailAddress(`${'a'.repeat(65)}@example.com`));
  assert('an address over 254 characters is rejected', () =>
    !isEmailAddress(`${'a'.repeat(60)}@${'b'.repeat(200)}.com`));

  console.log('\n▶ Email — normalisation is trim + lowercase (what the models already do)');

  assert('surrounding whitespace is stripped', () =>
    normalizeEmailAddress('  name@example.com \n') === 'name@example.com');
  assert('case is folded so "already registered" lookups work', () =>
    normalizeEmailAddress('Name@Example.COM') === 'name@example.com');
  assert('the schema emits the normalised value', () =>
    EmailAddressSchema.parse('  Name@Example.COM ') === 'name@example.com');
  assert('toEmailAddress returns null rather than throwing on junk', () =>
    toEmailAddress('name@example') === null);

  console.log('\n▶ Optionality is unchanged — an optional field stays optional');

  assert('optional phone: absent is fine', () => output(OptionalPhoneNumberSchema, undefined) === undefined);
  assert('optional phone: present must still be valid', () =>
    rejects(OptionalPhoneNumberSchema, '670000000'));
  assert('optional email: absent is fine', () => output(OptionalEmailAddressSchema, undefined) === undefined);
  assert('optional email: present must still be valid', () =>
    rejects(OptionalEmailAddressSchema, 'name@example'));

  assert('clearable phone: "" clears to null', () => output(ClearablePhoneNumberSchema, '') === null);
  assert('clearable phone: whitespace-only clears to null', () =>
    output(ClearablePhoneNumberSchema, '   ') === null);
  assert('clearable phone: null clears', () => output(ClearablePhoneNumberSchema, null) === null);
  assert('clearable phone: absent leaves unchanged', () =>
    output(ClearablePhoneNumberSchema, undefined) === undefined);
  assert('clearable phone: a real value must be valid E.164', () =>
    rejects(ClearablePhoneNumberSchema, '670000000'));
  assert('clearable email: "" clears to null', () => output(ClearableEmailAddressSchema, '') === null);
  assert('clearable email: a real value must be valid', () =>
    rejects(ClearableEmailAddressSchema, 'name@example'));

  console.log('\n▶ The rule reaches the real request schemas');

  assert('register: email stays optional', () =>
    RegisterSchema.safeParse({
      phone: '+237670000000',
      name: 'Ada',
      password: 'secret1',
    }).success);
  assert('register: a national phone is rejected', () =>
    rejects(RegisterSchema, { phone: '670000000', name: 'Ada', password: 'secret1' }));
  assert('register: a malformed optional email is rejected when supplied', () =>
    rejects(RegisterSchema, {
      phone: '+237670000000',
      email: 'ada@example',
      name: 'Ada',
      password: 'secret1',
    }));
  assert('register: phone and email are normalised for storage', () => {
    const parsed = RegisterSchema.parse({
      phone: '+237 670 00 00 00',
      email: '  Ada@Example.COM ',
      name: 'Ada',
      password: 'secret1',
    });
    return parsed.phone === '+237670000000' && parsed.email === 'ada@example.com';
  });

  assert('login: an email identifier is lowercased to match the stored row', () =>
    LoginSchema.parse({ identifier: 'Ada@Example.COM', password: 'x' }).identifier ===
    'ada@example.com');
  assert('login: a formatted phone identifier is canonicalised', () =>
    LoginSchema.parse({ identifier: '+237 670 00 00 00', password: 'x' }).identifier ===
    '+237670000000');
  assert('login: a malformed identifier is rejected', () =>
    rejects(LoginSchema, { identifier: 'not-an-identifier', password: 'x' }));

  assert('payout: a mobile-money number must be E.164', () =>
    rejects(PayoutDetailsZodSchema, [
      { method: 'mobile_money', mobile_money: { provider: 'MTN', phone_number: '670000000', account_name: 'Ada' } },
    ]));
  assert('payout: a valid mobile-money number is normalised', () => {
    const parsed = PayoutDetailsZodSchema.parse([
      {
        method: 'mobile_money',
        mobile_money: { provider: 'MTN', phone_number: '+237 670-00-00-00', account_name: 'Ada' },
      },
    ]);
    return parsed[0].mobile_money?.phone_number === '+237670000000';
  });
  /**
   * A bank entry carries no phone number at all, so the E.164 rule must not touch it.
   *
   * That used to be provable by asserting the whole schema ACCEPTS one — until
   * `ENABLED_PAYOUT_METHODS` became `['mobile_money']` (`core/types/payout.types.ts:180`),
   * at which point the schema started refusing bank entries on `method`, correctly and for
   * a reason that has nothing to do with phone numbers. The old assertion then failed while
   * the property it was written to protect was still true.
   *
   * So assert WHERE the refusal lands rather than that there is none, and read the current
   * setting rather than hardcoding it — the shape `test:payout-methods` already uses at
   * `:270-300`, so flipping a kind back on flips this test with it instead of failing it.
   * It is also a stronger assertion than the original: it proves the phone rule is absent
   * *and* that the switch is the only thing standing in the way.
   */
  const bankEnabled = isPayoutMethodEnabled('bank');
  assert(
    'payout: a bank entry is refused only by the SWITCH, never by the phone rule ' +
      `(switch says ${bankEnabled})`,
    () => {
      const result = PayoutDetailsZodSchema.safeParse([
        {
          method: 'bank',
          bank: { bank_name: 'B', account_number: '1', account_name: 'Ada', country: 'CM' },
        },
      ]);
      if (bankEnabled) return result.success;
      return (
        !result.success &&
        result.error.issues.length === 1 &&
        result.error.issues[0].path.join('.') === '0.method'
      );
    },
  );

  assert('payment channel: every field stays optional', () =>
    PaymentChannelSchema.safeParse({}).success);
  assert('payment channel: a supplied number must be E.164', () =>
    rejects(PaymentChannelSchema, { phoneNumber: '670000000' }));
  assert('payment channel: a supplied receipt email must be valid', () =>
    rejects(PaymentChannelSchema, { customerEmail: 'buyer@example' }));

  assert('store profile: support contacts are clearable and validated', () =>
    rejects(UpdateStoreProfileSchema, { supportPhone: '670000000', version: 0 }) &&
    rejects(UpdateStoreProfileSchema, { supportWhatsapp: '670000000', version: 0 }) &&
    rejects(UpdateStoreProfileSchema, { supportEmail: 'help@shop', version: 0 }) &&
    UpdateStoreProfileSchema.safeParse({ supportPhone: '', version: 0 }).success &&
    UpdateStoreProfileSchema.safeParse({ version: 0 }).success);

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
