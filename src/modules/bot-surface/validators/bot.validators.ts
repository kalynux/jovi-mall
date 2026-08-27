import { z } from 'zod';
import { CONNECTION_CHANNELS } from '../../channel-connections';
import { TICKET_TYPE_VALUES, TICKET_STATUS_VALUES } from '../../tickets/types/ticket.types';
import { BOT_ONBOARDING_STEP_VALUES } from '../domain/bot-onboarding';

/**
 * Every body and path parameter the bot surface accepts.
 *
 * ── WHY THE SCHEMAS ARE HERE AND NOT REUSED FROM THE CUSTOMER API ────────────
 * Most of these have a near-twin under `/api/customer/*`, and copying looks like the
 * mistake this codebase warns about everywhere else. It is not, and the difference is
 * the transport: the customer API reads its filters from a QUERY STRING and therefore
 * coerces (`z.coerce.number()`), while this surface reads a JSON body and must not — a
 * `limit: "5"` arriving as a string here means the automation layer built the call wrong,
 * and coercing it silently would hide that from the one caller who could fix it.
 *
 * What is NOT copied is anything with a rule in it. The bargain-price rule, the
 * cancellation policy, the eligibility matrix and the stock gate all stay on their
 * services; these schemas do shape and nothing else, exactly as `geo.validator.ts` does
 * for the geocoding routes.
 *
 * ── `.strict()` THROUGHOUT, AND THAT IS A CONTRACT DECISION ──────────────────
 * An unknown key is a 400 rather than a silently stripped field. The caller is a
 * generated automation layer built from `api-doc/n8n/tools/catalog.json`, so a key it
 * sends that this surface does not know about means the two have drifted — and the whole
 * point of a curated surface is that a drift is loud. The same argument the two
 * `/simple` product schemas make, for a caller that cannot read a changelog.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

/**
 * A free-form reference the customer quoted — an id, or a human-readable number.
 *
 * `orders_get_order` and `tickets_get` both accept "the id, or the number the customer
 * read out", so neither may demand an ObjectId. Bounded and trimmed rather than
 * unconstrained: it reaches a `$or` query, and an unbounded string in a filter is how a
 * search path becomes a denial-of-service.
 */
const quotedReference = z.string().trim().min(1).max(64);

// ─────────────────────────────────────────────────────────────────────────────
// The identity envelope — on EVERY call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **There is no `customerId`, `userId` or token field here, and there never may be.**
 *
 * `.strict()` is what makes that structural rather than a convention: a caller that adds
 * one gets a 400 naming the key, instead of a 200 and the quiet belief that it worked.
 * See `bot-identity.service.ts` for why a caller-supplied identity on this surface is
 * account takeover rather than a leak.
 *
 * `displayName` and `handle` are cosmetic and go no further than a new
 * `channel_connections` row's display fields. They are NOT used to resolve anybody.
 */
export const BotIdentityEnvelopeSchema = z
    .object({
        channel: z.enum(CONNECTION_CHANNELS),
        externalId: z.string().trim().min(1).max(128),
        displayName: z.string().trim().max(100).nullish(),
        handle: z.string().trim().max(100).nullish(),
        /**
         * Telegram's `from.language_code` (GAP-002 D-5). Cosmetic, like the two above, and
         * read at REGISTRATION only.
         *
         * Deliberately NOT `z.enum(BOT_LANGUAGES)`: Telegram sends real BCP-47 tags
         * (`en-GB`, `pt-BR`, `de`), and refusing the envelope over one would 400 every
         * message from a German phone on a field that is only ever a hint. It is bounded
         * and then matched exactly against the five supported languages in
         * `bot-registration.service.ts`; anything else silently takes the default.
         */
        language: z.string().trim().max(16).nullish(),
    })
    .strict();

/**
 * The wrapper every request body satisfies.
 *
 * `passthrough` on the outer object, because the operation's own arguments live beside
 * `identity` and each route parses those with its own strict schema. Splitting the
 * envelope check from the argument check is what lets the identity middleware run first
 * and refuse an unresolvable sender before a single argument is looked at — a caller with
 * no account should not be told which of their arguments were also wrong.
 */
export const BotEnvelopeSchema = z
    .object({ identity: BotIdentityEnvelopeSchema })
    .passthrough();

