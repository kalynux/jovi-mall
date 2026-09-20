import bcrypt from 'bcrypt';
import { ClientSession } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { generateSystemPassword } from '../../../core/auth/system-password';
import { TransactionManager } from '../../../core/database/transaction.manager';
import { connectionService, ConnectionService, maskIdentity } from '../../channel-connections';
import { CustomerModel, ICustomer } from '../../customers/customer.model';
import { UserModel } from '../../users/user.model';
import { WhatsappService } from '../../whatsapp/whatsapp.service';
import {
    loginIdentityResolver,
    LoginIdentityResolver,
    messagingPhoneToE164,
    RegistrationIdentityResolution,
    ResolvedRegistrationAccount,
} from '../../messaging-login/services/identity-resolver.service';
import {
    applyOnboardingStep,
    BotOnboardingRecord,
    BotOnboardingStep,
    isOnboardingComplete,
    isRequiredStep,
    normalizeOnboarding,
    onboardingChanged,
    seedOnboarding,
} from '../domain/bot-onboarding';
import { BotIdentityEnvelope } from './bot-identity.service';

/**
 * Registration on first contact, and the chat-collected profile that follows it — GAP-002.
 *
 * ── WHAT CHANGED FROM THE WRITTEN SPECIFICATION, AND ON WHOSE SAY-SO ────────
 * `api-doc/n8n/BACKEND-GAPS.md` § GAP-002 specifies an EXPLICIT-CONSENT flow: the bot asks
 * "would you like an account?", mints a single-use `consentToken`, and creates nothing
 * until it comes back. **Two of its five design decisions were reversed by the product
 * owner on 2026-08-26**, and both reversals are load-bearing enough to state here rather
 * than only in the doc:
 *
 *   **D-2 — consent is no longer asked.** The account is created on the sender's first
 *   message, silently. There is no `consentToken` and no route that mints one. The
 *   argument the doc makes against this is unchanged and correct — creating an account is
 *   a durable act with a data-protection footprint, and a person who messaged a shop to
 *   ask a price did not ask for one — so it is recorded as an accepted cost rather than
 *   settled. What softens it: nothing is collected that the channel did not already hand
 *   over (an identifier and a profile name), and every field beyond that is asked for one
 *   turn at a time with a real refusal available.
 *
 *   **D-3 — a business account IS now upgraded.** GAP-002 D-3, ARCHITECTURE §3.3 and the
 *   catalogue's own `when_not_to_use` all say a vendor, agency or agent is never handed a
 *   shopping account. The owner's position is that every inbound chat is a customer
 *   conversation, so a business account acquires a customer role and profile like anybody
 *   else. ⚠ **The consequence to know before building on this**: once that role exists,
 *   `resolveForLogin` starts succeeding for that person, so the bot `/login` command will
 *   mint them a customer session where it used to refuse. Nothing else about their vendor
 *   account changes, and `/reset-password` still resolves against the roles they actually
 *   hold.
 *
 * D-1 (reuse the ladder), D-4 (the password rule) and D-5 (seed the language honestly) are
 * implemented exactly as written.
 *
 * ── IT DOES NOT CALL `AuthService.register`, AND THAT IS THE POINT ──────────
 * `register` and `addRole` both mint a token pair as their last act. Calling either from
 * here would put a live customer session inside this module's call graph — the one thing
 * the whole curated-surface design exists to prevent, and the thing `test:bot-surface`
 * source-scans for. Discarding the returned tokens is not good enough: the invariant worth
 * having is "no code path from this surface reaches a token", not "we throw them away".
 *
 * So the six lines that create a User and a Customer are written out, with
 * `generateSystemPassword()` — the same helper, the same bcrypt cost, the same
 * disclosed-to-nobody password D-4 requires. This is a deliberate duplication of a small
 * mechanism to avoid an import that would defeat a security property; the alternative was
 * a no-token variant of `register`, which is a bigger change to a hotter file.
 *
 * ── THE CONNECTION IS BOUND AFTER THE COMMIT, NOT INSIDE IT ─────────────────
 * `ConnectionService.bindVerifiedIdentity` is not session-aware, so User + Customer commit
 * first and the binding follows. A crash in between leaves an account with no connection
 * row — and that state REPAIRS ITSELF on the very next message, by construction: on
 * WhatsApp step 2 of the ladder re-finds the account by phone and binds it, and on Telegram
 * the sender is asked for their contact again and the same phone resolves the same account.
 * A window that heals on the next inbound message was not worth making the connection
 * service session-aware for.
 */

