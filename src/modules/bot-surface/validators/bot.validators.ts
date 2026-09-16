import { z } from 'zod';
import { CONNECTION_CHANNELS } from '../../channel-connections';
import { TICKET_TYPE_VALUES, TICKET_STATUS_VALUES } from '../../tickets/types/ticket.types';
import { BOT_ONBOARDING_STEP_VALUES } from '../domain/bot-onboarding';
import { BOT_CHAT_LIST_MAX } from '../domain/bot-list-window';
import { PhoneNumberSchema } from '../../../core/validation/phone';
import { EmailAddressSchema } from '../../../core/validation/email';
import { ACCOUNT_CLOSURE_CONFIRMATION } from '../../users/user.validator';
import {
    CUSTOMER_AGGREGATE_TYPES,
    CustomerAggregateType,
} from '../../notifications/models/customer-notification.model';

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
 * ⚠ **There is no `customerId` or `userId` field here, and there never may be.**
 *
 * `.strict()` is what makes that structural rather than a convention: a caller that adds
 * one gets a 400 naming the key, instead of a 200 and the quiet belief that it worked.
 * See `bot-identity.service.ts` for why a caller-supplied identity on this surface is
 * account takeover rather than a leak.
 *
 * ⚠ **`token` is not a counter-example to that rule, and the union below is what keeps it
 * from becoming one.** A sealed token is not an identity a caller CHOSE; it is one this
 * service issued, signed, and will verify before believing a word of it — see
 * `domain/bot-identity-token.ts`. The two forms are mutually exclusive (`.strict()` on
 * both halves), so a body carrying `channel` AND `token` is a 400 rather than a silent
 * decision about which one wins. `test:bot-surface` § 9 pins exactly that.
 *
 * `displayName` and `handle` are cosmetic and go no further than a new
 * `channel_connections` row's display fields. They are NOT used to resolve anybody.
 */
export const BotRawIdentityEnvelopeSchema = z
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
 * The sealed form — the only one an MCP transport can send.
 *
 * ⚠ **This exists because n8n's MCP Server Trigger gives a connected tool node no
 * per-request context at all** (measured 2026-09-06; the trigger runs *after* the tool).
 * The model's arguments are the only channel, so the envelope has to survive a trip
 * through a model — and a raw one there is an account-takeover primitive. The whole
 * argument is in `domain/bot-identity-token.ts`.
 *
 * Bounded at 2048 so a caller cannot make this service HMAC an unbounded string.
 */
export const BotSealedIdentityEnvelopeSchema = z
    .object({ token: z.string().trim().min(1).max(2048) })
    .strict();

/**
 * Either form, never a blend.
 *
 * ⚠ **Order matters only for the error message, not the outcome** — both halves are
 * `.strict()`, so exactly one can ever match and a body carrying fields from both matches
 * neither. The sealed form is tried first because it is the shorter shape and produces the
 * more legible union error for the caller most likely to get this wrong.
 */
export const BotIdentityEnvelopeSchema = z.union([
    BotSealedIdentityEnvelopeSchema,
    BotRawIdentityEnvelopeSchema,
]);

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
        /**
         * The lock the bargaining sub-agent minted when a haggle closed. This is the
         * door that price actually arrives through — bargaining is chat-only (D-6),
         * so the storefront has no control that produces one.
         *
         * ⚠ It changes the ADDS semantics above: a locked add SETS the line to
         * `quantity`, because the lock is bound to a quantity and incrementing would
         * produce one nobody agreed a price for. See `CartService.addToCart`.
         *
         * Not an identity and not a price — it names a deal the backend already
         * validated, so nothing here lets a caller choose what a customer pays.
         */
        negotiationLockRef: z.string().trim().min(1).max(200).optional(),
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
 * `limit` defaults to 5, not 20 — and since 2026-09-06 it is also CAPPED at 5.
 *
 * The catalogue's `chat_default_limit`. A chat reply that lists twenty orders is a wall
 * of text nobody reads, and the model paying for those tokens summarises them badly.
 * Every list on this surface defaults the same way.
 *
 * ⚠ **The `max` was 100, and a default is not a cap.** A model that decided it needed
 * "all" of something could ask for a hundred and get them, and on the MCP transport the
 * only thing telling it not to is a sentence in the server's `instructions` — which is a
 * rule the model breaks under exactly the pressure that makes it matter. The ceiling is
 * `BOT_CHAT_LIST_MAX` now, and asking for more is a **400 rather than a silent clamp**:
 * a caller that believes it requested fifty rows and was handed five would report the
 * five as the whole answer.
 *
 * `domain/bot-list-window.ts` carries the reasoning and the "see the rest" link.
 */