// ─────────────────────────────────────────────────────────────────────────────
// Cart
// ─────────────────────────────────────────────────────────────────────────────

export const BotCartAddItemSchema = z
    .object({
        productId: objectId,
        variantId: objectId,
        /** ADDS to the line. `cart_set_item_quantity` is what sets an absolute value. */
        quantity: z.number().int().min(1).max(999).default(1),
    })
    .strict();

export const BotVariantParamSchema = z.object({ variantId: objectId });

export const BotCartSetQuantitySchema = z
    .object({ quantity: z.number().int().min(1).max(999) })
    .strict();

export const BotCartQuoteSchema = z
    .object({ deliveryAddressId: objectId.optional() })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Checkout and payments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **`deliveryAddressId` is REQUIRED here and optional on the customer API.**
 *
 * `POST /api/customer/orders/checkout` falls back to the customer's default saved
 * address when none is given, which is right for a screen that shows the address beside
 * the button. In a chat the confirmation is a sentence the bot wrote a turn earlier, and
 * a fallback means the sentence and the order can disagree about where the parcel is
 * going with nobody able to see it. Naming it is what makes them agree.
 *
 * `paymentMethod` is required for the same reason and not defaulted to `online`: "cash on
 * delivery" and "pay now" are different conversations, and a default picks one silently.
 */
export const BotCheckoutSchema = z
    .object({
        paymentMethod: z.enum(['online', 'cash_on_delivery']),
        deliveryAddressId: objectId,
    })
    .strict();

export const BotTransactionParamSchema = z.object({ transactionId: z.string().trim().min(1).max(64) });

// ─────────────────────────────────────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `limit` defaults to 5, not 20.
 *
 * The catalogue's `chat_default_limit`. A chat reply that lists twenty orders is a wall
 * of text nobody reads, and the model paying for those tokens summarises them badly.
 * Every list on this surface defaults the same way.
 */
const chatPage = {
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(100).default(5),
};

export const BotOrderListSchema = z
    .object({
        status: z
            .enum([
                'pending', 'processing', 'partially_shipped', 'shipped',
                'partially_delivered', 'delivered', 'fulfilled', 'cancelled', 'returned',
            ])
            .optional(),
        paymentStatus: z
            .enum(['pending', 'AWAITING_PAYMENT', 'partially_paid', 'paid', 'disputed', 'failed', 'refunded'])
            .optional(),
        q: z.string().trim().min(1).max(200).optional(),
        ...chatPage,
    })
    .strict();

export const BotCartIdParamSchema = z.object({ cartId: z.string().trim().min(1).max(64) });
export const BotOrderParamSchema = z.object({ orderId: quotedReference });
export const BotOrderShipmentParamSchema = z.object({
    orderId: quotedReference,
    shipmentId: objectId,
});

/** `shipmentId` is required only when the order carries more than one parcel. */
export const BotCodCodeSchema = z.object({ shipmentId: objectId.optional() }).strict();

export const BotOrderCancelSchema = z
    .object({ reason: z.string().trim().max(500).optional() })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Profile, addresses and geo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five languages the platform's notification copy is actually written in.
 *
 * Deliberately narrower than `preferences.language`, which the customer API validates as
 * a BCP-47 string of 2–10 characters. A bot that set `de` would produce a profile the
 * notification catalogs have no copy for, and every consumer would fall back silently —
 * so this surface may only choose from what exists. The list is the same one every
 * notification catalog asserts completeness against at boot.
 */
export const BOT_LANGUAGES = ['en', 'fr', 'pt', 'es', 'ar'] as const;

export const BotSetLanguageSchema = z.object({ language: z.enum(BOT_LANGUAGES) }).strict();

/**
 * ⚠ **`geoCandidateRef`, and there is deliberately no way to send coordinates.**
 *
 * Two reasons, and the second is the sharp one. A bot that can build a `geo` object can
 * build a wrong one, and an address that looks right and points somewhere else is a
 * delivery to the wrong street. And a `null` inside the 2dsphere-indexed saved-address
 * array makes the WHOLE customer document unwritable — measured, not fixed by a sparse or
 * partial index, and the failure presents as "this customer cannot be edited at all". A
 * caller assembling a `geo` object sends a null eventually.
 *
 * The handle is minted by `/geo/search` or `/geo/reverse` and is single-use, which is
 * also what makes saving an address idempotent under retry.
 */
