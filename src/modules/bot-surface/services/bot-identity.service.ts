import {
    IdentityResolution,
    LoginIdentityResolver,
    loginIdentityResolver,
    ResolvedLoginAccount,
} from '../../messaging-login/services/identity-resolver.service';
import { MessagingChannel } from '../../channel-connections';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Who is the automation layer acting for?
 *
 * ── THE ONE RULE THIS FILE EXISTS TO HOLD ────────────────────────────────────
 * **The identity is never a parameter.** No route on this surface takes a `customerId`,
 * a `userId` or a token, and every one of them resolves its caller through this service
 * from the `identity` envelope the transport attached. That is the same rule `/connect`
 * already enforces, and for the same reason: the deleted `link` command let a caller name
 * somebody else's number, and on a surface that reaches carts, orders and addresses a
 * caller-supplied identity is not a leak but an account takeover.
 *
 * ── IT REUSES THE LADDER; IT DOES NOT REIMPLEMENT IT ─────────────────────────
 * `LoginIdentityResolver` already answers "which account is this chat?" — the three-step
 * ladder, the E.164 repair that `wa_phone_id` needs, and the refusal table. A second
 * implementation would be a second opinion about one fact, and the drift between them
 * would be a login bug. So this is a thin translation layer and deliberately nothing more:
 * it calls `resolveForLogin`, maps the six outcomes onto HTTP, and stops.
 *
 * The intent passed down is `login`, which is what gives this surface its customer gate
 * for free: a vendor, an agency or an agent messaging the bot is refused rather than
 * quietly handed a shopping account, and a customer role is never auto-provisioned.
 *
 * ⚠ **The resolver BINDS on success**, when the identity was not already bound — a
 * WhatsApp sender whose number matches an account gets a `channel_connections` row
 * written the first time they use a tool, exactly as they would from `/login`. That is
 * intended, and it is what makes step 1 of the ladder serve every later call. It happens
 * only on success: binding off the back of a refusal would record a durable claim about
 * an account the platform just declined to act for.
 *
 * ── `messagingPhoneToE164` IS NOT OPTIONAL, AND IT IS ALREADY IN THERE ───────
 * `wa_phone_id` arrives from Meta as bare digits (`237600123456`) while `login_phone` is
 * stored as strict E.164 (`+237600123456`), and the shared helpers do not bridge the gap.
 * A hand-rolled `findByPhone(externalId)` here would match NOTHING, FOR EVERY USER, while
 * looking perfectly implemented — which is the single easiest way to ship this broken.
 * Reusing the resolver is what makes that impossible rather than merely unlikely.
 */

/** The envelope every bot call carries. Derived by the automation layer from the webhook. */
export interface BotIdentityEnvelope {
    channel: MessagingChannel;
    /** `wa_phone_id` (bare digits) for WhatsApp; `chat_id` for Telegram. */
    externalId: string;
    /** Cosmetic. Stored on a new connection so a settings screen has something to show. */
    displayName?: string | null;
    /** Telegram `@handle` only. WhatsApp has none. */
    handle?: string | null;
    /**
     * Telegram's `from.language_code`. WhatsApp carries nothing (GAP-002 D-5).
     *
     * ⚠ **Read at REGISTRATION only, and never again.** It seeds `preferences.language` on
     * an account being created this instant, so a first reply is written in a language the
     * person plausibly reads instead of in English. Once the account exists,
     * `preferences.language` is the customer's own setting and this field must not touch
     * it: a Telegram client's locale is a device setting that changes when somebody borrows
     * a phone, and letting it overwrite a deliberate `/language` choice on every message
     * would make that setting impossible to keep.
     */
    language?: string | null;
}