const chatPage = {
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(BOT_CHAT_LIST_MAX).default(BOT_CHAT_LIST_MAX),
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
/**
 * `PATCH /profile` — the ONE profile field a chat may write.
 *
 * ⚠ **Deliberately narrower than `PATCH /api/customer/profile`, and every omission is a
 * decision rather than an oversight.** The customer API takes seven fields; six of them are
 * refused here:
 *
 *   - `preferences.language` has its OWN route (`profile_set_language`), and two writers of
 *     one field is how the narrow one's five-language guard gets bypassed by the wide one.
 *   - `preferences.marketing_opt_in` overlaps the notification preferences this surface
 *     already exposes. Same argument.
 *   - `preferences.currency` — the platform prices in XAF; a customer-chosen currency here
 *     changes no total and would be a setting that appears to work.
 *   - `preferences.{ai_tone, compact_mode, ads_compact_mode}` describe a web UI. There is
 *     no web UI in a chat.
 *   - `avatarFileId` / `avatarUrl` need an upload path this surface does not have yet.
 *   - `bio` and `dateOfBirth` are **dropped by `toBotProfileSummary`**, so writing them
 *     from a chat would let a customer set something they can never read back here.
 *   - ⛔ `recentProductCode` is SERVER-MANAGED by `recentlyViewedService`, whose own
 *     docstring explains why a caller-chosen value is a caller-chosen position in a bounded
 *     list. It must never appear on this surface.
 *
 * What is left is the field a customer actually asks to change in a chat: the name the bot
 * greets them by, most often because onboarding captured a messaging-profile name they do
 * not use.
 */
export const BotProfileUpdateSchema = z
    .object({ name: z.string().trim().min(1).max(100) })
    .strict();

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

/**
 * `PATCH /addresses/:addressId` — rename it, re-describe it, or re-point it.
 *
 * ⚠ **The no-coordinates rule holds here exactly as it does on the add**, and this is the
 * route where forgetting it would be easiest: the customer API's `PATCH` takes the whole
 * address including a `geo` object, and mirroring that shape would put the 2dsphere null
 * back within reach of a caller. Re-pointing an address means naming a **new candidate
 * handle**, which the controller resolves and rebuilds from — the same path `addresses_add`
 * takes, so there is one way to write a `geo` on this surface rather than two.
 *
 * ⚠ **`isDefault` is absent, and it is absent from the customer API's PATCH too.** It is a
 * relationship BETWEEN addresses — exactly one may hold it — so setting it means clearing
 * every sibling. `addresses_set_default` owns that clear-then-set; accepting the flag here
 * would be a second way to write it, and the one that forgets the other half.
 *
 * ⚠ **At least one field is required.** A `.strict()` object of all-optional fields accepts
 * `{}`, which would spend an idempotency key, write nothing, and answer 200 — a caller
 * that built the body wrong would read that as success.
 */
export const BotAddressUpdateSchema = z
    .object({
        label: z.string().trim().min(1).max(50).optional(),
        /** ⚠ Clearable: `null` removes the line, `undefined` leaves it alone. */
        addressLine2: z.string().trim().max(200).nullish(),
        /** Re-point the address at a different place. Same single-use handle as the add. */
        geoCandidateRef: z.string().trim().min(1).max(128).optional(),
    })
    .strict()
    .refine(
        (v) => v.label !== undefined || v.addressLine2 !== undefined || v.geoCandidateRef !== undefined,
        { message: 'Name at least one field to change' },
    );

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
        /**
         * ⚠ **The second of the two limits, and it was `max(10)` rather than `max(100)`.**
         * Worth capping with the rest anyway: the address picker renders one row per
         * candidate as a tappable control, and WhatsApp's list message caps its rows —
         * so ten candidates is a picker that cannot be drawn, not merely a long one.
         */
        limit: z.number().int().min(1).max(BOT_CHAT_LIST_MAX).default(BOT_CHAT_LIST_MAX),
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

/**
 * ⚠ **`ref`, and there is deliberately no way to send a file id.**
 *
 * The same rule `geoCandidateRef` follows one section up, for the same reason and with a
 * sharper edge. A caller that could name a `files` row directly could attach any file the
 * customer has ever uploaded — an avatar, a receipt from another ticket — to any ticket
 * they follow, and nothing downstream would find that odd. A handle is minted by
 * `/files/inbound`, owned by one account, single-use and thirty minutes old at most.
 */
export const BotTicketAttachmentSchema = z
    .object({ ref: z.string().trim().min(1).max(128) })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Inbound files (Step 7b)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A file the customer sent in the chat, delivered by the automation layer as bytes.
 *
 * ⚠ **`contentBase64` is the ONE field on this whole surface that carries a payload rather
 * than a reference**, and it is why this route needs its own body-parser ceiling in
 * `app.ts`.
 *
 * ⚠ **The cap here sits AT that parser ceiling, deliberately, and must never drop below it.**
 * It is a character count and the real limit is `BOT_INBOUND_FILE_MAX_BYTES`, applied to the
 * DECODED buffer in the controller — the only length that means anything. A lower cap here
 * looks tidier and is wrong: it fires *before* the controller and turns an honest
 * "that file is too large" into a generic validation failure, for every file between the two
 * numbers. Set at the parser's ceiling, anything the parser admitted reaches the controller,
 * so there is exactly one size refusal and it is the one a chat can relay. Measured by
 * `verify:bot-surface` § 12, which is what caught the narrow band the first version left.
 *
 * ⚠ **`mimeType` is what the CALLER claims**, and the upload pipeline re-derives the real
 * type from the bytes and refuses a mismatch. Nothing here trusts it beyond deciding
 * whether to spend the pipeline on it at all.
 */
export const BotInboundFileSchema = z
    .object({
        fileName: z.string().trim().min(1).max(255),
        mimeType: z.string().trim().min(1).max(128),
        // 12 MB of characters — `BOT_FILE_BODY_LIMIT`'s own ceiling, so a body the parser
        // accepted always reaches the controller's decoded-byte check.
        contentBase64: z.string().min(1).max(12 * 1024 * 1024),
    })
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

// ─────────────────────────────────────────────────────────────────────────────
// Product cards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `catalog_show_products` — the ids the model chose, in the order it ranked them.
 *
 * ⚠ **A minimum of ONE, deliberately, even though the model is told to narrate a single
 * product in prose.** The rule about when to draw cards belongs in the system prompt, where
 * it can be phrased as guidance; enforcing it here would turn a judgement call about a
 * conversation into a 400 the customer experiences as the bot ignoring them.
 *
 * The ceiling is two pages of five. A model handed a bigger allowance fills it, and the
 * eleventh product is one nobody scrolls to.
 */
export const BotProductDisplaySchema = z
    .object({ productIds: z.array(objectId).min(1).max(10) })
    .strict();

/**
 * `catalog_display_action` — a button the customer pressed.
 *
 * The token is opaque here on purpose: `parseBotActionId` owns the vocabulary, and a Zod
 * `enum` of verbs would be a second copy of it that drifts. Bounded and trimmed because it
 * arrives from a messaging platform and reaches a lookup.
 */
export const BotDisplayActionSchema = z
    .object({ token: z.string().trim().min(1).max(128) })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
// The in-app screens
//
// ⚠ **All three are `.strict()`**, which on this surface is the norm rather than a choice:
// an unknown key here means the automation layer and this contract disagree, and a silently
// ignored field is how a filter the model believed it applied never reaches the query.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `inapp_open_listing` — what the product grid should show.
 *
 * ⚠ **Every field is optional and an empty body is VALID**, meaning "the whole shop". That is
 * the browse case and it is the common one; requiring a filter would make the plain
 * "show me what you have" turn impossible to express.
 *
 * ⚠ **`productIds` is the one field that is not a filter** — it pins an exact set, for a
 * wishlist or a model-chosen selection rendered as a grid rather than as five chat cards. It
 * is capped at fifty, well above the chat's ten: the grid is precisely the surface that can
 * show more than a chat can, so inheriting the chat's ceiling would defeat the feature. The
 * cap exists at all because the value is echoed into a query.
 */
export const BotInAppListingSchema = z
    .object({
        q: z.string().trim().min(1).max(120).optional(),
        category: z.string().trim().min(1).max(120).optional(),
        storeSlug: z.string().trim().min(1).max(160).optional(),
        productIds: z.array(objectId).min(1).max(50).optional(),
    })
    .strict();

/**
 * `inapp_open_product` — the product whose screen to open.
 *
 * ⚠ **Not `objectId`, deliberately, and the controller re-checks the shape.** Same rule as
 * `BotTransactionParamSchema`: a shape refusal here would answer 400 where every other unknown
 * product answers 404, and a caller learning that its id was well-formed-but-unknown is being
 * told a real row exists somewhere.
 */
export const BotInAppProductSchema = z.object({
    productId: z.string().trim().min(1).max(64),
});

/** `inapp_open_stores` — the store directory, optionally narrowed. */
export const BotInAppStoresSchema = z
    .object({
        q: z.string().trim().min(1).max(120).optional(),
        city: z.string().trim().min(1).max(120).optional(),
    })
    .strict();

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

/**
 * `POST /bookings/availability` — a service product's bookable slots.
 *
 * ⚠ **The date range is OPTIONAL here and REQUIRED on the customer API**, and that is the
 * deliberate difference. `GET /api/products/:productId/availability` 400s without both
 * `fromDate` and `toDate` because a calendar widget always knows which fortnight it is
 * rendering. A model does not: asking it to compute two ISO-8601 instants is asking it to
 * do date arithmetic, which is a thing models get wrong quietly — an off-by-one month
 * answers "no availability" for a product with plenty.
 *
 * Omitted, the handler uses now → +`BOT_AVAILABILITY_WINDOW_DAYS`, the same 21 days the
 * storefront's own booking panel opens with.
 *
 * `slotId` is NOT an ObjectId. It is `slot_<startMs>_<endMs>`, minted by
 * `SlotGeneratorService` and parsed back by it — so it is validated by shape here rather
 * than by the `objectId` regex every other id on this surface uses.
 */
export const BotBookingAvailabilitySchema = z
    .object({
        productId: objectId,
        /** ISO-8601. Defaults to now. */
        from: z.string().datetime({ offset: true }).optional(),
        /** ISO-8601. Defaults to `from` + 21 days. */
        to: z.string().datetime({ offset: true }).optional(),
        ...chatPage,
    })
    .strict()
    .refine((d) => !(d.from && d.to && new Date(d.from) > new Date(d.to)), {
        message: 'from must be before or equal to to',
        path: ['from'],
    });

/** `slot_<startMs>_<endMs>` — see `SlotGeneratorService.parseSlotId`. */
const slotId = z
    .string()
    .trim()
    .regex(/^slot_\d{1,15}_\d{1,15}$/, 'Must be a slot id of the form slot_<startMs>_<endMs>');

/**
 * `POST /bookings` — book a slot.
 *
 * ⚠ **There is no `metadata`, and the customer API has one.** `POST /api/products/:id/book`
 * forwards `req.body.metadata` onto the booking document, and `createBooking` renders
 * `metadata.notes` into the vendor's Google Calendar event description. A free-form object
 * authored by a model, landing in a real business's calendar, is not something the customer
 * asked for — so this surface offers the ONE key that has a defined destination, as a
 * capped string, and drops the rest.
 *
 * ⚠ **There is no `slotId` lock step either.** This route takes the hold itself; see
 * `BotBookingController.create` for why a chat must never hold one across a turn.
 */
export const BotBookingCreateSchema = z
    .object({
        productId: objectId,
        slotId,
        /** The customer's own words about the appointment. Reaches the vendor's calendar. */
        notes: z.string().trim().min(1).max(500).optional(),
    })
    .strict();

/** `PATCH /bookings/:bookingId/reschedule` — move it to another slot the bot will hold. */
export const BotBookingRescheduleSchema = z
    .object({ slotId })
    .strict();

/**
 * The money pair, `POST /bookings/:bookingId/{pay,pay-balance}`.
 *
 * Mirrors `InitiateBookingPaymentSchema` rather than importing it, for the reason every
 * other schema here is restated: the customer API's `channel` carries `cardToken`, and a
 * card token has no business arriving from a chat transport. `customerName` goes too — the
 * platform knows the customer's name and does not need a model's version of it.
 *
 * ⚠ **`phoneOperator` must be ASKED, never guessed.** Sending MTN for an Orange number
 * reaches the customer as "payment declined", and the catalogue says so on
 * `payment_initiate` for the same reason.
 */
export const BotBookingPaySchema = z
    .object({
        gateway: z.enum(['NOTCHPAY', 'MYCOOLPAY', 'STRIPE']),
        phoneNumber: z.string().trim().min(1).max(20).optional(),
        phoneOperator: z.enum(['MTN', 'ORANGE', 'MOOV']).optional(),
        customerEmail: z.string().trim().email().max(254).optional(),
    })
    .strict()
    .refine((d) => d.gateway === 'STRIPE' || Boolean(d.phoneNumber), {
        message: 'phoneNumber is required for mobile money payments',
        path: ['phoneNumber'],
    });

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

/**
 * `POST /reviews/list` — the customer's own reviews, every status by default.
 *
 * ⚠ **Every status is the point of this list, not a permissive default.** A customer who
 * wrote a review and cannot find it on the product page has no other way to learn it is
 * simply waiting for a moderator — which is the reason the storefront's own page exists
 * too. Narrowing to `published` by default would hide exactly the row somebody asks about.
 *
 * `status` is nonetheless offered, because "did mine go up?" is a real question and
 * answering it by listing everything for the model to filter is four rows to discard.
 *
 * ⚠ There is no `subjectType` filter and it would be a trap if there were: a delivery
 * review's `status` does not mean what it says (see `toBotReviewDto`), so a filter pairing
 * the two would invite `{ subjectType: 'delivery', status: 'published' }` — a query whose
 * name promises a page nothing will ever appear on.
 */
export const BotReviewListSchema = z
    .object({
        status: z.enum(['pending', 'published', 'rejected']).optional(),
        ...chatPage,
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
/**
 * `POST /notifications/list` — the inbox.
 *
 * ⚠ **`aggregateType` is DERIVED from `CUSTOMER_AGGREGATE_TYPES`, never re-typed**, which
 * is the rule the notification model states about its own Mongoose enum and the reason the
 * agent stack's eight `agent_contract.*` situations were once undeliverable.
 *
 * It is not academic here: the customer API's own list filter hardcoded
 * `['booking','order','shipment','payment']` and GAP-012 added `ticket` to the union
 * without it, so a customer on the website could not filter to their ticket notifications
 * at all. Copying that literal would have reproduced the defect on a second surface.
 */
export const BotNotificationListSchema = z
    .object({
        /** `true` narrows to unread. There is deliberately no "read only" — nobody asks. */
        unreadOnly: z.boolean().optional(),
        /**
         * ⚠ Cast to a non-empty tuple **of the union type**, not of `string`. The looser
         * `as [string, ...string[]]` (used elsewhere in this file for the ticket enums)
         * compiles and then infers `string`, so every call site needs its own cast back —
         * and a cast back is a place to write the wrong type. This keeps the literals.
         */
        aggregateType: z
            .enum(CUSTOMER_AGGREGATE_TYPES as unknown as readonly [CustomerAggregateType, ...CustomerAggregateType[]])
            .optional(),
        ...chatPage,
    })
    .strict();

export const BotNotificationParamSchema = z.object({ notificationId: objectId });

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

/**
 * `POST /command` — the raw text of one message, and nothing else.
 *
 * ⚠ **The automation layer sends the message VERBATIM and parses nothing.** No command name,
 * no argument list, no alias resolution: the vocabulary is a five-language table and n8n is
 * the one layer with no copy table. A `command` field here would be exactly the parse this
 * route exists to keep server-side.
 *
 * ⚠ **It must be the RAW text, never Telegram's `bot_command` entity.** That entity stops at
 * a hyphen, which is why `/reset-password` was only ever readable as `/reset` plus trailing
 * text — the trap `commands.json`'s `canonical_name_rule` documents and the reason the
 * vocabulary is now one word with no separators at all.
 *
 * The cap is Telegram's own message ceiling. A command line longer than that is not a
 * command, and bounding it here keeps the edit-distance search off an unbounded string.
 */
export const BotCommandDispatchSchema = z
    .object({
        text: z.string().min(1).max(4096),
    })
    .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Saved payment methods
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three mobile-money networks the storefront offers, and the only values this surface
 * will save.
 *
 * ⚠ **Copied from `frontend/landing`'s own `MOMO_PROVIDERS`**, which is a hand-typed list
 * there too — the backend column is a free `String`, so nothing checks either side. A
 * fourth network added on the website is a value this schema will refuse until it is added
 * here as well.
 */
export const BOT_WALLET_PROVIDERS = ['mtn_momo', 'orange_money', 'moov_money'] as const;

/**
 * `POST /payment-methods` — save a mobile-money wallet.
 *
 * ── WHY THERE IS NO CARD PATH, AND WHY THAT IS NOT CAUTION ──────────────────
 * `POST /api/me/payment-methods` requires `gateway_customer_id` and
 * `gateway_instrument_id`. For a CARD those are produced by the payment gateway's own SDK
 * running in a browser, after the shopper types a number the platform never sees. A chat
 * has no browser and no SDK, so there is no honest way for a chat caller to hold one — a
 * model asked for those two fields would supply something invented.
 *
 * For a WALLET they are not tokens at all: the storefront sends the customer's E.164 number
 * as **both** values, because for mobile money the customer and the instrument are the same
 * thing. So this route takes the number and composes the rest server-side.
 *
 * ⚠ **`display_label` and `last4` are composed here too, not accepted.** They are what a
 * chat will read back out to the customer, and a model that wrote its own label could
 * produce a wallet named after the wrong network — which is then the label the customer
 * picks at checkout.
 */
export const BotPaymentMethodAddSchema = z
    .object({
        provider: z.enum(BOT_WALLET_PROVIDERS),
        /**
         * The wallet's own number.
         *
         * ⚠ `PhoneNumberSchema` rather than a loose string, and it is the platform's own —
         * it normalises formatting away and then REFUSES anything that is not strict E.164.
         * The value is stored as the thing a gateway will later be asked to debit, so a
         * locally-formatted number saved today is a payment that fails at checkout weeks
         * later with nothing to point at. Refusing at the door is the only cheap moment.
         */
        phoneNumber: PhoneNumberSchema,
        /** Make it the one checkout reaches for first. */
        makeDefault: z.boolean().optional(),
    })
    .strict();

export const BotPaymentMethodParamSchema = z.object({ methodId: objectId });

// ─────────────────────────────────────────────────────────────────────────────
// Contact changes — what the account signs in with (MCP parity step 6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `PATCH /contact/email` — open a change of login email.
 *
 * ⚠ **`EmailAddressSchema`, the platform's own, rather than a loose string.** It normalises
 * and then REFUSES anything that is not RFC-shaped, which is the only cheap moment: the
 * value becomes what `POST /auth/login` resolves the account by, and an address that this
 * door accepts and login cannot resolve is an account nobody can sign into. The same
 * argument `BotPaymentMethodAddSchema` makes about E.164.
 *
 * ⚠ **The address is NOT clearable here, and that is the customer API's rule inherited
 * whole** (`user.validator.ts`): clearing a login identifier is an administrator's
 * operation, because a self-service path that could remove the last one lets a person lock
 * themselves out with no way back. `clearable()` would be exactly the wrong helper.
 */
export const BotContactEmailSchema = z.object({ email: EmailAddressSchema }).strict();

/**
 * `PATCH /contact/phone` — open a change of login phone.
 *
 * ⚠ **Requesting is not confirming, and on this surface the gap is wider than it looks.**
 * The proof the platform accepts is a WhatsApp connection whose identity IS the new number
 * (`ContactChangeService.assertPhoneProved`) — there is no SMS provider in this service and
 * a template message to a stranger's number would need a credit wallet a customer does not
 * have. So a customer chatting on Telegram, or on WhatsApp from their OLD number, cannot
 * complete this from where they are standing. See `BotContactController.changePhone`.
 */
export const BotContactPhoneSchema = z.object({ phone: PhoneNumberSchema }).strict();

// ─────────────────────────────────────────────────────────────────────────────
// Messaging connections and account closure (MCP parity step 7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `DELETE /connections/:channel`.
 *
 * The enum is `CONNECTION_CHANNELS`, imported rather than spelled out, so a third channel
 * added to that module is accepted here without an edit — and, more to the point, so this
 * schema cannot come to disagree with the ladder that resolves the caller.
 */
export const BotConnectionParamSchema = z.object({ channel: z.enum(CONNECTION_CHANNELS) });

/**
 * `POST /account/close` — irreversible, and the phrase is the whole guard.
 *
 * ⚠ **The literal is the platform's own `ACCOUNT_CLOSURE_CONFIRMATION`, imported**, so this
 * surface cannot come to demand a different phrase from the storefront. It is deliberately
 * NOT translated: it is a token rather than a sentence — the thing the flow sends after the
 * customer has tapped a button, exactly as `bot-action-id.ts` argues a determined answer
 * must be an untranslated id and never a typed word. What the CUSTOMER reads is the
 * localised consequence in `botChrome('accountClosurePrompt')`, which the flow shows first.
 *
 * ⚠ **Not the password, and that is the customer API's reasoning inherited whole**
 * (`user.validator.ts`): customers on this platform are passwordless by default and sign in
 * through this very bot, so a password gate would make closure impossible for most of the
 * people entitled to it. The phrase does the one job a confirmation can do — it makes the
 * request impossible to send by accident.
 */
export const BotAccountCloseSchema = z
    .object({ confirm: z.literal(ACCOUNT_CLOSURE_CONFIRMATION) })
    .strict();
