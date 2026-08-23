/**
 * test:geocoding-chain — the multi-provider failover chain. **No DB, no network.**
 *
 * Every provider is a fake implementing `IGeocodingProvider`, so the failover
 * rules are asserted as behaviour rather than as a source scan. That matters
 * more here than usual: the whole point of the chain is what it does when a
 * provider MISBEHAVES, and the misbehaviour is a 429 or a timeout — neither of
 * which anybody can reproduce on demand against a live provider without
 * deliberately burning a day's quota.
 *
 * ── What the chain exists for ─────────────────────────────────────────────────
 *
 * Both paid providers have free tiers in the low thousands of calls a day
 * (Geoapify 3 000 @ 5 rps soft, LocationIQ 5 000 @ 2 rps HARD). Address search at
 * checkout spends them. The chain adds the allowances together instead of making
 * the platform pick one and be down when it runs out.
 *
 * ── The four rules under test, and why each is a rule ─────────────────────────
 *
 *  1. A **429 or an outage** moves to the next provider. The "reached my limit"
 *     and "one is down" cases.
 *  2. An **empty result also moves on** — coverage genuinely differs between
 *     providers on Cameroonian addresses, so "no match" from one is worth asking
 *     the next. The chain returns empty only once everybody has been asked.
 *  3. A **`GEO_SEARCH_FAILED` does NOT move on.** A malformed query will be just
 *     as malformed at the next provider, and a rejected key must surface rather
 *     than be papered over by the reserve.
 *  4. **Candidates are passed through untouched.** A stored `GeoAddress.provider`
 *     must name the SERVICE that resolved it, never the chain — that value is
 *     what makes `provider_place_id` resolvable later.
 *
 * Run: npm run test:geocoding-chain
 */