/** `Customer.name` is `required: true` and a channel may hand over no profile name. */
const PLACEHOLDER_NAME = 'Customer';

/**
 * D-5, honestly. Telegram sends `from.language_code`; WhatsApp sends nothing at all.
 *
 * Mapped only on an exact match against the five languages every notification catalog has
 * copy for — a `de` seeded here would produce a profile every consumer falls back from
 * silently. Anything else takes the platform default and `/language` corrects it.
 */
const SEEDABLE_LANGUAGES = Object.freeze(['en', 'fr', 'pt', 'es', 'ar'] as const);
const DEFAULT_LANGUAGE = 'en';

export interface BotRegistrationOutcome {
    account: ResolvedRegistrationAccount;
    /** True only on the call that created the `users` row. */
    createdAccount: boolean;
    /** True when this call attached the customer role to an account that lacked it. */
    createdCustomerProfile: boolean;
    customer: ICustomer;
}

export class BotRegistrationService {
    constructor(
        private readonly resolver: LoginIdentityResolver = loginIdentityResolver,
        private readonly connections: ConnectionService = connectionService,
        private readonly transactions: TransactionManager = new TransactionManager(),
        private readonly whatsappWindow: WhatsappService = new WhatsappService(),
    ) {}

    // ─────────────────────────────────────────────────────────────────────────
    // The every-message entry point
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Upsert the customer behind this messaging identity.
     *
     * Called on EVERY inbound message, so the common case — an established customer — must
     * be cheap and must write nothing. It is: the resolution is one indexed lookup on
     * `channel_connections`, and a customer whose onboarding is already recorded takes the
     * early return below without a single write.
     *
     * ⚠ **Telegram cannot register here and that is not a limitation of this method.** A
     * `chat_id` bears no relation to any phone number, so an unbound Telegram chat is
     * ANONYMOUS — there is no account to create one for and nowhere to record anything
     * about the sender. It returns `null` (which the controller renders as
     * `registered: false` with `next.step: 'phone'`), and the account is created by the
     * contact share on `POST /identity/onboarding`. The alternative — an identifier-less
     * `users` row created immediately — was considered and declined: a row with neither
     * `login_email` nor `login_phone` can never be signed into, can never be found by a
     * password reset, and would collide the moment the person shared a number that already
     * belonged to an account.
     */
    async sync(envelope: BotIdentityEnvelope): Promise<BotRegistrationOutcome | null> {
        /**
         * ⚠ FIRST, AND BEFORE EVERY EARLY RETURN. An inbound message is a fact about the
         * channel, not about whether we could resolve an account from it — a Telegram
         * first-contact (`needs_contact`), a suspended account (`assertNotRefused` throws)
         * and an established customer all messaged us just the same. Placing this after the
         * resolution would record only the cases that happen to succeed.
         */
        await this.recordInboundActivity(envelope);

        const resolution = await this.resolver.resolveForRegistration(
            envelope.channel,
            envelope.externalId,
        );

        if (resolution.status === 'resolved') {
            return this.ensureCustomer(resolution.account, envelope, false);
        }

        // Telegram, first contact. Nothing to create, nothing to refuse — the contact share
        // is the next step and the controller says so.
        if (resolution.status === 'needs_contact') return null;

        /**
         * ⚠ **A suspended account is REFUSED, not routed around.** Without this branch the
         * `no_account` fallthrough below would create a SECOND account for the same person
         * the moment the first was suspended — an administrator's decision undone by the
         * suspended person sending one message. `identity_taken` is the same shape of
         * refusal arriving from the connection index.
         */
        this.assertNotRefused(resolution);

        // `no_account`. On WhatsApp the sender id IS a phone number we can register with;
        // on Telegram this branch is unreachable, having been answered above.
        const phone = messagingPhoneToE164(envelope.externalId);
        if (envelope.channel !== 'whatsapp' || !phone) return null;

        return this.createAccount(envelope, phone);
    }

