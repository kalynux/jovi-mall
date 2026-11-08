import { Types } from 'mongoose';
import { toGeoAddress } from '../../../../core/types/geo-address.types';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import type { IListingContentDoc } from '../../models/listing.model';
import type { ListingContactSetDoc } from '../../repositories/listing-contact.repository';
import type { ListingContentInput, ListingContactsInput } from '../../validators/listing.validator';
import { classifyVideoUrl } from '../listing-rules';

/**
 * Wire (camelCase, validated) → stored (snake_case) for a listing's two halves, as a PATCH:
 * an absent key keeps the stored value, `null` clears a clearable one, a value replaces it.
 * Pure apart from the video-host rule, which throws its own 422.
 */

export function emptyContent(): IListingContentDoc {
  return {
    title: '',
    company_name: '',
    category_ids: [],
    country: '',
    city: '',
    area: '',
    description: '',
    description_rich: null,
    photo_file_ids: [],
    opening_hours: null,
  };
}

export function emptyContacts(): ListingContactSetDoc {
  return { whatsapp: null, phone: null, email: null, website: null, socials: [], location: null, video: null };
}

/** A deep-enough copy of stored content — the revision clone (L-5) must not alias `published`. */
export function cloneContent(c: IListingContentDoc | null | undefined): IListingContentDoc {
  if (!c) return emptyContent();
  return {
    title: c.title ?? '',
    company_name: c.company_name ?? '',
    category_ids: [...(c.category_ids ?? [])],
    country: c.country ?? '',
    city: c.city ?? '',
    area: c.area ?? '',
    description: c.description ?? '',
    description_rich: c.description_rich ?? null,
    photo_file_ids: [...(c.photo_file_ids ?? [])],
    opening_hours: c.opening_hours ? c.opening_hours.map((h) => ({ ...h })) : null,
  };
}

export function cloneContacts(c: ListingContactSetDoc | null | undefined): ListingContactSetDoc {
  if (!c) return emptyContacts();
  return {
    whatsapp: c.whatsapp ?? null,
    phone: c.phone ?? null,
    phone2: c.phone2 ?? null,
    email: c.email ?? null,
    website: c.website ?? null,
    socials: (c.socials ?? []).map((s) => ({ network: s.network, url: s.url })),
    location: c.location ?? null,
    video: c.video ? { url: c.video.url, host: c.video.host, checked_at: c.video.checked_at ?? null } : null,
  };
}

export function applyContentPatch(
  base: IListingContentDoc | null | undefined,
  input: ListingContentInput | undefined,
  resolvedCategoryIds: Types.ObjectId[] | undefined,
): IListingContentDoc {
  const next = cloneContent(base);
  if (!input) return next;
  if (input.title !== undefined) next.title = input.title;
  if (input.companyName !== undefined) next.company_name = input.companyName;
  if (resolvedCategoryIds !== undefined) next.category_ids = resolvedCategoryIds;
  if (input.country !== undefined) next.country = input.country;
  if (input.city !== undefined) next.city = input.city;
  if (input.area !== undefined) next.area = input.area;
  if (input.description !== undefined) next.description = input.description;
  if (input.descriptionRich !== undefined) next.description_rich = input.descriptionRich;
  if (input.photoFileIds !== undefined) next.photo_file_ids = input.photoFileIds.map((id) => new Types.ObjectId(id));
  if (input.openingHours !== undefined) {
    next.opening_hours = input.openingHours === null
      ? null
      : input.openingHours.map((h) => ({ day: h.day, open_time: h.openTime, close_time: h.closeTime, is_closed: h.isClosed }));
  }
  return next;
}

/**
 * Apply a contacts PATCH. A video link is classified here: anything but a YouTube or Google
 * Drive link is `422 LISTING_VIDEO_LINK_INVALID`. An unchanged link keeps its `checked_at`; a
 * new one starts unchecked (the oEmbed check runs at submit).
 */
/**
 * Keep the two phone numbers clean whatever a PATCH sent (2026-11-08): a lone second number
 * becomes the first (call-me and every reader of `phone` see a number), and a second number equal
 * to the first, compared by digits, is dropped. Applied after every patch, so a provider who clears
 * the first number keeps the second as their only one.
 */
export function normalisePhones(set: { phone?: string | null; phone2?: string | null }): void {
  const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');
  if (!digits(set.phone) && digits(set.phone2)) {
    set.phone = set.phone2 ?? null;
    set.phone2 = null;
  }
  if (digits(set.phone2) && digits(set.phone2) === digits(set.phone)) set.phone2 = null;
  if (!digits(set.phone2)) set.phone2 = null;
}

export function applyContactsPatch(
  base: ListingContactSetDoc | null | undefined,
  input: ListingContactsInput | undefined,
): ListingContactSetDoc {
  const next = cloneContacts(base);
  if (!input) return next;
  if (input.whatsapp !== undefined) next.whatsapp = input.whatsapp ?? null;
  if (input.phone !== undefined) next.phone = input.phone ?? null;
  if (input.phone2 !== undefined) next.phone2 = input.phone2 ?? null;
  normalisePhones(next);
  if (input.email !== undefined) next.email = input.email ?? null;
  if (input.website !== undefined) next.website = input.website ?? null;
  if (input.socials !== undefined) next.socials = input.socials.map((s) => ({ network: s.network, url: s.url }));
  if (input.location !== undefined) next.location = input.location === null ? null : toGeoAddress(input.location);
  if (input.video !== undefined) {
    if (input.video === null) {
      next.video = null;
    } else {
      const host = classifyVideoUrl(input.video.url);
      if (!host) {
        throw createAppError(
          ERROR_CODES.LISTING_VIDEO_LINK_INVALID,
          422,
          'The location video must be a YouTube link (youtube.com or youtu.be) or a Google Drive file link.',
        );
      }
      const same = base?.video?.url === input.video.url;
      next.video = { url: input.video.url, host, checked_at: same ? base?.video?.checked_at ?? null : null };
    }
  }
  return next;
}

/** Every photo id the listing references across both copies — what `file_references` mirrors. */
export function photoUnion(...contents: Array<IListingContentDoc | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const c of contents) for (const id of c?.photo_file_ids ?? []) ids.add(id.toString());
  return [...ids];
}
