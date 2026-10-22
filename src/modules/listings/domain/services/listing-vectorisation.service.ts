import { Types } from 'mongoose';
import { logger } from '../../../../core/logging';
import { getStorageProvider } from '../../../../core/storage/storage.instance';
import { creditWalletService } from '../../../billing/services/credit-wallet.service';
import { VECTORISATION_COST } from '../../../billing/config/credit.config';
import { categoryCatalogCache } from '../../../categories/services/category-catalog.cache';
import { FileRepositoryMongo } from '../../../catalog/repositories/mongo/file.repository.mongo';
import { resolveFileDetails } from '../../../catalog/read-models/file-detail.resolver';
import { isRenderableImage } from '../../../catalog/read-models/product-image.resolver';
import type { FileDetail } from '../../../catalog/read-models/product-detail.read-model';
import { listingRepository, ListingRepository, ListingRow } from '../../repositories/listing.repository';
import { buildListingVectoriserPayload, ListingVectoriserPayload } from '../listing-vectoriser.payload';
import { HttpListingVectoriserTransport, ListingVectoriserTransport } from './listing-vectoriser.client';

/**
 * Listing indexing (SERVICE-LISTINGS-PLAN L-18, O-18, § n8n) — the listing twin of
 * `catalog/domain/services/VectorisationService`, and deliberately the same machine:
 *
 *   submit   `POST <base>` → **202** `{ job_id, accepted[], rejected[] }`. Accepted → a claim
 *            ticket (`vectorisation_job`) and `pending`; anything else is over NOW → `failed`
 *            and, when this attempt was paid for, refunded.
 *   callback `POST /api/internal/vectoriser/callback` rows with `kind: 'listing'` land in
 *            `applyCallbackResults`, a compare-and-set on the claim ticket — the claim BEFORE the
 *            refund, so a re-delivered report can never pay twice.
 *   remove   `POST <base>/delete` `{ kind: 'listing', listing_id, vectorised_id }` on archive and
 *            suspension, then a local reset so the next resume indexes afresh.
 *
 * ── Who pays ─────────────────────────────────────────────────────────────────
 * The fee is taken at SUBMISSION (O-18), not here. `index(id, { billed })` only records whether
 * this attempt was paid for, so a failure returns exactly what was taken: `billed: true` after an
 * approval whose submission paid; `false` for the re-index after a resume or an unsuspension,
 * which the provider did not ask for.
 *
 * Every public method is safe fire-and-forget: it logs and never rejects.
 */
export interface ListingCallbackRow {
  listing_id: string;
  status: string;
  vectorised_id?: string | null;
  error?: string | null;
}

export interface ListingCallbackResult {
  applied: number;
  completed: number;
  failed: number;
  refunded: number;
  ignored: string[];
  unknown: Array<{ listing_id: string; status: string }>;
}

interface AcceptedResponse {
  job_id?: string | number;
  accepted?: Array<string | number>;
  rejected?: Array<{ listing_id?: string | null; product_id?: string | null; reason?: string }>;
}

const log = () => logger();

export class ListingVectorisationService {
  constructor(
    private readonly repo: ListingRepository = listingRepository,
    private readonly transport: ListingVectoriserTransport = new HttpListingVectoriserTransport(),
    private readonly fileRepo: FileRepositoryMongo = new FileRepositoryMongo(),
    private readonly wallet: Pick<typeof creditWalletService, 'credit'> = creditWalletService,
  ) {}

  /** The payload for one PUBLISHABLE listing, or `null` (not found / not live / no content). */
  async buildPayload(listingId: string): Promise<ListingVectoriserPayload | null> {
    const [row] = await this.repo.findIndexable([listingId]);
    if (!row) return null;
    return this.payloadFor(row);
  }

  /** The `/payloads` pull (`kind: 'listing'`): publishable listings only, the rest `missing`. */
  async buildPayloadsFor(ids: string[]): Promise<{ listings: ListingVectoriserPayload[]; missing: string[] }> {
    const unique = [...new Set(ids)];
    const rows = await this.repo.findIndexable(unique);
    const byId = new Map(rows.map((r) => [r._id.toString(), r]));
    const listings: ListingVectoriserPayload[] = [];
    const missing: string[] = [];
    for (const id of unique) {
      const row = byId.get(id);
      const payload = row ? await this.payloadFor(row) : null;
      if (payload) listings.push(payload);
      else missing.push(id);
    }
    return { listings, missing };
  }

  private async payloadFor(row: ListingRow): Promise<ListingVectoriserPayload | null> {
    if (!row.published) return null;
    const categoryNames = (await categoryCatalogCache.refsFor(row.published.category_ids)).map((c) => c.name);
    const ids = (row.published.photo_file_ids ?? []).map((id) => id.toString());
    const details = await resolveFileDetails(ids, this.fileRepo, getStorageProvider());
    const images = ids.map((id) => details.get(id)).filter((f): f is FileDetail => isRenderableImage(f));
    return buildListingVectoriserPayload(row, { categoryNames, images });
  }

