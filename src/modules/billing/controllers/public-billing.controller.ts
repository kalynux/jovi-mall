import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { pricingPlanService } from '../services/pricing-plan.service';
import { toPublicPlanDto } from '../dto/public-plan.dto';
import { PublicListPlansQuerySchema } from '../validators/billing.validators';
import { BILLING_OWNER_TYPES, BillingOwnerType } from '../billing.types';
import {
  CREDIT_TOPUP_PACKS,
  VECTORISATION_COST,
  WHATSAPP_TEMPLATE_COST,
  AI_COPY_FIELD_COST,
  LISTING_REVEAL_FIRST_COST,
  LISTING_REVEAL_NEXT_COST,
} from '../config/credit.config';

/**
 * Unauthenticated reads of the published price list.
 *
 * These exist for one reason: the marketing site prints real prices, and until
 * now it could not read them. `GET /api/{role}/plans` is behind
 * `requireAuth + requireRole`, so a logged-out visitor had no way to fetch the
 * catalog and the numbers were hand-copied out of `seed-pricing-plans.ts` and
 * `credit.config.ts` — a copy that goes stale silently, and whose failure mode is
 * publishing a price the platform does not charge.
 *
 * Read-only, no side effects, no identity. Everything served here is already
 * printed on a public page; nothing owner-scoped is reachable from this
 * controller, and it must stay that way — see `public-billing.routes.ts`.
 */

/**
 * How long a client/CDN may reuse a response. Prices are admin-editable, so this
 * is the window in which an edit is invisible to the marketing site. Five minutes
 * trades that lag for not putting an unauthenticated endpoint straight onto Mongo.
 */
const PUBLIC_CACHE_SECONDS = 300;

function cacheable(res: Response): Response {
  return res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`);
}

export class PublicBillingController {
  /**
   * GET /api/public/plans[?role=vendor|agency|agent][&includeInactive=true][&vendorKind=seller|provider]
   *
   * Flat array across roles (grouped by role in `BILLING_OWNER_TYPES` order, then
   * by `sort_order`/`price` within a role) — the same shape and ordering as the
   * admin catalog, so a client can group by `role` in one pass.
   *
   * Active tiers only by default. `includeInactive=true` adds the defined-but-not
   * -purchasable tiers, each carrying `is_active: false`, so a "coming soon"
   * column can be rendered from live data instead of a second hand-kept list.
   * Soft-deleted plans are never returned either way.
   */
  static listPlans = asyncHandler(async (req: Request, res: Response) => {
    const { role, includeInactive, vendorKind } = PublicListPlansQuerySchema.parse(req.query);
    // `vendorKind` (SERVICE-LISTINGS-PLAN § C-5) asks for vendor plans of one kind, so it
    // narrows the roles to `vendor` — an agency plan has no kind to match. `role=agency` with a
    // `vendorKind` is therefore an empty list, honestly, rather than a silently ignored filter.
    const roles: BillingOwnerType[] = vendorKind
      ? (role && role !== 'vendor' ? [] : ['vendor'])
      : role ? [role] : [...BILLING_OWNER_TYPES];
    const groups = await Promise.all(
      roles.map((r) =>
        r === 'vendor' && vendorKind
          ? pricingPlanService.listForVendorKind(vendorKind, !includeInactive)
          : pricingPlanService.listForRole(r, !includeInactive)
      )
    );
    cacheable(res).json({ success: true, data: groups.flat().map(toPublicPlanDto) });
  });

  /**
   * GET /api/public/credit-packs
   *
   * The buyable top-up packs AND what a metered action costs. Both are published
   * on the pricing page and both live in `credit.config.ts`, so both are served
   * here — a pack price the page gets right next to an action cost it guessed is
   * the same failure with extra steps. The costs are env-overridable, which is
   * exactly why they must be read rather than copied.
   */
  static listCreditPacks = asyncHandler(async (_req: Request, res: Response) => {
    cacheable(res).json({
      success: true,
      data: {
        packs: CREDIT_TOPUP_PACKS,
        actionCosts: {
          vectorisation: VECTORISATION_COST,
          whatsappTemplate: WHATSAPP_TEMPLATE_COST,
          aiCopyField: AI_COPY_FIELD_COST,
          // SERVICE-LISTINGS-PLAN L-7 / § C-5: what a PROVIDER pays when a customer unlocks a
          // listing's first contact field in a 30-day window, and each further one. Dashboards
          // and the bot read these here and never hard-code them.
          listingRevealFirst: LISTING_REVEAL_FIRST_COST,
          listingRevealNext: LISTING_REVEAL_NEXT_COST,
        },
      },
    });
  });
}
