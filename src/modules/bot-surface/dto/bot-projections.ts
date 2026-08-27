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

/**
 * The four places the bot surface's output DIFFERS from the customer API's.
 *
 * Everything else on this surface relays the customer API's own projection unchanged, and
 * that is the design: the bot is a door, not a second read model. These four exist because
 * a chat window makes something specific true that a browser does not, and each carries
 * the reason.
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
    /** `••••1234` / `@handle`. The ONLY form of the identity that leaves this service. */
    identityHint: string | null;
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

/** `+237600124417` → `+2376••••4417`. */
function maskPhone(phone: string): string {
    if (phone.length <= 8) return '••••';
    return `${phone.slice(0, 5)}••••${phone.slice(-4)}`;
}

/** Exported for `test:bot-surface`, which pins both shapes against the credential-delivery pair. */
export const __maskingForTests = { maskEmail, maskPhone };