import { ChainedGeocodingProvider } from '../../src/core/geocoding/geocoding.chain';
import {
    GeoCandidate,
    GeoSearchOptions,
    IGeocodingProvider,
} from '../../src/core/geocoding/geocoding-provider.interface';
import { GEO_PROVIDERS, GeoProviderName } from '../../src/core/types/geo-address.types';
import { createAppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';

let passed = 0;
let failed = 0;

function assert(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}${detail ? `\n       ${detail}` : ''}`);
        failed++;
    }
}

function candidate(provider: GeoProviderName, label: string): GeoCandidate {
    return {
        formatted_address: label,
        coordinates: { type: 'Point', coordinates: [9.7, 4.05] },
        provider,
        provider_place_id: `${provider}-1`,
        components: {
            street: null, neighbourhood: null, city: 'Douala',
            region: 'Littoral', country: 'Cameroun', country_code: 'CM', postal_code: null,
        },
    };
}

type Behaviour = 'hit' | 'empty' | 'rate_limited' | 'unavailable' | 'search_failed';

/** A provider whose behaviour is dictated, and which counts how often it is asked. */
class FakeProvider implements IGeocodingProvider {
    calls = 0;

    constructor(
        readonly name: GeoProviderName,
        private readonly behaviour: Behaviour,
    ) {}

    private act(): never | null {
        switch (this.behaviour) {
            case 'rate_limited':
                throw createAppError(ERROR_CODES.GEO_PROVIDER_RATE_LIMITED, 429, `${this.name} is rate limited`);
            case 'unavailable':
                throw createAppError(ERROR_CODES.GEO_PROVIDER_UNAVAILABLE, 503, `${this.name} is unreachable`);
            case 'search_failed':
                throw createAppError(ERROR_CODES.GEO_SEARCH_FAILED, 502, `${this.name} rejected the query`);
            default:
                return null;
        }
    }

    async search(_query: string, _opts?: GeoSearchOptions): Promise<GeoCandidate[]> {
        this.calls++;
        this.act();
        return this.behaviour === 'hit' ? [candidate(this.name, `${this.name} result`)] : [];
    }

    async reverse(_lat: number, _lng: number): Promise<GeoCandidate | null> {
        this.calls++;
        this.act();
        return this.behaviour === 'hit' ? candidate(this.name, `${this.name} reverse`) : null;
    }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
    try {
        await fn();
        return null;
    } catch (error) {
        return (error as { code?: string }).code ?? 'UNKNOWN';
    }
}

async function main(): Promise<void> {
    console.log('\n── 1 · Quota and outage move to the next provider ─────────────────────\n');
    {
        const a = new FakeProvider('geoapify', 'rate_limited');
        const b = new FakeProvider('locationiq', 'hit');
        const chain = new ChainedGeocodingProvider([a, b]);

        const results = await chain.search('Akwa Douala');
        assert('a 429 on the first provider is served by the second', results.length === 1);
        assert('…and the result is the SECOND provider\'s', results[0].provider === 'locationiq');
        assert('…having asked both exactly once', a.calls === 1 && b.calls === 1, `${a.calls}/${b.calls}`);
    }
    {
        const a = new FakeProvider('geoapify', 'unavailable');
        const b = new FakeProvider('locationiq', 'hit');
        const chain = new ChainedGeocodingProvider([a, b]);
        const results = await chain.search('Akwa Douala');
        assert('an outage (5xx/timeout/DNS) fails over the same way', results[0]?.provider === 'locationiq');
    }
    {
        const a = new FakeProvider('geoapify', 'rate_limited');
        const b = new FakeProvider('locationiq', 'hit');
        const chain = new ChainedGeocodingProvider([a, b]);
        const result = await chain.reverse(4.05, 9.7);
        assert('reverse fails over on the same conditions as search', result?.provider === 'locationiq');
    }

    console.log('\n── 2 · An EMPTY result moves on too — coverage differs ────────────────\n');
    {
        const a = new FakeProvider('geoapify', 'empty');
        const b = new FakeProvider('locationiq', 'hit');
        const chain = new ChainedGeocodingProvider([a, b]);

        const results = await chain.search('a street only one of them has mapped');
        assert('"no match" from the first is asked of the second', results[0]?.provider === 'locationiq');
        assert('…and the first was still asked', a.calls === 1);
    }
    {
        const a = new FakeProvider('geoapify', 'empty');
        const b = new FakeProvider('locationiq', 'empty');
        const c = new FakeProvider('nominatim', 'empty');
        const chain = new ChainedGeocodingProvider([a, b, c]);

        const results = await chain.search('a genuinely unresolvable address');
        assert('when nobody has it the chain returns EMPTY, not an error', results.length === 0);
        assert('…having asked every provider', a.calls === 1 && b.calls === 1 && c.calls === 1);
        assert('…and reverse does the same, returning null', (await chain.reverse(0, 0)) === null);
    }

    console.log('\n── 3 · A first HIT stops the chain — the reserve is not spent ─────────\n');
    {
        const a = new FakeProvider('geoapify', 'hit');
        const b = new FakeProvider('locationiq', 'hit');
        const chain = new ChainedGeocodingProvider([a, b]);

        await chain.search('Akwa Douala');
        assert('the first provider answering ends it', a.calls === 1 && b.calls === 0, `${a.calls}/${b.calls}`);
        await chain.reverse(4.05, 9.7);
        assert('…and the same on reverse', b.calls === 0);
    }

    console.log('\n── 4 · What must NOT fail over ────────────────────────────────────────\n');
    {
        const a = new FakeProvider('geoapify', 'search_failed');
        const b = new FakeProvider('locationiq', 'hit');
        const chain = new ChainedGeocodingProvider([a, b]);

        const code = await codeOf(() => chain.search('malformed'));
        assert(
            'GEO_SEARCH_FAILED propagates — a bad query is bad everywhere, and a rejected key must be seen',
            code === ERROR_CODES.GEO_SEARCH_FAILED,
            `got ${code}`,
        );
        assert('…and the reserve\'s quota was NOT spent reproducing it', b.calls === 0, `${b.calls} call(s)`);
    }

    console.log('\n── 5 · "Nobody could be asked" ≠ "everybody said no" ──────────────────\n');
    {
        const a = new FakeProvider('geoapify', 'rate_limited');
        const b = new FakeProvider('locationiq', 'unavailable');
        const chain = new ChainedGeocodingProvider([a, b]);

        const code = await codeOf(() => chain.search('Akwa Douala'));
        assert(
            'every provider failing THROWS the last error rather than returning empty',
            code === ERROR_CODES.GEO_PROVIDER_UNAVAILABLE,
            `got ${code}`,
        );
        assert('…and reverse behaves identically', (await codeOf(() => chain.reverse(4.05, 9.7))) === ERROR_CODES.GEO_PROVIDER_UNAVAILABLE);
    }
    {
        // The distinction that makes rule 5 subtle: one 429 followed by an honest
        // miss is a MISS. Returning an error there would tell a customer the
        // service is broken when the truth is their street is not on the map.
        const a = new FakeProvider('geoapify', 'rate_limited');
        const b = new FakeProvider('locationiq', 'empty');
        const chain = new ChainedGeocodingProvider([a, b]);

        const results = await chain.search('an address that really is not there');
        assert('a 429 THEN an honest miss is a miss, not an error', results.length === 0);
        assert('…and the same on reverse', (await chain.reverse(0, 0)) === null);
    }

    console.log('\n── 6 · The chain never renames a candidate ────────────────────────────\n');
    {
        const chain = new ChainedGeocodingProvider([
            new FakeProvider('geoapify', 'empty'),
            new FakeProvider('locationiq', 'hit'),
        ]);
        const results = await chain.search('Akwa Douala');

        assert(
            'the candidate reports the SERVICE that resolved it, not the chain',
            results[0].provider === 'locationiq',
        );
        assert(
            '…and its provider_place_id is that service\'s, so it stays resolvable',
            results[0].provider_place_id === 'locationiq-1',
        );
        // The structural half: there is no such thing as a 'chain' provider name,
        // so a row can never be written claiming one.
        assert(
            'GEO_PROVIDERS does not contain "chain" — a stored row cannot name the mechanism',
            !(GEO_PROVIDERS as readonly string[]).includes('chain'),
        );
        assert(
            '…and both adapters ARE nameable, so their rows are valid',
            (GEO_PROVIDERS as readonly string[]).includes('geoapify')
            && (GEO_PROVIDERS as readonly string[]).includes('locationiq'),
        );
    }

    console.log('\n── 7 · Construction ───────────────────────────────────────────────────\n');
    {
        let threw = false;
        try {
            new ChainedGeocodingProvider([]);
        } catch {
            threw = true;
        }
        assert('an empty chain is refused at construction', threw);

        const chain = new ChainedGeocodingProvider([
            new FakeProvider('geoapify', 'hit'),
            new FakeProvider('locationiq', 'hit'),
            new FakeProvider('nominatim', 'hit'),
        ]);
        assert('`chain` reports the order, for the operations surface', chain.chain.join(',') === 'geoapify,locationiq,nominatim');
        assert('`name` reports the FIRST provider — it is only ever used for logging', chain.name === 'geoapify');
    }

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