export const BotAddAddressSchema = z
    .object({
        label: z.string().trim().min(1).max(50),
        geoCandidateRef: z.string().trim().min(1).max(128),
        /** The flat number, the landmark, the directions — what a geocoder never knows. */
        addressLine2: z.string().trim().max(200).optional(),
        isDefault: z.boolean().default(false),
    })
    .strict();

export const BotAddressParamSchema = z.object({ addressId: objectId });

// ─────────────────────────────────────────────────────────────────────────────
// Registration and onboarding (GAP-002)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `POST /identity/sync` — the every-message upsert.
 *
 * Takes no arguments of its own. The identity envelope is the whole input, and everything
 * this route decides is derived from it plus what the database already holds.
 *
 * ⚠ **There is deliberately no `message` field**, and the automation layer holds the
 * customer's first message instead. The flow this route serves is "interrupt the first
 * message, collect an account, then answer what they originally asked" — so something has
 * to remember the question. Storing it here would mean a durable column of raw customer
 * message text in the profile collection with no retention policy, or a Redis stash whose
 * expiry is a second thing to reason about; the n8n execution that asked the question is
 * already the natural place for it. `onboarding.complete` flipping to true is the signal to
 * replay it. Product owner's decision, 2026-08-26.
 */
export const BotIdentitySyncSchema = z.object({}).strict();

/**
 * A Telegram `contact` payload, as the onboarding phone step accepts it.
 *
 * ⚠ **`userId` is REQUIRED here and optional on `login_contact`'s schema**, and that
 * difference is deliberate rather than an oversight. That command refuses a missing
 * `user_id` in its handler, one line later, so the two agree on the outcome; making it
 * required at the schema on the path that CREATES AN ACCOUNT means the guard cannot be
 * reached with nothing to compare. A contact card shared from an address book carries no
 * `user_id` at all, and that is exactly the payload this must never act on.
 *
 * Ids arrive as a JSON number or a string depending on the bridge — the same union
 * `login-contact.command.ts` accepts, for the same reason.
 */
export const BotVerifiedContactSchema = z
    .object({
        phoneNumber: z.string().trim().min(1).max(64),
        userId: z.union([z.string().trim().min(1).max(64), z.number()]),
        firstName: z.string().trim().max(120).optional(),
        lastName: z.string().trim().max(120).optional(),
    })
    .strict();

/**
 * `POST /identity/onboarding` — submit or skip one step.
 *
 * ⚠ **Which field a step requires is checked in the SERVICE, not here**, and this is the
 * same call `bargain-price.rule.ts` makes about its min/max ordering. A
 * `z.discriminatedUnion` on `step` would state it — but every member would need a
 * `superRefine` to express "required when `action` is provide", and a refined member is a
 * `ZodEffects` that `discriminatedUnion` rejects outright. The union-of-objects that
 * remains produces an error naming every branch it tried, which is unreadable for the one
 * caller who could act on it. So the shape is flat and `BOT_ONBOARDING_VALUE_REQUIRED`
 * names the step and the field it wanted.
 *
 * `action` defaults to `provide`: a caller sending a value and no action means to provide
 * it, while defaulting to `skip` would silently discard data somebody typed.
 */
export const BotOnboardingSubmitSchema = z
    .object({
        step: z.enum(BOT_ONBOARDING_STEP_VALUES as unknown as [string, ...string[]]),
        action: z.enum(['provide', 'skip']).default('provide'),
        /** `step: 'phone'`, Telegram only. */
        contact: BotVerifiedContactSchema.optional(),
        /** `step: 'name'`. */
        name: z.string().trim().min(2).max(100).optional(),
        /** `step: 'email'`. */
        email: z.string().trim().toLowerCase().email().max(200).optional(),
        /**
         * `step: 'address'`. The same shape `POST /addresses` takes, and for the same
         * reason — a `candidateRef` and never coordinates (GAP-005). The step is applied by
         * delegating to the identical service call, so an address saved during onboarding
         * and one saved later are byte-identical documents.
         */
        address: BotAddAddressSchema.optional(),
    })
    .strict();

