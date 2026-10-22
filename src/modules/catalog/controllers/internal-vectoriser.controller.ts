import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { vectorisationService } from '../domain/services/VectorisationService';
import {
  VectoriserPayloadsSchema,
  VectoriserCallbackSchema,
  VectoriserListingPayloadsSchema,
  VectoriserListingResultsSchema,
  isListingPayloadsRequest,
  splitCallbackByKind,
} from '../validators/internal-vectoriser.validator';
import { listingVectorisationService } from '../../listings/domain/services/listing-vectorisation.service';

/**
 * InternalVectoriserController — the surface the n8n `wi-mall-vectoriser`
 * workflow consumes.
 *
 * Authenticated by the shared service token, not a user session: the caller is
 * an automation, and the two things it does here are read a payload and report
 * an outcome. Contract: `api-doc/n8n/vectoriser/README.md` § 2–4.
 *
 * ── The direction of each route, since the names do not say it ───────────────
 *
 *   /payloads   n8n ASKS jovi-mall for product data   (a read; writes nothing)
 *   /callback   n8n TELLS jovi-mall what it indexed   (the only write here)
 *
 * ⚠ **Neither route may take a product's fate from the caller's word alone.**
 * `/callback` writes `completed` for whatever the vectoriser says completed —
 * which is exactly why the workflow proves each row with `RETURNING product_id`
 * on its side before reporting it. The one time it did not, a job reported eight
 * successes for three indexed products (README § 10). This controller is the
 * consumer of that guarantee, not a second check on it.
 */
export class InternalVectoriserController {
  /**
   * POST /api/internal/vectoriser/payloads
   * Body: { product_ids: string[] }
   *
   * The spreadsheet path only. A row carrying both a title and a price is used
   * as-is by the workflow; anything less is a reference, and this is where the
   * reference is resolved.
   *
   * `missing` is part of the answer, not an error: a sheet naming a product that
   * has since been deleted should index the rest and say which one it skipped.
   */
  static getPayloads = asyncHandler(async (req: Request, res: Response) => {
    // `kind: 'listing'` (service listings, L-18) is answered by the listings module. Every
    // other body — every body the workflow sends today — takes the product path below,
    // unchanged.
    if (isListingPayloadsRequest(req.body)) {
      const { listing_ids } = VectoriserListingPayloadsSchema.parse(req.body);
      const { listings, missing } = await listingVectorisationService.buildPayloadsFor(listing_ids);
      res.json({ success: true, data: { listings, missing } });
      return;
    }

    const { product_ids } = VectoriserPayloadsSchema.parse(req.body);

    // Duplicates in a spreadsheet column are ordinary. Building the same payload
    // twice costs a dozen redundant queries and would put the product in the
    // batch twice, so they are collapsed here rather than downstream.
    const unique = [...new Set(product_ids)];

    const { products, missing } = await vectorisationService.buildPayloadsFor(unique);

    res.json({ success: true, data: { products, missing } });
  });

  /**
   * POST /api/internal/vectoriser/callback
   * Body: README § 3.
   *
   * Where a vectorisation actually finishes: `completed` sets the id and status,
   * `failed` sets the status and returns the credit.
   *
   * ⚠ **Always 200 on a well-formed body, even when every result was ignored.**
   * The report is the vectoriser's only delivery — it does not retry — so a
   * non-2xx buys nothing and loses the rows that WERE applicable. The per-result
   * verdict is in the response body and in the log, which is where a caller that
   * cannot act on failure should be told things.
   */
  static receiveCallback = asyncHandler(async (req: Request, res: Response) => {
    // Rows carrying `kind: 'listing'` are split off first. A report with none — every report
    // the workflow sends today — reaches the product path as the SAME object, untouched.
    const { productBody, listingRows } = splitCallbackByKind(req.body);
    const report = VectoriserCallbackSchema.parse(productBody);

    const result = await vectorisationService.applyCallbackReport(report);

    if (listingRows.length === 0) {
      res.json({ success: true, data: result });
      return;
    }

    const listings = await listingVectorisationService.applyCallbackResults(
      report.job_id,
      VectoriserListingResultsSchema.parse(listingRows),
    );
    res.json({ success: true, data: { ...result, listings } });
  });
}
