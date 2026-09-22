import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { connectionService } from '../../channel-connections';
import { CustomerRepository } from '../../customers/customer.repository';
import { CustomerProfileService } from '../../customers/services/customer-profile.service';
import { ICustomer } from '../../customers/customer.model';
import { OrderModel } from '../../orders/order.model';
import { FulfillmentStatus } from '../../orders/order.model';
import { geoCandidateStore } from '../services/geo-candidate.store';
import { botPendingQuestionStore } from '../services/bot-pending-question.store';
import { BotPendingQuestion, PendingQuestionOwner } from '../domain/bot-pending-question';
import {
    botCallerOf,
    botEnvelopeOf,
    setBotResponseLanguage,
} from '../middlewares/bot-identity.middleware';
import {
    botRegistrationService,
    BotRegistrationOutcome,
    currentRecords,
} from '../services/bot-registration.service';
import { BotOnboardingRecord, isOnboardingComplete, seedOnboarding } from '../domain/bot-onboarding';
import { sealBotIdentity } from '../domain/bot-identity-token';
import { BotSyncDto, toBotIdentityDto, toBotSyncDto } from '../dto/bot-projections';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { openSurfaceActionId, orderActionId, skipActionId } from '../domain/bot-action-id';
import { supportFormActionId } from '../domain/bot-ticket-actions';
import { BotIdentitySyncSchema, BotOnboardingSubmitSchema } from '../validators/bot.validators';
import { __toSavedAddressInput as toSavedAddressInput } from './bot-profile.controller';

const customerRepository = new CustomerRepository();
const customerProfileService = new CustomerProfileService();

/**
 * Fulfilment states in which nothing is still coming.
 *
 * Derived as the complement of these rather than listed positively, so a status added to
 * the order model is `open` until somebody decides otherwise — the safe direction for a
 * flag whose job is "is there anything worth asking about". A new status silently reading
 * as `closed` would make the bot open a conversation as though the customer had nothing
 * in flight.
 */
const SETTLED_FULFILMENT: readonly FulfillmentStatus[] = ['fulfilled', 'cancelled', 'returned'];

export class BotIdentityController {
    /**
     * `POST /api/internal/bot/identity/resolve` — who is this sender?
     *
     * The first call of any conversation whose context is cold, and the one the automation
     * layer caches for the rest of it. Everything it returns is something a later answer
     * depends on: the name to greet them by, the language to write in, whether there is an
     * order worth mentioning, and where else the platform can reach them.
     *
     * ⚠ **A 200 here always means `state: 'customer'`.** Every other sender state is a
     * REFUSAL carrying `details.state` and `details.reason` — `404 BOT_IDENTITY_UNRESOLVED`
     * with `state: 'anonymous'`, `409 BOT_IDENTITY_NEEDS_CONTACT` with the same,
     * `403 BOT_IDENTITY_NOT_CUSTOMER` with `state: 'non_customer'`. That is the catalogue's
     * own `errors` block for this tool, and it is what the registration flow (GAP-002)
     * reads to decide whether to offer an account. The field is on the DTO anyway so a
     * caller can branch on one shape rather than on a status code.
     */
    static resolve = asyncHandler(async (req: Request, res: Response) => {
        const caller = botCallerOf(req);

        // Read the Customer directly rather than through `CustomerProfileService.getProfile`,
        // which additionally resolves an avatar file and the unified payment-method store —
        // three extra reads for two fields, on the call every conversation makes first.
        const [customer, states, openOrder, pendingQuestion] = await Promise.all([
            customerRepository.findById(caller.customerId),
            connectionService.getStates(caller.userId),
            OrderModel.exists({
                customer_id: caller.customerId,
                fulfillment_status: { $nin: SETTLED_FULFILMENT },
            }),
            waitingQuestionOf(caller),
        ]);

        const envelope = botEnvelopeOf(req);

        sendSuccess(res, toBotIdentityDto({
            displayName: customer?.name ?? null,
            language: customer?.preferences?.language ?? null,
            connectedChannels: states.filter((s) => s.connection !== null).map((s) => s.channel),
            hasOpenOrders: openOrder !== null,
            identityHint: caller.identityHint,
            // ⚠ The maintenance fallback must key memory exactly as `/identity/sync` does.
            memoryEpoch: customer?.bot_memory_epoch ?? 0,
            pendingQuestion,
            /**
             * Sealed from the ENVELOPE this request carried, not from `caller`.
             *
             * ⚠ **The two are not interchangeable and only one of them round-trips.** A
             * `ResolvedBotCaller` names the account; the resolver's job is to turn a
             * messaging identity INTO one, and it cannot run backwards — an account
             * reachable from two channels has no single `externalId`. Sealing the envelope
             * is what makes the token unseal to the same sender the next call resolves.
             */
            botToken: sealBotIdentity({
                channel: envelope.channel,
                externalId: envelope.externalId,
                language: customer?.preferences?.language ?? envelope.language ?? null,
            }),
        }));
    });

