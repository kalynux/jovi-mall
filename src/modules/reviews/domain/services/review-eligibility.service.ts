import { Types } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { OrderModel } from '../../../orders/order.model';
import { ShipmentModel } from '../../../shipments/shipment.model';
import { ProductModel } from '../../../catalog/models/product.model';
import { ListingModel } from '../../../listings/models/listing.model';
import { ListingLeadModel } from '../../../listings/models/listing-lead.model';
import { ReviewAuthorRole, ReviewSubjectType } from '../../models/review.model';
import { roleMayReview } from '../review-targets';

/**
 * Who is asking, in both identity spaces at once.
 *
 * `userId` is what a review is authored by (`users`), `roleEntityId` is what
 * ownership is checked against (`customers` / `vendors` / `delivery_agencies`).
 * Every caller has both on `req.auth`, and the two are never interchangeable.
 */
export interface ReviewAuthor {
  userId: string;
  role: ReviewAuthorRole;
  roleEntityId: string;
}

/** What eligibility resolved: the evidence, and the targets that follow from it. */
export interface ReviewEligibility {
  orderId: string | null;
  shipmentId: string | null;
  productId: string | null;
  agentId: string | null;
  agencyId: string | null;
  /** Listing reviews (2026-11-08): the listing, which is subject and target at once. */
  listingId?: string | null;
  vendorId: string | null;
}

/**
 * ReviewEligibilityService — the verified-purchase / verified-delivery gate.
 *
 * ── Why this is the point of the module rather than a detail of it ────────────
 * Page 07 asks for verified-purchase gating explicitly, and Google's review spam
 * policy is the concrete reason: publishing `aggregateRating` built from reviews
 * anybody can write earns a manual action, which is worse for the storefront than
 * having no ratings at all. On the delivery side the stake is different and larger —
 * after Step 11 a delivery rating moves an agent's COD cash limit, so "who may rate
 * this delivery" is a question about real money.
 *
 * ── The two refusals mean different things, and both are deliberate ───────────
 * `REVIEW_SUBJECT_NOT_FOUND` (404) is returned for a subject that does not exist AND
 * for one that exists but is not this caller's — the same answer, so that probing ids
 * cannot confirm which. `REVIEW_NOT_ELIGIBLE` (422) is returned when the caller IS a
 * party to the thing and it simply has not reached a reviewable state: the order is
 * not completed, the shipment is not delivered. That distinction is safe to make,
 * because it tells the caller nothing they did not already know.
 */
export class ReviewEligibilityService {
  async resolve(
    author: ReviewAuthor,
    subjectType: ReviewSubjectType,
    subjectId: string,
  ): Promise<ReviewEligibility> {
    if (!roleMayReview(subjectType, author.role)) {
      throw createAppError(ERROR_CODES.REVIEW_ROLE_NOT_ALLOWED, 400, undefined, {
        subjectType,
        authorRole: author.role,
      });
    }

    if (subjectType === 'product') return await this.resolveProduct(author, subjectId);
    if (subjectType === 'listing') return await this.resolveListing(author, subjectId);
    return await this.resolveDelivery(author, subjectId);
  }

  /**
   * A product review is earned by a **completed order** containing that product.
   *
   * `completion.confirmed_at` rather than `fulfillment_status`, and that is the
   * meaningful choice. Completion is the platform's own "the customer has it" —
   * `OrderCompletionService.isSettled` requires every physical item terminal (a
   * partially-returned order is finished too) and, for a digital order,
   * `fulfillment_status === 'fulfilled'`. It is set by the customer confirming, by
   * the COD cash handover, or by the auto-confirm sweep, so every route to "this
   * person actually received what they bought" converges on this one field. Reading
   * `fulfillment_status` directly would have to reproduce that logic and would get
   * the partially-returned case wrong.
   *
   * The order is not required to be the *most recent* one — any completed order of
   * this customer containing this product qualifies, and the one that matched is
   * snapshotted as the evidence.
   */
  private async resolveProduct(author: ReviewAuthor, productId: string): Promise<ReviewEligibility> {
    if (author.role !== 'customer') {
      throw createAppError(ERROR_CODES.REVIEW_ROLE_NOT_ALLOWED, 400);
    }

    const product = await ProductModel.findOne({ _id: productId, deletedAt: null }, { _id: 1, vendorId: 1 }).lean();
    if (!product) throw createAppError(ERROR_CODES.REVIEW_SUBJECT_NOT_FOUND, 404);

    const order = await OrderModel.findOne(
      {
        customer_id: new Types.ObjectId(author.roleEntityId),
        'completion.confirmed_at': { $ne: null },
        'items.product_id': new Types.ObjectId(productId),
      },
      { _id: 1, vendor_id: 1 },
    )
      .sort({ created_at: -1 })
      .lean();

    if (!order) throw createAppError(ERROR_CODES.REVIEW_NOT_ELIGIBLE, 422, undefined, { subjectType: 'product' });

    return {
      orderId: order._id.toString(),
      shipmentId: null,
      productId,
      agentId: null,
      agencyId: null,
      // The seller as recorded on the ORDER, not on the product. A product may change
      // hands or be re-owned; the sale it was reviewed for did not.
      vendorId: order.vendor_id?.toString() ?? null,
    };
  }

