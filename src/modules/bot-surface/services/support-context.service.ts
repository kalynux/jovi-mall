import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { escapeRegex } from '../../../core/utils/regex.util';
import { CustomerModel } from '../../customers/customer.model';
import { recentlyViewedRepository } from '../../customers/repositories/recently-viewed.repository';
import { publicCatalogService } from '../../catalog/services/public-catalog.service';
import { OrderModel } from '../../orders/order.model';
import { ShipmentRepository } from '../../shipments/shipment.repository';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { toAgencyIdentity } from '../../magazin/read-models/agency-identity.resolver';
import { StoreRepository } from '../../store/repositories/store.repository';

/**
 * Who the customer should be talking to — the support-routing ladder (GAP-004).
 *
 * ── THE ONE ROUTE ON THIS SURFACE THAT COMPOSES RATHER THAN DELEGATES ────────
 * Every other handler under `/api/internal/bot/*` calls the same service the customer API
 * calls and projects the answer. This one walks a ladder across four sources and decides
 * which of three parties is relevant, and that decision exists nowhere else in the
 * codebase — so it is genuinely new logic on a surface whose rule is "no business logic
 * lives here".
 *
 * It is here anyway, and GAP-004's whole argument is why: the alternative is not "no
 * ladder", it is **the ladder in n8n**, composed from three round-trips. That would put a
 * routing policy in the automation layer, which is the one thing this architecture exists
 * to avoid — and it would be three chances per conversation to route a person to the wrong
 * seller. Every *fact* below still comes from an existing repository; only the order in
 * which they are consulted is new.
 *
 * If a second consumer ever appears (a storefront "get help" panel, say), this lifts into
 * a shared service unchanged — the ports below are already the whole of its input.
 *
 * ── THE LADDER, AND WHY IT STOPS AT THE FIRST RUNG THAT ANSWERS ──────────────
 *
 *   1. `hintOrderId`, then `hintProductId` — what the conversation is actually about
 *   2. the most recent order            → its store, and its parcels' delivery company
 *   3. the most recently viewed product → its store
 *   4. `profile.recentProductCode`      → that product → its store
 *   5. nothing                          → the platform alone
 *
 * ⚠ **The rungs are NOT filtered by scope.** `scope: 'agency'` against a product-only
 * context has genuinely nothing to answer with, and that is a legitimate empty answer
 * (`BOT_SUPPORT_SCOPE_UNAVAILABLE`) rather than a reason to keep climbing. Skipping the
 * product rungs to find *an* agency would answer about a different purchase than the one
 * the customer is looking at, which is the failure `must_echo` exists to prevent.
 *
 * ── `resolvedFrom` AND `subject.label` ARE CONTRACT, NOT DIAGNOSTICS ─────────
 * The reply must name what it routed from — *"about your order ORD-2026-000123 from
 * Maison Bella"*. A support contact for the wrong purchase is worse than asking which one,
 * and a wrong resolution that is stated is corrected in one turn while a silent one is
 * discovered at the door.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The wire shape
// ─────────────────────────────────────────────────────────────────────────────

/** `auto` walks the ladder; the others answer for one party and say so when it is absent. */
export type SupportScope = 'auto' | 'vendor' | 'agency' | 'platform';

/** Which rung answered. Part of the contract — the reply names it. */
export type SupportResolvedFrom =
    | 'hint_order'
    | 'hint_product'
    | 'recent_order'
    | 'recently_viewed'
    | 'recent_product_code'
    | 'none';

export interface SupportSubject {
    type: 'order' | 'product' | 'none';
    id: string | null;
    /** What the bot must echo. Never null unless there is no subject at all. */
    label: string | null;
}

export interface SupportVendorParty {
    /**
     * The store's slug, never the vendor id — the storefront addresses a seller by slug
     * precisely so an internal id never becomes a public identifier, and a chat window is
     * as public as it gets.
     */
    storeSlug: string;
    name: string;
    supportWhatsapp: string | null;
    supportPhone: string | null;
    supportEmail: string | null;
}

