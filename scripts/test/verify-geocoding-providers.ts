/**
 * verify:geocoding-providers — the paid adapters against the REAL APIs.
 * **Needs network and at least one API key. No database.**
 *
 * ── Why this exists, and why it is separate from test:geocoding-chain ────────
 *
 * `test:geocoding-chain` drives fakes, so it proves the failover RULES and
 * nothing about whether either adapter can actually read a response. Those are
 * different risks and only one of them can be tested offline:
 *
 *   - the chain's behaviour under a 429 is untestable live (you would have to
 *     burn a day's quota to produce one), so it is faked;
 *   - the adapters' field mapping is untestable offline (a fixture is just this
 *     file's author's belief about the response, written twice), so it is live.
 *
 * The failure this catches is the expensive one: an adapter that returns
 * `formatted_address: ''` and null components because a provider nests its
 * address one level deeper than assumed. Every downstream check passes — the
 * coordinates are right, the type is right — and the platform silently stores
 * addresses with no city on them.
 *
 * ── It SKIPS rather than fails when a key is absent ──────────────────────────
 *
 * Both keys are optional and a developer machine legitimately has neither. A
 * skipped provider is reported as skipped, loudly, and the run stays green — the
 * alternative is a suite everybody learns to ignore. It fails only when a key IS
 * present and the provider behind it does not behave as the adapter expects,
 * which is the only case where there is something to fix.
 *
 * ⚠ **It spends real quota** — six calls per configured provider at most. That is
 * nothing against 3 000–5 000/day, but do not put it in a loop.
 *
 * Run: npm run verify:geocoding-providers
 */
import dotenv from 'dotenv';
dotenv.config();

