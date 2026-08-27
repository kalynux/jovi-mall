/**
 * Live verification of registration on first contact — GAP-002. NEEDS Mongo and Redis.
 *
 * The DB-free half of this feature is the checklist arithmetic in
 * `bot-surface/domain/bot-onboarding.ts`, which `test:bot-surface` drives with no database.
 * Seven things it structurally cannot cover, and they are the ones that would ship broken:
 *
 *   1. **An account is really CREATED**, with a `users` row, a `Customer` profile and a
 *      `channel_connections` binding — in one turn on WhatsApp, and only after the contact
 *      share on Telegram. Nothing DB-free can assert a document exists.
 *   2. **A BARE-DIGITS `wa_phone_id` really lands as strict E.164.** `messagingPhoneToE164`
 *      is unit-tested, but the failure this guards is a `login_phone` written as
 *      `237600…` — an account nothing can ever find again, including its own second
 *      message. Only a round trip through a real `findByPhone` proves it.
 *   3. **A second message does NOT create a second account.** The whole feature is an
 *      upsert, and "upsert" is a claim about a unique index and a real query.
 *   4. **The anonymous routes really run for a sender with no account.** `requireBotIdentity`
 *      is a `router.use`; a source scan sees the `anonymous` column, and only a real request
 *      proves the middleware branches on it rather than 404ing the request that exists to
 *      create the account.
 *   5. **A suspended account is refused rather than duplicated.** The dangerous branch: get
 *      it wrong and an administrator's suspension is undone by the suspended person sending
 *      one message, silently, with a second account as the evidence.
 *   6. **A business account is UPGRADED, not refused** (owner decision 2026-08-26, reversing
 *      GAP-002 D-3) — and `roles` gains `customer` exactly once however many messages arrive.
 *   7. **`error.customerMessage` is really on the wire, localised.** The copy table is pure
 *      and assertable; that the error HANDLER attaches it, only for this surface, and in the
 *      language stamped on a request that has already failed, is end-to-end by construction.
 *
 * Writes its own `verify-botreg-*` fixtures and removes them, pass or fail, in the same
 * shape as `verify:bot-surface`.
 *
 * Run: npm run verify:bot-registration
 */
import http from 'http';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

process.env.JWT_SECRET ||= 'verify-secret-for-bot-registration-suite';
process.env.JWT_REFRESH_SECRET ||= 'verify-refresh-secret-for-bot-registration-suite';

// Both credentials, forced BEFORE the module graph loads — `requireServiceToken` captures
// `AGENT_CONFIG.INTERNAL_SERVICE_TOKEN` at import, so setting these later would leave the
// suite passing or failing on the developer's `.env` rather than on this code.
process.env.INTERNAL_SERVICE_TOKEN ||= 'verify-bot-registration-service-token';
process.env.BOT_WEBHOOK_SECRET = 'verify-bot-registration-webhook-secret';
const SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET;

import { app } from '../src/app';
import { UserModel } from '../src/modules/users/user.model';
import { CustomerModel } from '../src/modules/customers/customer.model';
import { ChannelConnectionModel } from '../src/modules/channel-connections/channel-connection.model';
import { CustomerNotificationPreferenceModel } from '../src/modules/notifications/models/customer-notification-preference.model';
import { botIdempotencyStore } from '../src/modules/bot-surface/services/bot-idempotency.store';
import { closeRedisClients } from '../src/infra/redis/redis.factory';

// ─────────────────────────────────────────────────────────────────────────────
// Assertion harness — the house style: plain asserts, no runner
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function section(title: string): void {
    console.log(`\n▶ ${title}`);
}