export interface SupportAgencyParty {
    id: string;
    name: string;
    supportWhatsapp: string | null;
    supportPhone: string | null;
    supportEmail: string | null;
}

export interface SupportPlatformParty {
    /**
     * ⚠ **Constant `true`, and honestly so.** Every caller of this route has already been
     * resolved to an active customer by `requireBotIdentity`, and `tickets_create` is
     * mounted for exactly that caller — so there is no state in which a resolved sender
     * cannot open one. The field is in the contract because the platform is the party
     * whose availability does NOT depend on context: when a seller has published no
     * contacts and nothing has shipped, this is the fall-through, and a flow reading it
     * should not have to know that it is always true to rely on it.
     */
    canOpenTicket: boolean;
}

export interface SupportContext {
    resolvedFrom: SupportResolvedFrom;
    subject: SupportSubject;
    vendor: SupportVendorParty | null;
    agency: SupportAgencyParty | null;
    /**
     * Always present, in every scope. The fall-through when a contact is missing is always
     * a ticket, so narrowing to `scope: 'vendor'` must not remove the answer the flow
     * needs when that vendor turns out to have published no contacts at all.
     */
    platform: SupportPlatformParty;
}

export interface SupportContextQuery {
    scope: SupportScope;
    hintOrderId?: string;
    hintProductId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ports — the whole of this service's input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Narrow ports rather than the repositories themselves, for one reason: the ladder is the
 * thing GAP-004 exists to move out of n8n, so it has to be testable *as a policy* — and
 * `test:bot-surface` runs with no database at all. Four small interfaces make that a
 * matter of passing four object literals; the concrete repositories are wired in the
 * defaults at the bottom of this file and are the only place Mongoose appears.
 */

/** The order facts the ladder needs — not the document, which carries far more. */
export interface SupportOrderFacts {
    id: string;
    orderNumber: string;
    vendorId: string;
}

export interface SupportOrderPort {
    /** An order the customer owns, by id or by the number they read out. Null if neither. */
    findOwned(customerId: string, reference: string): Promise<SupportOrderFacts | null>;
    /** Their most recent order, whatever its state. */
    findMostRecent(customerId: string): Promise<SupportOrderFacts | null>;
}

export interface SupportStoreFacts {
    slug: string;
    name: string;
    supportEmail: string | null;
    supportPhone: string | null;
    supportWhatsapp: string | null;
}

export interface SupportStorePort {
    findByVendorId(vendorId: string): Promise<SupportStoreFacts | null>;
    findBySlug(slug: string): Promise<SupportStoreFacts | null>;
}

export interface SupportAgencyPort {
    /** The delivery company behind an order's parcels, or null while nothing has shipped. */
    findForOrder(orderId: string): Promise<SupportAgencyParty | null>;
}

export interface SupportProductFacts {
    id: string;
    title: string;
    storeSlug: string;
}

export interface SupportProductPort {
    /** A PUBLISHABLE product, or null — the same predicate the rest of `/api/public` uses. */
    find(productId: string): Promise<SupportProductFacts | null>;
}

export interface SupportRecencyPort {
    /** The head of the recently-viewed list, or null. */
    mostRecentlyViewedProductId(customerId: string): Promise<string | null>;
    /** `Customer.recent_product_code`. Free-form by history — see the service. */
    recentProductCode(customerId: string): Promise<string | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────

export class SupportContextService {
    constructor(
        private readonly orders: SupportOrderPort = defaultOrderPort,
        private readonly stores: SupportStorePort = defaultStorePort,
        private readonly agencies: SupportAgencyPort = defaultAgencyPort,
        private readonly products: SupportProductPort = defaultProductPort,
        private readonly recency: SupportRecencyPort = defaultRecencyPort,
    ) {}

    async resolve(customerId: string, query: SupportContextQuery): Promise<SupportContext> {
        const context = await this.walkLadder(customerId, query);
        return applyScope(context, query.scope);
    }