/**
 * A resolved caller.
 *
 * Both ids are here and they are NOT interchangeable. `customerId` is the `Customer`
 * profile, which is what the cart, orders, addresses, wishlist, digital and notification
 * services scope on (`req.auth.role_entity._id` on the ordinary customer API). `userId`
 * is the `users` row, which is what bookings, tickets and reviews scope on
 * (`req.auth.user.id`). Passing one where the other is meant silently reads an empty
 * list rather than failing, which is why both travel together and neither is derived
 * from the other at a call site.
 */
export type ResolvedBotCaller = ResolvedLoginAccount;

/**
 * The three sender states from ARCHITECTURE §3.3, reported in `details.state` on every
 * identity refusal.
 *
 * A refusal carries it because the automation layer branches on it: `anonymous` on
 * Telegram means render the `request_contact` keyboard, `anonymous` on WhatsApp means
 * offer registration (GAP-002), and `non_customer` means tell them to sign in with their
 * password. Without it, three different conversations would have to be inferred from a
 * status code.
 */
export type BotSenderState = 'customer' | 'non_customer' | 'anonymous';

/** Why the sender is in that state. The resolver's own vocabulary, passed through. */
export type BotSenderReason =
    | 'resolved'
    | 'needs_contact'
    | 'no_account'
    | 'not_customer'
    | 'account_inactive'
    | 'identity_taken';

export class BotIdentityService {
    constructor(private readonly resolver: LoginIdentityResolver = loginIdentityResolver) {}

    /**
     * Resolve the envelope, or throw the mapped refusal.
     *
     * Throws rather than returning a union, unlike the resolver it wraps, and the reason
     * is where each is read from. The resolver's caller is a command handler that turns
     * every outcome into a sentence for a chat window, so a union keeps the whole copy
     * table visible in one `switch`. This one's caller is Express middleware, where a
     * refusal is an HTTP response and `next(error)` is how one is produced — a union
     * there would be re-thrown at every call site.
     */
    async resolve(envelope: BotIdentityEnvelope): Promise<ResolvedBotCaller> {
        const resolution = await this.resolver.resolveForLogin(
            envelope.channel,
            envelope.externalId,
            { displayName: envelope.displayName ?? null, handle: envelope.handle ?? null },
        );

        if (resolution.status === 'resolved') return resolution.account;

        throw refusalFor(resolution);
    }

    /**
     * Resolve, or answer null — the GAP-002 variant, for `anonymous` routes only.
     *
     * ⚠ **It refuses NOTHING, including a suspended account, and that is deliberate.**
     * Every refusal `resolve` raises is a statement about what this sender may *do*, and
     * the two routes that call this do not yet know what they are being asked to do — the
     * registration path has to be able to tell "no account at all" (create one) apart from
     * "an account this door will not act for" (do not create a second one). Collapsing
     * those would have `identity/sync` mint a duplicate account for every suspended
     * customer who sends a message.
     *
     * So the refusals move DOWN a layer, to `BotRegistrationService`, which re-runs the same
     * ladder under the `register` intent — no role gate — and can therefore tell a vendor
     * apart from a stranger. The consequence to hold on to: **a null here means UNRESOLVED,
     * never PERMITTED.** It is returned for a sender with no account, for an unbound
     * Telegram chat, for a suspended account and for a business account alike, and the
     * caller owes its own gate on every one of them.
     */
    async resolveSoftly(envelope: BotIdentityEnvelope): Promise<ResolvedBotCaller | null> {
        const resolution = await this.resolver.resolveForLogin(
            envelope.channel,
            envelope.externalId,
            { displayName: envelope.displayName ?? null, handle: envelope.handle ?? null },
        );

        return resolution.status === 'resolved' ? resolution.account : null;
    }
}

export const botIdentityService = new BotIdentityService();