export const BotGeoSearchSchema = z
    .object({
        q: z.string().trim().min(1).max(300),
        limit: z.number().int().min(1).max(10).default(5),
    })
    .strict();

export const BotGeoReverseSchema = z
    .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
    })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Tickets
// ─────────────────────────────────────────────────────────────────────────────

export const BotTicketListSchema = z
    .object({
        status: z.enum(TICKET_STATUS_VALUES as [string, ...string[]]).optional(),
        ...chatPage,
    })
    .strict();

export const BotTicketParamSchema = z.object({ ticketId: quotedReference });

/**
 * ⚠ **`description` is capped at 700, not the catalogue's 5000.**
 *
 * `TicketSchema.description` carries `maxlength: 700` in Mongoose and `CreateTicketSchema`
 * enforces the same. A bot schema that accepted 5000 would parse cleanly, reach the
 * service, and fail on the model with a Mongoose `ValidationError` — a 500 for what is
 * plainly the caller's input problem. Refusing at the door with a named field is the
 * honest answer, and the deviation is recorded in `api-doc/n8n/bot-surface.md`.
 *
 * `type` is upper-cased before matching: the catalogue writes `order_issue` and the
 * platform enum is `ORDER_ISSUE`. No two members of that enum differ only by case, so the
 * fold cannot be ambiguous.
 *
 * `entityType` and `importance` are optional here and required on the customer API. The
 * catalogue makes them optional because a chat rarely establishes either, so the defaults
 * are applied in the controller — `OTHER` anchored to the customer's own id, exactly what
 * `TicketController.createTicket` already does for a general question.
 */
export const BotTicketCreateSchema = z
    .object({
        subject: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(700),
        type: z
            .string()
            .trim()
            .transform((v) => v.toUpperCase())
            .pipe(z.enum(TICKET_TYPE_VALUES as [string, ...string[]])),
        importance: z.enum(['low', 'medium', 'high']).default('medium'),
        entityType: z.enum(['ORDER', 'PRODUCT']).optional(),
        entityId: objectId.optional(),
    })
    .strict()
    .refine((d) => !(d.entityType && !d.entityId), {
        message: 'entityId is required when entityType is given',
        path: ['entityId'],
    });

/** `body` on the wire, `content` on the service. The catalogue's name wins at the door. */
export const BotTicketNoteSchema = z
    .object({ body: z.string().trim().min(1).max(5000) })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Support routing (GAP-004)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **The two hints are typed DIFFERENTLY, and it matches what each subject already is
 * elsewhere on this surface.**
 *
 * `hintOrderId` is a `quotedReference` — an id *or* the order number the customer read
 * out — because `orders_get_order` accepts both and a chat routinely quotes
 * "ORD-2026-000123". `hintProductId` is a strict `objectId`, because every product-taking
 * tool here takes one (a product slug is unique per vendor, not globally, so it is not a
 * handle this surface can resolve on its own).
 *
 * The catalogue types both as bare strings; the descriptions there say which is which.
 *
 * ⚠ **Neither hint may be a party.** There is deliberately no `storeSlug` or `agencyId`
 * field: those are the *answer*, and accepting one would let a caller ask for a seller's
 * contacts by naming them — turning a support-routing read into a directory lookup over
 * every store on the platform, from a chat window, with no relationship to the customer.
 */
export const BotSupportContextSchema = z
    .object({
        scope: z.enum(['auto', 'vendor', 'agency', 'platform']).default('auto'),
        hintOrderId: quotedReference.optional(),
        hintProductId: objectId.optional(),
    })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Wishlist, recently viewed, digital, bookings, reviews
// ─────────────────────────────────────────────────────────────────────────────

export const BotPageSchema = z.object({ ...chatPage }).strict();
export const BotProductIdSchema = z.object({ productId: objectId }).strict();
export const BotProductParamSchema = z.object({ productId: objectId });
export const BotEntitlementSchema = z.object({ entitlementId: objectId }).strict();

export const BotBookingListSchema = z
    .object({
        status: z.enum(['pending', 'confirmed', 'completed', 'no_show', 'cancelled']).optional(),
        ...chatPage,
    })
    .strict();