    /**
     * The ladder. Returns the first rung that answers, with every party that rung yields.
     *
     * ⚠ **A hint that does not resolve is REFUSED, never fallen through.** Falling through
     * would answer about the customer's *other* purchase while the conversation is about
     * this one — and because the answer names its own subject, the customer would read a
     * confident sentence about the wrong thing. The two refusals are the ordinary
     * `ORDER_NOT_FOUND` / `CATALOG_PRODUCT_NOT_FOUND` every other route on this surface
     * raises for an id that is not theirs, so no new handling is needed at the caller.
     *
     * ⚠ **An order hint wins over a product hint** when both are sent. An order is the more
     * specific subject (it has a seller *and* a delivery company; a product has only a
     * seller), and it is rung 1 in GAP-004's own ladder.
     */
    private async walkLadder(customerId: string, query: SupportContextQuery): Promise<SupportContext> {
        if (query.hintOrderId) {
            const order = await this.orders.findOwned(customerId, query.hintOrderId);
            if (!order) {
                throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, {
                    orderId: query.hintOrderId,
                });
            }
            return this.fromOrder(order, 'hint_order');
        }

        if (query.hintProductId) {
            const product = await this.products.find(query.hintProductId);
            if (!product) {
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, undefined, {
                    productId: query.hintProductId,
                });
            }
            return this.fromProduct(product, 'hint_product');
        }

        const recentOrder = await this.orders.findMostRecent(customerId);
        if (recentOrder) return this.fromOrder(recentOrder, 'recent_order');

        const viewedId = await this.recency.mostRecentlyViewedProductId(customerId);
        if (viewedId) {
            const viewed = await this.products.find(viewedId);
            // A row whose product has since been unpublished is SKIPPED rather than
            // refused: `recently_viewed` deliberately outlives the products in it (the read
            // degrades an entry to `product: null`), so an absent one here means the
            // catalogue moved on, not that the customer asked for something impossible.
            if (viewed) return this.fromProduct(viewed, 'recently_viewed');
        }

        /**
         * ⚠ **`recent_product_code` is CLIENT-WRITABLE and has no guaranteed vocabulary.**
         * `PATCH /api/customer/profile` accepts any trimmed string in it, and it predates
         * the recently-viewed list that now maintains it — its own service says so. So it
         * is read defensively: anything that is not an id resolving to a publishable
         * product simply does not answer, and the ladder falls to the platform rung. It is
         * never an error, because a value a client set years ago is not a request.
         */
        const code = await this.recency.recentProductCode(customerId);
        if (code && Types.ObjectId.isValid(code)) {
            const coded = await this.products.find(code);
            if (coded) return this.fromProduct(coded, 'recent_product_code');
        }

        return {
            resolvedFrom: 'none',
            subject: { type: 'none', id: null, label: null },
            vendor: null,
            agency: null,
            platform: PLATFORM,
        };
    }

    /**
     * An order yields both trading parties.
     *
     * ⚠ **The delivery company comes from the order's SHIPMENTS, not from
     * `items[].delivery.agency_id`.** The assignment is on the item from checkout onward,
     * but the customer has never been shown it: `GET /api/customer/orders/:orderId/shipments`
     * is the only place this platform discloses which agency is carrying a parcel, and it
     * has nothing to disclose until a shipment row exists. Reading the item instead would
     * make this route the first door to name a delivery company the customer has not been
     * told about — and it would name one that reassignment can still change. It is also
     * what makes the catalogue's own sentence true: the agency "only exists once an order
     * has shipped".
     */
    private async fromOrder(
        order: SupportOrderFacts,
        resolvedFrom: SupportResolvedFrom,
    ): Promise<SupportContext> {
        const [store, agency] = await Promise.all([
            this.stores.findByVendorId(order.vendorId),
            this.agencies.findForOrder(order.id),
        ]);

        return {
            resolvedFrom,
            subject: {
                type: 'order',
                id: order.id,
                label: store ? `${order.orderNumber} — ${store.name}` : order.orderNumber,
            },
            vendor: store ? toVendorParty(store) : null,
            agency,
            platform: PLATFORM,
        };
    }

