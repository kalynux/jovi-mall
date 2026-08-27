import {
    GeoCandidate,
    GeoSearchOptions,
    IGeocodingProvider,
} from './geocoding-provider.interface';
import { GeoProviderName, IGeoAddressComponents } from '../types/geo-address.types';

/**
 * Provider text, made safe to show a human.
 *
 * ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────────
 * Geocoding providers return **HTML-escaped** strings, because their data comes out of
 * OpenStreetMap where an apostrophe is frequently stored as an entity. A real LocationIQ
 * result for `"Akwa, Douala"`, captured 2026-08-26:
 *
 *     "École Bilingue la Pouponnière d&apos;AKWA, Rue 1.491, Camp Yabassi, Douala, …"
 *
 * jovi-mall passed that through untouched, so `d&apos;AKWA` reached a chat window, a
 * delivery label and `order.delivery_address.formatted_address` **as literal text**. It is
 * not a rendering problem a frontend can fix: the entity is in the stored value, and the
 * customer confirming an address is confirming a string that is wrong on its face.
 *
 * Found while writing the Telegram onboarding walkthrough, which quoted real responses.
 * That is the argument for writing docs from live output rather than from imagination.
 *
 * ── WHY A DECORATOR, AND NOT THREE CALLS IN THREE ADAPTERS ──────────────────
 * Every adapter is affected — this is provider data, not one provider's quirk — and a
 * fourth adapter written next year would be affected too, by an author who has no reason to
 * know this file exists. `createGeocodingProvider` is documented as *"the ONLY place where
 * geocoding provider selection happens"*, so wrapping its return makes the sanitisation
 * structural rather than remembered. Same argument `resolveVirusScanner` makes about being
 * the only door, and the same shape as the cache and chain decorators already here.
 *
 * ⚠ It wraps INSIDE the factory, so `CachedGeocodingProvider` sees clean candidates and the
 * cache therefore stores clean values. Wrapping outside the cache would leave entity-bearing
 * strings in Redis for their full 24-hour TTL and decode them on every read instead of once.
 *
 * ── WHAT IT DELIBERATELY DOES NOT TOUCH ─────────────────────────────────────
 * `provider_place_id` and `coordinates`. A place id is an opaque provider handle that must
 * round-trip byte-identically — it is what makes a stored address re-resolvable — and an
 * `&` inside one is data, not markup. Decoding it could silently corrupt a reference nobody
 * would notice was broken until a lookup failed months later.
 */

/**
 * The entities a geocoder actually emits, plus the five XML predefined ones.
 *
 * Deliberately a SHORT closed table rather than a full HTML entity set (there are 2 231 of
 * them). Address data is not documents: what appears is apostrophes, ampersands, quotes and
 * the occasional non-breaking space. A large table would be a large surface for a bug in a
 * function that runs on every address the platform resolves.
 */
const NAMED: Readonly<Record<string, string>> = Object.freeze({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    /**
     * ⚠ **Decoded to an ORDINARY space (U+0020), not to U+00A0**, and that is a deliberate
     * infidelity. These strings become `address_line1`, `city` and `region`, which are
     * trimmed, compared and matched all over this codebase — `toPersistableHeadquarters`
     * content-matches addresses to preserve subdocument ids, for one. A non-breaking space
     * is invisible, survives `.trim()`, and makes two addresses that look identical compare
     * unequal. Faithfulness would buy nothing a reader could see and cost a class of bug
     * nobody would find.
     */
    nbsp: ' ',
});

/**
 * One pass, and the single pass IS the protection against double-decoding.
 *
 * `&amp;apos;` must become `&apos;` — the literal text somebody wrote — and never `'`. A
 * loop, or decoding `&amp;` in a separate pass from the rest, produces exactly that second
 * result: the classic double-unescape bug. `String.replace` does not rescan its own
 * replacements, so each entity is consumed exactly once and the output is final.
 */
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g;

