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
    // Both providers signal "no match" differently — Geoapify with an empty
    // FeatureCollection, LocationIQ with a 404 — and BOTH must arrive here as an
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

    if (skipped === 2) {
        console.log('\n⚠ BOTH providers were skipped, so this run proved NOTHING about either');
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