    /**
     * `POST /api/internal/bot/identity/sync` — the every-message upsert (GAP-002).
     *
     * **Call this on EVERY inbound message.** It answers three questions in one round trip:
     * who is this, does an account exist for them now (creating one if not), and what is
     * still missing from their profile. `identity/resolve` remains the read-only version
     * for a caller that must not create anything — during a `readonly` maintenance window
     * this route is refused and that one still works.
     *
     * ⚠ **`isNew` is true exactly once per account** and is the first-message signal. A
     * caller that greets on `!onboarding.complete` instead will greet on every message
     * until the checklist finishes, which is a different behaviour and usually not the one
     * intended.
     *
     * ⚠ **An unbound Telegram chat answers 200 with `registered: false`, not a refusal.**
     * That is the difference from `identity/resolve`, which 409s with
     * `BOT_IDENTITY_NEEDS_CONTACT`. A `chat_id` maps to no phone number, so there is
     * genuinely no account to create yet — but "we need your number" is the ordinary,
     * expected first turn of a Telegram conversation rather than an error, and the response
     * carries `onboarding.next.step: 'phone'` so the caller renders the `request_contact`
     * keyboard from the same field it reads in every other state.
     */
    static sync = asyncHandler(async (req: Request, res: Response) => {
        BotIdentitySyncSchema.parse(req.body ?? {});
        const envelope = botEnvelopeOf(req);

        const outcome = await botRegistrationService.sync(envelope);

        if (!outcome) {
            // Telegram, first contact. No account, so no stored checklist — the pristine
            // one is reported, and its first step is the contact share.
            setBotResponseLanguage(req, envelope.language ?? null);
            const dto = toBotSyncDto({
                registered: false,
                isNew: false,
                upgraded: false,
                customer: null,
                records: seedOnboarding([], new Date()),
                channel: envelope.channel,
                // The envelope hint is all we know — there is no profile yet. That is why
                // the transport should forward Telegram's `from.language_code`: it is the
                // only thing standing between this prompt and English.
                language: envelope.language ?? null,
            });
            // The turn this whole route exists for. `describe` covers every other branch.
            setOnboardingReply(req, dto, envelope.language ?? null);
            sendSuccess(res, dto);
            return;
        }

        sendSuccess(
            res,
            await describe(req, outcome),
            // 201 on the call that created the account, 200 otherwise. `isNew` in the body
            // is the field a caller should branch on — the status is for the HTTP log.
            { status: outcome.createdAccount ? 201 : 200 },
        );
    });

