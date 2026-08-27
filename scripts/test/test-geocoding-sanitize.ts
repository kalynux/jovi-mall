/**
 * test:geocoding-sanitize — HTML entities in provider text. **No DB, no network.**
 *
 * ── The defect this suite is the record of ───────────────────────────────────
 * Geocoding providers return HTML-ESCAPED strings, because their data comes out of
 * OpenStreetMap. A real LocationIQ result for `"Akwa, Douala"`, captured from the live
 * dev server on 2026-08-26:
 *
 *     "École Bilingue la Pouponnière d&apos;AKWA, Rue 1.491, Camp Yabassi, Douala, …"
 *
 * jovi-mall passed that through untouched, so `d&apos;AKWA` reached a chat window, a
 * delivery label, and the stored `order.delivery_address.formatted_address` as literal
 * text. No frontend can fix it: the entity is in the value.
 *
 * It was found while writing `api-doc/n8n/TELEGRAM-ONBOARDING-WALKTHROUGH.md`, which quotes
 * real captured responses rather than composed ones — which is the argument for writing docs
 * that way.
 *
 * ── The two properties that need a test rather than a reading ────────────────
 *  1. **Single-pass decoding.** `&amp;apos;` must stay `&apos;`, never become `'`. A loop, or
 *     decoding `&amp;` separately, produces the classic double-unescape bug — and it is
 *     invisible until somebody's address contains a literal ampersand.
 *  2. **The wrapper is on the FACTORY's return.** A source scan is the only way to see that
 *     a fourth adapter written later inherits the fix, because nothing behavioural can
 *     observe an adapter that does not exist yet.
 *
 * Run: npm run test:geocoding-sanitize
 */
import fs from 'fs';
import path from 'path';
import {
    decodeProviderEntities,
    sanitizeGeoCandidate,
    SanitizedGeocodingProvider,
} from '../../src/core/geocoding/geocoding.sanitize';
import {
    GeoCandidate,
    GeoSearchOptions,
    IGeocodingProvider,
} from '../../src/core/geocoding/geocoding-provider.interface';
import { GeoProviderName } from '../../src/core/types/geo-address.types';

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

function section(title: string): void {
    console.log(`\n▶ ${title}`);
}

function candidate(over: Partial<GeoCandidate> = {}): GeoCandidate {
    return {
        formatted_address: 'Akwa, Douala',
        coordinates: { type: 'Point', coordinates: [9.7, 4.05] },
        provider: 'locationiq',
        provider_place_id: 'way:12345',
        components: {
            street: null,
            neighbourhood: 'Akwa',
            city: 'Douala I',
            region: 'Littoral',
            country: 'Cameroun',
            country_code: 'CM',
            postal_code: null,
        },
        ...over,
    };
}

class FakeProvider implements IGeocodingProvider {
    readonly name: GeoProviderName = 'locationiq';
    constructor(
        private readonly results: GeoCandidate[],
        private readonly reverseResult: GeoCandidate | null = null,
    ) {}
    async search(_q: string, _o?: GeoSearchOptions): Promise<GeoCandidate[]> {
        return this.results;
    }
    async reverse(_lat: number, _lng: number): Promise<GeoCandidate | null> {
        return this.reverseResult;
    }
}