    /**
     * Record that a message arrived on this channel — the two stamps that nothing wrote.
     *
     * ── Why this is here and not in the adapter ──────────────────────────────────
     *
     * `POST /api/webhooks/whatsapp` already calls `WhatsappService.recordInbound`, and for
     * a while that looked like the answer. It is not: the automation layer only reaches
     * that path on the COMMAND branch (`run command` in `wi-mall-core`), so an ordinary
     * chat message never touched it. `sync` is the one entry point n8n calls on EVERY
     * inbound — `Inbound → sync identity` is the first edge in the workflow — which is
     * what makes it the only honest place for this.
     *
     * ── The two stamps answer different questions and both were dead ─────────────
     *
     *   `channel_connections.last_seen_at` — "when did this account last message us?"
     *       Declared with that exact docstring, given a `touch()` repository method AND a
     *       best-effort service wrapper, and then called by nothing. It was written only by
     *       `bind()`, so it recorded when the connection was made, never its use. ⚠ Read
     *       that field's own docstring before touching this: its predecessor, `wa.last_seen_at`,
     *       was declared on all four role models and written by absolutely nothing. This is
     *       the second time the same field has rotted; `test:connections` now pins it.
     *
     *   `open_chat_window:<digits>` — "may we send free-form text right now?"
     *       Meta allows a free-form reply for 24 hours after an inbound message; outside it
     *       only an approved template may be sent. With nothing writing this key the answer
     *       was permanently NO, which sent WhatsApp phone verification down the template
     *       path on every single attempt — and both OTP templates are currently unsendable,
     *       so every code failed to deliver. See `phone-verification.service.ts`.
     *
     * ── Best-effort, and deliberately so ─────────────────────────────────────────
     *
     * Neither stamp may fail the message that triggered it. `ConnectionService.touch`
     * already swallows its own errors; `recordInbound` is a raw Redis write and does not,
     * so it is wrapped here. A customer losing their reply because a bookkeeping write
     * missed would be a far worse failure than a window we under-report — and
     * under-reporting merely restores the behaviour that existed before this method.
     *
     * ⚠ **WhatsApp only for the window.** The 24-hour rule is Meta's; Telegram has no such
     * concept and stamping it there would put a WhatsApp-shaped key under a Telegram id.
     * `last_seen_at` is channel-agnostic and is stamped for both.
     */
    private async recordInboundActivity(envelope: BotIdentityEnvelope): Promise<void> {
        await this.connections.touch(envelope.channel, envelope.externalId);

        if (envelope.channel !== 'whatsapp') return;

        try {
            /**
             * BARE DIGITS, which is what the adapter delivers and what Meta addresses by.
             * `PhoneVerificationService.deliver` derives the same key from the other side
             * with `phone.replace(/^\+/, '')` — the two must agree or the window is written
             * under one id and read under another.
             */
            await this.whatsappWindow.recordInbound(envelope.externalId);
        } catch (error) {
            console.error('[BotRegistration] Failed to open the WhatsApp service window:', error);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Account creation and upgrade
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Create the `users` row and its customer profile, in one transaction.
     *
     * `phone` is already E.164 — repaired by `messagingPhoneToE164` at both call sites,
     * because `wa_phone_id` arrives as bare digits and Telegram's `contact.phone_number` is
     * inconsistent about its `+`. Writing the raw value here would create accounts nothing
     * can ever find again.
     *
     * The `phone` onboarding step is seeded as **provided**: the number was not typed into
     * a form, it was proved by the inbound message itself (WhatsApp) or by Telegram's own
     * signup verification (the contact share). Asking for it afterwards would be asking a
     * person to confirm the number they are visibly writing from.
     */
    private async createAccount(
        envelope: BotIdentityEnvelope,
        phone: string,
    ): Promise<BotRegistrationOutcome> {
        const now = new Date();
        const displayName = cleanName(envelope.displayName);
        const passwordHash = await bcrypt.hash(generateSystemPassword(), 10);

        const created = await this.transactions.runInTransaction(async (session) => {
            const [user] = await UserModel.create(
                [{
                    login_phone: phone,
                    password_hash: passwordHash,
                    roles: ['customer'],
                    status: 'active',
                }],
                { session },
            );

            const customer = await this.insertCustomer(user._id, {
                name: displayName ?? PLACEHOLDER_NAME,
                phone,
                language: seedLanguage(envelope),
                channel: envelope.channel,
                // The name is pre-filled but NOT confirmed: a WhatsApp profile name is
                // whatever the person set on their phone, and it is what a delivery agent
                // will read. `name` therefore stays a required, pending step even when it
                // already has a plausible value in it.
                onboarding: seedOnboarding(['phone'], now),
                session,
            });

            return { user, customer };
        });

        await this.bind(created.user._id.toString(), envelope);
        await this.seedNotificationChannel(created.customer._id.toString(), envelope.channel);

        return {
            account: {
                userId: created.user._id.toString(),
                customerId: created.customer._id.toString(),
                roles: ['customer'],
                channel: envelope.channel,
                externalIdentity: envelope.externalId,
                identityHint: maskIdentity(envelope.channel, envelope.externalId, envelope.handle ?? null),
            },
            createdAccount: true,
            createdCustomerProfile: true,
            customer: created.customer,
        };
    }

    /**
     * A located account, guaranteed to hold a customer profile and an onboarding record
     * afterwards.
     *
     * Three states arrive here and only the first is free:
     *
     *   1. **A customer with onboarding already recorded** — the overwhelmingly common
     *      case, on every message after the first. Returns without writing.
     *   2. **A customer with NO onboarding record** — every account that predates GAP-002,
     *      and every account registered at the web form. Backfilled from what the profile
     *      actually holds (below), never seeded as all-pending: asking a customer of two
     *      years for the name and email already on their profile would be absurd.
     *   3. **An account with no customer profile at all** — a vendor, agency or agent. The
     *      D-3 reversal: the role is attached and a profile is created, seeded from the
     *      `users` row's own identifiers.
     */
    private async ensureCustomer(
        account: ResolvedRegistrationAccount,
        envelope: BotIdentityEnvelope,
        bindOnResolve: boolean,
    ): Promise<BotRegistrationOutcome> {
        if (bindOnResolve) await this.bind(account.userId, envelope);

        if (account.customerId) {
            const customer = await CustomerModel.findById(account.customerId);
            if (customer) {
                if (!customer.bot_onboarding) {
                    await this.backfillOnboarding(customer, envelope);
                }
                return {
                    account,
                    createdAccount: false,
                    createdCustomerProfile: false,
                    customer,
                };
            }
            /**
             * The resolver said there was a profile and it is gone between two reads. A
             * concurrent deletion, or a fixture cleaning up mid-conversation. Falling
             * through to the create branch is the right repair — the alternative is a 500
             * on a route the customer reaches by saying "hello".
             */
        }

        // ── State 3: attach the customer role and build the profile ──────────
        const now = new Date();
        const created = await this.transactions.runInTransaction(async (session) => {
            const user = await UserModel.findById(account.userId).session(session);
            if (!user) {
                throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404);
            }

            /**
             * `$addToSet`, never `$push`. This runs on every message until the profile
             * exists, and two messages arriving together would otherwise leave `roles`
             * holding `['vendor','customer','customer']` — which every `roles.includes`
             * check tolerates and every roles listing renders wrong.
             */
            if (!user.roles.includes('customer')) {
                await UserModel.updateOne(
                    { _id: user._id },
                    { $addToSet: { roles: 'customer' } },
                    { session },
                );
            }

            const customer = await this.insertCustomer(user._id, {
                name: cleanName(envelope.displayName) ?? PLACEHOLDER_NAME,
                phone: user.login_phone,
                email: user.login_email,
                language: seedLanguage(envelope),
                channel: envelope.channel,
                // The phone step is satisfied iff the ACCOUNT already carries a number —
                // which it does for every account this platform can create. Deriving it
                // rather than hardcoding `['phone']` keeps the checklist honest for a
                // legacy row that somehow has none.
                onboarding: seedOnboarding(user.login_phone ? ['phone'] : [], now),
                session,
            });

            return customer;
        });

        await this.seedNotificationChannel(created._id.toString(), envelope.channel);

        console.log(
            `[BotSurface] attached a customer profile to user ${account.userId} `
            + `from ${envelope.channel} (roles were: ${account.roles.join(',') || 'none'})`,
        );

        return {
            account: { ...account, customerId: created._id.toString() },
            createdAccount: false,
            createdCustomerProfile: true,
            customer: created,
        };
    }

    /**
     * Give a pre-GAP-002 customer a checklist that reflects what they already told us.
     *
     * ⚠ **Derived from field presence, and that is not a contradiction of the domain
     * file's argument for storing state.** The argument there is that presence cannot
     * distinguish "not asked" from "declined", which is true — and on an account created
     * BEFORE this feature existed, nothing was ever declined, so there is nothing for
     * presence to be wrong about. It is the one moment the derivation is sound, and it
     * happens exactly once per account.
     *
     * A saved address counts as the `address` step, an email as the `email` step, and the
     * name and phone as themselves. What is genuinely absent stays `pending` and the bot
     * will ask for it once, which is the correct outcome.
     */
    private async backfillOnboarding(customer: ICustomer, envelope: BotIdentityEnvelope): Promise<void> {
        const now = new Date();
        let records = seedOnboarding([], now);

        const satisfied: BotOnboardingStep[] = [];
        if (customer.phone) satisfied.push('phone');
        if (customer.name && customer.name !== PLACEHOLDER_NAME) satisfied.push('name');
        if (customer.email) satisfied.push('email');
        if ((customer.saved_addresses?.length ?? 0) > 0) satisfied.push('address');

        for (const step of satisfied) {
            records = applyOnboardingStep(records, step, 'provided', now);
        }

        await this.persistOnboarding(customer, records, envelope.channel, now);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Onboarding
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Record one answer, and write whatever value came with it onto the profile.
     *
     * The two halves are not separable: a `name` step marked `provided` with the name not
     * actually written is an account that will never be asked again for a name it does not
     * have. So every branch below writes the value and the record in one `save()`.
     */
    async applyStep(
        customer: ICustomer,
        step: BotOnboardingStep,
        action: 'provide' | 'skip',
        value: { name?: string; email?: string },
        channel: string,
    ): Promise<ICustomer> {
        const now = new Date();

        if (action === 'skip') {
            if (isRequiredStep(step)) {
                throw createAppError(ERROR_CODES.BOT_ONBOARDING_STEP_NOT_SKIPPABLE, 422, undefined, {
                    step,
                });
            }

            /**
             * A Skip that changes nothing writes nothing — see `applyOnboardingStep`, which
             * owns the rule that a stale Skip cannot overwrite an answered step. The
             * customer is returned as it stands, so the caller still answers with the
             * CURRENT checklist (`onboarding.next` and all) rather than with a refusal: the
             * person tapped a button that was true when it was drawn, and telling them their
             * email was declined — or erroring at them — are both wrong answers to it.
             */
            const before = currentRecords(customer);
            const records = applyOnboardingStep(before, step, 'skipped', now);
            if (!onboardingChanged(before, records)) return customer;

            return this.persistOnboarding(customer, records, channel, now);
        }

        switch (step) {
            case 'name': {
                const name = cleanName(value.name);
                if (!name) throw missingValue(step, 'name');
                customer.name = name;
                break;
            }
            case 'email': {
                const email = value.email?.trim().toLowerCase();
                if (!email) throw missingValue(step, 'email');
                /**
                 * Written to the PROFILE only, never to `User.login_email`.
                 *
                 * `login_email` is an account identifier with a unique index and its own
                 * proof-of-control flow (`pending_email` + a hashed token). A chat message
                 * proves nothing about an address, so promoting one here would let anybody
                 * claim any unused address as a login identifier by typing it at a bot —
                 * and, on a collision, would fail with a duplicate-key error mid-flow.
                 * `email_verified` therefore stays false and the ordinary verification path
                 * is still what promotes it.
                 */
                customer.email = email;
                customer.email_verified = false;
                break;
            }
            case 'phone':
            case 'address':
                /**
                 * Both are recorded here and WRITTEN ELSEWHERE, because both need a proof
                 * this method does not have. `phone` is established by the contact share in
                 * `registerFromContact`, and `address` by `POST /addresses`, which spends a
                 * single-use geo candidate handle — the GAP-005 mechanism that makes it
                 * structurally impossible to save an ungeocoded address. The controller
                 * routes both before reaching this switch.
                 */
                break;
            default: {
                const unreachable: never = step;
                throw missingValue(unreachable, 'value');
            }
        }

        const records = applyOnboardingStep(currentRecords(customer), step, 'provided', now);
        return this.persistOnboarding(customer, records, channel, now);
    }

    /**
     * The Telegram completion: a verified contact creates or attaches the account.
     *
     * ⚠ **`contact.user_id === the sender` must ALREADY have been enforced by the caller**,
     * exactly as it must before `resolveFromVerifiedContact`. A Telegram user can share
     * somebody else's contact card and it arrives in the same shape — without that guard
     * this method creates an account bound to a stranger's phone number, which is a worse
     * outcome than the sign-in takeover the guard was originally written for.
     */
    async registerFromContact(
        envelope: BotIdentityEnvelope,
        phoneNumber: string,
    ): Promise<BotRegistrationOutcome> {
        const phone = messagingPhoneToE164(phoneNumber);
        if (!phone) {
            throw createAppError(ERROR_CODES.MAGIC_CONTACT_UNVERIFIED, 400, undefined, {
                reason: 'unparseable_phone',
            });
        }

        const resolution = await this.resolver.resolveRegistrationFromVerifiedContact(
            envelope.externalId,
            phone,
        );

        if (resolution.status === 'resolved') {
            // Binds FIRST here, unlike `sync`: this is the moment the chat earns its claim
            // on the account, and every later message resolves through step 1 because of it.
            return this.ensureCustomer(resolution.account, envelope, true);
        }

        this.assertNotRefused(resolution);

        // `no_account` — nobody holds this number. Create, and bind to this chat.
        return this.createAccount(envelope, phone);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shared internals
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * The refusals that must never fall through to "create an account".
     *
     * Kept as one method with an exhaustiveness check rather than two `if`s at each call
     * site: a status added to `IdentityResolution` later fails to COMPILE here, instead of
     * silently reaching a create branch that mints a duplicate account.
     */
    private assertNotRefused(
        resolution: Exclude<RegistrationIdentityResolution, { status: 'resolved' }>,
    ): void {
        switch (resolution.status) {
            case 'account_inactive':
                throw createAppError(ERROR_CODES.AUTH_ACCOUNT_SUSPENDED, 403, undefined, {
                    state: 'non_customer',
                    reason: 'account_inactive',
                });
            case 'identity_taken':
                throw createAppError(ERROR_CODES.BOT_REGISTRATION_IDENTITY_TAKEN, 409, undefined, {
                    reason: 'identity_taken',
                });
            case 'not_customer':
                /**
                 * Structurally unreachable: `resolveForRegistration` has no role gate, so
                 * `gateForRegistration` cannot produce this. Left as an explicit case rather
                 * than folded into the default, so removing that property from the register
                 * intent surfaces here rather than at a `never` assignment nobody reads.
                 */
                throw createAppError(ERROR_CODES.BOT_IDENTITY_NOT_CUSTOMER, 403);
            case 'needs_contact':
            case 'no_account':
                return;
            default: {
                const unreachable: never = resolution;
                return unreachable;
            }
        }
    }

    private async insertCustomer(
        userId: unknown,
        input: {
            name: string;
            phone?: string;
            email?: string;
            language: string;
            channel: string;
            onboarding: BotOnboardingRecord[];
            session: ClientSession;
        },
    ): Promise<ICustomer> {
        const now = new Date();
        const [customer] = await CustomerModel.create(
            [{
                user_id: userId,
                name: input.name,
                phone: input.phone,
                email: input.email,
                /**
                 * ⚠ **`phone_verified: true` — and it is a claim this path can actually
                 * make.** The number was not typed into a form: on WhatsApp the message
                 * arrived FROM it, and on Telegram it is the number Telegram itself
                 * verified at signup and the sender proved is theirs. That is a stronger
                 * proof than the web registration path has, which sets this false and never
                 * sends an SMS to change it.
                 */
                phone_verified: Boolean(input.phone),
                // Never true here, whatever the account holds. See `applyStep`'s email case.
                email_verified: false,
                status: 'active',
                preferences: { language: input.language },
                bot_onboarding: {
                    complete: isOnboardingComplete(input.onboarding),
                    steps: input.onboarding,
                    source_channel: input.channel,
                    started_at: now,
                    completed_at: isOnboardingComplete(input.onboarding) ? now : null,
                },
            }],
            { session: input.session },
        );
        return customer;
    }

    /**
     * Write the checklist and its derived `complete` flag together, never apart.
     *
     * `complete` is redundant with `steps` by construction, and it is stored anyway for one
     * reason: it is the thing an operator, a future report and a `$match` filter will want,
     * and re-deriving a four-element predicate inside an aggregation is how the two answers
     * start disagreeing. Writing them in one `save()` is what keeps the redundancy safe —
     * the same discipline `UserRepository.updatePassword` follows for the hash and its epoch
     * stamp.
     *
     * `completed_at` is stamped once and never cleared. Onboarding cannot regress — a
     * provided step can be re-provided but never un-provided — so a cleared stamp would
     * only ever be a bug, and keeping the first one is the honest record of when the
     * account became usable.
     */
    private async persistOnboarding(
        customer: ICustomer,
        records: BotOnboardingRecord[],
        channel: string,
        now: Date,
    ): Promise<ICustomer> {
        const complete = isOnboardingComplete(records);
        const existing = customer.bot_onboarding;

        customer.bot_onboarding = {
            complete,
            steps: records,
            source_channel: existing?.source_channel ?? channel,
            started_at: existing?.started_at ?? now,
            completed_at: existing?.completed_at ?? (complete ? now : null),
        };

        await customer.save();
        return customer;
    }

    /**
     * Point the new customer's notifications at the channel they arrived on (GAP-012).
     *
     * ── WHY THIS IS PART OF REGISTRATION AT ALL ─────────────────────────────
     * `emailEnabled`, `telegramEnabled` and `whatsappEnabled` all default to **false**, so
     * a customer created here would receive in-app records and a push to a device token
     * they do not have — and NOTHING on the channel they are actually talking to us on.
     * Every proactive template GAP-012 asks for would be structurally unreachable for the
     * exact population GAP-002 exists to create: "your order shipped", "your parcel is out
     * for delivery", "your question has an answer" would all be written, approved,
     * addressed, and never sent.
     *
     * The product owner's decision (2026-08-26) is that arriving on a channel IS the
     * choice: somebody who opens a conversation on WhatsApp to buy something is not
     * surprised to hear about that purchase on WhatsApp. It is the same reading of intent
     * as the D-2 reversal above, applied one step later, and it is reversible in one
     * message — `notifications_update_preferences` with `channel: 'none'`.
     *
     * ── FOUR PROPERTIES ─────────────────────────────────────────────────────
     * 1. **New profiles only.** Called from the two paths that CREATE a customer, never
     *    from the backfill branch. An account of two years standing has a preference
     *    somebody chose, and registration is not the place to overrule it.
     * 2. **After the identity is bound**, so the connection the delivery path checks
     *    already exists. `determineDeliveryChannels` re-checks it live anyway — a
     *    preference pointing at a channel with no connection simply does not deliver —
     *    but ordering it this way means the first notification after registration works.
     * 3. **`upsertPreferences`, not a direct write**, so the "at most one secondary
     *    channel" rule is applied by the one place that owns it rather than asserted here.
     * 4. **Best-effort and self-catching.** A preference is not worth failing a
     *    registration over; the account and its binding are the durable part, and the
     *    customer can set this from the chat in one message. It is logged rather than
     *    swallowed, because silently having no channel is the exact failure this closes.
     */
    private async seedNotificationChannel(customerId: string, channel: string): Promise<void> {
        try {
            const { CustomerNotificationPreferenceRepository } = await import(
                '../../notifications/repositories/customer-notification-preference.repository'
            );
            await new CustomerNotificationPreferenceRepository().upsertPreferences(customerId, {
                telegramEnabled: channel === 'telegram',
                whatsappEnabled: channel === 'whatsapp',
                // Explicitly false rather than omitted: `upsertPreferences` only applies the
                // secondary-channel block when one of the three is definitively set, and
                // sending only the `true` would rely on its auto-disable rather than saying
                // what is meant. Same reasoning `BotNotificationController.update` gives.
                emailEnabled: false,
            });
        } catch (error) {
            console.error(
                `[BotSurface] could not seed the ${channel} notification channel for customer `
                + `${customerId} — they will receive no proactive messages until they set one`,
                error,
            );
        }
    }

    private async bind(userId: string, envelope: BotIdentityEnvelope): Promise<void> {
        await this.connections.bindVerifiedIdentity(userId, {
            channel: envelope.channel,
            externalId: envelope.externalId,
            displayName: envelope.displayName ?? null,
            // WhatsApp has no handle; passing one through would store a field that channel
            // can never produce, which a settings screen would then render.
            handle: envelope.channel === 'telegram' ? envelope.handle ?? null : null,
        });
    }
}

export const botRegistrationService = new BotRegistrationService();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The checklist as stored, completed into the current step list. */
export function currentRecords(customer: ICustomer): BotOnboardingRecord[] {
    return normalizeOnboarding(customer.bot_onboarding?.steps ?? null);
}

/**
 * A usable display name, or null.
 *
 * `Customer.name` has no `minlength`, but `RegisterSchema` holds every other path to two
 * characters and a one-character name on a delivery label is not a name. Clamped to 100 to
 * match the envelope's own bound — a messaging profile name is caller-supplied and reaches
 * a shipment label, an order confirmation and an agent's screen.
 */
function cleanName(raw: string | null | undefined): string | null {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed.length < 2) return null;
    return trimmed.length > 100 ? trimmed.slice(0, 100) : trimmed;
}

/** D-5 — seed from what the channel volunteered, and only on an exact match. */
function seedLanguage(envelope: BotIdentityEnvelope): string {
    const claimed = (envelope.language ?? '').trim().toLowerCase();
    return (SEEDABLE_LANGUAGES as readonly string[]).includes(claimed) ? claimed : DEFAULT_LANGUAGE;
}

function missingValue(step: string, field: string) {
    return createAppError(ERROR_CODES.BOT_ONBOARDING_VALUE_REQUIRED, 400, undefined, {
        step,
        field,
    });
}