    /**
     * `POST /api/internal/bot/identity/onboarding` — submit or skip one step (GAP-002).
     *
     * The step vocabulary, which are required, and what each accepts all come from
     * `onboarding.next` on the previous response. A caller that walks `next` in order can
     * never reach `BOT_ONBOARDING_NOT_REGISTERED` or `BOT_ONBOARDING_STEP_NOT_SKIPPABLE`;
     * both exist for a caller that guesses.
     *
     * ── THE THREE STEPS THAT ARE NOT JUST A FIELD WRITE ─────────────────────
     * `phone` creates or attaches the account (Telegram's contact share) and is the ONLY
     * step reachable before an account exists. `address` spends a single-use geo candidate
     * handle through the same service `POST /addresses` uses — so an address saved during
     * onboarding and one saved a month later are byte-identical documents, and neither can
     * be ungeocoded. `name` and `email` are plain writes.
     */
    static onboarding = asyncHandler(async (req: Request, res: Response) => {
        const input = BotOnboardingSubmitSchema.parse(req.body ?? {});
        const envelope = botEnvelopeOf(req);
        const step = input.step as BotOnboardingRecord['step'];

        // ── The phone step: the only one that may run with no account ────────
        if (step === 'phone') {
            if (input.action === 'skip') {
                throw createAppError(ERROR_CODES.BOT_ONBOARDING_STEP_NOT_SKIPPABLE, 422, undefined, {
                    step,
                });
            }
            if (!input.contact) {
                throw createAppError(ERROR_CODES.BOT_ONBOARDING_VALUE_REQUIRED, 400, undefined, {
                    step,
                    field: 'contact',
                });
            }

            /**
             * ⚠ **THE GUARD THE WHOLE FLOW RESTS ON.** A Telegram user can share somebody
             * else's contact card and it arrives in exactly this shape. Without this check
             * anyone could forward a victim's contact and have an account created against
             * that person's phone number — worse than the sign-in takeover the identical
             * guard in `login-contact.command.ts` was written for, because this one leaves a
             * durable account behind.
             *
             * The comparand is the ENVELOPE's `externalId` — the chat id the transport put
             * there from the webhook's own fields — never a payload-supplied `from.id`.
             * Taking both sides of the comparison from caller-supplied data would let anyone
             * who can reach this route satisfy it by sending two matching numbers, which is
             * not a guard at all.
             */
            if (String(input.contact.userId) !== String(envelope.externalId)) {
                console.warn(
                    `[BotSurface] refused a contact share on ${envelope.channel}:${envelope.externalId}`
                    + ' — the shared contact is not the sender\'s own',
                );
                throw createAppError(ERROR_CODES.MAGIC_CONTACT_UNVERIFIED, 400);
            }

            /**
             * ⚠ **The phone step can be the COMPLETING one too, rarely.** It is asked first, so
             * normally it cannot be — but a backfilled account (`backfillOnboarding` marks a
             * step satisfied from field presence) can hold a name, an email and an address with
             * `phone` still pending, and then sharing a contact finishes the checklist. An
             * account that does not exist yet was definitionally not complete a moment ago.
             */
            const before = req.bot?.caller
                ? await customerRepository.findById(req.bot.caller.customerId)
                : null;
            const wasComplete = before ? isOnboardingComplete(currentRecords(before)) : false;

            const outcome = await botRegistrationService.registerFromContact(
                envelope,
                input.contact.phoneNumber,
            );

            const dto = await describe(req, outcome);
            if (!wasComplete && isOnboardingComplete(currentRecords(outcome.customer))) {
                setWelcomeReply(req, outcome.customer.preferences?.language ?? null);
            }

            sendSuccess(res, dto, { status: outcome.createdAccount ? 201 : 200 });
            return;
        }

        // ── Every other step needs an account that already exists ────────────
        const caller = req.bot?.caller;
        if (!caller) {
            throw createAppError(ERROR_CODES.BOT_ONBOARDING_NOT_REGISTERED, 409, undefined, {
                step,
                // The one step that IS available in this state — so the refusal tells the
                // caller what to do rather than only what it may not.
                availableStep: 'phone',
            });
        }

        const customer = await customerRepository.findById(caller.customerId);
        if (!customer) {
            // The resolver produced a `customerId`, so the profile existed a query ago.
            throw createAppError(ERROR_CODES.AUTH_PROFILE_NOT_FOUND, 404, undefined, { role: 'customer' });
        }

        if (step === 'address' && input.action === 'provide') {
            if (!input.address) {
                throw createAppError(ERROR_CODES.BOT_ONBOARDING_VALUE_REQUIRED, 400, undefined, {
                    step,
                    field: 'address',
                });
            }

            const stored = await geoCandidateStore.consume(caller.userId, input.address.geoCandidateRef);
            if (!stored) {
                throw createAppError(ERROR_CODES.BOT_GEO_CANDIDATE_EXPIRED, 400, undefined, {
                    candidateRef: input.address.geoCandidateRef,
                });
            }

            await customerProfileService.addAddress(
                caller.customerId,
                toSavedAddressInput({
                    label: input.address.label,
                    addressLine2: input.address.addressLine2 ?? null,
                    /**
                     * The FIRST address a customer saves is their default whatever they
                     * asked for — `isDefault: false` on an empty list produces a customer
                     * with addresses and no default, which is a checkout that cannot pick
                     * one. Onboarding is by definition the empty-list case.
                     */
                    isDefault: input.address.isDefault || (customer.saved_addresses?.length ?? 0) === 0,
                    candidate: stored.candidate,
                    rawInput: stored.rawInput,
                }),
            );
        }

        /**
         * Read BEFORE the write — the welcome fires on the transition, not on the state. See
         * `setWelcomeReply`.
         */
        const wasComplete = isOnboardingComplete(currentRecords(customer));

        const updated = await botRegistrationService.applyStep(
            customer,
            step,
            input.action,
            { name: input.name, email: input.email },
            envelope.channel,
        );

        const dto = await describe(req, {
            account: { ...caller, customerId: caller.customerId, roles: [], },
            createdAccount: false,
            createdCustomerProfile: false,
            customer: updated,
        });

        /**
         * ⚠ **After `describe`, which is what makes this the last word.** `describe` calls
         * `setOnboardingReply`, which sets the next question — and on the completing call there
         * is no next question, so it sets nothing and leaves this standing. Setting the welcome
         * first would work today and would silently become a lost message the day that function
         * gains a branch for `next: null`.
         */
        if (!wasComplete && isOnboardingComplete(currentRecords(updated))) {
            setWelcomeReply(req, updated.preferences?.language ?? null);
        }

        sendSuccess(res, dto);
    });
}