async function check(label: string, fn: () => boolean | Promise<boolean>): Promise<void> {
    try {
        const ok = await fn();
        if (ok) {
            passed++;
            console.log(`  ✅ ${label}`);
        } else {
            failed++;
            console.error(`  ❌ FAIL: ${label}`);
        }
    } catch (error) {
        failed++;
        console.error(`  ❌ THREW: ${label}`);
        console.error('     ↳', error instanceof Error ? error.message : error);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — FIXED ids, so an interrupted run is swept by the next one
// ─────────────────────────────────────────────────────────────────────────────

/** Bare digits, exactly as Meta sends them. The E.164 repair is what this proves. */
const NEW_WA_PHONE_ID = '237600000391';
const NEW_PHONE_E164 = '+237600000391';

const SUSPENDED_WA_PHONE_ID = '237600000392';
const SUSPENDED_PHONE = '+237600000392';

const VENDOR_WA_PHONE_ID = '237600000393';
const VENDOR_PHONE = '+237600000393';

const TG_CHAT_ID = 'verify-botreg-tg-93001';
const TG_PHONE_RAW = '237600000394';
const TG_PHONE_E164 = '+237600000394';

const SUSPENDED_USER_ID = new mongoose.Types.ObjectId('60700000000000000000d392');
const VENDOR_USER_ID = new mongoose.Types.ObjectId('60700000000000000000d393');

const ALL_PHONES = [NEW_PHONE_E164, SUSPENDED_PHONE, VENDOR_PHONE, TG_PHONE_E164];
const ALL_EXTERNAL_IDS = [NEW_WA_PHONE_ID, SUSPENDED_WA_PHONE_ID, VENDOR_WA_PHONE_ID, TG_CHAT_ID];

let server: http.Server | null = null;
let base = '';
const spentScopes: Array<[string, string]> = [];

type Json = Record<string, unknown>;
interface BotResponse { status: number; body: Json }

let keyCounter = 0;
const nextKey = (): string => `verify-botreg-${Date.now()}-${keyCounter++}`;

async function call(
    path: string,
    args: Json,
    identity: Json,
    options: { idempotencyKey?: string } = {},
): Promise<BotResponse> {
    const key = options.idempotencyKey ?? nextKey();
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SERVICE_TOKEN}`,
            'X-Webhook-Secret': WEBHOOK_SECRET,
            'Idempotency-Key': key,
        },
        body: JSON.stringify({ identity, ...args }),
    });

    const channel = String(identity.channel);
    spentScopes.push([`anon:${channel}:*`, key]);

    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

const sync = (identity: Json, options?: { idempotencyKey?: string }): Promise<BotResponse> =>
    call('/api/internal/bot/identity/sync', {}, identity, options);

const onboard = (identity: Json, args: Json): Promise<BotResponse> =>
    call('/api/internal/bot/identity/onboarding', args, identity);

const wa = (externalId: string, extra: Json = {}): Json =>
    ({ channel: 'whatsapp', externalId, ...extra });

const data = (r: BotResponse): Json => (r.body.data ?? {}) as Json;
const onboarding = (r: BotResponse): Json => (data(r).onboarding ?? {}) as Json;
const next = (r: BotResponse): Json => (onboarding(r).next ?? {}) as Json;
const err = (r: BotResponse): Json => (r.body.error ?? {}) as Json;

async function cleanup(): Promise<void> {
    /**
     * The preference rows are keyed on `customerId`, so they have to be collected BEFORE the
     * customers are deleted — after that there is nothing left to join on and every run would
     * leak one row per registration, each of them holding a unique index on `customerId`.
     */
    const doomed = await CustomerModel.find({
        $or: [
            { phone: { $in: ALL_PHONES } },
            { user_id: { $in: [SUSPENDED_USER_ID, VENDOR_USER_ID] } },
        ],
    }).select('_id').lean();

    await Promise.allSettled([
        UserModel.deleteMany({
            $or: [
                { _id: { $in: [SUSPENDED_USER_ID, VENDOR_USER_ID] } },
                { login_phone: { $in: ALL_PHONES } },
            ],
        }),
        CustomerModel.deleteMany({ phone: { $in: ALL_PHONES } }),
        ChannelConnectionModel.deleteMany({ external_id: { $in: ALL_EXTERNAL_IDS } }),
        CustomerNotificationPreferenceModel.deleteMany({
            customerId: { $in: doomed.map((c) => c._id) },
        }),
    ]);

    // The customer profiles created by an UPGRADE carry the account's phone, so the sweep
    // above catches them — but one whose user row had no phone would be orphaned. Sweep by
    // user id too, for the vendor case specifically.
    await Promise.allSettled([
        CustomerModel.deleteMany({ user_id: { $in: [SUSPENDED_USER_ID, VENDOR_USER_ID] } }),
    ]);
}

async function seed(): Promise<void> {
    await UserModel.create({
        _id: SUSPENDED_USER_ID,
        login_phone: SUSPENDED_PHONE,
        password_hash: 'verify-botreg-not-a-real-hash',
        roles: ['customer'],
        status: 'suspended',
    });
    await UserModel.create({
        _id: VENDOR_USER_ID,
        login_phone: VENDOR_PHONE,
        password_hash: 'verify-botreg-not-a-real-hash',
        roles: ['vendor'],
        status: 'active',
    });
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('\n═══ verify:bot-registration (NEEDS Mongo + Redis) ══════════════════════════\n');

    await mongoose.connect(process.env.MONGO_URI as string);
    await cleanup();
    await seed();

    const listening = app.listen(0);
    server = listening;
    await new Promise<void>((resolve) => listening.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(listening.address() as { port: number }).port}`;

    // ═════════════════════════════════════════════════════════════════════════
    section('1 · WhatsApp — an account is created on the FIRST message');
    // ═════════════════════════════════════════════════════════════════════════

    const first = await sync(wa(NEW_WA_PHONE_ID, { displayName: 'Ada Nkeng', language: 'fr' }));

    await check('the first message answers 201 and isNew:true', () =>
        first.status === 201 && data(first).isNew === true && data(first).registered === true);

    await check('⚠ the BARE-DIGITS wa_phone_id landed as strict E.164 on the users row', async () => {
        const user = await UserModel.findOne({ login_phone: NEW_PHONE_E164 });
        const wrong = await UserModel.findOne({ login_phone: NEW_WA_PHONE_ID });
        // The second half is the assertion that matters: a row written under bare digits is
        // an account nothing can ever find again, and it looks perfectly implemented.
        return user !== null && wrong === null;
    });

    await check('a Customer profile was created with the messaging profile name', async () => {
        const customer = await CustomerModel.findOne({ phone: NEW_PHONE_E164 });
        return customer !== null && customer.name === 'Ada Nkeng';
    });

    await check('⚠ phone_verified is TRUE — the message arrived FROM the number', async () => {
        const customer = await CustomerModel.findOne({ phone: NEW_PHONE_E164 });
        return customer?.phone_verified === true && customer?.email_verified === false;
    });

    await check('the language hint seeded preferences.language', async () => {
        const customer = await CustomerModel.findOne({ phone: NEW_PHONE_E164 });
        return customer?.preferences?.language === 'fr';
    });

    await check('the channel_connections row was bound', async () => {
        const connection = await ChannelConnectionModel.findOne({
            channel: 'whatsapp',
            external_id: NEW_WA_PHONE_ID,
        });
        return connection !== null;
    });

    await check('a system password was minted and is NOT the placeholder', async () => {
        const user = await UserModel.findOne({ login_phone: NEW_PHONE_E164 });
        return typeof user?.password_hash === 'string' && user.password_hash.startsWith('$2');
    });

    await check('⚠ NO session was minted — the body carries no token of any kind', () =>
        !JSON.stringify(first.body).match(/accessToken|refreshToken|"tokens"/));

    /**
     * ⚠ **GAP-012's half of registration, and it is not decoration.** All three secondary
     * channel flags default to FALSE on `customer_notification_preferences`, so before this
     * a bot-registered customer received in-app records and a push to a device token they do
     * not have — and NOTHING on the channel they were talking to us on. Every proactive
     * template GAP-012 asks for would be written, approved, addressed and never sent, for
     * exactly the population GAP-002 exists to create.
     *
     * A source scan sees the call; only this proves the row is really written, that it names
     * the channel the sender arrived on, and that the one-secondary-channel rule held.
     */
    await check('⚠ the notification channel is seeded to the channel they arrived on', async () => {
        const customer = await CustomerModel.findOne({ phone: NEW_PHONE_E164 });
        const prefs = await CustomerNotificationPreferenceModel.findOne({
            customerId: customer!._id,
        });
        return prefs?.whatsappEnabled === true
            && prefs?.telegramEnabled === false
            && prefs?.emailEnabled === false;
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('2 · The checklist — phone is already satisfied, name is next');
    // ═════════════════════════════════════════════════════════════════════════

    await check('the phone step is PROVIDED — the sender id IS the number', () => {
        const steps = (onboarding(first).steps ?? []) as Array<Json>;
        const phone = steps.find((s) => s.step === 'phone');
        return phone?.state === 'provided';
    });

    await check('next is `name`, required, not skippable', () =>
        next(first).step === 'name'
        && next(first).required === true
        && next(first).skippable === false);

    await check('the descriptor says which field and of what kind', () =>
        next(first).field === 'name' && next(first).kind === 'text');

    await check('onboarding is not complete, and name is outstanding', () => {
        const outstanding = onboarding(first).outstandingRequired as string[];
        return onboarding(first).complete === false && outstanding.includes('name');
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('3 · The upsert — a second message creates NOTHING');
    // ═════════════════════════════════════════════════════════════════════════

    const second = await sync(wa(NEW_WA_PHONE_ID, { displayName: 'Ada Nkeng' }));

    await check('the second message answers 200 and isNew:false', () =>
        second.status === 200 && data(second).isNew === false);

    await check('⚠ there is still exactly ONE account for this number', async () =>
        (await UserModel.countDocuments({ login_phone: NEW_PHONE_E164 })) === 1);

    await check('…and exactly ONE customer profile', async () =>
        (await CustomerModel.countDocuments({ phone: NEW_PHONE_E164 })) === 1);

    await check('…and exactly ONE connection row', async () =>
        (await ChannelConnectionModel.countDocuments({
            channel: 'whatsapp',
            external_id: NEW_WA_PHONE_ID,
        })) === 1);

    await check('a stale language hint does NOT overwrite the stored preference', async () => {
        await sync(wa(NEW_WA_PHONE_ID, { language: 'es' }));
        const customer = await CustomerModel.findOne({ phone: NEW_PHONE_E164 });
        return customer?.preferences?.language === 'fr';
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('4 · Walking the checklist to complete');
    // ═════════════════════════════════════════════════════════════════════════

    const named = await onboard(wa(NEW_WA_PHONE_ID), { step: 'name', name: 'Ada N.' });

    await check('providing the name advances to `email`', () =>
        named.status === 200 && next(named).step === 'email' && next(named).skippable === true);

    await check('⚠ a SKIPPABLE step\'s prompt is a QUESTION and teaches no magic word', () => {
        /**
         * ⚠ **INVERTED 2026-08-27.** This used to assert the opposite — that the prompt
         * SAYS it is skippable — because the only way to decline was to type a word. That
         * put a five-language vocabulary (`passer` · `saltar` · `omitir` · `تخطٍّ` · `skip`)
         * on the path back, in the layer with no copy table, and put a quoted token inside
         * an otherwise ordinary sentence. The refusal is a **button** now, so finding that
         * vocabulary again would mean somebody had put the interface back into the prose.
         *
         * French, because the account created in §1 carries `preferences.language: 'fr'`.
         * The button assertion is § 9; this one is only about the sentence.
         */
        const prompt = String(next(named).prompt);
        return prompt.length > 10
            && !/passer|facultatif|skip|"|«/i.test(prompt)
            && /e-mail/i.test(prompt);
    });

    await check('a WhatsApp prompt never asks for a contact keyboard', () =>
        next(named).requestContact === undefined);

    await check('the name really landed on the profile', async () => {
        const customer = await CustomerModel.findOne({ phone: NEW_PHONE_E164 });
        return customer?.name === 'Ada N.';
    });

    await check('⚠ a REQUIRED step cannot be skipped', async () => {
        const refused = await onboard(wa(NEW_WA_PHONE_ID), { step: 'name', action: 'skip' });
        return refused.status === 422 && err(refused).code === 'BOT_ONBOARDING_STEP_NOT_SKIPPABLE';
    });

    await check('providing a step with no value is a 400 naming the field', async () => {
        const refused = await onboard(wa(NEW_WA_PHONE_ID), { step: 'email' });
        const details = (err(refused).details ?? {}) as Json;
        return refused.status === 400
            && err(refused).code === 'BOT_ONBOARDING_VALUE_REQUIRED'
            && details.field === 'email';
    });

    const skippedEmail = await onboard(wa(NEW_WA_PHONE_ID), { step: 'email', action: 'skip' });

    await check('a SKIPPABLE step can be skipped, and moves on', () =>
        skippedEmail.status === 200 && next(skippedEmail).step === 'address');

    await check('⚠ the skip is RECORDED, so it is never asked again', () => {
        const steps = (onboarding(skippedEmail).steps ?? []) as Array<Json>;
        return steps.find((s) => s.step === 'email')?.state === 'skipped';
    });

    const done = await onboard(wa(NEW_WA_PHONE_ID), { step: 'address', action: 'skip' });

    await check('skipping the last step COMPLETES onboarding', () =>
        done.status === 200
        && onboarding(done).complete === true
        && onboarding(done).next === null);

    await check('completion is persisted, not just reported', async () => {
        const customer = await CustomerModel.findOne({ phone: NEW_PHONE_E164 });
        return customer?.bot_onboarding?.complete === true
            && customer?.bot_onboarding?.completed_at instanceof Date;
    });

    await check('⚠ a later sync still reports complete — the flag survives a fresh read', async () => {
        const after = await sync(wa(NEW_WA_PHONE_ID));
        return onboarding(after).complete === true && onboarding(after).next === null;
    });

    await check('a skipped step may still be PROVIDED later — skip is not a one-way door', async () => {
        const late = await onboard(wa(NEW_WA_PHONE_ID), { step: 'email', email: 'ada@example.com' });
        const customer = await CustomerModel.findOne({ phone: NEW_PHONE_E164 });
        return late.status === 200
            && customer?.email === 'ada@example.com'
            // ⚠ Written to the PROFILE only. Promoting it to a login identifier on the say-so
            // of a chat message would let anybody claim any unused address.
            && customer?.email_verified === false;
    });

    await check('⚠ …and the email did NOT become a login identifier', async () => {
        const user = await UserModel.findOne({ login_phone: NEW_PHONE_E164 });
        return !user?.login_email;
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('5 · Telegram — anonymous until the contact share');
    // ═════════════════════════════════════════════════════════════════════════

    const tgIdentity = { channel: 'telegram', externalId: TG_CHAT_ID, handle: '@ada' };
    const tgFirst = await sync(tgIdentity);

    await check('an unbound chat answers 200 registered:false — NOT a refusal', () =>
        tgFirst.status === 200
        && data(tgFirst).registered === false
        && data(tgFirst).state === 'anonymous');

    await check('⚠ next is `phone`, so the caller renders request_contact from the usual field', () =>
        next(tgFirst).step === 'phone' && next(tgFirst).kind === 'phone_contact');

    /**
     * ⚠ THE REPORTED DEFECT. `next.step: 'phone'` with no sentence left a Telegram sender
     * with nothing that could be said to them — the success path had descriptors only,
     * while errors carried `customerMessage`. Both halves are asserted here.
     */
    await check('⚠ …and it carries the SENTENCE to send, not just the field name', () => {
        const prompt = next(tgFirst).prompt;
        return typeof prompt === 'string' && prompt.length > 20;
    });

    await check('⚠ …and requestContact:true — the marker n8n ALREADY handles for /login', () =>
        next(tgFirst).requestContact === true);

    await check('the prompt is in the language the envelope asked for', async () => {
        const fr = await sync({ channel: 'telegram', externalId: 'verify-botreg-tg-fr-1', language: 'fr' });
        const en = await sync({ channel: 'telegram', externalId: 'verify-botreg-tg-en-1', language: 'en' });
        const frPrompt = String(next(fr).prompt);
        const enPrompt = String(next(en).prompt);
        return frPrompt !== enPrompt && /téléphone/i.test(frPrompt) && /phone/i.test(enPrompt);
    });

    await check('an unsupported language falls back to English, never to the step name', async () => {
        const de = await sync({ channel: 'telegram', externalId: 'verify-botreg-tg-de-1', language: 'de' });
        const prompt = String(next(de).prompt);
        return /phone/i.test(prompt) && !/\bphone_contact\b/.test(prompt);
    });

    await check('⚠ no prompt anywhere leaks a step name, a field name or a code', async () => {
        const seen = [tgFirst, first, named, skippedEmail].map((r) => String(next(r).prompt ?? ''));
        return seen.every((p) => !/geoCandidateRef|phone_contact|BOT_|_id\b|customerId/.test(p));
    });

    await check('⚠ NO account was created for an anonymous chat', async () =>
        (await ChannelConnectionModel.countDocuments({ external_id: TG_CHAT_ID })) === 0);

    await check('⚠ a step other than phone is refused while there is no account', async () => {
        const refused = await onboard(tgIdentity, { step: 'name', name: 'Ada' });
        const details = (err(refused).details ?? {}) as Json;
        return refused.status === 409
            && err(refused).code === 'BOT_ONBOARDING_NOT_REGISTERED'
            && details.availableStep === 'phone';
    });

    await check('⚠ THE GUARD: a contact that is not the sender\'s own is REFUSED', async () => {
        const refused = await onboard(tgIdentity, {
            step: 'phone',
            contact: { phoneNumber: TG_PHONE_RAW, userId: 'somebody-else-entirely' },
        });
        return refused.status === 400 && err(refused).code === 'MAGIC_CONTACT_UNVERIFIED';
    });

    await check('…and that refusal created NO account', async () =>
        (await UserModel.countDocuments({ login_phone: TG_PHONE_E164 })) === 0);

    const tgRegistered = await onboard(tgIdentity, {
        step: 'phone',
        contact: { phoneNumber: TG_PHONE_RAW, userId: TG_CHAT_ID, firstName: 'Ada' },
    });

    await check('the sender\'s OWN contact creates the account', () =>
        tgRegistered.status === 201 && data(tgRegistered).isNew === true);

    await check('⚠ the bare-digits contact phone also landed as E.164', async () =>
        (await UserModel.countDocuments({ login_phone: TG_PHONE_E164 })) === 1);

    await check('the chat is now bound, so the next message resolves instantly', async () => {
        const again = await sync(tgIdentity);
        return data(again).registered === true && data(again).isNew === false;
    });

    await check('next is `name` — phone is behind them now', () =>
        next(tgRegistered).step === 'name');

    // ═════════════════════════════════════════════════════════════════════════
    section('6 · The two refusals that must never fall through to "create"');
    // ═════════════════════════════════════════════════════════════════════════

    const suspended = await sync(wa(SUSPENDED_WA_PHONE_ID));

    await check('⚠ a SUSPENDED account is refused, not routed around', () =>
        suspended.status === 403 && err(suspended).code === 'AUTH_ACCOUNT_SUSPENDED');

    await check('⚠ …and NO second account was created for that number', async () =>
        (await UserModel.countDocuments({ login_phone: SUSPENDED_PHONE })) === 1);

    const vendor = await sync(wa(VENDOR_WA_PHONE_ID, { displayName: 'Bella Store' }));

    await check('a BUSINESS account is UPGRADED, not refused (owner decision, reverses D-3)', () =>
        vendor.status === 200 && data(vendor).registered === true && data(vendor).upgraded === true);

    await check('the customer role was attached to the EXISTING user row', async () => {
        const user = await UserModel.findById(VENDOR_USER_ID);
        return user?.roles.includes('vendor') === true && user?.roles.includes('customer') === true;
    });

    await check('⚠ the role appears exactly ONCE however many messages arrive', async () => {
        await sync(wa(VENDOR_WA_PHONE_ID));
        await sync(wa(VENDOR_WA_PHONE_ID));
        const user = await UserModel.findById(VENDOR_USER_ID);
        return user?.roles.filter((r) => r === 'customer').length === 1;
    });

    await check('…and there is exactly ONE customer profile for them', async () =>
        (await CustomerModel.countDocuments({ user_id: VENDOR_USER_ID })) === 1);

    await check('a repeat sync reports upgraded:false — it happened once', async () => {
        const again = await sync(wa(VENDOR_WA_PHONE_ID));
        return data(again).upgraded === false && data(again).isNew === false;
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('7 · error.customerMessage — the sentence a chat can relay verbatim');
    // ═════════════════════════════════════════════════════════════════════════

    await check('⚠ every bot-surface refusal carries a customerMessage', () => {
        const message = err(suspended).customerMessage;
        return typeof message === 'string' && message.length > 0;
    });

    await check('⚠ it names no error code, no field and no internal concept', () => {
        const message = String(err(suspended).customerMessage);
        return !/BOT_|AUTH_|customerId|userId|identity|_id/.test(message);
    });

    await check('the developer-facing `message` is STILL there and is different', () =>
        typeof err(suspended).message === 'string'
        && err(suspended).message !== err(suspended).customerMessage);

    await check('a French customer is answered in French', async () => {
        // The account created in section 1 has `preferences.language: 'fr'`, and the guard
        // stamps it on the request from the profile — so a failure on THIS account is
        // worded in French even though the envelope carries no hint.
        const refused = await onboard(wa(NEW_WA_PHONE_ID), { step: 'name', action: 'skip' });
        const message = String(err(refused).customerMessage);
        return message !== '' && /[éèêàç]|n'est|pas/i.test(message);
    });

    await check('an ANONYMOUS sender is answered from the envelope hint', async () => {
        const refused = await onboard(
            { channel: 'telegram', externalId: 'verify-botreg-tg-unknown-1', language: 'pt' },
            { step: 'name', name: 'Whoever' },
        );
        const message = String(err(refused).customerMessage);
        return err(refused).code === 'BOT_ONBOARDING_NOT_REGISTERED' && message.length > 0;
    });

    await check('an UNCATALOGUED code still gets a category sentence, never a raw code', async () => {
        // A validation failure from Zod — no per-code entry exists for it by construction.
        const refused = await onboard(wa(NEW_WA_PHONE_ID), { step: 'not-a-real-step' });
        const message = String(err(refused).customerMessage);
        return refused.status === 400 && message.length > 0 && !/not-a-real-step/.test(message);
    });

    await check('⚠ customerMessage is ABSENT off the bot surface', async () => {
        const res = await fetch(`${base}/api/public/products/000000000000000000000000`);
        const body = (await res.json().catch(() => ({}))) as Json;
        const error = (body.error ?? {}) as Json;
        return res.status >= 400 && error.customerMessage === undefined;
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('8 · Idempotency on the anonymous routes');
    // ═════════════════════════════════════════════════════════════════════════

    await check('a mutating registration route demands an Idempotency-Key', async () => {
        const res = await fetch(`${base}/api/internal/bot/identity/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SERVICE_TOKEN}`,
                'X-Webhook-Secret': WEBHOOK_SECRET,
            },
            body: JSON.stringify({ identity: wa(NEW_WA_PHONE_ID) }),
        });
        const body = (await res.json().catch(() => ({}))) as Json;
        return res.status === 400
            && (body.error as Json)?.code === 'BOT_IDEMPOTENCY_KEY_REQUIRED';
    });

    await check('⚠ a replayed key answers the STORED response, not a second creation', async () => {
        const key = nextKey();
        const a = await sync(wa('237600000395'), { idempotencyKey: key });
        const b = await sync(wa('237600000395'), { idempotencyKey: key });
        await UserModel.deleteMany({ login_phone: '+237600000395' });
        await CustomerModel.deleteMany({ phone: '+237600000395' });
        await ChannelConnectionModel.deleteMany({ external_id: '237600000395' });
        // Both report isNew — the second because it is the first one's stored answer.
        return a.status === 201 && b.status === 201 && data(b).isNew === true;
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('9 · `reply` — the request body n8n POSTs to the channel unmodified');
    // ═════════════════════════════════════════════════════════════════════════
    //
    // `test:bot-surface` § 11 pins the RENDERER against every branch with nothing running.
    // What only a live boot can prove is the WIRING: that the interceptor is mounted, that
    // it survives the idempotency wrapper, and that the field lands on a real HTTP response
    // rather than on a projection somebody forgot to send. A renderer nothing calls is
    // exactly the shape of the defect this whole change was reported for.

    const replyOf = (res: BotResponse): Json => (res.body.reply ?? {}) as Json;
    const replyBody = (res: BotResponse): Json => (replyOf(res).body ?? {}) as Json;

    const tgReply = await sync({ channel: 'telegram', externalId: 'verify-botreg-tg-reply-1' });

    await check('⚠ the Telegram first turn carries a COMPLETE sendMessage body', () => {
        const body = replyBody(tgReply);
        const markup = (body.reply_markup ?? {}) as Json;
        const keyboard = (markup.keyboard ?? []) as Array<Array<Json>>;
        return replyOf(tgReply).channel === 'telegram'
            && replyOf(tgReply).method === 'sendMessage'
            && body.chat_id === 'verify-botreg-tg-reply-1'
            && body.text === next(tgReply).prompt
            && keyboard[0]?.[0]?.request_contact === true
            && typeof keyboard[0]?.[0]?.text === 'string'
            && markup.one_time_keyboard === true
            && markup.resize_keyboard === true;
    });

    await check('⚠ the reply is TOP-LEVEL — one expression serves every response shape', () =>
        tgReply.body.reply !== undefined && (tgReply.body.data as Json).reply === undefined);

    await check('`prompt` and `customerMessage` are KEPT beside it, not replaced', () =>
        typeof next(tgReply).prompt === 'string');

    await check('the reply is written in the language the envelope asked for', async () => {
        const fr = await sync({ channel: 'telegram', externalId: 'verify-botreg-tg-reply-fr', language: 'fr' });
        const text = String(replyBody(fr).text ?? '');
        const label = String(
            ((((replyBody(fr).reply_markup as Json)?.keyboard as Array<Array<Json>>)?.[0]?.[0]) ?? {}).text ?? '',
        );
        // The button label too — the one string the walkthrough used to hand to n8n.
        return /téléphone/i.test(text) && /numéro/i.test(label);
    });

    await check('⚠ WhatsApp gets a Meta Cloud API body, not a Telegram one', async () => {
        const res = await sync(wa('237600000396'));
        await UserModel.deleteMany({ login_phone: '+237600000396' });
        await CustomerModel.deleteMany({ phone: '+237600000396' });
        await ChannelConnectionModel.deleteMany({ external_id: '237600000396' });
        const body = replyBody(res);
        return replyOf(res).channel === 'whatsapp'
            && replyOf(res).method === 'messages'
            && body.messaging_product === 'whatsapp'
            && body.to === '237600000396'
            && body.recipient_type === 'individual';
    });

    await check('⚠ a FAILURE carries one too, built from error.customerMessage', async () => {
        const res = await call('/api/internal/bot/cart/get', {}, { channel: 'telegram', externalId: '99000123' });
        const error = (res.body.error ?? {}) as Json;
        return res.status >= 400
            && typeof error.customerMessage === 'string'
            && replyBody(res).text === error.customerMessage;
    });

    await check('⚠ a needs-contact refusal renders the KEYBOARD, not just the sentence', async () => {
        // The one refusal whose copy says "tap the button below" in five languages. A
        // sentence naming a control nobody rendered is worse than one that does not.
        const res = await call(
            '/api/internal/bot/identity/resolve',
            {},
            { channel: 'telegram', externalId: '99000124' },
        );
        const markup = (replyBody(res).reply_markup ?? {}) as Json;
        const keyboard = (markup.keyboard ?? []) as Array<Array<Json>>;
        return (res.body.error as Json)?.code === 'BOT_IDENTITY_NEEDS_CONTACT'
            && keyboard[0]?.[0]?.request_contact === true;
    });

    await check('⚠ a replayed idempotent response carries the SAME reply', async () => {
        const key = nextKey();
        const id = { channel: 'telegram', externalId: 'verify-botreg-tg-reply-idem' };
        const a = await sync(id, { idempotencyKey: key });
        const b = await sync(id, { idempotencyKey: key });
        // The interceptor is mounted AFTER the idempotency guard precisely so the stored
        // body already contains the reply. The other order replays a 200 with nothing to
        // send, and the customer is told nothing while the log shows a success.
        return JSON.stringify(a.body.reply) === JSON.stringify(b.body.reply)
            && a.body.reply !== undefined;
    });

    await check('⚠ a SKIPPABLE step ships a Skip BUTTON, and the token is not translated', () => {
        /**
         * `named` is the § 4 response that advanced to `email` on a French account. The
         * label is French and the id is not — which is the whole reason the refusal stopped
         * being a word the customer types.
         */
        // ⚠ `named` is a WHATSAPP identity, so this is a Cloud API interactive body — not a
        // Telegram `inline_keyboard`. The token is the half that is identical on both.
        const interactive = (replyBody(named).interactive ?? {}) as Json;
        const action = (interactive.action ?? {}) as Json;
        const buttons = (action.buttons ?? []) as Array<Json>;
        const reply = (buttons[0]?.reply ?? {}) as Json;
        const bodyText = String(((interactive.body ?? {}) as Json).text ?? '');
        return interactive.type === 'button'
            && reply.id === 'skip:email'
            && reply.title === 'Passer'
            && bodyText.includes('e-mail');
    });

    await check('⚠ …and pressing it really skips the step, with no word parsed anywhere', async () => {
        // The token maps to the body that already existed. What changed is how the customer
        // reaches it: `callback_query.data` → `{ step, action }`, no language involved.
        const [verb, step] = 'skip:email'.split(':');
        const res = await onboard(wa(NEW_WA_PHONE_ID), { step, action: verb });
        return res.status === 200
            && ((onboarding(res).steps ?? []) as Array<Json>)
                .find((s) => s.step === 'email')?.state === 'skipped';
    });

    await check('a finished checklist sets NO reply — that turn belongs to the model', () => {
        // `named`/`skippedEmail` walked the checklist in § 4; the last response there has
        // nothing left to ask, and a cheerful "all done!" would talk over the answer to
        // whatever the customer actually came to ask.
        return done.body.reply === undefined && onboarding(done).next === null;
    });

    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n────────────────────────────────────────────────────────────────────────────');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('────────────────────────────────────────────────────────────────────────────\n');
}

main()
    .catch((error) => {
        failed++;
        console.error('\n💥 the suite itself threw:', error);
    })
    .finally(async () => {
        await cleanup();
        await Promise.allSettled(
            spentScopes.map(([scope, key]) => botIdempotencyStore.release(scope, key)),
        );
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await mongoose.disconnect();
        await closeRedisClients();
        process.exit(failed > 0 ? 1 : 0);
    });
