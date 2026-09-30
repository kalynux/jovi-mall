/**
 * test:payment-methods — saved payment methods name no aggregator (ADR-A08, 2026-09-30), offline.
 *
 * Owner decisions this pins: (1) WALLETS ONLY — a card is refused until card payments exist;
 * (2) the old body is REPLACED, with no compatibility shim.
 *
 *   1. Schema          { provider MTN|ORANGE|MOOV, phoneNumber E.164, label?, isDefault? },
 *                      .strict(): a card and every legacy key → refused.
 *   2. Service         the network check (422 PAYMENT_PROVIDER_PHONE_MISMATCH), the canonical
 *                      row it writes (no gateway field), the limit.
 *   3. Mapper          the response shape; legacy rows mapped, not dropped; never a full number.
 *   4. Stored payer    checkout reads `phone_number` first, then a legacy E.164 gateway id.
 *   5. Surfaces        /api/customer/payment-methods is a thin alias of /api/me/payment-methods.
 *   6. Bot door        its input is unchanged; it stores the canonical form through the service.
 *
 * The service runs against an in-memory repository, so nothing here needs a database.
 * ⚠ No controller is imported (see `ts-node-suites-must-not-import-controllers`): the two
 * surface checks read source as text and name the span they read.
 *
 * Run: npm run test:payment-methods
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Types } from 'mongoose';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { AddPaymentMethodSchema } from '../../src/modules/payment-methods/validators/payment-method.validators';
import { PaymentMethodService } from '../../src/modules/payment-methods/services/payment-method.service';
import {
    PaymentMethodCreateData,
    UserPaymentMethodRepository,
} from '../../src/modules/payment-methods/repositories/user-payment-method.repository';
import { PaymentMethodMapper, walletNumberOf } from '../../src/modules/payment-methods/dto/payment-method.dto';
import { IUserPaymentMethod } from '../../src/modules/payment-methods/models/user-payment-method.model';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { BOT_WALLET_PROVIDERS, BotPaymentMethodAddSchema } from '../../src/modules/bot-surface/validators/bot.validators';
import { toBotPaymentMethodDto } from '../../src/modules/bot-surface/dto/bot-projections';
import { providerForSavedWallet } from '../../src/modules/payments/domain/payment-provider';

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
    let ok: boolean;
    try {
        ok = await fn();
    } catch (err) {
        originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        passed++;
        originalConsole.log(`  ✅ ${name}`);
    } else {
        failed++;
        originalConsole.error(`  ❌ FAIL: ${name}`);
    }
}

function section(title: string): void {
    originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

const SRC = join(__dirname, '../../src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

/** The source between two markers, so a scan names exactly what it reads. */
function span(text: string, from: string, to: string): string {
    const a = text.indexOf(from);
    if (a < 0) throw new Error(`span start not found: ${from}`);
    const b = text.indexOf(to, a + from.length);
    if (b < 0) throw new Error(`span end not found: ${to}`);
    return text.slice(a, b);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MTN_NUMBER = '+237670124417';
const ORANGE_NUMBER = '+237690120044';
/** 62x is Camtel: not in the prefix table, so the declared provider wins. */
const UNKNOWN_PREFIX_NUMBER = '+237620001234';
const OWNER = new Types.ObjectId().toString();

/** A persisted row, as Mongoose would hand it back. */
function row(over: Partial<IUserPaymentMethod> = {}): IUserPaymentMethod {
    return {
        _id: new Types.ObjectId(),
        owner_role: 'customer',
        owner_id: new Types.ObjectId(OWNER),
        provider: 'MTN',
        phone_number: MTN_NUMBER,
        gateway_customer_id: null,
        gateway_instrument_id: null,
        method_type: 'mobile_money',
        display_label: 'MTN Mobile Money · ••••4417',
        brand: null,
        last4: '4417',
        exp_month: null,
        exp_year: null,
        holder_name: null,
        is_default: false,
        created_at: new Date('2026-09-30T10:00:00Z'),
        updated_at: new Date('2026-09-30T10:00:00Z'),
        ...over,
    } as unknown as IUserPaymentMethod;
}

/** An in-memory repository that records what the service asks it to write. */
class MemoryRepo {
    writes: PaymentMethodCreateData[] = [];
    count = 0;
    async countByOwner(): Promise<number> {
        return this.count;
    }
    async create(_role: string, _owner: string, data: PaymentMethodCreateData): Promise<IUserPaymentMethod> {
        this.writes.push(data);
        return row({ ...data, is_default: data.is_default || this.count === 0 } as Partial<IUserPaymentMethod>);
    }
}

function serviceWith(repo: MemoryRepo): PaymentMethodService {
    return new PaymentMethodService(repo as unknown as UserPaymentMethodRepository);
}

async function refusal(fn: () => Promise<unknown>): Promise<AppError | null> {
    try {
        await fn();
        return null;
    } catch (err) {
        return err instanceof AppError ? err : null;
    }
}

(async () => {
    // ── 1. Schema ────────────────────────────────────────────────────────────
    section('1. Schema — wallets only, the old body refused');

    const wallet = { provider: 'MTN', phoneNumber: MTN_NUMBER };

    await assert('a wallet body parses; label and isDefault are optional', () => {
        const bare = AddPaymentMethodSchema.safeParse(wallet);
        const full = AddPaymentMethodSchema.safeParse({ ...wallet, label: ' My MoMo ', isDefault: true });
        return bare.success && full.success && full.data.label === 'My MoMo' && full.data.isDefault === true;
    });
    await assert('all three wallet providers are accepted', () =>
        ['MTN', 'ORANGE', 'MOOV'].every((provider) =>
            AddPaymentMethodSchema.safeParse({ provider, phoneNumber: MTN_NUMBER }).success));
    await assert('⛔ a CARD is refused (owner decision 1), and the message says why', () => {
        const r = AddPaymentMethodSchema.safeParse({ ...wallet, provider: 'CARD' });
        return !r.success && r.error.issues.some((i) => /card is not available/.test(i.message));
    });
    await assert('⛔ an aggregator name or the legacy lowercase vocabulary is refused', () =>
        ['notchpay', 'stripe', 'mtn_momo', 'orange_money', 'NOTCHPAY', ''].every((provider) =>
            !AddPaymentMethodSchema.safeParse({ ...wallet, provider }).success));
    for (const legacyKey of [
        'gateway_customer_id', 'gateway_instrument_id', 'method_type', 'display_label',
        'brand', 'last4', 'exp_month', 'exp_year', 'holder_name', 'is_default',
    ]) {
        await assert(`⛔ legacy key \`${legacyKey}\` → refused, not stripped (.strict)`, () =>
            !AddPaymentMethodSchema.safeParse({ ...wallet, [legacyKey]: 'x' }).success);
    }
    await assert('⛔ the whole OLD body is refused', () =>
        !AddPaymentMethodSchema.safeParse({
            provider: 'mtn_momo', gateway_customer_id: MTN_NUMBER, gateway_instrument_id: MTN_NUMBER,
            method_type: 'mobile_money', display_label: 'MTN', is_default: false,
        }).success);
    await assert('the number must be E.164; formatting is normalised away', () => {
        const spaced = AddPaymentMethodSchema.safeParse({ ...wallet, phoneNumber: '+237 670-124-417' });
        return spaced.success && spaced.data.phoneNumber === MTN_NUMBER
            && !AddPaymentMethodSchema.safeParse({ ...wallet, phoneNumber: '670124417' }).success
            && !AddPaymentMethodSchema.safeParse({ provider: 'MTN' }).success;
    });
    await assert('a label is at most 100 characters and not blank', () =>
        !AddPaymentMethodSchema.safeParse({ ...wallet, label: 'x'.repeat(101) }).success
        && !AddPaymentMethodSchema.safeParse({ ...wallet, label: '   ' }).success);

    // ── 2. Service ───────────────────────────────────────────────────────────
    section('2. Service — the network check and the canonical row');

    await assert('⛔ a number on another network → 422 PAYMENT_PROVIDER_PHONE_MISMATCH {provider, detected}', async () => {
        const repo = new MemoryRepo();
        const err = await refusal(() =>
            serviceWith(repo).add('customer', OWNER, { provider: 'MTN', phoneNumber: ORANGE_NUMBER }));
        return err !== null
            && err.code === ERROR_CODES.PAYMENT_PROVIDER_PHONE_MISMATCH
            && err.statusCode === 422
            && err.details?.provider === 'MTN' && err.details?.detected === 'ORANGE'
            && repo.writes.length === 0;
    });
    await assert('⛔ MOOV with an MTN-prefix number is a mismatch too (prefix alone decides)', async () => {
        const err = await refusal(() =>
            serviceWith(new MemoryRepo()).add('customer', OWNER, { provider: 'MOOV', phoneNumber: MTN_NUMBER }));
        return err?.code === ERROR_CODES.PAYMENT_PROVIDER_PHONE_MISMATCH && err.details?.detected === 'MTN';
    });
    await assert('an unknown prefix is not a mismatch — the declared provider wins', async () => {
        const repo = new MemoryRepo();
        const dto = await serviceWith(repo).add('customer', OWNER, { provider: 'ORANGE', phoneNumber: UNKNOWN_PREFIX_NUMBER });
        return dto.provider === 'ORANGE' && repo.writes[0]?.provider === 'ORANGE';
    });
    await assert('⭐ the row written is canonical: provider, phone_number, and NO gateway field', async () => {
        const repo = new MemoryRepo();
        await serviceWith(repo).add('customer', OWNER, { provider: 'MTN', phoneNumber: MTN_NUMBER });
        const w = repo.writes[0] as unknown as Record<string, unknown>;
        return w.provider === 'MTN'
            && w.phone_number === MTN_NUMBER
            && w.method_type === 'mobile_money'
            && w.last4 === '4417'
            && !Object.keys(w).some((k) => k.startsWith('gateway_'))
            && !['brand', 'exp_month', 'exp_year', 'holder_name'].some((k) => k in w);
    });
    await assert('the label is composed in the storefront format when none is given', async () => {
        const repo = new MemoryRepo();
        await serviceWith(repo).add('customer', OWNER, { provider: 'ORANGE', phoneNumber: ORANGE_NUMBER });
        await serviceWith(repo).add('customer', OWNER, { provider: 'MTN', phoneNumber: MTN_NUMBER, label: 'Work phone' });
        return repo.writes[0].display_label === 'Orange Money · ••••0044'
            && repo.writes[1].display_label === 'Work phone';
    });
    await assert('isDefault is passed through (default false)', async () => {
        const repo = new MemoryRepo();
        await serviceWith(repo).add('customer', OWNER, { provider: 'MTN', phoneNumber: MTN_NUMBER });
        await serviceWith(repo).add('customer', OWNER, { provider: 'MTN', phoneNumber: MTN_NUMBER, isDefault: true });
        return repo.writes[0].is_default === false && repo.writes[1].is_default === true;
    });
    await assert('the eleventh method → 409 PAYMENT_METHOD_LIMIT_REACHED', async () => {
        const repo = new MemoryRepo();
        repo.count = 10;
        const err = await refusal(() =>
            serviceWith(repo).add('customer', OWNER, { provider: 'MTN', phoneNumber: MTN_NUMBER }));
        return err?.code === ERROR_CODES.PAYMENT_METHOD_LIMIT_REACHED && err.statusCode === 409;
    });

    // ── 3. Mapper ────────────────────────────────────────────────────────────
    section('3. Response — one shape, masked, legacy rows mapped');

    const EXPECTED_KEYS = ['createdAt', 'id', 'isDefault', 'kind', 'label', 'last4', 'maskedPhone', 'provider', 'updatedAt'];

    await assert('a new row → exactly { id, provider, kind, label, maskedPhone, last4, isDefault, createdAt, updatedAt }', () => {
        const dto = PaymentMethodMapper.toDto(row());
        return JSON.stringify(Object.keys(dto).sort()) === JSON.stringify(EXPECTED_KEYS)
            && dto.provider === 'MTN' && dto.kind === 'MOBILE_MONEY' && dto.last4 === '4417'
            && dto.maskedPhone === '+2376••••4417';
    });
    await assert('⛔ the full number and every gateway field stay out of the response', () => {
        const json = JSON.stringify(PaymentMethodMapper.toDto(row({
            gateway_customer_id: 'cus_SECRET', gateway_instrument_id: 'inst_SECRET', holder_name: 'Nadege Fotso',
        })));
        return !json.includes(MTN_NUMBER) && !json.includes('gateway') && !json.includes('SECRET')
            && !json.includes('Nadege');
    });
    await assert('a legacy wallet row (`mtn_momo`, number in gateway_customer_id) reads as MTN, masked', () => {
        const dto = PaymentMethodMapper.toDto(row({
            provider: 'mtn_momo', phone_number: null, gateway_customer_id: MTN_NUMBER, gateway_instrument_id: MTN_NUMBER,
        }));
        return dto.provider === 'MTN' && dto.maskedPhone === '+2376••••4417'
            && !JSON.stringify(dto).includes(MTN_NUMBER);
    });
    await assert('a legacy row naming only an aggregator → provider null, no masked number, still listed', () => {
        const dto = PaymentMethodMapper.toDto(row({
            provider: 'notchpay', phone_number: null, gateway_customer_id: 'seed_cus_7e57_0', last4: '0001',
        }));
        return dto.provider === null && dto.maskedPhone === null && dto.kind === 'MOBILE_MONEY' && dto.last4 === '0001';
    });
    await assert('a legacy card row → provider CARD, kind CARD, no masked number', () => {
        const dto = PaymentMethodMapper.toDto(row({
            provider: 'stripe', method_type: 'card', phone_number: null, gateway_customer_id: 'cus_1',
            brand: 'visa', last4: '4242', exp_month: 11, exp_year: 2029,
        }));
        return dto.provider === 'CARD' && dto.kind === 'CARD' && dto.maskedPhone === null && dto.last4 === '4242';
    });

    // ── 4. Stored payer ──────────────────────────────────────────────────────
    section('4. Checkout reads phone_number first, then a legacy E.164 gateway id');

    await assert('phone_number wins over a legacy gateway_customer_id', () =>
        walletNumberOf(row({ phone_number: MTN_NUMBER, gateway_customer_id: ORANGE_NUMBER })) === MTN_NUMBER);
    await assert('a legacy row falls back to gateway_customer_id', () =>
        walletNumberOf(row({ phone_number: null, gateway_customer_id: ORANGE_NUMBER })) === ORANGE_NUMBER);
    await assert('⛔ an aggregator customer id is never taken for a number', () =>
        walletNumberOf(row({ phone_number: null, gateway_customer_id: 'seed_cus_7e57_0' })) === null);
    await assert('a card row has no wallet number', () =>
        walletNumberOf(row({ method_type: 'card', phone_number: null, gateway_customer_id: MTN_NUMBER })) === null);
    await assert('storedPayer reads through walletNumberOf, not a raw gateway id', () => {
        const fn = span(read('modules/bot-surface/miniapp/surfaces/checkout-payer.ts'),
            'export async function storedPayer(', '\n}\n');
        return fn.includes('walletNumberOf(wallet)') && !fn.includes('gateway_customer_id');
    });

    // ── 5. Surfaces ──────────────────────────────────────────────────────────
    section('5. /api/customer/payment-methods is a thin alias');

    await assert('/api/me/payment-methods is mounted', () =>
        /router\.use\('\/me\/payment-methods', paymentMethodRoutes\)/.test(read('api/index.ts')));
    await assert('the customer POST and DELETE are the SAME handlers as /api/me', () => {
        const routes = read('modules/customers/routes.ts');
        return routes.includes("router.post('/payment-methods', PaymentMethodController.add);")
            && routes.includes("router.delete('/payment-methods/:id', PaymentMethodController.remove);");
    });
    await assert('no second payment-method schema survives in the customer module', () => {
        const validator = read('modules/customers/validators/customer-onboarding.validator.ts');
        const controller = read('modules/customers/controllers/customer-profile.controller.ts');
        return !validator.includes('gateway_customer_id') && !controller.includes('PaymentMethod');
    });

    // ── 6. Bot door ──────────────────────────────────────────────────────────
    section('6. Bot door — input unchanged, canonical storage');

    await assert('the bot input is unchanged: mtn_momo / orange_money / moov_money + phoneNumber', () =>
        BOT_WALLET_PROVIDERS.every((provider) =>
            BotPaymentMethodAddSchema.safeParse({ provider, phoneNumber: MTN_NUMBER }).success)
        && !BotPaymentMethodAddSchema.safeParse({ provider: 'MTN', phoneNumber: MTN_NUMBER }).success);
    await assert('every bot wallet name maps to a canonical provider', () =>
        BOT_WALLET_PROVIDERS.map(providerForSavedWallet).join() === 'MTN,ORANGE,MOOV');
    await assert('⭐ BotPaymentMethodController.add stores through the service in the canonical form', () => {
        const add = span(read('modules/bot-surface/controllers/bot-payment-method.controller.ts'),
            'static add = asyncHandler(', 'sendSuccess(res, toBotPaymentMethodDto(method)');
        return add.includes('paymentMethodService.add(')
            && add.includes('provider: providerForSavedWallet(input.provider)!')
            && add.includes('phoneNumber: input.phoneNumber')
            && !add.includes('gateway_');
    });
    await assert('the bot projection keeps its output keys and carries no number, not even masked', () => {
        const bot = toBotPaymentMethodDto(PaymentMethodMapper.toDto(row()));
        const json = JSON.stringify(bot);
        return JSON.stringify(Object.keys(bot).sort())
                === JSON.stringify(['brand', 'expired', 'expires', 'id', 'isDefault', 'label', 'last4', 'provider', 'type'])
            && bot.type === 'mobile_money' && bot.provider === 'MTN'
            && !json.includes(MTN_NUMBER) && !json.includes('+2376');
    });

    originalConsole.log(`\n${'═'.repeat(76)}`);
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('═'.repeat(76));
    process.exit(failed > 0 ? 1 : 0);
})();