/**
 * The shared response body for every registration and onboarding turn.
 *
 * One projection for both routes, deliberately: a caller that walks `next` through four
 * steps must not have to parse a different shape on the turn that happened to create the
 * account. The only fields that differ between them are `isNew` and `upgraded`.
 *
 * It also **sets the response language** from the customer's own profile, which is what
 * makes an error raised later in this request answerable in a language they read. See
 * `setBotResponseLanguage`.
 */
async function describe(req: Request, outcome: BotRegistrationOutcome) {
    const customer: ICustomer = outcome.customer;
    const language = customer.preferences?.language ?? null;
    setBotResponseLanguage(req, language);
    const envelope = botEnvelopeOf(req);

    const [states, openOrder, pendingQuestion] = await Promise.all([
        connectionService.getStates(outcome.account.userId),
        OrderModel.exists({
            customer_id: customer._id,
            fulfillment_status: { $nin: SETTLED_FULFILMENT },
        }),
        waitingQuestionOf({ userId: outcome.account.userId, channel: outcome.account.channel }),
    ]);

    const dto = toBotSyncDto({
        registered: true,
        isNew: outcome.createdAccount,
        upgraded: outcome.createdCustomerProfile && !outcome.createdAccount,
        customer: toBotIdentityDto({
            displayName: customer.name ?? null,
            language,
            connectedChannels: states.filter((s) => s.connection !== null).map((s) => s.channel),
            hasOpenOrders: openOrder !== null,
            identityHint: outcome.account.identityHint,
            /**
             * ⭐ Read off the document this route ALREADY loaded — the memory epoch costs no query
             * on the one call every inbound message makes.
             */
            memoryEpoch: customer.bot_memory_epoch ?? 0,
            pendingQuestion,
            // Sealed from the envelope, for the reason given in `resolve` above. This is
            // the mint that matters in practice: `/identity/sync` runs on EVERY inbound
            // message, so a conversation is handed a fresh token each turn and the TTL
            // never has to stretch to cover one.
            botToken: sealBotIdentity({
                channel: envelope.channel,
                externalId: envelope.externalId,
                language: language ?? envelope.language ?? null,
            }),
        }),
        records: currentRecords(customer),
        channel: outcome.account.channel,
        // The customer's OWN setting once the account exists — never the envelope hint,
        // which is a device locale and would override a deliberate `/language` choice.
        language,
    });

    setOnboardingReply(req, dto, language);
    return dto;
}

/**
 * The Yes/No question waiting for a typed answer in this conversation, for the model to see.
 *
 * ⚠ **Fail-open to null.** Every inbound message makes this call; a Redis blip must not fail the
 * turn. The cost of a null is that the model does not know about the question, and the customer
 * taps the button instead — nothing runs on its own.
 */
async function waitingQuestionOf(owner: PendingQuestionOwner): Promise<BotPendingQuestion | null> {
    try {
        return await botPendingQuestionStore.peek(owner);
    } catch (error) {
        console.warn('[BotSurface] could not read the question waiting for an answer', error);
        return null;
    }
}

