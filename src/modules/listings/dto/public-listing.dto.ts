import type { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import type { CategoryRef } from '../../categories/services/category-catalog.cache';
import { LISTING_CONTACT_FIELDS, ListingContactField, ListingOpeningHours } from '../domain/listing.types';

/**
 * The PUBLIC listing DTOs (SERVICE-LISTINGS-PLAN § C-3) — the storefront card and detail, and
 * what the bot hydrates search results into.
 *
 * ⛔ **These are explicit projections, field by field, and must stay so.** A spread publishes
 * whatever the model gains next, silently. No contact value, no `vendorId` and no pin may ever
 * appear here (L-26) — and none can, because every value below is copied from `published`
 * (which holds no contact) or from `available_fields` (which holds NAMES). `test:service-listings-catalog`
 * builds these from documents poisoned with contact values in every slot and searches the JSON.
 */

/** What a public card is built from — a lean `listings` row (the vendor join already dropped). */
export interface PublicListingSource {
  _id: { toString(): string };
  slug: string;
  available_fields?: ReadonlyArray<string> | null;
  published_at?: Date | null;
  published: {
    title: string;
    company_name: string;
    country: string;
    city: string;
    area: string;
    description: string;
    description_rich: unknown | null;
    opening_hours: ListingOpeningHours[] | null;
  } | null;
}

export interface PublicListingCard {
  id: string;
  slug: string;
  kind: 'listing';
  title: string;
  companyName: string;
  categories: Array<{ id: string; name: string; slug: string }>;
  country: string;
  city: string;
  area: string;
  photo: FileDetail | null;
  rating: PublicListingRating | null;
  availableFields: ListingContactField[];
  revealCosts: { first: number; next: number };
}

/**
 * The customers' published rating of the listing (since 2026-11-08; `listingRatingOf`), or `null`
 * when nobody has reviewed it. The shape mirrors the product card's rating block.
 */
export interface PublicListingRating {
  average: number;
  count: number;
}

export interface PublicListingOpeningHours {
  day: ListingOpeningHours['day'];
  openTime: string;
  closeTime: string;
  isClosed: boolean;
}

export interface PublicListingDetail extends PublicListingCard {
  description: string;
  descriptionRich: unknown | null;
  photos: FileDetail[];
  openingHours: PublicListingOpeningHours[] | null;
  publishedAt: string | null;
}

export interface PublicListingContext {
  categories: CategoryRef[];
  /** Renderable images only, in the provider's order (the caller filters blocked/non-image). */
  photos: FileDetail[];
  revealCosts: { first: number; next: number };
  rating: PublicListingRating | null;
}

/** Field NAMES only, filtered to the known set and in button order — never a value. */
export function publicAvailableFields(names: ReadonlyArray<string> | null | undefined): ListingContactField[] {
  const have = new Set(names ?? []);
  return LISTING_CONTACT_FIELDS.filter((f) => have.has(f));
}

export function toPublicListingCard(row: PublicListingSource, ctx: PublicListingContext): PublicListingCard {
  const p = row.published;
  return {
    id: row._id.toString(),
    slug: row.slug,
    kind: 'listing',
    title: p?.title ?? '',
    companyName: p?.company_name ?? '',
    categories: ctx.categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
    country: p?.country ?? '',
    city: p?.city ?? '',
    area: p?.area ?? '',
    photo: ctx.photos[0] ?? null,
    rating: ctx.rating,
    availableFields: publicAvailableFields(row.available_fields),
    revealCosts: { first: ctx.revealCosts.first, next: ctx.revealCosts.next },
  };
}

export function toPublicOpeningHours(rows: ListingOpeningHours[] | null | undefined): PublicListingOpeningHours[] | null {
  if (!rows) return null;
  return rows.map((h) => ({ day: h.day, openTime: h.open_time, closeTime: h.close_time, isClosed: h.is_closed === true }));
}

export function toPublicListingDetail(row: PublicListingSource, ctx: PublicListingContext): PublicListingDetail {
  const p = row.published;
  return {
    ...toPublicListingCard(row, ctx),
    description: p?.description ?? '',
    descriptionRich: p?.description_rich ?? null,
    photos: [...ctx.photos],
    openingHours: toPublicOpeningHours(p?.opening_hours),
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
  };
}
