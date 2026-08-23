import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { AgencyStockLevelRepository, StockLevelRow } from '../repositories/agency-stock-level.repository';
import {
  AgencyStorageInvoiceRepository,
  agencyStorageInvoiceRepository,
} from '../repositories/agency-storage-invoice.repository';
import { IAgencyStorageInvoice, IStorageInvoiceLine } from '../models/agency-storage-invoice.model';
import { StoragePeriod, previousPeriod, parsePeriodKey } from '../domain/services/storage-period';

export interface InvoiceRunResult {
  periodKey: string;
  agenciesVisited: number;
  invoicesCreated: number;
  invoicesAlreadyIssued: number;
  agenciesSkippedNoPolicy: number;
}

/**
 * Storage rent, written down once a month (D-7).
 *
 * ## What this does NOT do, and it is the first thing to know
 *
 * **It moves no money.** There is no earnings entry, no wallet debit, no payout and no
 * charge. The vendor pays the agency out of band exactly as they did before; what changed
 * is that both sides now read one durable, dated number instead of an agency reading a
 * live-computed figure off its own screen and telling the vendor what it says.
 *
 * ## The three rules the generator follows
 *
 * **1 · Only counted stock is billed.** A `derived` row is one no agency has taken intake
 * on, so the platform does not know what is on that shelf and will not invent a charge for
 * it (D-6). An agency that never records receipts is invoiced for nothing, and that is the
 * visible operational cost of D-6 rather than a bug.
 *
 * **2 · Only an agency that offers warehousing is invoiced.** `policies.pricing.storage_based`
 * disabled means no rate was ever agreed; issuing a zero-total statement would imply one
 * exists. Those agencies are skipped and counted separately in the run result.
 *
 * **3 · Every number is frozen at issue** — the rate, the quantities, the SKU labels, the
 * depot names. An agency raising its rate must not restate a month a vendor has already
 * paid, and a vendor renaming a SKU must not rewrite last month's statement.
 */
export class AgencyStorageInvoiceService {
  constructor(
    private readonly stockLevels: AgencyStockLevelRepository = new AgencyStockLevelRepository(),
    private readonly invoices: AgencyStorageInvoiceRepository = agencyStorageInvoiceRepository,
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly magazins: MagazinRepository = new MagazinRepository(),
  ) { }

  /**
   * Issue every agency's statements for a period.
   *
   * `now` is a parameter rather than an ambient clock so a run can be replayed for a past
   * month and so the boundary cases are testable. Idempotent at the repository — a second
   * run over the same month issues nothing.
   */
  async runForPeriod(now: Date, periodKey?: string): Promise<InvoiceRunResult> {
    const period = periodKey ? parsePeriodKey(periodKey) : previousPeriod(now);
    if (!period) {
      throw createAppError(
        ERROR_CODES.VALIDATION_ERROR,
        400,
        'Period must be YYYY-MM.',
        { periodKey },
      );
    }

    const agencyIds = await this.agencies.listAllIds();
    let created = 0;
    let existing = 0;
    let skipped = 0;

    for (const agencyId of agencyIds) {
      const outcome = await this.runForAgency(agencyId, period);
      if (outcome === null) {
        skipped++;
        continue;
      }
      created += outcome.created;
      existing += outcome.existing;
    }

    return {
      periodKey: period.key,
      agenciesVisited: agencyIds.length,
      invoicesCreated: created,
      invoicesAlreadyIssued: existing,
      agenciesSkippedNoPolicy: skipped,
    };
  }

  /**
   * One agency's statements for a period — one per vendor whose stock it holds.
   *
   * Returns `null` when the agency does not offer warehousing at all (rule 2), which the
   * caller reports separately from "offered it and held nothing".
   */
  async runForAgency(
    agencyId: string,
    period: StoragePeriod,
  ): Promise<{ created: number; existing: number } | null> {
    const agency = await this.agencies.findById(agencyId);
    const pricing = agency?.policies?.pricing?.storage_based ?? null;
    if (!pricing?.enabled) return null;

    const rate = pricing.monthly_storage_fee_per_sku ?? 0;

    const rows = await this.stockLevels.findCountedRowsForAgency(agencyId);
    if (rows.length === 0) return { created: 0, existing: 0 };

    const depotLabels = await this.depotLabels(agencyId);

    const byVendor = new Map<string, StockLevelRow[]>();
    for (const row of rows) {
      const list = byVendor.get(row.vendorId) ?? [];
      list.push(row);
      byVendor.set(row.vendorId, list);
    }

    let created = 0;
    let existing = 0;

    for (const [vendorId, vendorRows] of byVendor) {
      const lines = vendorRows.map<IStorageInvoiceLine>(row => ({
        stock_level_id: new Types.ObjectId(row.id),
        product_id: new Types.ObjectId(row.productId),
        variant_id: new Types.ObjectId(row.variantId),
        sku: row.sku,
        product_title: row.productTitle,
        location_id: row.locationId ? new Types.ObjectId(row.locationId) : null,
        location_label: row.locationId ? depotLabels.get(row.locationId) ?? null : null,
        quantity: row.quantityOnHand,
        monthly_rate_per_sku: rate,
        line_total: rate * row.quantityOnHand,
      }));

      const result = await this.invoices.issueOnce({
        agencyId,
        vendorId,
        periodKey: period.key,
        periodStart: period.start,
        periodEnd: period.end,
        monthlyRatePerSku: rate,
        lines,
      });

      if (result.created) created++; else existing++;
    }

    return { created, existing };
  }

  /** The agency states that this statement was paid. Compare-and-set from `open`. */
  async settle(
    agencyId: string,
    invoiceId: string,
    actorUserId: string | null,
    note: string | null,
  ): Promise<IAgencyStorageInvoice> {
    const moved = await this.invoices.transitionFromOpen(invoiceId, agencyId, 'settled', actorUserId, note);
    if (moved) return moved;
    await this.assertExists(invoiceId, { agencyId });
    throw createAppError(ERROR_CODES.STORAGE_INVOICE_NOT_OPEN, 409, undefined, { invoiceId });
  }

  /** The statement was issued in error. Kept, never deleted — a gap would mean something. */
  async void(
    agencyId: string,
    invoiceId: string,
    note: string | null,
  ): Promise<IAgencyStorageInvoice> {
    const moved = await this.invoices.transitionFromOpen(invoiceId, agencyId, 'void', null, note);
    if (moved) return moved;
    await this.assertExists(invoiceId, { agencyId });
    throw createAppError(ERROR_CODES.STORAGE_INVOICE_NOT_OPEN, 409, undefined, { invoiceId });
  }

  /**
   * 404 vs 409, told apart the way every other verdict write here tells them apart: the
   * compare-and-set already failed, so the only question left is whether the row exists at
   * all for this caller.
   */
  private async assertExists(invoiceId: string, scope: { agencyId?: string; vendorId?: string }): Promise<void> {
    const found = await this.invoices.findScoped(invoiceId, scope);
    if (!found) {
      throw createAppError(ERROR_CODES.STORAGE_INVOICE_NOT_FOUND, 404, undefined, { invoiceId });
    }
  }

  private async depotLabels(agencyId: string): Promise<Map<string, string | null>> {
    const depots = (await this.magazins.findHqAddressListsByAgencyIds([agencyId])).get(agencyId) ?? [];
    return new Map(depots.map(d => [d._id.toString(), d.label ?? d.address_description ?? null]));
  }
}

export const agencyStorageInvoiceService = new AgencyStorageInvoiceService();