  /**
   * Send one live listing to the index. Never rejects.
   * @param billed whether THIS attempt was paid for at submission — refunded on failure if so.
   */
  async index(listingId: string, opts: { billed: boolean }): Promise<void> {
    const ctx = { listingId, billed: opts.billed };
    try {
      const listing = await this.repo.findById(listingId);
      if (!listing) return;
      const vendorId = listing.vendor_id.toString();
      const payload = await this.buildPayload(listingId);
      if (!payload) {
        // Not publishable any more (suspended or archived between the commit and here). Nothing
        // to index; return a paid fee, since no indexing will happen for it.
        await this.failAndRefund(listingId, vendorId, opts.billed, 'not publishable at index time');
        return;
      }
      await this.repo.setFields(listingId, { vectorisation_status: 'pending', vectorisation_job: null });

      const verdict = await this.transport.post<AcceptedResponse>('', payload, { retry: true });
      if (!verdict.ok) {
        await this.failAndRefund(listingId, vendorId, opts.billed, `request failed: ${verdict.error}`);
        return;
      }
      const jobId = String(verdict.body?.job_id ?? '');
      const accepted = new Set((verdict.body?.accepted ?? []).map(String));
      if (!accepted.has(listingId) || !jobId) {
        const reason = verdict.body?.rejected?.[0]?.reason ?? (jobId ? 'not accepted' : 'no job_id');
        await this.failAndRefund(listingId, vendorId, opts.billed, `rejected by the vectoriser: ${reason}`);
        return;
      }
      await this.repo.setFields(listingId, {
        vectorisation_status: 'pending',
        vectorisation_job: { jobId, billed: opts.billed, requestedAt: new Date() },
      });
      log().info({ ...ctx, jobId }, 'listing vectorisation: accepted — awaiting callback');
    } catch (err) {
      log().error({ ...ctx, err }, 'listing vectorisation: unexpected failure');
    }
  }

  /** The single exit for a failure seen BEFORE the 202 (never for an accepted attempt). */
  private async failAndRefund(listingId: string, vendorId: string, billed: boolean, reason: string): Promise<void> {
    if (billed && VECTORISATION_COST > 0) {
      await this.wallet
        .credit('vendor', vendorId, VECTORISATION_COST, 'refund', 'vectorisation', listingId)
        .catch((err) => log().error({ listingId, vendorId, err }, 'listing vectorisation: REFUND FAILED — credit owed to provider'));
    }
    await this.repo
      .setFields(listingId, { vectorisation_status: 'failed', vectorisation_job: null })
      .catch((err) => log().error({ listingId, err }, 'listing vectorisation: could not record failure'));
    log().warn({ listingId, reason, refunded: billed && VECTORISATION_COST > 0 }, 'listing vectorisation: failed');
  }

  /**
   * Take a listing out of the index (archive, any suspension) and reset the local columns, so a
   * later resume indexes it afresh. Mirrors `VectorisationService.removeFromIndex` for the
   * upstream call; best-effort, never rejects.
   */
  async deindex(listingId: string, vectorisedId: string | null): Promise<void> {
    try {
      if (vectorisedId) {
        const verdict = await this.transport.post('/delete', { kind: 'listing', listing_id: listingId, vectorised_id: vectorisedId });
        if (!verdict.ok) log().warn({ listingId, error: verdict.error }, 'listing deindex: upstream delete failed (non-critical)');
      }
      // The claim ticket goes too: a callback for an attempt in flight must not write
      // `completed` back onto a listing that is no longer live.
      await this.repo.setFields(listingId, { vectorised_data_id: null, vectorisation_status: 'not_started', vectorisation_job: null });
    } catch (err) {
      log().error({ listingId, err }, 'listing deindex: unexpected failure');
    }
  }

  /**
   * Apply the `kind: 'listing'` rows of a vectoriser report. The product half of the same report
   * goes to `VectorisationService.applyCallbackReport`, untouched.
   */
  async applyCallbackResults(jobId: string, rows: ListingCallbackRow[]): Promise<ListingCallbackResult> {
    const out: ListingCallbackResult = { applied: 0, completed: 0, failed: 0, refunded: 0, ignored: [], unknown: [] };
    for (const row of rows) {
      const listingId = String(row.listing_id ?? '');
      const status = String(row.status ?? '');
      if (!listingId || !Types.ObjectId.isValid(listingId) || (status !== 'completed' && status !== 'failed')) {
        out.unknown.push({ listing_id: listingId, status });
        continue;
      }
      const $set =
        status === 'completed'
          ? { vectorised_data_id: row.vectorised_id ? String(row.vectorised_id) : listingId, vectorisation_status: 'completed', vectorisation_job: null }
          : { vectorisation_status: 'failed', vectorisation_job: null };

      let before: ListingRow | null;
      try {
        // The claim: matches only the attempt this report is about. new: false → the row as it
        // was, so `billed` and the current status are read off the claimed ticket.
        before = await this.repo.claimVectorisationJob(listingId, jobId, $set);
      } catch (err) {
        out.unknown.push({ listing_id: listingId, status });
        log().error({ jobId, listingId, err }, 'listing callback: claim write failed');
        continue;
      }
      if (!before) {
        out.ignored.push(listingId);
        continue;
      }
      out.applied++;
      if (status === 'completed') {
        out.completed++;
        // Suspended or archived while the job was in flight: the index now holds a listing that
        // is not live. Take it straight back out.
        if (before.status !== 'live') void this.deindex(listingId, row.vectorised_id ? String(row.vectorised_id) : listingId);
        continue;
      }
      out.failed++;
      if (before.vectorisation_job?.billed === true && VECTORISATION_COST > 0) {
        try {
          await this.wallet.credit('vendor', before.vendor_id.toString(), VECTORISATION_COST, 'refund', 'vectorisation', listingId);
          out.refunded++;
        } catch (err) {
          log().error({ jobId, listingId, err }, 'listing callback: REFUND FAILED — credit owed to provider');
        }
      }
    }
    log().info({ jobId, ...out, ignored: out.ignored.length, unknown: out.unknown.length }, 'listing callback: applied');
    return out;
  }
}

export const listingVectorisationService = new ListingVectorisationService();
