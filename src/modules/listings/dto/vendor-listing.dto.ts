import type { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import type { CategoryRef } from '../../categories/services/category-catalog.cache';
import type { IListingContentDoc } from '../models/listing.model';
import type { ListingContactSetDoc } from '../repositories/listing-contact.repository';
import type { ListingRow } from '../repositories/listing.repository';
import { ListingContactField, ListingReviewState, ListingStatus, ListingSuspensionReason } from '../domain/listing.types';
import { publicAvailableFields, toPublicOpeningHours, PublicListingOpeningHours } from './public-listing.dto';

/**
 * The PROVIDER's own listing DTOs (§ C-3: `VendorListingSummary`, `VendorListingDetail`).
 *
 * The detail is the one listing read that carries contacts — the provider's OWN, through
 * `ListingContactRepository.getForOwner`. Explicit projections, like the public DTOs.
 *
 * Deliberately NOT shown to the provider: the reviewer's identity (`decided_by_*`), the text
 * pre-flags (help for the reviewer, never a decision — showing them would teach a provider
 * exactly which spellings slip past), and the index-fee ledger reference.
 */

export interface VendorListingContentDto {
  title: string;
  companyName: string;
  categories: Array<{ id: string; name: string; slug: string }>;
  country: string;
  city: string;
  area: string;
  description: string;
  descriptionRich: unknown | null;
  photoFileIds: string[];
  photos: FileDetail[];
  openingHours: PublicListingOpeningHours[] | null;
}

export interface VendorListingContactsDto {
  whatsapp: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  socials: Array<{ network: string; url: string }>;
  location: {
    formatted_address: string;
    coordinates: { type: 'Point'; coordinates: [number, number] };
    provider: string;
    provider_place_id: string | null;
    components: Record<string, string | null>;
    raw_input: string | null;
  } | null;
  video: { url: string; host: string; checkedAt: string | null } | null;
}

export interface VendorListingReviewDto {
  state: ListingReviewState;
  submittedAt: string | null;
  decidedAt: string | null;
  reasons: string[];
}

export interface VendorListingSuspensionDto {
  reason: ListingSuspensionReason;
  previousStatus: ListingStatus;
  at: string | null;
  note: string | null;
}

export interface VendorListingSummary {
  id: string;
  slug: string;
  status: ListingStatus;
  title: string;
  companyName: string;
  hasRevision: boolean;
  review: VendorListingReviewDto | null;
  suspension: VendorListingSuspensionDto | null;
  availableFields: ListingContactField[];
  vectorisationStatus: string;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface VendorListingDetail extends VendorListingSummary {
  published: VendorListingContentDto | null;
  pending: VendorListingContentDto | null;
  contacts: { published: VendorListingContactsDto | null; pending: VendorListingContactsDto | null };
  lastDecision: { decision: string; at: string | null; reasons: string[] } | null;
  archivedAt: string | null;
}

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

function reviewDto(row: ListingRow): VendorListingReviewDto | null {
  const r = row.review;
  if (!r) return null;
  return { state: r.state, submittedAt: iso(r.submitted_at), decidedAt: iso(r.decided_at), reasons: [...(r.reasons ?? [])] };
}

function suspensionDto(row: ListingRow): VendorListingSuspensionDto | null {
  const s = row.suspension;
  if (!s) return null;
  return { reason: s.reason, previousStatus: s.previous_status, at: iso(s.at), note: s.note ?? null };
}

export function toVendorListingSummary(row: ListingRow): VendorListingSummary {
  const shown = row.pending ?? row.published;
  return {
    id: row._id.toString(),
    slug: row.slug,
    status: row.status,
    title: row.published?.title || shown?.title || '',
    companyName: row.published?.company_name || shown?.company_name || '',
    hasRevision: !!row.published && !!row.pending,
    review: reviewDto(row),
    suspension: suspensionDto(row),
    availableFields: publicAvailableFields(row.available_fields),
    vectorisationStatus: row.vectorisation_status ?? 'not_started',
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toVendorContentDto(
  content: IListingContentDoc | null,
  categories: CategoryRef[],
  photos: Map<string, FileDetail>,
): VendorListingContentDto | null {
  if (!content) return null;
  const photoFileIds = (content.photo_file_ids ?? []).map((id) => id.toString());
  return {
    title: content.title ?? '',
    companyName: content.company_name ?? '',
    categories: categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
    country: content.country ?? '',
    city: content.city ?? '',
    area: content.area ?? '',
    description: content.description ?? '',
    descriptionRich: content.description_rich ?? null,
    photoFileIds,
    photos: photoFileIds.map((id) => photos.get(id)).filter((f): f is FileDetail => !!f),
    openingHours: toPublicOpeningHours(content.opening_hours),
  };
}

export function toVendorContactsDto(set: ListingContactSetDoc | null): VendorListingContactsDto | null {
  if (!set) return null;
  const loc = set.location;
  return {
    whatsapp: set.whatsapp ?? null,
    phone: set.phone ?? null,
    email: set.email ?? null,
    website: set.website ?? null,
    socials: (set.socials ?? []).map((s) => ({ network: s.network, url: s.url })),
    location: loc
      ? {
          formatted_address: loc.formatted_address,
          coordinates: { type: 'Point', coordinates: [loc.coordinates.coordinates[0], loc.coordinates.coordinates[1]] },
          provider: loc.provider,
          provider_place_id: loc.provider_place_id ?? null,
          components: { ...(loc.components as unknown as Record<string, string | null>) },
          raw_input: loc.raw_input ?? null,
        }
      : null,
    video: set.video ? { url: set.video.url, host: set.video.host, checkedAt: iso(set.video.checked_at) } : null,
  };
}

export function toVendorListingDetail(
  row: ListingRow,
  parts: {
    published: VendorListingContentDto | null;
    pending: VendorListingContentDto | null;
    contacts: { published: ListingContactSetDoc | null; pending: ListingContactSetDoc | null } | null;
  },
): VendorListingDetail {
  const d = row.last_decision;
  return {
    ...toVendorListingSummary(row),
    published: parts.published,
    pending: parts.pending,
    contacts: {
      published: toVendorContactsDto(parts.contacts?.published ?? null),
      pending: toVendorContactsDto(parts.contacts?.pending ?? null),
    },
    lastDecision: d ? { decision: d.decision, at: iso(d.at), reasons: [...(d.reasons ?? [])] } : null,
    archivedAt: iso(row.archived_at),
  };
}