    /** A product yields a seller and nothing else — an agency attaches to a shipment. */
    private async fromProduct(
        product: SupportProductFacts,
        resolvedFrom: SupportResolvedFrom,
    ): Promise<SupportContext> {
        const store = await this.stores.findBySlug(product.storeSlug);

        return {
            resolvedFrom,
            subject: { type: 'product', id: product.id, label: product.title },
            vendor: store ? toVendorParty(store) : null,
            agency: null,
            platform: PLATFORM,
        };
    }
}

const PLATFORM: SupportPlatformParty = Object.freeze({ canOpenTicket: true });

function toVendorParty(store: SupportStoreFacts): SupportVendorParty {
    return {
        storeSlug: store.slug,
        name: store.name,
        supportWhatsapp: store.supportWhatsapp,
        supportPhone: store.supportPhone,
        supportEmail: store.supportEmail,
    };
}

/**
 * Narrow the answer to one party, or refuse.
 *
 * ── THE TWO REFUSALS ARE DIFFERENT QUESTIONS, AND THAT IS WHY THERE ARE TWO ──
 * `BOT_SUPPORT_NO_CONTEXT` (404) — there is nothing to route from at all. Nobody named a
 * subject, and the customer has never ordered, viewed or been recorded against anything.
 * `BOT_SUPPORT_SCOPE_UNAVAILABLE` (409) — there IS a subject, and the party asked for does
 * not exist for it. Overwhelmingly this is `agency` against a product, or against an order
 * whose parcels have not been created yet.
 *
 * ⚠ **`auto` and `platform` never raise either.** GAP-004's ladder ends "nothing → platform
 * only", and that is the better chat answer as well as the specified one: a customer who
 * says "I need help" having never ordered should be offered a ticket, not told that
 * nothing was found. The two refusals are reachable only through a NAMED party scope,
 * which is the request that genuinely cannot be answered.
 */
