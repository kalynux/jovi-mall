import { GeoCandidate } from '../../../core/geocoding';
import { ICustomerSavedAddress } from '../../customers/customer.model';
import { GetCustomerProfileResponseDto } from '../../customers/dto/customer-profile.dto';
import { MessagingChannel } from '../../channel-connections';
import { BotSenderState } from '../services/bot-identity.service';
import {
    BotOnboardingNext,
    BotOnboardingRecord,
    BotOnboardingStep,
    BotOnboardingStepState,
    isOnboardingComplete,
    isRequiredStep,
    nextOnboardingStep,
    normalizeOnboarding,
    outstandingRequired,
} from '../domain/bot-onboarding';
import { BotOnboardingPrompt, onboardingPromptFor } from '../domain/bot-onboarding-copy';
import { botChrome } from '../domain/bot-chrome-copy';

/**
 * The places the bot surface's output DIFFERS from the customer API's.
 *
 * Everything else on this surface relays the customer API's own projection unchanged, and
 * that is the design: the bot is a door, not a second read model. These exist because a
 * chat window makes something specific true that a browser does not, and each carries the
 * reason.
 *
 * ⚠ This said 'the FOUR places' until 2026-09-06 and had been wrong since notifications
 * landed. A count in prose that nothing asserts is a count that goes stale — read the
 * numbered sections below, and `bot-surface.md` § 6, which now says the same thing.
 *
 * ⚠ **These are projections, not filters.** Every one builds a fresh object with named
 * fields rather than spreading and deleting. A spread republishes whatever the underlying
 * DTO gains next, silently, into a channel that is screenshotted and forwarded — the same
 * argument `catalog/dto` makes about `EnrichedProduct`, one layer further out.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1 · The sender
// ─────────────────────────────────────────────────────────────────────────────

export interface BotIdentityDto {
    state: BotSenderState;
    isCustomer: boolean;
    /** The customer's own name, for a greeting. Never the messaging profile name. */
    displayName: string | null;
    language: string | null;
    /** Which channels this account is bound to — so the bot can say where else it reaches them. */
    connectedChannels: MessagingChannel[];
    /** Whether there is anything in flight worth opening the conversation with. */
    hasOpenOrders: boolean;
    /** `••••1234` / `@handle`. The only HUMAN-READABLE form of the identity that leaves this service. */
    identityHint: string | null;
    /**
     * The **sealed identity token** — this sender's identity, signed, for a transport that
     * cannot carry the envelope itself.
     *
     * ⚠ **Its whole purpose is to be handed to a model, and that is why it is sealed
     * rather than raw.** n8n's MCP Server Trigger gives a tool node no per-request context,
     * so an MCP-hosted tool has nowhere to read an envelope from except the model's own
     * arguments. This is the only thing safe to put there: a model can echo it, and cannot
     * author one for anybody else. See `domain/bot-identity-token.ts`.
     *
     * ⚠ **Not a contradiction of the `externalId` rule below.** That rule forbids handing
     * back a durable, human-readable messaging identifier; this is opaque, expiring, and
     * useless without both of this surface's credentials.
     *
     * Callers that do not host an MCP server should ignore it. Never show it to a customer.
     */
    botToken: string;
}

/**
 * ⚠ **`externalId` is absent, and that is the rule rather than an omission.**
 *
 * `GET /api/me/connections` will not return a raw messaging identifier even to the account
 * that owns it — `identityHint` is the only form that leaves the backend — and this
 * surface must not become the exception. The caller already knows the identity: it sent
 * it. Echoing it back adds nothing and puts a durable identifier into a model's context
 * window and every log line on the path.
 */
