import type { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import type { ListingOpeningHours } from './listing.types';

/**
 * The vectoriser payload for ONE listing (SERVICE-LISTINGS-PLAN L-18, § n8n, L-26).
 *
 * ⛔ **Public fields only — no contact, no vendor email or phone, no pin.** A product's payload
 * carries `vendor.email` for sellers (deliberately, L-26); a listing's carries no vendor block at
 * all. Everything here is copied from `listings.published` — a collection that holds no contact
 * by construction — so the index the bot searches cannot hold one either.
 * `test:service-listings-catalog` builds this from a poisoned row and searches the JSON.
 *
 * `kind: 'listing'` is what the n8n workflow dispatches on; an entry with no `kind` is a
 * product, so the live product flow is untouched. The id travels as `listing_id`, never as
 * `product_id`, so a listing can never be mistaken for (or overwrite) a product row.
 */
export interface ListingVectoriserPayload {
  kind: 'listing';
  listing_id: string;
  slug: string;
  status: 'live';
  title: string;
  company_name: string;
  description: string;
  /** The PRIMARY category's name (`categories[0]`), as the product payload carries it. */
  category: string;
  categories: string[];
  country: string;
  city: string;
  area: string;
  images: Array<{ id: string; url: string | null; mimeType: string; size: number }>;
  opening_hours: Array<{ day: string; open_time: string; close_time: string; is_closed: boolean }> | null;
}

export interface ListingPayloadSource {
  _id: { toString(): string };
  slug: string;
  published: {
    title: string;
    company_name: string;
    description: string;
    country: string;
    city: string;
    area: string;
    opening_hours: ListingOpeningHours[] | null;
  } | null;
}

export function buildListingVectoriserPayload(
  row: ListingPayloadSource,
  ctx: { categoryNames: string[]; images: FileDetail[] },
): ListingVectoriserPayload | null {
  const p = row.published;
  if (!p) return null;
  return {
    kind: 'listing',
    listing_id: row._id.toString(),
    slug: row.slug,
    status: 'live',
    title: p.title,
    company_name: p.company_name,
    description: p.description,
    category: ctx.categoryNames[0] ?? '',
    categories: [...ctx.categoryNames],
    country: p.country,
    city: p.city,
    area: p.area,
    images: ctx.images.map((f) => ({ id: f.id, url: f.url, mimeType: f.mimeType, size: f.size })),
    opening_hours: p.opening_hours
      ? p.opening_hours.map((h) => ({ day: h.day, open_time: h.open_time, close_time: h.close_time, is_closed: h.is_closed === true }))
      : null,
  };
}