async function main(): Promise<void> {
    console.log('\n═══ test:geocoding-sanitize ════════════════════════════════════════════════\n');

    // ═════════════════════════════════════════════════════════════════════════
    section('1 · The real string that prompted this');
    // ═════════════════════════════════════════════════════════════════════════

    const REAL = "École Bilingue la Pouponnière d&apos;AKWA, Rue 1.491, Camp Yabassi, Douala, Wouri, Littoral, Cameroun";
    const REAL_FIXED = "École Bilingue la Pouponnière d'AKWA, Rue 1.491, Camp Yabassi, Douala, Wouri, Littoral, Cameroun";

    assert('the captured LocationIQ result decodes to real prose',
        decodeProviderEntities(REAL) === REAL_FIXED,
        decodeProviderEntities(REAL));

    assert('accents and non-ASCII are untouched',
        decodeProviderEntities('École Pouponnière') === 'École Pouponnière');

    // ═════════════════════════════════════════════════════════════════════════
    section('2 · The entity table');
    // ═════════════════════════════════════════════════════════════════════════

    assert('&apos; → apostrophe', decodeProviderEntities('Rue d&apos;Akwa') === "Rue d'Akwa");
    assert('&amp; → ampersand', decodeProviderEntities('Smith &amp; Sons') === 'Smith & Sons');
    assert('&quot; → quote', decodeProviderEntities('&quot;Le Bistro&quot;') === '"Le Bistro"');
    assert('&lt; and &gt;', decodeProviderEntities('a &lt;b&gt; c') === 'a <b> c');
    assert('decimal numeric &#39;', decodeProviderEntities('d&#39;Akwa') === "d'Akwa");
    assert('hex numeric &#x27;', decodeProviderEntities('d&#x27;Akwa') === "d'Akwa");
    assert('hex is case-insensitive', decodeProviderEntities('d&#X27;Akwa') === "d'Akwa");
    assert('named is case-insensitive', decodeProviderEntities('a &AMP; b') === 'a & b');
    assert('several in one string',
        decodeProviderEntities('d&apos;A &amp; d&apos;B') === "d'A & d'B");

    /**
     * ⚠ Decoded to an ORDINARY space, not U+00A0. These strings become `city` and `region`,
     * which are trimmed and compared all over this codebase — an invisible non-breaking
     * space makes two identical-looking addresses compare unequal.
     */
    assert('&nbsp; becomes an ordinary space, NOT U+00A0',
        decodeProviderEntities('Douala&nbsp;I') === 'Douala I'
        && !decodeProviderEntities('Douala&nbsp;I').includes(' '));

    // ═════════════════════════════════════════════════════════════════════════
    section('3 · ⚠ Single-pass — the double-unescape bug');
    // ═════════════════════════════════════════════════════════════════════════

    assert('⚠ &amp;apos; stays &apos; — it is NOT decoded twice',
        decodeProviderEntities('a &amp;apos; b') === "a &apos; b",
        decodeProviderEntities('a &amp;apos; b'));

    assert('⚠ &amp;amp; stays &amp;',
        decodeProviderEntities('&amp;amp;') === '&amp;');

    assert('⚠ decoding an already-decoded string changes nothing further',
        decodeProviderEntities(decodeProviderEntities("d'Akwa & Co")) === "d'Akwa & Co");

    // ═════════════════════════════════════════════════════════════════════════
    section('4 · What is left alone');
    // ═════════════════════════════════════════════════════════════════════════

    assert('a bare ampersand is not touched',
        decodeProviderEntities('Rue A & B') === 'Rue A & B');

    assert('an UNKNOWN entity name is left literal — never guessed at',
        decodeProviderEntities('Rue A&section;B') === 'Rue A&section;B');

    assert('an unterminated entity is left literal',
        decodeProviderEntities('100&amp 200') === '100&amp 200');

    assert('a string with no ampersand short-circuits unchanged',
        decodeProviderEntities('Akwa, Douala') === 'Akwa, Douala');

    assert('an empty string survives', decodeProviderEntities('') === '');

    // ── The control-character guard ──────────────────────────────────────────
    assert('⚠ a NUL entity is refused and left literal',
        decodeProviderEntities('a&#0;b') === 'a&#0;b');

    assert('⚠ a C0 control entity is refused',
        decodeProviderEntities('a&#7;b') === 'a&#7;b');

    assert('⚠ a C1 control entity is refused',
        decodeProviderEntities('a&#x9f;b') === 'a&#x9f;b');

    assert('⚠ a lone surrogate is refused — it would not serialise as UTF-8',
        decodeProviderEntities('a&#xD800;b') === 'a&#xD800;b');

    assert('⚠ an out-of-range code point is refused rather than throwing', (() => {
        try {
            return decodeProviderEntities('a&#9999999;b') === 'a&#9999999;b';
        } catch {
            return false;
        }
    })());

    assert('a legitimate high code point still decodes',
        decodeProviderEntities('a&#x1F600;b') === 'a\u{1F600}b');

    // ═════════════════════════════════════════════════════════════════════════
    section('5 · The candidate projection');
    // ═════════════════════════════════════════════════════════════════════════

    const dirty = candidate({
        formatted_address: REAL,
        provider_place_id: 'way:1&amp;2',
        components: {
            street: 'Rue d&apos;Akwa',
            neighbourhood: null,
            city: 'Douala&nbsp;I',
            region: 'Littoral',
            country: 'C&ocirc;te',
            country_code: 'CM',
            postal_code: null,
        },
    });
    const clean = sanitizeGeoCandidate(dirty);

    assert('formatted_address is decoded', clean.formatted_address === REAL_FIXED);
    assert('component strings are decoded', clean.components.street === "Rue d'Akwa");
    assert('a null component stays null', clean.components.neighbourhood === null);
    assert('an unknown named entity in a component is left literal',
        clean.components.country === 'C&ocirc;te');

    /**
     * ⚠ A place id is an opaque provider handle that must round-trip byte-identically — it
     * is what makes a stored address re-resolvable. An `&` inside one is data, not markup.
     */
    assert('⚠ provider_place_id is NOT decoded', clean.provider_place_id === 'way:1&amp;2');
    assert('coordinates are carried through untouched',
        clean.coordinates.coordinates[0] === 9.7 && clean.coordinates.coordinates[1] === 4.05);
    assert('provider is preserved', clean.provider === 'locationiq');

    assert('the input candidate is not mutated', dirty.formatted_address === REAL);

    /**
     * The generic mapping is what makes an EIGHTH component field safe. A hand-listed mapper
     * would leave it undecoded, silently, and the symptom would be one entity in one city
     * name months later.
     */
    const extra = sanitizeGeoCandidate(candidate({
        components: { ...candidate().components, block: 'B&amp;C' } as never,
    }));
    assert('⚠ a component field this file has never heard of is still decoded',
        (extra.components as unknown as Record<string, string>).block === 'B&C');

    // ═════════════════════════════════════════════════════════════════════════
    section('6 · The decorator');
    // ═════════════════════════════════════════════════════════════════════════

    const wrapped = new SanitizedGeocodingProvider(
        new FakeProvider([candidate({ formatted_address: REAL })], candidate({ formatted_address: REAL })),
    );

    const searched = await wrapped.search('akwa');
    assert('search() decodes every candidate', searched[0].formatted_address === REAL_FIXED);

    const reversed = await wrapped.reverse(4.05, 9.7);
    assert('reverse() decodes its candidate', reversed?.formatted_address === REAL_FIXED);

    assert('the decorator forwards `name`, so nothing downstream can tell it is wrapped',
        wrapped.name === 'locationiq');

    const empty = new SanitizedGeocodingProvider(new FakeProvider([], null));
    assert('an empty search stays empty', (await empty.search('nowhere')).length === 0);
    assert('a null reverse stays null', (await empty.reverse(0, 0)) === null);

    // ═════════════════════════════════════════════════════════════════════════
    section('7 · Source scans — where the wrapper sits');
    // ═════════════════════════════════════════════════════════════════════════

    const root = path.join(__dirname, '..', '..', 'src', 'core', 'geocoding');

    /**
     * ⚠ **Comments are stripped before every scan below**, and this is a house rule rather
     * than a convenience — `test:geocoding-cache` and `test:connections` both do it, and the
     * latter states why: the tombstones explaining what a file does and does not do are the
     * most useful thing in a diff, and a scan that forces their removal has made the codebase
     * worse.
     *
     * It earned its keep immediately here. The `nothing else wraps with it` assertion below
     * failed on first run because `geocoding.cache.ts` *mentions*
     * `SanitizedGeocodingProvider` in a comment explaining the ordering — exactly the comment
     * a future reader most needs.
     */
    const strip = (s: string): string =>
        s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const readSrc = (file: string): string => strip(fs.readFileSync(path.join(root, file), 'utf8'));

    const factory = readSrc('geocoding.factory.ts');
    const instance = readSrc('geocoding.instance.ts');

    /**
     * ⚠ The invariant nothing behavioural can see: an adapter written NEXT YEAR inherits
     * this. It does so only because the wrap is on the factory's return rather than in three
     * adapters, and only a scan can assert a property about code that does not exist yet.
     */
    assert('⚠ the factory wraps its return — so a FOURTH adapter inherits the fix',
        /return new SanitizedGeocodingProvider\(/.test(factory));

    assert('the factory has exactly one return path through the wrapper',
        (factory.match(/new SanitizedGeocodingProvider\(/g) ?? []).length === 1);

    /**
     * ⚠ Order matters: sanitising INSIDE the cache means Redis stores decoded values and the
     * work happens once. Outside, every cache read would decode again — and entity-bearing
     * strings would sit in Redis for their full 24-hour TTL.
     */
    assert('⚠ the cache wraps the factory output, so the cache stores DECODED values',
        /new CachedGeocodingProvider\(\s*provider,/.test(instance)
        && !/SanitizedGeocodingProvider/.test(instance));

    /**
     * A second wrap would decode twice and reintroduce exactly the bug § 3 pins.
     */
    const others = ['geocoding.chain.ts', 'geocoding.cache.ts']
        .filter((f) => /new SanitizedGeocodingProvider\(/.test(readSrc(f)));
    assert('⚠ nothing else wraps with it — a second wrap would decode twice',
        others.length === 0, others.join(', '));

    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n────────────────────────────────────────────────────────────');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('────────────────────────────────────────────────────────────\n');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error('\n💥 the suite itself threw:', error);
    process.exit(1);
});