function applyScope(context: SupportContext, scope: SupportScope): SupportContext {
    if (scope === 'auto') return context;
    if (scope === 'platform') return { ...context, vendor: null, agency: null };

    const party = scope === 'vendor' ? context.vendor : context.agency;

    if (!party) {
        if (context.subject.type === 'none') {
            throw createAppError(ERROR_CODES.BOT_SUPPORT_NO_CONTEXT, 404, undefined, { scope });
        }
        throw createAppError(ERROR_CODES.BOT_SUPPORT_SCOPE_UNAVAILABLE, 409, undefined, {
            scope,
            subjectType: context.subject.type,
        });
    }

    return scope === 'vendor'
        ? { ...context, agency: null }
        : { ...context, vendor: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// The default ports — the only place a repository is touched
// ─────────────────────────────────────────────────────────────────────────────

const storeRepository = new StoreRepository();
const shipmentRepository = new ShipmentRepository();
const magazinRepository = new MagazinRepository();

const defaultOrderPort: SupportOrderPort = {
    /**
     * The same id-or-number lookup `bot-order.controller.ts` performs, and deliberately the
     * same shape: a customer quoting "ORD-2026-000123" in a chat must reach the same order
     * here as they do from `orders_get_order`. `escapeRegex` because every search path in
     * this service is `$regex`-based and an unescaped term is injection plus ReDoS.
     */
    async findOwned(customerId, reference) {
        const customer = new Types.ObjectId(customerId);

        if (Types.ObjectId.isValid(reference)) {
            const byId = await OrderModel.findOne({ _id: reference, customer_id: customer })
                .select('order_number vendor_id')
                .lean();
            if (byId) return { id: byId._id.toString(), orderNumber: byId.order_number, vendorId: byId.vendor_id.toString() };
        }

        const byNumber = await OrderModel.findOne({
            customer_id: customer,
            order_number: { $regex: `^${escapeRegex(reference)}$`, $options: 'i' },
        })
            .select('order_number vendor_id')
            .lean();

        return byNumber
            ? { id: byNumber._id.toString(), orderNumber: byNumber.order_number, vendorId: byNumber.vendor_id.toString() }
            : null;
    },

    /** Served by the existing `{ customer_id: 1, created_at: -1 }` index. */
    async findMostRecent(customerId) {
        const row = await OrderModel.findOne({ customer_id: new Types.ObjectId(customerId) })
            .sort({ created_at: -1 })
            .select('order_number vendor_id')
            .lean();

        return row
            ? { id: row._id.toString(), orderNumber: row.order_number, vendorId: row.vendor_id.toString() }
            : null;
    },
};

const defaultStorePort: SupportStorePort = {
    async findByVendorId(vendorId) {
        // The OrNull variant: `findByVendorId` throws on absence because a vendor without a
        // store is a provisioning bug, and that is true — but it must not turn "who do I
        // contact about this order" into a 404 for the customer.
        const store = await storeRepository.findByVendorIdOrNull(vendorId);
        return store ? toStoreFacts(store) : null;
    },

    async findBySlug(slug) {
        const store = await storeRepository.findBySlug(slug);
        return store ? toStoreFacts(store) : null;
    },
};

function toStoreFacts(store: {
    slug: string;
    name: string;
    support_email?: string | null;
    support_phone?: string | null;
    support_whatsapp?: string | null;
}): SupportStoreFacts {
    return {
        slug: store.slug,
        name: store.name,
        supportEmail: store.support_email ?? null,
        supportPhone: store.support_phone ?? null,
        supportWhatsapp: store.support_whatsapp ?? null,
    };
}

const defaultAgencyPort: SupportAgencyPort = {
    /**
     * The agency behind the MOST RECENT parcel.
     *
     * An order's items can carry different agencies (the agency is a property of the
     * variant's delivery configuration), so a multi-parcel order can have more than one.
     * The newest shipment is the one the customer is most likely asking about, and naming
     * one delivery company is a better chat answer than listing two — the ones not named
     * are still reachable through `orders_list_shipments`, which returns every parcel with
     * its own agency block.
     *
     * The logo is deliberately NOT resolved: `resolveAgencyIdentity` would cost a file
     * query and a storage round-trip for a contact card that renders as text.
     */
    async findForOrder(orderId) {
        const shipments = await shipmentRepository.findByOrderId(orderId);
        if (shipments.length === 0) return null;

        const latest = [...shipments].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        )[0];

        const agencyId = latest.agency_id.toString();
        const identities = await magazinRepository.findIdentitiesByAgencyIds([agencyId]);
        const fields = identities.get(agencyId);
        // An agency with no magazin yields no identity at all — the same `?? null` every
        // other caller of this resolver applies.
        if (!fields) return null;

        const identity = toAgencyIdentity(agencyId, fields, null);
        return {
            id: identity.id,
            name: identity.name,
            supportWhatsapp: identity.supportWhatsapp,
            supportPhone: identity.supportPhone,
            supportEmail: identity.supportEmail,
        };
    },
};

const defaultProductPort: SupportProductPort = {
    /**
     * `listByIds` rather than a direct `ProductModel` read, because it carries the
     * publishable predicate — the same one `/api/public` applies — and returns the store
     * slug and the title in one query. A product a shopper cannot see must not be a
     * subject a support answer names.
     */
    async find(productId) {
        if (!Types.ObjectId.isValid(productId)) return null;
        const card = (await publicCatalogService.listByIds([productId])).get(productId);
        return card ? { id: card.id, title: card.title, storeSlug: card.store.slug } : null;
    },
};

const defaultRecencyPort: SupportRecencyPort = {
    async mostRecentlyViewedProductId(customerId) {
        const { rows } = await recentlyViewedRepository.listPage(customerId, 1, 1);
        return rows[0]?.product_id?.toString() ?? null;
    },

    async recentProductCode(customerId) {
        const customer = await CustomerModel.findById(customerId).select('recent_product_code').lean();
        return customer?.recent_product_code ?? null;
    },
};

export const supportContextService = new SupportContextService();