export const BotBookingParamSchema = z.object({ bookingId: objectId });
export const BotBookingCancelSchema = z
    .object({ reason: z.string().trim().max(500).optional() })
    .strict();

/** ⚠ `delivery` takes a SHIPMENT id, never an order id. Same rule as the customer API. */
export const BotReviewEligibilitySchema = z
    .object({
        subjectType: z.enum(['product', 'delivery']),
        subjectId: objectId,
    })
    .strict();

/**
 * `body` only — no `title`.
 *
 * The customer API accepts both, and a chat produces one block of prose rather than a
 * headline and a body. Offering `title` would mean asking the model to split the
 * customer's sentence into two, which is exactly the kind of paraphrase the catalogue
 * tells it not to perform on a review.
 *
 * ⚠ Sending `body` is what holds the review for a moderator; a bare star publishes
 * immediately and moves a public rating. That is a domain rule (`initialStatusOf`) and
 * deliberately not expressed here — a schema cannot say "this field changes the workflow".
 */
export const BotReviewCreateSchema = z
    .object({
        subjectType: z.enum(['product', 'delivery']),
        subjectId: objectId,
        rating: z.number().int().min(1).max(5),
        body: z.string().trim().min(1).max(2000).optional(),
    })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Notification preferences
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **`channel` is ONE value, not three booleans**, and that is a real difference from
 * `PATCH /api/customer/notifications/preferences`.
 *
 * The customer API takes `emailEnabled` / `telegramEnabled` / `whatsappEnabled`
 * independently and the service then auto-disables the others, because a settings screen
 * renders three switches. A chat cannot show three switches, and a caller sending two
 * `true`s would be relying on which one the service happens to keep. One value says the
 * only thing that is actually true — the platform delivers on at most one secondary
 * channel — and `none` says it out loud instead of leaving it to three falses.
 *
 * ⚠ **Money and cancellation notifications carry no key here and must not gain one.**
 * `SITUATION_PREFERENCE` has no entry for them, so no preference silences them: a
 * customer is the counterparty to somebody else's action there, not the owner of a
 * dashboard. Only progress reporting is gated.
 */
export const BotNotificationPreferencesSchema = z
    .object({
        channel: z.enum(['email', 'telegram', 'whatsapp', 'none']).optional(),
        orderUpdates: z.boolean().optional(),
        bookingUpdates: z.boolean().optional(),
        bookingReminders: z.boolean().optional(),
        marketing: z.boolean().optional(),
    })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Proactive messaging (GAP-012)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The closed set of situations the automation layer may raise.
 *
 * ⚠ **This is an ENUM, not a string, and it will stay one.** A route that relayed arbitrary
 * text could send nothing at all outside WhatsApp's 24-hour service window — which is the
 * only situation it would ever be reached in — and would make "no proactive marketing"
 * (`ARCHITECTURE.md` § 12) unenforceable by anything but good intentions. The copy lives in
 * `customer-notification-catalog.ts`, in five languages, with an approved template behind
 * each member.
 *
 * ⚠ **One member is the honest size today.** Every other proactive message a customer
 * receives is the consequence of something the PLATFORM did, so the platform raises it from
 * its own event and n8n has no part in it. `order.payment_link` is the one thing the
 * conversation knows and the platform cannot: that somebody chose to pay by card in a chat
 * and then stopped writing. A `z.enum` of one still reads as a closed set and still refuses
 * everything else — which is what it is for.
 */
export const BOT_NOTIFY_SITUATIONS = ['order.payment_link'] as const;

export const BotMessagingNotifySchema = z
    .object({
        situation: z.enum(BOT_NOTIFY_SITUATIONS),
        /**
         * Not an `objectId` on purpose — it is validated and OWNER-SCOPED in the controller,
         * and a shape refusal here would answer 400 where every other unknown transaction
         * answers 404. Those must not differ: a caller learning that their id was
         * well-formed-but-unknown, rather than malformed, is being told a real row exists
         * somewhere. Same rule as `BotTransactionParamSchema` above.
         */
        transactionId: z.string().trim().min(1).max(64),
    })
    .strict();

/** Routes that take no arguments at all still reject a stray key. */
export const BotNoArgsSchema = z.object({}).strict();
