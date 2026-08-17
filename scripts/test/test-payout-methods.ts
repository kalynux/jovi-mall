/**
 * Test: the shared payout-method contract — mobile money, bank, and card.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free: `PayoutDetailsZodSchema` and `maskPayoutMethods` are pure,
 * and every payout owner (vendor, agency, agent) plus the PayoutRequest snapshot
 * goes through exactly these two — so one file covers all four surfaces.
 *
 * **Two schemas, two sections.** `PayoutMethodShapeZodSchema` is what a payout
 * method *is* and knows all three kinds; `PayoutMethodZodSchema` is that plus
 * `ENABLED_PAYOUT_METHODS`, and is what requests are parsed with. Bank and card
 * are switched OFF at the time of writing, so the shape sections keep their
 * rules under test while the gate section proves they are refused today. A rule
 * nothing exercises is a rule that rots — and these come back on eventually.
 *
 * The card section is the point of the file. A card payout destination holds no
 * PAN and no CVV by design (see the header on `CardSubSchema`), and the rules
 * that keep it that way are only rules if something fails when they break:
 * forbidden fields must be REFUSED rather than silently stripped, and no field
 * the client invents may reach the transform's output.
 *
 * Run: npm run test:payout-methods
 */
import {
    ENABLED_PAYOUT_METHODS,
    formatMaskedCardNumber,
    isCardExpired,
    isPayoutMethodEnabled,
    maskPayoutMethods,
    PayoutDetailsZodSchema,
    PayoutMethodShapeZodSchema,
    PayoutMethodZodSchema,
    IPayoutMethod,
} from '../../src/core/types/payout.types';
import { toAdminPayoutRequestDto } from '../../src/modules/earnings/dto/admin-payout-request.dto';

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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date();
const FUTURE_YEAR = NOW.getUTCFullYear() + 3;
const PAST_YEAR = NOW.getUTCFullYear() - 1;

const momo = (overrides: Record<string, unknown> = {}) => ({
    method: 'mobile_money',
    mobile_money: {
        provider: 'MTN Mobile Money',
        phone_number: '+237670000000',
        account_name: 'Tech Solutions Sarl',
        ...overrides,
    },
});

const bank = (overrides: Record<string, unknown> = {}) => ({
    method: 'bank',
    bank: {
        bank_name: 'Afriland First Bank',
        account_number: '10005000123456789',
        account_name: 'Tech Solutions Sarl',
        country: 'CM',
        ...overrides,
    },
});

const card = (overrides: Record<string, unknown> = {}) => ({
    method: 'card',
    card: {
        brand: 'visa',
        last4: '4242',
        card_holder_name: 'JEAN DUPONT',
        expiry_month: 8,
        expiry_year: FUTURE_YEAR,
        country: 'CM',
        ...overrides,
    },
});

/**
 * Parse against the SHAPE — all three kinds, switch bypassed. Returns null
 * instead of throwing so asserts stay flat.
 */
function parse(input: unknown): ReturnType<typeof PayoutMethodShapeZodSchema.parse> | null {
    const result = PayoutMethodShapeZodSchema.safeParse(input);
    return result.success ? result.data : null;
}

function issuePaths(input: unknown): string[] {
    const result = PayoutMethodShapeZodSchema.safeParse(input);
    if (result.success) return [];
    return result.error.issues.map((i) => i.path.join('.'));
}

/** Parse the way a REQUEST is parsed — switch included. */
function parseRequest(input: unknown): boolean {
    return PayoutMethodZodSchema.safeParse(input).success;
}