import { GeoapifyProvider } from '../../src/core/geocoding/providers/geoapify.provider';
import { LocationIqProvider } from '../../src/core/geocoding/providers/locationiq.provider';
import { MapboxProvider } from '../../src/core/geocoding/providers/mapbox.provider';
import { GeoCandidate, IGeocodingProvider } from '../../src/core/geocoding/geocoding-provider.interface';

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}${detail ? `\n       ${detail}` : ''}`);
        failed++;
    }
}

/** A real place with a real street, in the platform's own market. */
const QUERY = 'Boulevard de la Liberté, Akwa, Douala';
/** Akwa, Douala — the coordinate the reverse lookup must land in. */
const LAT = 4.0511;
const LNG = 9.7085;

async function exercise(label: string, provider: IGeocodingProvider): Promise<void> {
    console.log(`\n── ${label} ${'─'.repeat(Math.max(2, 62 - label.length))}\n`);

    // ── search ───────────────────────────────────────────────────────────────
    const results = await provider.search(QUERY, { limit: 3, countryCodes: ['cm'] });

    assert(`${label}: a real Douala address returns at least one candidate`, results.length > 0,
        'zero results — either coverage is worse than expected or the request shape is wrong');
    if (results.length === 0) return;

    const first = results[0];

    assert(`${label}: the candidate names THIS provider`, first.provider === provider.name,
        `provider = ${first.provider}`);

    assert(`${label}: formatted_address is non-empty`, first.formatted_address.trim().length > 0,
        'an empty formatted address is the signature of a mis-mapped response field');

    // ⚠ Asserted across the CANDIDATE LIST, not on the top result, and the
    // distinction was learned the hard way on 2026-08-23. This suite's job is the
    // adapter's FIELD MAPPING; a provider's RANKING is its own business and not
    // something this repository can fix. Geoapify ranks the exact street match
    // for "Boulevard de la Liberté, Akwa, Douala" THIRD, with confidence 0, below
    // a different Akwa 267 km away — so asserting on `results[0]` failed for a
    // reason that had nothing to do with the mapping being right.
    //
    // The failure this assertion exists for is still caught: a swapped [lat, lng]
    // pair puts Douala in the Gulf of Guinea, thousands of km out, so NO candidate
    // would land near. Both halves stay plausible numbers, which is why it is
    // asserted rather than eyeballed.
    const distanceKm = (c: GeoCandidate): number => {
        const [lon, lat] = c.coordinates.coordinates;
        return Math.hypot((lon - LNG) * 111 * Math.cos((LAT * Math.PI) / 180), (lat - LAT) * 111);
    };
    const nearest = results.reduce((a, b) => (distanceKm(a) <= distanceKm(b) ? a : b));

    assert(`${label}: coordinates are [lng, lat] in that ORDER`,
        distanceKm(nearest) < 25,
        `nearest of ${results.length} candidate(s) was ${distanceKm(nearest).toFixed(1)} km from Akwa — `
        + 'a swapped pair would be thousands of km out');

    // REPORTED, never asserted. Relevance is the provider's, and pinning it would
    // make this suite fail on somebody else's ranking change. It is printed
    // because it is the number that decides the CHAIN ORDER (ADR-A04 D-3): the
    // chain only consults the next provider when the first returns nothing, so
    // whoever is first is what a customer sees.
    console.log(
        `  ℹ  ${label}: top result ${distanceKm(first).toFixed(1)} km from Akwa — "${first.formatted_address}"`,
    );

    assert(`${label}: the GeoJSON type is Point`, first.coordinates.type === 'Point');

    // The components are the half a coordinate check cannot see. `city` and
    // `country_code` are the two the platform actually branches on — country for
    // the profile country gate, city for the delivery region.
    assert(`${label}: components.country_code is a 2-letter uppercase code`,
        first.components.country_code === 'CM',
        `country_code = ${String(first.components.country_code)}`);

    assert(`${label}: components.city is populated for a city-centre address`,
        (first.components.city ?? '').length > 0,
        `city = ${String(first.components.city)} — null here means the address sub-object was read wrong`);

    assert(`${label}: components.region is populated`,
        (first.components.region ?? '').length > 0,
        `region = ${String(first.components.region)}`);

    assert(`${label}: the limit is honoured`, results.length <= 3, `${results.length} results for limit 3`);

    // ── reverse ──────────────────────────────────────────────────────────────
    const reversed = await provider.reverse(LAT, LNG);
    assert(`${label}: reverse resolves a real coordinate`, reversed !== null);

    if (reversed) {
        assert(`${label}: the reversed candidate names this provider`, reversed.provider === provider.name);
        assert(`${label}: …with a non-empty formatted_address`, reversed.formatted_address.trim().length > 0);
        assert(`${label}: …and lands in Cameroon`, reversed.components.country_code === 'CM',
            `country_code = ${String(reversed.components.country_code)}`);
    }

    // ── a query nobody can resolve ───────────────────────────────────────────
    //
    // The providers signal "no match" differently — Geoapify and Mapbox with an empty
    // FeatureCollection, LocationIQ with a 404 — and ALL must arrive here as an
    // empty array rather than as a thrown error. Getting this wrong is what makes
    // the chain spend every provider's quota on every unmatchable address.
    const nothing = await provider.search('zzzz qqqq no such place zzzz', { limit: 1, countryCodes: ['cm'] });
    assert(`${label}: an unresolvable query returns [] rather than throwing`, Array.isArray(nothing),
        'a no-match must not be an error — see the chain\'s failover rules');
}

async function main(): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════════════════════');
    console.log('  verify:geocoding-providers — the paid adapters, against the real APIs');
    console.log('═══════════════════════════════════════════════════════════════════════');

    const timeout = Number(process.env.GEO_REQUEST_TIMEOUT_MS) || 8000;

    if (process.env.GEO_MAPBOX_TOKEN) {
        const permanent = !['false', '0'].includes((process.env.GEO_MAPBOX_PERMANENT ?? '').toLowerCase());
        // Printed because a 403 on every call below almost always means THIS: a
        // permanent request on an account with no card on file.
        console.log(`\n  ℹ  mapbox: permanent=${permanent}`);
        const mapbox = new MapboxProvider(
            { apiKey: process.env.GEO_MAPBOX_TOKEN, baseUrl: process.env.GEO_MAPBOX_BASE_URL, permanent },
            timeout, 5, ['cm'],
        );
        console.log(`\n── mapbox ${'─'.repeat(56)}\n`);

        // ⚠ NOT the shared `exercise`, and the reason is a measured fact rather than a
        // preference. On 2026-10-18 Mapbox resolved NOTHING finer than a city anywhere
        // in Cameroon — eight well-known Douala/Yaoundé streets and quarters all came
        // back as `place: Douala` / `region: Littoral`, and the adapter (correctly)
        // drops those. So `exercise`'s Douala fixture can no longer reach the mapping
        // code at all. The MAPPING is proven on a market Mapbox does cover; Cameroon
        // COVERAGE is reported, never asserted — it is Mapbox's data, not our bug.
        const paris = await mapbox.search('10 Rue de Rivoli, Paris', { limit: 3, countryCodes: ['fr'] });
        assert('mapbox: a street-level address in a covered market returns a candidate', paris.length > 0);
        const p0 = paris[0];
        if (p0) {
            const [lon, lat] = p0.coordinates.coordinates;
            assert('mapbox: candidate names this provider', p0.provider === 'mapbox');
            assert('mapbox: formatted_address is non-empty', p0.formatted_address.trim().length > 0);
            assert('mapbox: coordinates are [lng, lat] in that ORDER', Math.abs(lon - 2.35) < 0.2 && Math.abs(lat - 48.86) < 0.2,
                `got [${lon}, ${lat}]`);
            assert('mapbox: components.street is populated', (p0.components.street ?? '').length > 0,
                `street = ${String(p0.components.street)}`);
            assert('mapbox: components.city is populated', (p0.components.city ?? '').length > 0,
                `city = ${String(p0.components.city)}`);
            assert('mapbox: components.region is populated', (p0.components.region ?? '').length > 0,
                `region = ${String(p0.components.region)}`);
            assert('mapbox: components.country_code is FR', p0.components.country_code === 'FR',
                `country_code = ${String(p0.components.country_code)}`);
            assert('mapbox: provider_place_id is set', !!p0.provider_place_id);
        }
        const parisRev = await mapbox.reverse(48.8606, 2.3376);
        assert('mapbox: reverse resolves a covered coordinate at street level',
            parisRev !== null && (parisRev.components.street !== null || parisRev.components.neighbourhood !== null));

        const nothing = await mapbox.search('zzzz qqqq no such place zzzz', { limit: 1 });
        assert('mapbox: an unresolvable query returns [] rather than throwing', Array.isArray(nothing));

        // Coverage in the market we serve — REPORTED.
        const cm = await mapbox.search(QUERY, { limit: 3, countryCodes: ['cm'] });
        const cmRev = await mapbox.reverse(LAT, LNG);
        console.log(`  ℹ  mapbox: Cameroon street-level coverage — search "${QUERY}": ${cm.length} candidate(s); `
            + `reverse Akwa: ${cmRev ? `"${cmRev.formatted_address}"` : 'none'}. `
            + 'Zero means every Cameroonian lookup falls through to the next provider.');

        // Mapbox-only: a query past v6's 20-word limit must come back EMPTY so the
        // chain asks the next provider — never as a 422 the chain would not fall
        // over on. Answered locally, so it spends no quota.
        const long = await new MapboxProvider(
            { apiKey: process.env.GEO_MAPBOX_TOKEN, permanent }, timeout, 5, ['cm'],
        ).search(Array.from({ length: 25 }, (_, i) => `mot${i}`).join(' '));
        assert('mapbox: a query past the 20-word limit returns [] (chain falls through)', long.length === 0);

        // Mapbox-only: it may answer ONLY at street / neighbourhood level, so a city-
        // level centroid can never block LocationIQ's street match (ADR-A04 D-4). A
        // bare city name is the query most likely to tempt a coarse answer; [] is a
        // pass, since the chain then asks the next provider.
        const cityOnly = await new MapboxProvider(
            { apiKey: process.env.GEO_MAPBOX_TOKEN, permanent }, timeout, 5, ['cm'],
        ).search('Douala');
        assert('mapbox: no candidate is coarser than a neighbourhood (city-only query)',
            cityOnly.every(c => c.components.street !== null || c.components.neighbourhood !== null),
            cityOnly.map(c => c.formatted_address).join(' | '));
    } else {
        console.log('\n  ⏭  mapbox SKIPPED — GEO_MAPBOX_TOKEN is not set');
        skipped++;
    }

    if (process.env.GEO_GEOAPIFY_API_KEY) {
        await exercise('geoapify', new GeoapifyProvider(
            { apiKey: process.env.GEO_GEOAPIFY_API_KEY, baseUrl: process.env.GEO_GEOAPIFY_BASE_URL },
            timeout, 5, ['cm'],
        ));
    } else {
        console.log('\n  ⏭  geoapify SKIPPED — GEO_GEOAPIFY_API_KEY is not set');
        skipped++;
    }

    if (process.env.GEO_LOCATIONIQ_API_KEY) {
        await exercise('locationiq', new LocationIqProvider(
            { apiKey: process.env.GEO_LOCATIONIQ_API_KEY, baseUrl: process.env.GEO_LOCATIONIQ_BASE_URL },
            timeout, 5, ['cm'],
        ));
    } else {
        console.log('\n  ⏭  locationiq SKIPPED — GEO_LOCATIONIQ_API_KEY is not set');
        skipped++;
    }

    if (skipped === 3) {
        console.log('\n⚠ EVERY provider was skipped, so this run proved NOTHING about any');
        console.log('  adapter. They are written against the published response shapes and have');
        console.log('  never been exercised against a live key. Set a key and run this before');
        console.log('  trusting `GEO_PROVIDER=chain` in a deployment.\n');
    }

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed, ${skipped} provider(s) skipped\n`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