export function toBotIdentityDto(input: {
    displayName: string | null;
    language: string | null;
    connectedChannels: MessagingChannel[];
    hasOpenOrders: boolean;
    identityHint: string | null;
    botToken: string;
}): BotIdentityDto {
    return {
        // Reachable only on a resolved caller — every other state is a refusal carrying its
        // own `details.state`. See `bot-identity.service.ts`.
        state: 'customer',
        isCustomer: true,
        displayName: input.displayName,
        language: input.language,
        connectedChannels: input.connectedChannels,
        hasOpenOrders: input.hasOpenOrders,
        identityHint: input.identityHint,
        botToken: input.botToken,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b · The sender, after an upsert — GAP-002
// ─────────────────────────────────────────────────────────────────────────────

export interface BotOnboardingStepDto {
    step: BotOnboardingStep;
    required: boolean;
    state: BotOnboardingStepState;
    /** When it left `pending`. Null while it never has. */
    at: string | null;
}

export interface BotSyncDto {
    /**
     * Is there an account for this sender NOW?
     *
     * False only for an unbound Telegram chat, where a `chat_id` maps to no phone number
     * and therefore to no account. Every other sender is registered by the time this
     * answers — including one who had no account a moment ago.
     */
    registered: boolean;
    /**
     * Did THIS call create the account?
     *
     * ⚠ **The "first message" signal, and it is true exactly once per account.** A caller
     * that greets on `isNew` will greet once; a caller that greets on `!onboarding.complete`
     * will greet on every message until onboarding finishes, which is a different and
     * usually wrong behaviour.
     */
    isNew: boolean;
    /** True when this call attached a customer profile to an account that already existed. */
    upgraded: boolean;
    state: BotSenderState;
    /** Null while `registered` is false — there is no profile to describe yet. */
    customer: BotIdentityDto | null;
    onboarding: {
        complete: boolean;
        steps: BotOnboardingStepDto[];
        /**
         * What to ask for next, or null when nothing is outstanding.
         *
         * ⚠ **Carries the SENTENCE as well as the descriptor**, and this comment used to say
         * the opposite — *"a descriptor, never a sentence; the wording belongs to the
         * automation layer"*. That was wrong on a premise already known to be wrong: the
         * automation layer has no copy table and no translator, so a `next.step: 'phone'`
         * with no prompt left a Telegram sender with nothing that could be said to them.
         * Same correction as `error.customerMessage`, on the success path.
         */
        next: (BotOnboardingNext & BotOnboardingPrompt) | null;
        /** Required steps still unprovided. Empty ⟺ the account is usable for checkout. */
        outstandingRequired: BotOnboardingStep[];
        /** How many steps have never been answered. Drives a progress line if one is wanted. */
        remaining: number;
    };
    /**
     * Copy the AUTOMATION LAYER needs when IT fails, in the customer's language.
     *
     * ⚠ **This is the one thing on this surface written for a failure this service cannot
     * see.** Every other sentence is attached to a request — `error.customerMessage` to a
     * refusal, `onboarding.next.prompt` to a question, `reply` to a turn. When the caller's
     * own model errors, times out or returns nothing, there is no request here to answer and
     * therefore nowhere to hang a sentence — but a customer is still sitting in a chat window
     * waiting. So it is handed over in advance, on the call the caller already makes on every
     * message.
     *
     * It exists for exactly the reason `error.customerMessage` and `next.prompt` do, arriving
     * by a fourth door: **the automation layer has no copy table and no translator.** A
     * five-language table in an n8n expression is one nobody reviews and nobody notices has
     * gone stale.
     *
     * ⚠ **Do NOT use it for the finished-checklist turn.** That one carries no `reply` on
     * purpose — see `setOnboardingReply` — and the turn belongs to the model. This is what to
     * say when the model is what broke.
     */
    fallback: {
        assistantUnavailable: string;
    };
}

/**
 * ⚠ **`onboarding` is present even when `registered` is false**, and that is what makes the
 * Telegram first-contact turn actionable.
 *
 * An unbound chat has no stored checklist — there is no account to store one on — so the
 * one reported is the pristine list every account starts from, whose first entry is
 * `phone`. The caller therefore reads `next` and renders the `request_contact` keyboard
 * without having to special-case "not registered" at all: the same field, in the same
 * place, means the same thing in both states.
 */
export function toBotSyncDto(input: {
    registered: boolean;
    isNew: boolean;
    upgraded: boolean;
    customer: BotIdentityDto | null;
    records: readonly BotOnboardingRecord[];
    /** Decides the phone prompt's wording and whether a contact keyboard is asked for. */
    channel: MessagingChannel;
    /**
     * The customer's own `preferences.language` once they have an account, and the
     * envelope's hint before that. Never null-able into a step name — `onboardingPromptFor`
     * falls back to English.
     */
    language: string | null;
}): BotSyncDto {
    const records = normalizeOnboarding(input.records);
    const step = nextOnboardingStep(records);

    return {
        registered: input.registered,
        isNew: input.isNew,
        upgraded: input.upgraded,
        // The three sender states, and only two are reachable here: `non_customer` is a
        // REFUSAL on this surface, never a 200 — an account this door will not act for is
        // raised as `AUTH_ACCOUNT_SUSPENDED` rather than described in a success body.
        state: input.registered ? 'customer' : 'anonymous',
        customer: input.customer,
        onboarding: {
            complete: isOnboardingComplete(records),
            steps: records.map((r) => ({
                step: r.step,
                required: isRequiredStep(r.step),
                state: r.state,
                at: r.at ? new Date(r.at).toISOString() : null,
            })),
            // Spread rather than nested, so `next.step` and `next.prompt` sit together —
            // a caller reads one object to know what to ask and how to ask it.
            next: step
                ? { ...step, ...onboardingPromptFor(step.step, input.channel, input.language) }
                : null,
            outstandingRequired: outstandingRequired(records),
            remaining: records.filter((r) => r.state === 'pending').length,
        },
        fallback: {
            assistantUnavailable: botChrome('assistantUnavailable', input.language),
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · The profile — masked, and counted rather than listed
// ─────────────────────────────────────────────────────────────────────────────

export interface BotProfileSummaryDto {
    name: string;
    emailMasked: string | null;
    phoneMasked: string | null;
    emailVerified: boolean;
    phoneVerified: boolean;
    preferences: { language: string; currency: string };
    timezone: string;
    savedAddressCount: number;
    status: string;
}

/**
 * ⚠ **`email` and `phone` are MASKED, and `savedAddresses` becomes a count.**
 *
 * A chat window is shared, screenshotted and read over a shoulder, and the reply passes
 * through a model's context on the way. The customer already knows their own number, so
 * printing it in full buys nothing and risks a screenshot; `j••••t@example.com` answers
 * the only question a chat asks of it — "is this the right address?" — which is exactly
 * what `GET /api/me/connections` decided for messaging identities.
 *
 * The address ARRAY goes for a different reason: a profile read is not an address flow.
 * `POST /addresses/list` returns them properly, with the `deliverable` verdict the
 * checkout flow actually needs; putting a second, unverdicted copy in the profile would
 * give the model two lists to disagree about.
 *
 * The avatar, the bio, the date of birth and the saved payment methods are dropped
 * outright. Not masked — dropped. Nothing on this surface can act on them, and a field a
 * chat cannot use is a field that only travels.
 */
export function toBotProfileSummary(profile: GetCustomerProfileResponseDto): BotProfileSummaryDto {
    return {
        name: profile.name,
        emailMasked: profile.email ? maskEmail(profile.email) : null,
        phoneMasked: profile.phone ? maskPhone(profile.phone) : null,
        emailVerified: profile.emailVerified,
        phoneVerified: profile.phoneVerified,
        preferences: {
            language: profile.preferences.language,
            currency: profile.preferences.currency,
        },
        timezone: profile.timezone,
        savedAddressCount: profile.savedAddresses.length,
        status: profile.status,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Addresses — a verdict instead of coordinates
// ─────────────────────────────────────────────────────────────────────────────

export interface BotAddressDto {
    id: string;
    label: string;
    formattedAddress: string;
    addressLine2: string | null;
    city: string;
    state: string | null;
    country: string;
    isDefault: boolean;
    /**
     * Has a geocoded location — the single fact checkout needs.
     *
     * Computed once here rather than inferred by the caller from the presence of a `geo`
     * key, because "inferred by the caller" is how a bot ends up offering an address that
     * `POST /checkout` will refuse, after the customer has already confirmed it.
     */
    deliverable: boolean;
}

/**
 * ⚠ **Raw `coordinates` are omitted.**
 *
 * Not because a coordinate is a secret — the customer chose it — but because a caller that
 * can read them is a caller that will eventually send them back, and `POST /addresses`
 * deliberately accepts only a `geoCandidateRef`. Withholding them is what keeps that
 * one-way. See `geo-candidate.store.ts` for the null-coordinate failure this protects.
 */
export function toBotAddressDto(address: ICustomerSavedAddress): BotAddressDto {
    return {
        id: address._id.toString(),
        label: address.label,
        // The geocoder's canonical one-line form when there is one; the typed line
        // otherwise, so a legacy address still renders as something a person recognises.
        formattedAddress: address.geo?.formatted_address ?? address.address_line1,
        addressLine2: address.address_line2 ?? null,
        city: address.city,
        state: address.state ?? null,
        country: address.country,
        isDefault: address.is_default,
        deliverable: Boolean(address.geo?.coordinates),
    };
}

export function toBotAddressList(addresses: readonly ICustomerSavedAddress[]): BotAddressDto[] {
    return addresses.map(toBotAddressDto);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Geo candidates — a handle instead of a pin
// ─────────────────────────────────────────────────────────────────────────────

export interface BotGeoCandidateDto {
    candidateRef: string;
    formattedAddress: string;
    components: {
        street: string | null;
        neighbourhood: string | null;
        city: string | null;
        region: string | null;
        country: string | null;
        countryCode: string | null;
    };
}

/** ⚠ `coordinates` and `provider_place_id` stay behind the handle. See the store. */
export function toBotGeoCandidateDto(candidateRef: string, candidate: GeoCandidate): BotGeoCandidateDto {
    return {
        candidateRef,
        formattedAddress: candidate.formatted_address,
        components: {
            street: candidate.components.street ?? null,
            neighbourhood: candidate.components.neighbourhood ?? null,
            city: candidate.components.city ?? null,
            region: candidate.components.region ?? null,
            country: candidate.components.country ?? null,
            countryCode: candidate.components.country_code ?? null,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5 · The COD delivery code, stripped out of every order read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove `codCollections[].deliveryCode` from a customer order projection.
 *
 * ⚠ **Applied to BOTH order reads, and GAP-001 names only the group.** The rule it states
 * is "it must never reach the model incidentally, and disclosure happens only through
 * `/orders/:id/cod-code`" — and `POST /orders/:orderId` is built by the same
 * `customerOrderViewService.toDtos`, so leaving it on the single-order read would make
 * stripping it from the group pointless. One deliberate deviation, recorded in
 * `api-doc/n8n/bot-surface.md`.
 *
 * The delivery code is a payment credential: it is what the customer hands the agent to
 * prove they paid, and possession of it is the whole proof. It reaching a model's context
 * on every "where is my order?" would put it in a transcript nobody is guarding. The
 * dedicated route exists so that disclosing it is a decision the flow takes once, out
 * loud, rather than a field that rides along.
 *
 * Structural rather than clever: the collection object is rebuilt without the key, so a
 * future field named `code` or `pin` is NOT stripped and will be noticed, instead of being
 * silently covered by a regex that once looked comprehensive.
 */
export function stripDeliveryCodes<T extends { codCollections?: unknown[] }>(order: T): T {
    if (!Array.isArray(order.codCollections)) return order;

    return {
        ...order,
        codCollections: order.codCollections.map((entry) => {
            if (entry === null || typeof entry !== 'object') return entry;
            const { deliveryCode, ...rest } = entry as Record<string, unknown>;
            void deliveryCode;
            return rest;
        }),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Masking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `jean.dupont@example.com` → `j••••t@example.com`. Enough to recognise, not to retype.
 *
 * ⚠ Deliberately the SAME shapes as the two private helpers in
 * `messaging-login/services/admin-credential-delivery.service.ts`, which mask the same two
 * fields when telling an administrator where a recovery link was sent. They are copied
 * rather than imported because that file does not export them and is about something else
 * entirely — but a customer must not meet their own address masked two different ways
 * depending on which surface answered, so the shapes are pinned to each other by
 * `test:bot-surface` rather than by hope.
 */
function maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '••••';
    if (local.length <= 2) return `${local[0] ?? '•'}••••@${domain}`;
    return `${local[0]}••••${local[local.length - 1]}@${domain}`;
}

/**
 * `+237600124417` → `+2376••••4417`.
 *
 * ⚠ **Exported, unlike `maskEmail` beside it**, because one handler outside this file needs
 * it: `contact_confirm_phone` answers with the number it has just made the account's own,
 * and that is an identifier again rather than a value the customer typed a moment ago. It
 * is exported rather than copied for the obvious reason — a second masking shape means one
 * customer meeting their own number two ways depending on which route answered, which is
 * exactly what the note above says must not happen.
 */
export function maskPhone(phone: string): string {
    if (phone.length <= 8) return '••••';
    return `${phone.slice(0, 5)}••••${phone.slice(-4)}`;
}

/** Exported for `test:bot-surface`, which pins both shapes against the credential-delivery pair. */
export const __maskingForTests = { maskEmail, maskPhone };

// ─────────────────────────────────────────────────────────────────────────────
// 8 · Notifications — the inbox, minus everything operational
// ─────────────────────────────────────────────────────────────────────────────

export interface BotNotificationDto {
    id: string;
    /** The situation key — `order.shipped`, `ticket.replied`. Stable, machine-readable. */
    type: string;
    title: string;
    message: string;
    createdAt: string;
    isRead: boolean;
    /**
     * What it is ABOUT, so a follow-up can name it without guessing.
     *
     * `{ type: 'order', id: '…' }` is exactly what `orders_get_order` wants, which is what
     * turns "your order shipped" into a conversation rather than a dead end.
     */
    subject: { type: string; id: string };
    /** The customer-facing label the catalogue wrote, or null when there is no action. */
    actionLabel: string | null;
    /** Absolute, and in the customer's language. Null when there is none, or unconfigured. */
    actionUrl: string | null;
}

/**
 * One notification, as a chat may see it.
 *
 * ⚠ **THREE fields on this document must never reach a model, and a spread would ship all
 * three.** This is the projection rule (`test:public-catalog`'s leak assertions, one surface
 * over) doing real work rather than being restated:
 *
 *   - `idempotencyKey` is the internal dedup handle. It is not a secret, and it is also not
 *     something a customer has any use for; putting it in a context window invites a model
 *     to quote it.
 *   - `deliveryErrors[]` carries a raw provider error string per failed channel. That is
 *     operator diagnostics — SMTP responses, Meta rejection codes — and the surface's own
 *     rule is that an `internal`/`external_service` message never reaches a customer.
 *   - `customerId` is the row's owner. The caller already knows who they are; echoing an
 *     internal id back is the same argument that keeps `externalId` off the identity DTO.
 *
 * `deliveredVia` is dropped too, for a softer reason: "we also emailed you" is operational
 * detail a customer did not ask for, and it is the kind of line a model will narrate.
 * `readAt` goes because `isRead` answers the only question a chat asks.
 */
export function toBotNotificationDto(
    notification: {
        _id: unknown;
        type: string;
        title: string;
        message: string;
        aggregateType: string;
        aggregateId: unknown;
        action?: { label: string; path: string; url?: string } | null;
        isRead: boolean;
        createdAt: Date | string;
    },
    /** Resolves `action.path` to an absolute, locale-correct URL. Returns null when unset. */
    linkFor: (path: string) => string | null,
): BotNotificationDto {
    const action = notification.action ?? null;

    return {
        id: String(notification._id),
        type: notification.type,
        title: notification.title,
        message: notification.message,
        createdAt: new Date(notification.createdAt).toISOString(),
        isRead: notification.isRead,
        subject: {
            type: notification.aggregateType,
            id: String(notification.aggregateId),
        },
        actionLabel: action?.label ?? null,
        /**
         * ⚠ **`url` wins over `path` when both exist**, because `url` is already absolute
         * and may point somewhere that is not the storefront at all. Rebuilding it from
         * `path` would silently re-target such a notification at a page that does not exist.
         */
        actionUrl: action ? (action.url ?? linkFor(action.path)) : null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9 · Reviews — "my reviews", with the one word `status` gets wrong
// ─────────────────────────────────────────────────────────────────────────────

export interface BotReviewDto {
    id: string;
    /** 1–5, integer. There is no half-star on this platform. */
    rating: number;
    title: string | null;
    body: string | null;
    /** `pending` · `published` · `rejected`. ⚠ Read `publiclyVisible`, not this. */
    status: 'pending' | 'published' | 'rejected';
    createdAt: string;
    /**
     * What was reviewed, in the shape the next tool call wants.
     *
     * `{ type: 'product', id }` is exactly `catalog_get_product`'s argument. A `delivery`
     * id is a SHIPMENT id and no tool takes one — `orderId` below is the handle for those.
     */
    subject: { type: 'product' | 'delivery'; id: string };
    /**
     * The product's title, so a chat can name what the review is about.
     *
     * Null for a delivery review (a shipment has no name a customer would recognise, and
     * they are never told which agent carried it) and null for a product that is no longer
     * publishable — `listByIds` carries the same predicate `/api/public` does, so the bot
     * cannot name a product a shopper could not open. That is the rule
     * `support-context.service.ts` already applies to its recently-viewed rung.
     */
    subjectLabel: string | null;
    /** The order behind it — evidence of purchase, or the delivery's parent. Feeds `orders_get_order`. */
    orderId: string | null;
    /**
     * ⚠ **THE FIELD THIS PROJECTION EXISTS FOR. `status: 'published'` does not mean
     * "anyone can see it".**
     *
     * A delivery review is an internal quality signal that publishes to no page anywhere —
     * it moves an agent's aggregate and feeds their trust score, and `listPublicForProduct`
     * is the only public review read there is. But a bare-star delivery review is written
     * straight to `published` by `initialStatusOf`, so relaying `status` alone hands a model
     * the sentence *"your review is live"* about something the customer will never find.
     *
     * The storefront makes the same determination in its own `StatusBadge` — a delivery row
     * shows "Delivery feedback" rather than a status — so the choice is not whether it gets
     * made but whether it gets made twice. Making it here is the fourth instance of the rule
     * in `bot-surface.md` § 14: the automation layer decides nothing it can be handed.
     */
    publiclyVisible: boolean;
}

/**
 * One of the author's own reviews, as a chat may see it.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 *   - `moderation` — who rejected it, when, and **why**. `AuthorReviewDto` already omits
 *     it and this must never reacquire it: the reason is a moderator's private note
 *     written for the next moderator (`RejectReviewSchema`), and it is the one field on
 *     this document that would be actively harmful read aloud to the person it is about.
 *   - `authorUserId` — the caller's own id. Same argument that keeps `customerId` off
 *     `toBotNotificationDto` and `externalId` off the identity DTO: echoing an internal
 *     identifier back invites a model to quote it.
 *   - `publishedAt` — chat noise. "Is it up?" is answered by `publiclyVisible`; the date
 *     a moderator happened to clear the queue is not a thing anybody asks.
 */
export function toBotReviewDto(
    review: {
        id: string;
        rating: number;
        title: string | null;
        body: string | null;
        status: 'pending' | 'published' | 'rejected';
        createdAt: string;
        subjectType: 'product' | 'delivery';
        subjectId: string;
    },
    /** `subject_id` → product title, for the publishable ones only. Empty for a delivery. */
    productTitles: ReadonlyMap<string, string>,
    /** `order_id` off the stored row. Set on both subject types — see `resolveDelivery`. */
    orderId: string | null,
): BotReviewDto {
    return {
        id: review.id,
        rating: review.rating,
        title: review.title,
        body: review.body,
        status: review.status,
        createdAt: review.createdAt,
        subject: { type: review.subjectType, id: review.subjectId },
        subjectLabel:
            review.subjectType === 'product' ? productTitles.get(review.subjectId) ?? null : null,
        orderId,
        publiclyVisible: review.subjectType === 'product' && review.status === 'published',
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10 · Bookings — two different `pending`s on one document
// ─────────────────────────────────────────────────────────────────────────────

/** One bookable slot. `slotId` is the handle `bookings_create` wants, verbatim. */
export interface BotSlotDto {
    /**
     * `slot_<startMs>_<endMs>`. **Opaque** — echo it, never build one.
     *
     * Named `slotId` rather than the underlying `id` so that the argument it feeds is
     * obvious at a glance. A model that constructs a slot id gets `BOOKING_INVALID_SLOT_ID`
     * at best, and a slot nobody is actually free for at worst.
     */
    slotId: string;
    start: string;
    end: string;
    /** Capacity products only. Null on a single-occupancy service — not "no seats left". */
    spotsRemaining: number | null;
}

export function toBotSlotDto(slot: {
    id: string;
    start: Date;
    end: Date;
    spotsRemaining?: number;
}): BotSlotDto {
    return {
        slotId: slot.id,
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
        /**
         * ⚠ `?? null` and NOT `?? 1`. A calendar/manual product carries no seat count at
         * all, and inventing "1 left" would have a bot telling somebody to hurry.
         */
        spotsRemaining: slot.spotsRemaining ?? null,
    };
}

export interface BotBookingDto {
    id: string;
    /**
     * The booking's human-readable handle, `BKG-2026-000123` — what a customer
     * reads out and what the vendor's own notification names, so a chat quoting it
     * is quoting the same string both sides can see.
     *
     * `null` only for bookings written before the number existed (D-5 leaves those
     * un-backfilled), so a caller must handle it. Prefer `id` for anything the
     * model passes back to an API.
     */
    bookingNumber: string | null;
    /**
     * `pending` · `confirmed` · `completed` · `no_show` · `cancelled`.
     *
     * ⚠ Read `awaitingVendorApproval` for what `pending` MEANS here — see below.
     */
    status: string;
    startAt: string;
    endAt: string;
    /** The service booked. `null` only if the product was hard-deleted underneath it. */
    service: { id: string; name: string | null } | null;
    /** Who provides it, so a chat can say "your appointment with …". */
    vendor: { id: string; name: string | null } | null;
    price: { quoted: number; currency: string };
    payment: {
        /** `unpaid` · `pending` · `paid` · `disputed` · `failed` · `refunded` · `refund_pending`. */
        status: string;
        method: string | null;
        /** Whether this booking needs paying at all — a free service does not. */
        required: boolean;
    };
    /**
     * ⚠ **THE FIELD THIS PROJECTION EXISTS FOR. There are TWO `pending`s on a booking and
     * they mean unrelated things.**
     *
     * `status: 'pending'` means the VENDOR has not accepted the appointment yet — it is a
     * `manual`-mode product, and the booking is held until they confirm. Nothing is wrong
     * and nobody owes anything.
     *
     * `payment.status: 'pending'` means MONEY is in flight — a mobile-money prompt is
     * sitting on the customer's handset right now.
     *
     * A model handed both words will merge them, and the two mistakes available are the two
     * worst ones: telling somebody their appointment is confirmed when the vendor has not
     * looked at it, or telling them to pay again while a charge is live. So the one that
     * reads as a status is named explicitly instead.
     */
    awaitingVendorApproval: boolean;
    /**
     * What is still owed after the vendor settled a COMPLETED appointment, in `currency`.
     *
     * `0` in every other state, including "not settled yet" — the number is what a chat may
     * quote, and there is nothing to quote before settlement. `bookings_get_balance` is the
     * read that explains it, including the overpaid case this deliberately does not carry.
     */
    outstandingBalance: number;
    cancelledAt: string | null;
    /** Whatever the canceller typed. May be the vendor's words, not the customer's. */
    cancelledReason: string | null;
}

/**
 * One booking, as a chat may see it.
 *
 * ── WHY THIS EXISTS AT ALL, WHEN THE THREE OLDER BOOKING TOOLS RELAYED ──────
 * `bookings_list`, `bookings_get` and `bookings_cancel` passed the Mongoose document
 * straight through. They go through this now too, and that is a **deliberate breaking
 * change to three shipped routes** — safe to make because nothing consumes them yet: no
 * booking tool is registered on `wi-mall-mcp`, and `wi-mall-core` has never been activated
 * (`activeVersionId: null`, verified 2026-09-06). Left alone, the surface would have
 * carried two shapes for one entity forever, decided by which tool was written first.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 *   - `metadata` — `Mixed`, and WRITABLE BY THE CALLER on the customer API's own book
 *     route. An arbitrary object a web client authored is the last thing that should reach
 *     a model's context window, and it is exactly why this file's rule is "explicit fields,
 *     never a spread".
 *   - `externalCalendarEventId` — a handle into the VENDOR's Google Calendar. It belongs to
 *     a third party's account and answers no question a customer has.
 *   - `userId` — the caller's own id, echoed back. Same argument as `customerId` on the
 *     notification row.
 *   - `paymentTransactionId` and `settlement.balanceTransactionId` — real, and reachable
 *     through `bookings_payment_status`, which exists precisely so a transaction id is
 *     fetched when a payment question is being asked rather than riding on every row of
 *     every list.
 */
export function toBotBookingDto(booking: {
    _id: unknown;
    bookingNumber?: string | null;
    status: string;
    startAt: Date | string;
    endAt: Date | string;
    productId?: unknown;
    vendorId?: unknown;
    priceSnapshot: number;
    currency: string;
    requiresPayment: boolean;
    paymentStatus: string;
    paymentMethod?: string | null;
    cancelledAt?: Date | string | null;
    cancelledReason?: string | null;
    settlement?: { balanceDue?: number; balancePaid?: number } | null;
}): BotBookingDto {
    const settlement = booking.settlement ?? null;
    const outstanding = Math.max(0, (settlement?.balanceDue ?? 0) - (settlement?.balancePaid ?? 0));

    return {
        id: String(booking._id),
        bookingNumber: booking.bookingNumber ?? null,
        status: booking.status,
        startAt: new Date(booking.startAt).toISOString(),
        endAt: new Date(booking.endAt).toISOString(),
        service: refOf(booking.productId, 'title'),
        vendor: refOf(booking.vendorId, 'display_name'),
        price: { quoted: booking.priceSnapshot, currency: booking.currency },
        payment: {
            status: booking.paymentStatus,
            method: booking.paymentMethod ?? null,
            required: booking.requiresPayment,
        },
        awaitingVendorApproval: booking.status === 'pending',
        outstandingBalance: outstanding,
        cancelledAt: booking.cancelledAt ? new Date(booking.cancelledAt).toISOString() : null,
        cancelledReason: booking.cancelledReason ?? null,
    };
}

/**
 * A `populate`d reference, as `{ id, name }` — or just an id when it was not populated.
 *
 * ⚠ `getUserBookings` and `getUserBooking` populate; nothing guarantees a future caller
 * does. An unpopulated `ObjectId` must degrade to `{ id, name: null }` rather than
 * stringifying the whole document into a name, which is what a naive `String(ref[field])`
 * would produce.
 */
function refOf(ref: unknown, field: string): { id: string; name: string | null } | null {
    if (!ref) return null;
    if (typeof ref === 'object' && ref !== null && '_id' in ref) {
        const doc = ref as Record<string, unknown>;
        const name = doc[field];
        return { id: String(doc._id), name: typeof name === 'string' ? name : null };
    }
    return { id: String(ref), name: null };
}

/** What `bookings_payment_status` answers. Built here rather than relayed — see the route. */
export interface BotBookingPaymentDto {
    bookingId: string;
    status: string;
    method: string | null;
    required: boolean;
    amount: number;
    currency: string;
    /**
     * The live charge, when there is one. `transactionId` is what `payment_get_transaction`,
     * `payment_authorize_otp` and `payment_create_pay_link` all take — which is how a
     * booking payment rejoins the money tools every other payment on this surface uses.
     */
    transaction: { transactionId: string; status: string; gateway: string } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 11 · Saved payment methods — the card that cannot be used any more
// ─────────────────────────────────────────────────────────────────────────────

export interface BotPaymentMethodDto {
    id: string;
    /** What to call it out loud — "MTN Mobile Money · ••••4417". Composed at save time. */
    label: string;
    /** `card` · `mobile_money` · `bank_transfer`. */
    type: string;
    /** `mtn_momo`, `orange_money`, `moov_money`, `stripe`, … */
    provider: string;
    /** Card brand, when it is a card. Null on a wallet. */
    brand: string | null;
    /** The last four digits — of the card, or of the wallet's phone number. */
    last4: string | null;
    isDefault: boolean;
    /** `MM/YYYY` for a card, null for everything else. */
    expires: string | null;
    /**
     * ⚠ **THE FIELD THIS PROJECTION EXISTS FOR.** A saved card whose expiry has passed is
     * still in the list and still looks like a way to pay. Nothing removes it, and the
     * customer API reports the month and the year as two plain numbers, leaving the reader
     * to compare them against today.
     *
     * A model doing that comparison is a model doing date arithmetic, which it does quietly
     * wrong — and the failure lands as "use your Visa ending 4242", followed by a decline
     * the customer has to work out for themselves. So the comparison happens here, once.
     *
     * Always `false` for a wallet: a phone number does not expire.
     */
    expired: boolean;
}

/**
 * One saved payment method, as a chat may see it.
 *
 * ── THE NUMBER IS NEVER HERE, AND THAT IS THE CUSTOMER API'S RULE, NOT THIS ONE ──
 * `PaymentMethodMapper.toDto` already withholds `gateway_customer_id` and
 * `gateway_instrument_id`, which for a wallet ARE the customer's phone number. This
 * projection inherits that and adds nothing back. A chat can name a wallet; it cannot read
 * the number out, and checkout asks for it again.
 *
 * ⚠ That is a real limitation rather than an oversight, and the storefront meets it too —
 * it keeps a copy of the number in device storage precisely because the server will not
 * return one. A chat has no equivalent, so a saved wallet saves the customer choosing a
 * network, not typing a number.
 *
 * `holder_name` is dropped: it is the customer's own name, which a chat already knows.
 */
export function toBotPaymentMethodDto(
    method: {
        id: string;
        provider: string;
        method_type: string;
        display_label: string;
        brand: string | null;
        last4: string | null;
        exp_month: number | null;
        exp_year: number | null;
        is_default: boolean;
    },
    /** Injected so the comparison is testable without waiting for a card to expire. */
    now: Date = new Date(),
): BotPaymentMethodDto {
    const month = method.exp_month;
    const year = method.exp_year;
    const hasExpiry = typeof month === 'number' && typeof year === 'number';

    return {
        id: method.id,
        label: method.display_label,
        type: method.method_type,
        provider: method.provider,
        brand: method.brand,
        last4: method.last4,
        isDefault: method.is_default,
        expires: hasExpiry ? `${String(month).padStart(2, '0')}/${year}` : null,
        /**
         * ⚠ A card is good through the LAST DAY of its expiry month, so the comparison is
         * against the first day of the month AFTER it. Comparing against the first of the
         * expiry month itself would call a perfectly good card dead for up to 31 days.
         */
        expired: hasExpiry ? new Date(Date.UTC(year!, month!, 1)) <= now : false,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 12 · Contact state — masked on the left, verbatim on the right
// ─────────────────────────────────────────────────────────────────────────────

/** A change in flight. `target` is the value the customer typed — see below. */
export interface BotPendingContactDto {
    target: string;
    expiresAt: Date;
}

export interface BotContactStateDto {
    /** `j••••t@example.com`, or null when the account has no login email. */
    emailMasked: string | null;
    /** `+2376••••4417`, or null when the account has no login phone. */
    phoneMasked: string | null;
    pendingEmail: BotPendingContactDto | null;
    pendingPhone: BotPendingContactDto | null;
    /**
     * ⚠ **Whether the phone change is CONFIRMABLE FROM HERE**, computed rather than left to
     * be inferred. `ContactChangeService` proves a new number by requiring a WhatsApp
     * connection whose identity IS that number, so a customer with a pending change and no
     * such connection is holding a request they cannot complete — and the only signal the
     * customer API gives them is a `422 CONTACT_CHANGE_PHONE_UNPROVEN` after they try.
     *
     * Null when nothing is pending. See `BotContactController.getState`.
     */
    phoneChangeProved: boolean | null;
    /**
     * Where a customer changes either of these — the storefront's sign-in details page.
     *
     * ⚠ **DATA, deliberately, and not a button** (owner's ruling, 2026-09-20). Changing an
     * email or a phone is not built in chat; the customer is sent to the website. The link
     * travels here rather than as a rendered control because a reply carrying a control
     * REPLACES the model's sentence instead of joining it — so a button would cost the
     * customer the answer they usually came for, which is *"what email do you have for me?"*
     * rather than *"change it"*. As data, one sentence answers both.
     *
     * Null when the deployment has no storefront URL configured, in which case there is no
     * honest destination and nothing should be offered.
     */
    changeUrl: string | null;
}

/**
 * What the account signs in with, as a chat may see it.
 *
 * ── THE ASYMMETRY IS THE POINT, AND IT IS NOT AN OVERSIGHT ──────────────────
 * The CURRENT identifiers are masked, by the rule `toBotProfileSummary` already set: a chat
 * window is shared, screenshotted and read over a shoulder, the customer already knows
 * their own number, and printing it in full buys nothing.
 *
 * The PENDING target is verbatim, and masking it would defeat the read. The whole question
 * this answers is *"which address should I be checking for the link?"* — and
 * `Check j••••t@example.com` does not answer it. The customer typed the value seconds ago,
 * in this conversation, so it is already in the transcript and in the model's context;
 * `ContactChangeService` makes the same call in its own DTO ("the account holder typed it;
 * echoing it is not a leak").
 *
 * `requestedAt` is dropped. `expiresAt` is the one a chat can act on — "you have until…" —
 * and a second timestamp is a second thing for a model to narrate wrongly.
 */
export function toBotContactState(
    state: {
        email: string | null;
        phone: string | null;
        pendingEmail: { target: string; expiresAt: Date } | null;
        pendingPhone: { target: string; expiresAt: Date } | null;
    },
    /** Whether a WhatsApp connection currently proves the pending number. */
    phoneChangeProved: boolean | null,
    /**
     * Where the customer changes either value, already composed.
     *
     * ⚠ **Passed in rather than built here**, because the link depends on the customer's
     * language and on a deployment's `STOREFRONT_URL` — request-scoped facts a pure
     * projection has no business reading. Same reason `toBotNotificationDto` takes a link
     * builder instead of importing one.
     *
     * ⚠ **OPTIONAL, and the default is honest rather than a convenience.** It landed REQUIRED
     * and broke three call sites in `test-bot-surface.ts` — a file the author never opened —
     * which stopped the whole suite COMPILING and took every session's gate down with it.
     * **A required parameter added to a shared projection breaks every existing call site in
     * files the author never opens.** `null` is also the truthful value when no storefront is
     * configured, which is production today, so defaulting to it states a fact rather than
     * papering over one.
     */
    changeUrl: string | null = null,
): BotContactStateDto {
    return {
        emailMasked: state.email ? maskEmail(state.email) : null,
        phoneMasked: state.phone ? maskPhone(state.phone) : null,
        pendingEmail: state.pendingEmail
            ? { target: state.pendingEmail.target, expiresAt: state.pendingEmail.expiresAt }
            : null,
        pendingPhone: state.pendingPhone
            ? { target: state.pendingPhone.target, expiresAt: state.pendingPhone.expiresAt }
            : null,
        phoneChangeProved: state.pendingPhone ? phoneChangeProved : null,
        changeUrl,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 13 · Messaging connections — the hint, never the identity
// ─────────────────────────────────────────────────────────────────────────────

export interface BotConnectionDto {
    channel: MessagingChannel;
    connected: boolean;
    /** The messaging profile name. Null when the channel never sent one. */
    displayName: string | null;
    /** `••••1234` / `@handle`. The only human-readable form of an identity that leaves here. */
    identityHint: string | null;
    connectedAt: Date | null;
    /**
     * ⚠ **THE FIELD THIS PROJECTION EXISTS FOR.** Whether this is the channel the request
     * arrived on — which is the one `connections_disconnect` refuses to cut.
     *
     * Computed here rather than left to the caller, because the caller working it out means
     * the caller comparing `channel` against something it believes about itself, and the
     * failure lands as a chat offering a customer a button that answers 409. The backend is
     * the only side that knows, without doubt, which binding resolved this request.
     */
    isCurrentChannel: boolean;
}

/**
 * ── `howToConnect` IS DROPPED, AND THAT IS A DECISION ───────────────────────
 * `ChannelConnectionDto` carries a `deepLink` and a bot handle for every channel that is
 * NOT connected, because a settings screen needs to render a "connect WhatsApp" button.
 * A chat does not: the customer is already inside one of those two clients, and the
 * instruction — *send `/connect` to the bot, then redeem the code while signed in* — is a
 * conversation rather than a link. Relaying a `wa.me` deep link into a WhatsApp chat is an
 * invitation to tap through to the conversation you are already having.
 *
 * ⚠ **`external_id` is absent, and it is the same rule `toBotIdentityDto` states**:
 * `GET /api/me/connections` will not return a raw messaging identifier even to the account
 * that owns it, and this surface is not the exception. `identityHint` answers the only
 * question a chat asks — "is this the right account?"
 */
export function toBotConnectionDto(
    state: { channel: MessagingChannel; connected: boolean; displayName: string | null; identityHint: string | null; connectedAt: Date | null },
    currentChannel: MessagingChannel,
): BotConnectionDto {
    return {
        channel: state.channel,
        connected: state.connected,
        displayName: state.displayName,
        identityHint: state.identityHint,
        connectedAt: state.connectedAt,
        isCurrentChannel: state.channel === currentChannel,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 14 · Inbound files and ticket attachments (Step 7b)
// ─────────────────────────────────────────────────────────────────────────────

export interface BotInboundFileDto {
    /** The opaque handle. The only way to name this file again. */
    ref: string;
    fileName: string;
    mimeType: string;
    size: number;
    /**
     * ⚠ **THE FIELD THIS PROJECTION EXISTS FOR, and it is the same class of decision as
     * `expired` on a payment method or `publiclyVisible` on a review.**
     *
     * A model handed `mimeType: 'application/pdf'` and asked whether that is a photo will
     * mostly get it right and will occasionally tell a customer their receipt is an image.
     * The two words a chat sentence needs are decided once, here, from the type the
     * pipeline SNIFFED — not from the name, which a channel may not have sent and a
     * customer may have chosen.
     */
    kind: 'image' | 'document';
}

/**
 * ⚠ **`fileId` is deliberately absent, and so is the URL.**
 *
 * The id would be a durable, guessable-shaped identifier for a row that outlives the
 * conversation; the handle is 32 random bytes that expire in thirty minutes and are refused
 * for the wrong owner. Publishing the id beside the handle would make the handle's three
 * properties decorative — a caller would simply keep the id.
 *
 * The URL is absent for a plainer reason: nothing on this path has any business handing a
 * chat a link to a file the customer just sent it. They have the original.
 */
export function toBotInboundFileDto(
    ref: string,
    file: { mimeType: string; size: number; originalName?: string },
): BotInboundFileDto {
    return {
        ref,
        fileName: file.originalName ?? 'file',
        mimeType: file.mimeType,
        size: file.size,
        kind: file.mimeType.startsWith('image/') ? 'image' : 'document',
    };
}

export interface BotTicketAttachmentDto {
    id: string;
    fileName: string;
    mimeType: string;
    size: number;
    kind: 'image' | 'document';
    createdAt: Date;
    /**
     * How many the ticket now holds, and the platform's ceiling.
     *
     * ⚠ Present because five is a **hard** limit and the sixth attach is a 422, not a
     * silent drop. A chat that has just succeeded is the last moment at which telling the
     * customer "that is the fifth and last" costs nothing; discovering it on the next photo
     * costs them the photo.
     */
    attachmentCount: number;
    attachmentLimit: number;
}

export function toBotTicketAttachmentDto(
    // `id` is OPTIONAL on `ITicketAttachment` (it is the Mongoose virtual, present on every
    // hydrated document and absent from the interface's type). Accepted as optional and
    // narrowed here rather than asserted at the call site.
    attachment: { id?: string; file_name: string; mime_type: string; file_size: number; createdAt?: unknown },
    counts: { count: number; limit: number },
): BotTicketAttachmentDto {
    return {
        id: String(attachment.id),
        fileName: attachment.file_name,
        mimeType: attachment.mime_type,
        size: attachment.file_size,
        kind: attachment.mime_type.startsWith('image/') ? 'image' : 'document',
        createdAt: attachment.createdAt as Date,
        attachmentCount: counts.count,
        attachmentLimit: counts.limit,
    };
}