function requestIssues(input: unknown): Array<{ path: string; message: string }> {
    const result = PayoutMethodZodSchema.safeParse(input);
    if (result.success) return [];
    return result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

function main(): void {
    console.log('\n=== Payout methods (mobile money · bank · card) ===\n');
    console.log(`   enabled right now: ${ENABLED_PAYOUT_METHODS.join(', ')}\n`);

    // ─── Shape: the two pre-existing branches are untouched ──────────────────

    console.log('— existing branches (shape) —');

    assert('mobile_money still validates', () => parse(momo())?.method === 'mobile_money');

    assert('bank still validates', () => parse(bank())?.method === 'bank');

    assert('mobile_money nulls the bank AND card branches', () => {
        const parsed = parse(momo());
        return parsed?.bank === null && parsed?.card === null;
    });

    assert('bank nulls the mobile_money AND card branches', () => {
        const parsed = parse(bank());
        return parsed?.mobile_money === null && parsed?.card === null;
    });

    assert('an unknown method is refused', () => parse({ method: 'crypto' }) === null);

    // `.trim()` used to run AFTER `.min(1)`, so "   " validated and stored blank.
    assert('a whitespace-only bank name is refused, not stored blank', () => {
        return parse({ ...bank(), bank: { ...bank().bank, bank_name: '   ' } }) === null;
    });

    assert('a whitespace-only mobile-money account name is refused', () => {
        return parse({ ...momo(), mobile_money: { ...momo().mobile_money, account_name: ' ' } }) === null;
    });

    // ─── Card: the happy path (shape) ───────────────────────────────────────

    console.log('\n— card: accepted (shape) —');

    assert('a card destination validates', () => parse(card())?.method === 'card');

    assert('card nulls the mobile_money AND bank branches', () => {
        const parsed = parse(card());
        return parsed?.mobile_money === null && parsed?.bank === null;
    });

    assert('optional card fields default to null, never undefined', () => {
        const parsed = parse(card());
        return (
            parsed?.card?.issuing_bank === null &&
            parsed?.card?.gateway_provider === null &&
            parsed?.card?.gateway_token === null
        );
    });

    assert('a gateway token is carried through when supplied', () => {
        const parsed = parse(
            card({ gateway_provider: 'stripe', gateway_token: 'card_1PxyzABC' })
        );
        return parsed?.card?.gateway_token === 'card_1PxyzABC';
    });

    assert('brand is case-insensitive: "VISA" normalises to "visa"', () => {
        return parse(card({ brand: 'VISA' }))?.card?.brand === 'visa';
    });

    assert('brand tolerates surrounding whitespace', () => {
        return parse(card({ brand: '  Mastercard ' }))?.card?.brand === 'mastercard';
    });

    assert('an off-vocabulary brand is refused', () => parse(card({ brand: 'joviCard' })) === null);

    // ─── Card: the refusals that make the design real ────────────────────────

    console.log('\n— card: refused (shape) —');

    assert('a full PAN in `number` is REFUSED, not silently stripped', () => {
        return issuePaths(card({ number: '4242424242424242' })).includes('card.number');
    });

    assert('`card_number` is refused', () => {
        return issuePaths(card({ card_number: '4242424242424242' })).includes('card.card_number');
    });

    assert('`pan` is refused', () => issuePaths(card({ pan: '4242424242424242' })).includes('card.pan'));

    assert('a CVV is refused', () => issuePaths(card({ cvv: '123' })).includes('card.cvv'));

    assert('`cvc` and `security_code` are refused too', () => {
        const paths = issuePaths(card({ cvc: '123', security_code: '456' }));
        return paths.includes('card.cvc') && paths.includes('card.security_code');
    });

    assert('a harmless unknown field is accepted but never reaches the output', () => {
        const parsed = parse(card({ nickname: 'my payout card' }));
        return parsed !== null && !('nickname' in (parsed.card as object));
    });

    assert('last4 must be exactly 4 digits', () => {
        return parse(card({ last4: '424' })) === null && parse(card({ last4: '42x2' })) === null;
    });

    assert('an expired card is refused', () => {
        return parse(card({ expiry_month: 1, expiry_year: PAST_YEAR })) === null;
    });

    assert('a card expiring this month is still accepted', () => {
        return (
            parse(
                card({ expiry_month: NOW.getUTCMonth() + 1, expiry_year: NOW.getUTCFullYear() })
            ) !== null
        );
    });

    assert('expiry_month is bounded to 1–12', () => {
        return parse(card({ expiry_month: 0 })) === null && parse(card({ expiry_month: 13 })) === null;
    });

    assert('the holder name is required', () => parse(card({ card_holder_name: '  ' })) === null);

    assert('the card country is required, exactly as bank`s is', () => {
        return parse(card({ country: '' })) === null;
    });

    // ─── isCardExpired: the boundary itself ──────────────────────────────────

    console.log('\n— isCardExpired —');

    const jun2026 = new Date(Date.UTC(2026, 5, 15)); // month index 5 = June

    assert('a card valid through this month is NOT expired', () => !isCardExpired(6, 2026, jun2026));

    assert('last month is expired', () => isCardExpired(5, 2026, jun2026));

    assert('next month is not expired', () => !isCardExpired(7, 2026, jun2026));

    assert('a December card is not expired in June of the same year', () => {
        return !isCardExpired(12, 2026, jun2026);
    });

    assert('a January card of the FOLLOWING year is not expired', () => {
        return !isCardExpired(1, 2027, jun2026);
    });

    assert('a December card of the PREVIOUS year is expired', () => {
        return isCardExpired(12, 2025, jun2026);
    });

    // ─── The switch (ENABLED_PAYOUT_METHODS) ────────────────────────────────
    //
    // These assert the CURRENT setting rather than a hardcoded expectation, so
    // flipping a kind back on flips the test with it instead of failing.

    console.log('\n— the switch —');

    const bankEnabled = isPayoutMethodEnabled('bank');
    const cardEnabled = isPayoutMethodEnabled('card');

    assert('mobile money is always enabled — something must be', () => {
        return isPayoutMethodEnabled('mobile_money') && parseRequest(momo());
    });

    assert(`a bank request is ${bankEnabled ? 'accepted' : 'refused'} (switch says ${bankEnabled})`, () => {
        return parseRequest(bank()) === bankEnabled;
    });

    assert(`a card request is ${cardEnabled ? 'accepted' : 'refused'} (switch says ${cardEnabled})`, () => {
        return parseRequest(card()) === cardEnabled;
    });

    if (!bankEnabled) {
        assert('a disabled kind is refused ON `method`, with an explanatory message', () => {
            const issues = requestIssues(bank());
            return (
                issues.length === 1 &&
                issues[0].path === 'method' &&
                /not available right now/i.test(issues[0].message)
            );
        });

        // The gate is piped BEFORE the shape precisely so a half-filled form
        // hears "not available" instead of "bank_name is required".
        assert('a PARTIAL disabled entry still gets the switch message, not field errors', () => {
            const issues = requestIssues({ method: 'bank', bank: { bank_name: 'UBA' } });
            return issues.length === 1 && issues[0].path === 'method';
        });

        assert('one disabled entry poisons the whole list — index 0 or not', () => {
            return !PayoutDetailsZodSchema.safeParse([momo(), bank()]).success;
        });
    }

    assert('an unrecognised kind still gets the discriminator error, not the switch message', () => {
        const issues = requestIssues({ method: 'crypto' });
        return issues.length > 0 && !issues.some((i) => /not available right now/i.test(i.message));
    });

    // The shape must go on knowing every kind while the switch is off, or a kind
    // that comes back on comes back broken.
    assert('the SHAPE still accepts every kind regardless of the switch', () => {
        return parse(momo()) !== null && parse(bank()) !== null && parse(card()) !== null;
    });

    // ─── The ordered list ────────────────────────────────────────────────────

    console.log('\n— the ordered list —');

    assert('an empty list is refused', () => !PayoutDetailsZodSchema.safeParse([]).success);

    assert('four entries are refused', () => {
        return !PayoutDetailsZodSchema.safeParse([momo(), momo(), momo(), momo()]).success;
    });

    assert('three entries are the maximum, and are accepted', () => {
        return PayoutDetailsZodSchema.safeParse([momo(), momo(), momo()]).success;
    });

    assert('duplicates of one kind are allowed — nothing dedupes by `method`', () => {
        const alt = { ...momo(), mobile_money: { ...momo().mobile_money, phone_number: '+237690000000' } };
        return PayoutDetailsZodSchema.safeParse([momo(), alt]).success;
    });

    assert('order is preserved — index 0 is what the caller put there', () => {
        const alt = { ...momo(), mobile_money: { ...momo().mobile_money, account_name: 'Second' } };
        const result = PayoutDetailsZodSchema.safeParse([alt, momo()]);
        return result.success && result.data[0].mobile_money?.account_name === 'Second';
    });

    // ─── Masked read-back ────────────────────────────────────────────────────
    //
    // Reads are NOT gated: an owner who configured a bank or card before it was
    // switched off must still see it, and a PayoutRequest snapshot of one must
    // still render. Built through the shape schema for exactly that reason.

    console.log('\n— masked read-back (every kind, switch or no switch) —');

    const stored = [
        PayoutMethodShapeZodSchema.parse(card()),
        PayoutMethodShapeZodSchema.parse(bank()),
    ] as unknown as IPayoutMethod[];
    const masked = maskPayoutMethods(stored);

    assert('index 0 is the preferred method, index 1 is not', () => {
        return masked[0].is_preferred && !masked[1].is_preferred;
    });

    assert('the card block renders a 16-digit-looking masked number', () => {
        return masked[0].card?.number_masked === '•••• •••• •••• 4242';
    });

    assert('the card block still exposes last4 and the expiry', () => {
        return (
            masked[0].card?.last4 === '4242' &&
            masked[0].card?.expiry_month === 8 &&
            masked[0].card?.expiry_year === FUTURE_YEAR
        );
    });

    assert('a card entry carries no bank or mobile_money block', () => {
        return masked[0].bank === null && masked[0].mobile_money === null;
    });

    assert('a bank entry carries no card block', () => masked[1].card === null);

    assert('the bank account number is still masked to its tail', () => {
        return masked[1].bank?.account_number_masked.endsWith('6789') === true &&
            !masked[1].bank?.account_number_masked.includes('10005');
    });

    assert('legacy documents with no payout list mask to []', () => {
        return maskPayoutMethods(null).length === 0 && maskPayoutMethods(undefined).length === 0;
    });

    assert('formatMaskedCardNumber is the one renderer of that string', () => {
        return formatMaskedCardNumber('1881') === '•••• •••• •••• 1881';
    });

    // ── The admin payout queue ───────────────────────────────────────────────
    //
    // `toAdminPayoutRequestDto` is the lock that keeps a beneficiary's plaintext
    // account number off the administrator's screen. The endpoints used to return
    // `r.toObject()` and the raw model, so the whole `payout_method_snapshot` —
    // MSISDN and bank account number included — reached the wire.
    //
    // These assertions go at the DTO rather than at `maskPayoutMethod`, deliberately:
    // a correct masker called by a mapper that also spreads the document is still a
    // leak, and the spread is the mistake a future edit is likely to make.
    console.log('\n▸ Admin payout DTO — the destination never leaves unmasked');

    const MSISDN = '237670123456';
    const ACCOUNT_NO = '10005550006789';

    /** A payout row shaped like the document, with the fields the DTO reads. */
    const payoutRow = (snapshot: unknown) => ({
        id: '665f00000000000000000001',
        owner_type: 'agency',
        owner_id: { toString: () => '665f00000000000000000002' },
        amount: 250_000,
        currency: 'XAF',
        status: 'pending',
        origin: 'manual',
        payout_method_snapshot: snapshot,
        ticket_id: null,
        requested_by_user_id: { toString: () => '665f00000000000000000003' },
        resolved_at: null,
        resolved_by: null,
        resolved_by_source: undefined,
        resolved_by_name: undefined,
        paid_reference: null,
        rejection_reason: null,
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        updated_at: new Date('2026-08-02T00:00:00.000Z'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const momoDto = toAdminPayoutRequestDto(payoutRow(momo({ phone_number: MSISDN })), 'Jovi Express');
    const bankDto = toAdminPayoutRequestDto(payoutRow(bank({ account_number: ACCOUNT_NO })), null);

    assert('the mobile-money number is masked to its tail', () => {
        return momoDto.destination?.mobile_money?.phone_number_masked.endsWith('3456') === true;
    });

    assert('the RAW mobile-money number appears nowhere in the DTO', () => {
        return !JSON.stringify(momoDto).includes(MSISDN);
    });

    assert('the RAW bank account number appears nowhere in the DTO', () => {
        return !JSON.stringify(bankDto).includes(ACCOUNT_NO);
    });

    assert('no key named `payout_method_snapshot` survives onto the wire', () => {
        return !JSON.stringify(momoDto).includes('payout_method_snapshot');
    });

    assert('a card destination discloses no gateway token', () => {
        const dto = toAdminPayoutRequestDto(
            payoutRow(card({ gateway_token: 'tok_live_do_not_leak' })),
            null,
        );
        return !JSON.stringify(dto).includes('tok_live_do_not_leak');
    });

    assert('a legacy row with no snapshot reports null, not an empty destination', () => {
        return toAdminPayoutRequestDto(payoutRow(null), null).destination === null;
    });

    assert('an unresolved row reports the platform source, never a bare dangling id', () => {
        const { resolvedBy } = momoDto;
        return resolvedBy.id === null && resolvedBy.source === 'platform' && resolvedBy.name === null;
    });

    assert('an admin-resolved row carries its source and name snapshot', () => {
        const row = payoutRow(momo({ phone_number: MSISDN }));
        row.resolved_by = { toString: () => '665f00000000000000000009' };
        row.resolved_by_source = 'admin';
        row.resolved_by_name = 'A. Nkeng';
        const { resolvedBy } = toAdminPayoutRequestDto(row, null);
        return resolvedBy.source === 'admin' && resolvedBy.name === 'A. Nkeng';
    });

    assert('the operational fields an operator acts on are all still there', () => {
        return momoDto.amount === 250_000
            && momoDto.currency === 'XAF'
            && momoDto.status === 'pending'
            && momoDto.ownerName === 'Jovi Express'
            && momoDto.destination?.mobile_money?.account_name !== undefined;
    });

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main();