/**
 * Turn the next onboarding step into the message to send.
 *
 * ── WHY THIS IS ONE FUNCTION AND NOT A FIELD ON THE DTO ─────────────────────
 * `toBotSyncDto` is pure and knows nothing about a channel's controls — it words the
 * question (`next.prompt`) and reports whether the answer is a verified contact
 * (`next.requestContact`). Turning that pair into a keyboard is a rendering decision, and
 * rendering lives behind `setBotReply` so that the whole surface has exactly one path to a
 * platform payload.
 *
 * ⚠ **A finished checklist sets NOTHING, and that is the important branch.** `next: null`
 * means the platform has no question left, and the turn belongs to whoever is answering what
 * the customer actually asked — the model. Emitting a cheerful "all done!" here would talk
 * over it, and would be the one sentence on this surface written for no reason other than
 * that a field was available to fill.
 *
 * ── A SKIPPABLE STEP SHIPS A BUTTON, NOT AN INSTRUCTION ─────────────────────
 * `next.skippable` used to be expressed in the PROSE — *"just say \"skip\" if you would
 * rather not"* — which asked the customer to type a word whose spelling depends on their
 * language, and therefore asked something downstream to know five spellings of one intent.
 * The step now carries a Skip action whose label is translated and whose **id is not**
 * (`skipActionId`). The prompt went back to being a plain question.
 *
 * ⚠ The rule generalises, and the next turn that needs it should follow it: **an answer
 * drawn from a set known in advance is a button, never typed text.** See
 * `bot-action-id.ts`.
 */
/**
 * The welcome — the one turn the platform gets to say "you are set up, here is what I can do".
 *
 * ⚠ **It fires on the call that COMPLETES the checklist, and on no other**, which is the
 * owner's decision that the welcome comes AFTER the setup questions rather than before them. A
 * greeting sent at first contact lands on somebody who has just been asked for their phone
 * number and has not answered yet; sent on every later sync it becomes the thing the customer
 * scrolls past to find their answer.
 *
 * ⚠ **`wasComplete` is why this takes two states rather than one.** "The checklist is complete"
 * is true for ever afterwards, so welcoming on that alone would greet the customer again every
 * time they later offered an email or re-shared their contact. The transition is the event; the
 * state is not.
 *
 * The three buttons are the owner's: Browse · My orders · Help. Exactly three, which is also
 * WhatsApp's cap on reply buttons — a fourth would be dropped silently by the renderer.
 * `ord:list` and `tkt:new` belong to the orders stream and are agreed with it.
 */
function setWelcomeReply(req: Request, language: string | null): void {
    setBotReply(req, {
        kind: 'text',
        text: botChrome('welcomePrompt', language),
        actions: [
            { id: openSurfaceActionId('pl'), label: botChrome('browseProductsButton', language) },
            /**
             * ⚠ **`orderActionId('list')` rather than the literal `'ord:list'`.** `list` is the
             * orders stream's documented sentinel — its parser checks for it BEFORE the 24-hex
             * id test, precisely because no order id can look like it — and going through the
             * builder keeps this token inside `token()`'s 64-byte check like every other. There
             * is no `orderListActionId()` to import; if that stream adds one, this should use it.
             */
            { id: orderActionId('list'), label: botChrome('myOrdersButton', language) },
            { id: supportFormActionId(), label: botChrome('getHelpButton', language) },
        ],
    });
}

function setOnboardingReply(req: Request, dto: BotSyncDto, language: string | null): void {
    const next = dto.onboarding.next;
    if (!next) return;

    if (next.requestContact) {
        // The phone step. A verified contact is its own control, and it is never skippable.
        setBotReply(req, {
            kind: 'contact_request',
            text: next.prompt,
            buttonLabel: botChrome('contactButton', language),
        });
        return;
    }

    if (next.requestLocation) {
        /**
         * The address step. A pin is the shortcut and typing still works, so this control
         * replaces the plain `text` + Skip action rather than sitting beside it.
         *
         * ⚠ **The Skip travels as `skipLabel`, not as an `action`.** On Telegram a location
         * request is a reply keyboard and `reply_markup` is a union, so an inline Skip
         * carrying `skip:address` cannot be on the same message. The renderer puts a second
         * keyboard button there instead, and the caller is handed the exact string it will
         * send back (`next.skipLabel`) so it never has to know the word.
         */
        setBotReply(req, {
            kind: 'location_request',
            text: next.prompt,
            buttonLabel: botChrome('locationButton', language),
            ...(next.skipLabel ? { skipLabel: next.skipLabel } : {}),
        });
        return;
    }

    setBotReply(req, {
        kind: 'text',
        text: next.prompt,
        // Absent — not an empty array — on a required step, so the renderer's own
        // "no actions" branch is what draws a plain message.
        ...(next.skippable
            ? {
                  actions: [
                      { id: skipActionId(next.step), label: botChrome('skipButton', language) },
                  ],
              }
            : {}),
    });
}