  /**
   * A listing review is earned by a **lead** (owner L-27, 2026-10-19): the customer unlocked at
   * least one of the business's contacts, in any window, so they actually reached it. A save, a
   * view or a search result is not a lead and earns nothing. The provider can never review their
   * own listing: a lead is opened only by a customer's reveal.
   *
   * The two refusals keep their meaning. A listing that does not exist, or was never past review
   * (draft, pending, rejected — no customer can have seen it), is `REVIEW_SUBJECT_NOT_FOUND`, the
   * same answer whether or not it exists. A live or paused listing without this customer's lead
   * is `REVIEW_NOT_ELIGIBLE`.
   *
   * ⚠ An ARCHIVED listing (the provider removed it, or closed their account) takes no NEW review —
   * `REVIEW_SUBJECT_NOT_REVIEWABLE`, reason `listing_archived` — and keeps the ones it has (plan
   * § 3.1). A paused one does take reviews: the customer did contact the business, and a pause for
   * credits says nothing about how it served them. (Stated default, 2026-11-08.)
   */
  private async resolveListing(author: ReviewAuthor, listingId: string): Promise<ReviewEligibility> {
    if (author.role !== 'customer') {
      throw createAppError(ERROR_CODES.REVIEW_ROLE_NOT_ALLOWED, 400);
    }

    const listing = await ListingModel.findById(listingId, { _id: 1, vendor_id: 1, status: 1 }).lean();
    if (!listing || !['live', 'suspended', 'archived'].includes(listing.status)) {
      throw createAppError(ERROR_CODES.REVIEW_SUBJECT_NOT_FOUND, 404);
    }

    const lead = await ListingLeadModel.exists({
      customer_id: new Types.ObjectId(author.roleEntityId),
      listing_id: new Types.ObjectId(listingId),
    });
    if (!lead) throw createAppError(ERROR_CODES.REVIEW_NOT_ELIGIBLE, 422, undefined, { subjectType: 'listing' });

    if (listing.status === 'archived') {
      throw createAppError(ERROR_CODES.REVIEW_SUBJECT_NOT_REVIEWABLE, 422, undefined, { reason: 'listing_archived' });
    }

    return {
      orderId: null,
      shipmentId: null,
      productId: null,
      agentId: null,
      agencyId: null,
      listingId,
      vendorId: listing.vendor_id?.toString() ?? null,
    };
  }

  /**
   * A delivery review is earned by being a **party to a delivered shipment**, and
   * which party you are decides what you are attesting to.
   *
   *   customer — the recipient: did the parcel arrive well?
   *   vendor   — the seller: was my consignment handled well?
   *   agency   — the employer: did my agent run this well?
   *
   * All three rate the same shipment and all three land on the same agent, in three
   * separate aggregate rows feeding three separate trust factors.
   *
   * ⚠ **A shipment with no `agent_id` is refused**, for every role. Every target
   * derivation needs the agent, a `delivered` shipment always has one, and accepting
   * the review anyway would silently record a rating attributable to nobody. It is a
   * 422 rather than a 404 because the shipment is real and the caller is entitled to
   * it — it is simply not reviewable.
   */
  private async resolveDelivery(author: ReviewAuthor, shipmentId: string): Promise<ReviewEligibility> {
    const shipment = await ShipmentModel.findById(shipmentId, {
      _id: 1,
      status: 1,
      agent_id: 1,
      agency_id: 1,
      order_id: 1,
    }).lean();
    if (!shipment) throw createAppError(ERROR_CODES.REVIEW_SUBJECT_NOT_FOUND, 404);

    const order = await OrderModel.findById(shipment.order_id, { _id: 1, customer_id: 1, vendor_id: 1 }).lean();
    if (!order) throw createAppError(ERROR_CODES.REVIEW_SUBJECT_NOT_FOUND, 404);

    // Ownership first, and a miss is a 404 — "exists, but not yours" must not be
    // distinguishable from "does not exist" on an id somebody can guess.
    const owns =
      author.role === 'customer'
        ? order.customer_id?.toString() === author.roleEntityId
        : author.role === 'vendor'
          ? order.vendor_id?.toString() === author.roleEntityId
          : shipment.agency_id?.toString() === author.roleEntityId;
    if (!owns) throw createAppError(ERROR_CODES.REVIEW_SUBJECT_NOT_FOUND, 404);

    if (shipment.status !== 'delivered') {
      throw createAppError(ERROR_CODES.REVIEW_NOT_ELIGIBLE, 422, undefined, {
        subjectType: 'delivery',
        status: shipment.status,
      });
    }

    if (!shipment.agent_id) {
      throw createAppError(ERROR_CODES.REVIEW_SUBJECT_NOT_REVIEWABLE, 422, undefined, {
        reason: 'no_agent_bound',
      });
    }

    return {
      orderId: order._id.toString(),
      shipmentId,
      productId: null,
      agentId: shipment.agent_id.toString(),
      agencyId: shipment.agency_id?.toString() ?? null,
      vendorId: order.vendor_id?.toString() ?? null,
    };
  }
}

export const reviewEligibilityService = new ReviewEligibilityService();