/**
 * The C0 and C1 control ranges, which a numeric entity must never be allowed to introduce.
 *
 * `&#0;` and friends have no business in an address and would be a NUL or a control
 * character embedded in a value that reaches a log line, a PDF label and a Mongo document.
 * An out-of-range or control code point is left AS THE LITERAL ENTITY rather than dropped,
 * so the oddity stays visible to whoever reads it instead of silently vanishing.
 */
function isSafeCodePoint(code: number): boolean {
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return false;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
    if (code >= 0x7f && code <= 0x9f) return false;
    // Lone surrogates are not scalar values; `fromCodePoint` accepts them and produces a
    // string that is not well-formed UTF-8 the moment it is serialised.
    if (code >= 0xd800 && code <= 0xdfff) return false;
    return true;
}

/**
 * Decode the HTML entities a geocoding provider put in a human-readable string.
 *
 * Pure, total, and idempotent on already-clean input. Exported for `test:geocoding-sanitize`,
 * which drives it against the real provider strings that prompted it.
 */
export function decodeProviderEntities(value: string): string {
    // Cheap bail-out: the overwhelming majority of addresses contain no `&` at all, and this
    // runs on every candidate of every search.
    if (!value.includes('&')) return value;

    return value.replace(ENTITY, (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
        if (dec !== undefined) {
            const code = Number.parseInt(dec, 10);
            return isSafeCodePoint(code) ? String.fromCodePoint(code) : match;
        }
        if (hex !== undefined) {
            const code = Number.parseInt(hex, 16);
            return isSafeCodePoint(code) ? String.fromCodePoint(code) : match;
        }
        // An unknown name is left alone. `&section;` is not an entity we know, and a
        // street genuinely called "Rue A&B;" must not lose characters to a guess.
        return (name !== undefined && NAMED[name.toLowerCase()]) || match;
    });
}

/**
 * Sanitise every human-readable string on a candidate.
 *
 * ⚠ **Components are mapped GENERICALLY, over `Object.entries`, rather than field by
 * field.** `IGeoAddressComponents` has seven fields today and will grow — a hand-listed
 * mapper would leave the eighth un-decoded, silently, and the symptom would be one entity
 * appearing in one city name months later. Every string value is decoded; every non-string
 * is passed through untouched.
 */
export function sanitizeGeoCandidate(candidate: GeoCandidate): GeoCandidate {
    // Copy first, then overwrite only the string values in place. Rebuilding the object from
    // `Object.fromEntries` would widen it to a plain index signature and need a cast through
    // `unknown` — which is exactly the cast that stops the compiler noticing the day a
    // component field changes shape.
    const components = { ...(candidate.components ?? {}) } as IGeoAddressComponents;
    const writable = components as unknown as Record<string, unknown>;
    for (const key of Object.keys(writable)) {
        const value = writable[key];
        if (typeof value === 'string') writable[key] = decodeProviderEntities(value);
    }

    return {
        ...candidate,
        formatted_address: decodeProviderEntities(candidate.formatted_address ?? ''),
        components,
        // `provider_place_id` and `coordinates` are carried by the spread, undecoded, on
        // purpose. See the header.
    };
}

/**
 * The decorator the factory returns.
 *
 * Forwards `name` so `getGeocodingProviderType()` and every `GeoCandidate` still report the
 * real provider — the same property the cache decorator preserves, and what keeps "no
 * business logic branches on the provider" true.
 */
export class SanitizedGeocodingProvider implements IGeocodingProvider {
    constructor(private readonly inner: IGeocodingProvider) {}

    get name(): GeoProviderName {
        return this.inner.name;
    }

    async search(query: string, opts?: GeoSearchOptions): Promise<GeoCandidate[]> {
        const results = await this.inner.search(query, opts);
        return results.map(sanitizeGeoCandidate);
    }

    async reverse(lat: number, lng: number): Promise<GeoCandidate | null> {
        const result = await this.inner.reverse(lat, lng);
        return result ? sanitizeGeoCandidate(result) : null;
    }
}