/**
 * The refusal table, in one place.
 *
 * ── ⚠ WHAT REACHES THE CLIENT IS NOT WHAT IS WRITTEN HERE, AND THAT IS CORRECT ──
 * Phase 16 filters `details` at the BOUNDARY, keyed on category. The two `not_found` /
 * `conflict` refusals pass their `details` through, so `BOT_IDENTITY_UNRESOLVED` and
 * `BOT_IDENTITY_NEEDS_CONTACT` really do carry `state` and `reason` on the wire — which is
 * what the catalogue promises (`details_fields: ["state"]`) and what the registration flow
 * reads to decide whether to offer an account.
 *
 * The two **403s do not**. `AUTHORIZATION_DETAIL_KEYS` admits only `required`,
 * `requiredAny`, `resource` and `hint`, because an authorization failure that echoes facts
 * about the caller is a leak — that allowlist exists to stop `requireRole` sending `actual`
 * back. `state` and `reason` are dropped there, and nothing is lost: `BOT_IDENTITY_NOT_CUSTOMER`
 * already says the whole of what a client may know, and `reason` is precisely the field this
 * table refuses to disclose anyway (see `identity_taken` below). They are still WRITTEN,
 * because `details` on a refused request is journaled and reaches
 * `/api/internal/admin/system/errors`, where an operator investigating "the bot will not
 * serve me" needs to see which branch fired.
 *
 * **Do not "fix" this by widening `AUTHORIZATION_DETAIL_KEYS`.** `test:bot-surface` asserts
 * the boundary's verdict on all four refusals for exactly that reason.
 *
 * It is GAP-001's table verbatim, and the two entries worth explaining are the ones that
 * collapse:
 *
 *   - **`identity_taken` answers `BOT_IDENTITY_NOT_CUSTOMER`, not a code of its own.**
 *     The reachable way to hit it is one person's chat against another person's number,
 *     and a distinct code would tell the caller that some *other* account owns the
 *     identity they are writing from. `ConnectionService.redeemCode` refuses to name the
 *     other account for exactly this reason; a code that implies one would undo it.
 *   - **`account_inactive` answers the platform-wide `AUTH_ACCOUNT_SUSPENDED`.** A
 *     suspended account is a fact about the account rather than about this door, and a
 *     `BOT_*` alias would be a second code for one condition that every other surface
 *     already reports one way.
 *
 * The `state` on a suspended account is `non_customer`: the three states answer "what may
 * this sender do", and a suspended account may do nothing a customer may do. It is not
 * `anonymous`, because the platform knows exactly who they are.
 */
function refusalFor(resolution: Exclude<IdentityResolution<ResolvedBotCaller>, { status: 'resolved' }>) {
    switch (resolution.status) {
        case 'needs_contact':
            return createAppError(ERROR_CODES.BOT_IDENTITY_NEEDS_CONTACT, 409, undefined, {
                state: 'anonymous' satisfies BotSenderState,
                reason: 'needs_contact' satisfies BotSenderReason,
            });

        case 'no_account':
            return createAppError(ERROR_CODES.BOT_IDENTITY_UNRESOLVED, 404, undefined, {
                state: 'anonymous' satisfies BotSenderState,
                reason: 'no_account' satisfies BotSenderReason,
            });

        case 'not_customer':
            return createAppError(ERROR_CODES.BOT_IDENTITY_NOT_CUSTOMER, 403, undefined, {
                state: 'non_customer' satisfies BotSenderState,
                reason: 'not_customer' satisfies BotSenderReason,
            });

        case 'account_inactive':
            return createAppError(ERROR_CODES.AUTH_ACCOUNT_SUSPENDED, 403, undefined, {
                state: 'non_customer' satisfies BotSenderState,
                reason: 'account_inactive' satisfies BotSenderReason,
            });

        case 'identity_taken':
            return createAppError(ERROR_CODES.BOT_IDENTITY_NOT_CUSTOMER, 403, undefined, {
                state: 'non_customer' satisfies BotSenderState,
                reason: 'identity_taken' satisfies BotSenderReason,
            });

        default: {
            // Exhaustiveness: a status added to the resolver without a refusal here fails
            // to compile rather than falling through to a generic 500 nobody can act on.
            const unreachable: never = resolution;
            return unreachable;
        }
    }
}
