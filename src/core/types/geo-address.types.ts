import { Schema } from 'mongoose';
import { z } from 'zod';
import { GeoPointSchema, GeoPointZodSchema, IGeoPoint } from './geo.types';

/**
 * ─── GeoAddress: the platform's canonical geospatial address value object ─────
 *
 * A single reusable record embedded wherever an address is stored — vendor
 * business addresses, agency headquarters, customer saved addresses, order
 * pickup snapshots, and the order/shipment drop-off. It pairs a human-readable
 * address with the geospatial data returned by the active geocoding provider,
 * so nothing in the system relies on plain text for mapping.
 *
 * The value object is **provider-agnostic**: `provider` records who resolved it
 * (nominatim / google / mapbox / …) but no business logic branches on it. It is
 * produced by selecting one candidate from `GET /api/geo/search` and stored
 * verbatim, alongside (not instead of) any legacy loose fields the parent model
 * already carried — those are kept populated for backward compatibility.
 *
 * Design notes:
 *  - `coordinates` is a GeoJSON Point `[lng, lat]` (reuses {@link GeoPointSchema})
 *    so a `2dsphere` index on `<field>.coordinates` supports proximity queries.
 *  - `components` is the structured administrative breakdown; every part is
 *    nullable because provider coverage varies (rural Cameroon rarely has a
 *    postal code, some results have no street).
 *  - `raw_input` preserves exactly what the user typed before selecting a result,
 *    which is useful for debugging bad matches and re-search.
 */

/** Providers the abstraction can name. Only `nominatim` has an adapter today. */
export const GEO_PROVIDERS = ['nominatim', 'google', 'mapbox', 'here', 'geoapify'] as const;
export type GeoProviderName = (typeof GEO_PROVIDERS)[number];

// ─── Mongoose Sub-Schemas ────────────────────────────────────────────────────

/**
 * Structured administrative components. All optional — a geocoder may omit any
 * of them depending on coverage and the granularity of the matched place.
 */
const GeoAddressComponentsSchema = new Schema(
    {
        street: { type: String, default: null, trim: true },
        neighbourhood: { type: String, default: null, trim: true },
        city: { type: String, default: null, trim: true },
        region: { type: String, default: null, trim: true },        // state / province / region
        country: { type: String, default: null, trim: true },       // full country name
        country_code: { type: String, default: null, trim: true, uppercase: true }, // ISO-3166-1 alpha-2
        postal_code: { type: String, default: null, trim: true },
    },
    { _id: false }
);

/**
 * The GeoAddress sub-schema. Embed with `{ type: GeoAddressSchema, default: null }`
 * and add `parent.index({ '<field>.coordinates': '2dsphere' }, { sparse: true })`.
 */
export const GeoAddressSchema = new Schema(
    {
        /** Provider's canonical one-line address, e.g. "123 Main St, Yaoundé, Cameroon". */
        formatted_address: { type: String, required: true, trim: true },
        /** GeoJSON Point [longitude, latitude]. Required inside a populated GeoAddress. */
        coordinates: { type: GeoPointSchema, required: true },
        /** Which provider resolved this address. Informational only. */
        provider: { type: String, enum: GEO_PROVIDERS, required: true },
        /** Provider's stable place identifier (e.g. Nominatim osm_type:osm_id, Google place_id). */
        provider_place_id: { type: String, default: null, trim: true },
        /** Structured administrative breakdown (all parts nullable). */
        components: {
            type: GeoAddressComponentsSchema,
            required: true,
            default: () => ({}),
        },
        /** The free-form text the user typed before selecting this result. */
        raw_input: { type: String, default: null, trim: true },
        /** When this address was geocoded/selected. */
        resolved_at: { type: Date, required: true, default: Date.now },
    },
    { _id: false }
);

// ─── TypeScript Interfaces ───────────────────────────────────────────────────

export interface IGeoAddressComponents {
    street: string | null;
    neighbourhood: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    country_code: string | null;
    postal_code: string | null;
}

export interface IGeoAddress {
    formatted_address: string;
    coordinates: IGeoPoint;
    provider: GeoProviderName;
    provider_place_id: string | null;
    components: IGeoAddressComponents;
    raw_input: string | null;
    resolved_at: Date;
}

// ─── Zod Validators ──────────────────────────────────────────────────────────

/**
 * Validates a selected geocoding result the client sends back to store. This is
 * the shape the frontend gets from `GET /api/geo/search` (a `GeoCandidate`) plus
 * the original `raw_input`. `resolved_at` is server-assigned, so it is NOT
 * accepted from the client.
 */
export const GeoAddressComponentsZodSchema = z.object({
    street: z.string().trim().max(200).nullish(),
    neighbourhood: z.string().trim().max(200).nullish(),
    city: z.string().trim().max(120).nullish(),
    region: z.string().trim().max(120).nullish(),
    country: z.string().trim().max(120).nullish(),
    country_code: z.string().trim().length(2).toUpperCase().nullish(),
    postal_code: z.string().trim().max(32).nullish(),
});

export const GeoAddressZodSchema = z.object({
    formatted_address: z.string().min(1).max(500).trim(),
    coordinates: GeoPointZodSchema,
    provider: z.enum(GEO_PROVIDERS),
    provider_place_id: z.string().trim().max(200).nullish(),
    components: GeoAddressComponentsZodSchema.optional().default({}),
    raw_input: z.string().trim().max(500).nullish(),
});

export type GeoAddressInput = z.infer<typeof GeoAddressZodSchema>;

/**
 * Normalises a validated {@link GeoAddressInput} into a persistable {@link IGeoAddress}
 * (fills the server-assigned `resolved_at` and null-fills any absent component).
 * Use this in services before writing a GeoAddress to a model.
 */
/**
 * Normalises the optional `geo` field on an address-bearing input entry (a
 * validated business/HQ/saved address) into a persistable `geo: IGeoAddress | null`,
 * leaving every other field untouched. Use when mapping a full-replace address
 * array to its persistence shape, e.g. `input.addresses.map(withGeoAddress)`.
 */
export function withGeoAddress<T extends { geo?: GeoAddressInput | null }>(
    entry: T,
): Omit<T, 'geo'> & { geo: IGeoAddress | null } {
    const { geo, ...rest } = entry;
    return { ...rest, geo: geo ? toGeoAddress(geo) : null };
}

export function toGeoAddress(input: GeoAddressInput): IGeoAddress {
    const c = input.components ?? {};
    return {
        formatted_address: input.formatted_address,
        coordinates: input.coordinates,
        provider: input.provider,
        provider_place_id: input.provider_place_id ?? null,
        components: {
            street: c.street ?? null,
            neighbourhood: c.neighbourhood ?? null,
            city: c.city ?? null,
            region: c.region ?? null,
            country: c.country ?? null,
            country_code: c.country_code ?? null,
            postal_code: c.postal_code ?? null,
        },
        raw_input: input.raw_input ?? null,
        resolved_at: new Date(),
    };
}
