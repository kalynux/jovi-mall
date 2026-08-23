import { Types } from 'mongoose';
import { IAgencyStorageInvoice, StorageInvoiceStatus } from '../models/agency-storage-invoice.model';

export interface StorageInvoiceLineDto {
  stockLevelId: string;
  productId: string;
  variantId: string;
  sku: string | null;
  productTitle: string | null;
  locationId: string | null;
  locationLabel: string | null;
  quantity: number;
  monthlyRatePerSku: number;
  lineTotal: number;
}

export interface StorageInvoiceDto {
  id: string;
  agencyId: string;
  vendorId: string;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  skuCount: number;
  unitCount: number;
  monthlyRatePerSku: number;
  total: number;
  status: StorageInvoiceStatus;
  issuedAt: Date;
  settledAt: Date | null;
  note: string | null;
  /**
   * Present on the detail, absent on the list.
   *
   * A statement can carry a line per SKU, and a list of twelve months with every line
   * expanded is a payload nobody reads. The list carries `skuCount` and `unitCount`, which
   * is what a list row shows.
   */
  lines?: StorageInvoiceLineDto[];
}

/**
 * ⚠ **`settled_by_user_id` is deliberately not on the wire.** It is a `users` id, and neither
 * party to this statement can resolve one — an agency reading its own row would get an opaque
 * string, and a vendor reading it would learn an identifier for somebody at the agency. Who
 * marked it settled is an internal record; *that* it is settled, and when, is what both sides
 * need and both get.
 */
export function toStorageInvoiceDto(
  invoice: IAgencyStorageInvoice,
  options: { withLines: boolean },
): StorageInvoiceDto {
  const dto: StorageInvoiceDto = {
    id: (invoice._id as Types.ObjectId).toString(),
    agencyId: invoice.agency_id.toString(),
    vendorId: invoice.vendor_id.toString(),
    periodKey: invoice.period_key,
    periodStart: invoice.period_start,
    periodEnd: invoice.period_end,
    skuCount: invoice.sku_count,
    unitCount: invoice.unit_count,
    monthlyRatePerSku: invoice.monthly_rate_per_sku,
    total: invoice.total,
    status: invoice.status,
    issuedAt: invoice.issued_at,
    settledAt: invoice.settled_at ?? null,
    note: invoice.note ?? null,
  };

  if (options.withLines) {
    dto.lines = invoice.lines.map(line => ({
      stockLevelId: line.stock_level_id.toString(),
      productId: line.product_id.toString(),
      variantId: line.variant_id.toString(),
      sku: line.sku ?? null,
      productTitle: line.product_title ?? null,
      locationId: line.location_id ? line.location_id.toString() : null,
      locationLabel: line.location_label ?? null,
      quantity: line.quantity,
      monthlyRatePerSku: line.monthly_rate_per_sku,
      lineTotal: line.line_total,
    }));
  }

  return dto;
}
