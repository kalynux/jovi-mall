/**
 * The category duplicate guard — PURE: no I/O, no clock, no Mongo.
 *
 * There is ONE marketplace-wide category list and any vendor may add to it while
 * editing a product (owner decisions C-1, C-2 — PRODUCTION-READINESS/PRODUCT-CATEGORIES-PLAN.md).
 * Without a guard that list fills with "Shoes", "shoes", "Shoe", "Shose" and "SHOES ",
 * five chips on the storefront for one shelf. This file is the guard, and it answers
 * one question about a name a vendor typed: is it a category we already have?
 *
 * ## Three verdicts, and why there are three (C-3)
 *
 *  - `exact`   — the same category spelled differently: case, accents, spacing,
 *                punctuation, singular/plural, a word that was merged in by an admin.
 *                Reused SILENTLY. Asking "did you mean Shoes?" about "shoes" is noise.
 *  - `similar` — probably the same category, but only probably: a one-letter slip
 *                ("Shose"), or the same words in another order. The vendor is ASKED,
 *                and may insist. Never merged automatically, because the same distance
 *                that catches "Shose" would also turn "Cap" into "Cup".
 *  - `new`     — nothing close. Created.
 *
 * ## The singular rule only has to be CONSISTENT, not correct
 *
 * Both sides of every comparison go through `matchKey`, so the rule does not need to
 * produce a real word — it needs to send a singular and its plural to the same string.
 * "movie" and "movies" both become `movy`; "série" and "series" both become `sery`.
 * That is why there is no dictionary here, and why a "wrong-looking" key is not a bug.
 * Plurals are modelled for English and French (the platform's two working languages);
 * every other language still gets case, accent, spacing and typo handling.
 *
 * ## What it deliberately does NOT do
 *
 * Translation. "Shoes" and "Chaussures" share no letters a rule could use. That gap is
 * closed by the admin MERGE (C-4), which records the merged category's key as an
 * ALIAS of the survivor — so after one merge, the next vendor typing "chaussure"
 * gets an `exact` verdict pointing at "Shoes" (`via: 'alias'`).
 */

/** Display-name bounds. The upper bound is about chips and WhatsApp rows, not storage. */
export const CATEGORY_NAME_MIN_LENGTH = 2;
export const CATEGORY_NAME_MAX_LENGTH = 60;

/** How many categories one product may carry (stated default, uncontested). */
export const MAX_CATEGORIES_PER_PRODUCT = 5;

/** At most this many "did you mean" suggestions per name. */
export const MAX_CATEGORY_SUGGESTIONS = 3;

/**
 * Words that carry no category meaning on their own. "Bags & Shoes", "Bags and Shoes"
 * and "Sacs et chaussures" must not differ by a connector.
 */
const CONNECTOR_TOKENS = new Set(['and', 'et', '&']);

export interface CategoryCandidate {
    id: string;
    name: string;
    slug: string;
    /** `matchKey(name)` as stored. */
    matchKey: string;
    /** Keys of categories an administrator merged INTO this one. */
    aliasKeys: readonly string[];
}

export type CategoryMatchVerdict<C extends CategoryCandidate = CategoryCandidate> =
    | { kind: 'exact'; category: C; via: 'name' | 'alias' }
    | { kind: 'similar'; suggestions: C[] }
    | { kind: 'new' };

// ─────────────────────────────────────────────────────────────────────────────
//  Normalisation
// ─────────────────────────────────────────────────────────────────────────────

function stripAccents(value: string): string {
    return value.normalize('NFKD').replace(/\p{M}+/gu, '');
}

/**
 * The display form of a typed name, or `null` when it cannot be a category.
 *
 * Trims, collapses inner whitespace and NFC-normalises (so a decomposed "é" pasted
 * from a PDF is stored as the same bytes as a typed one). Refuses a name outside the
 * length bounds or with no letter or digit at all — "!!!" is not a shelf.
 *
 * Case is KEPT: the first vendor to write a category chooses how it is displayed,
 * and an administrator can rename it. Lower-casing everything would turn
 * "TV & Audio" into "tv & audio" for everyone.
 */
export function cleanCategoryName(raw: string): string | null {
    const cleaned = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (cleaned.length < CATEGORY_NAME_MIN_LENGTH) return null;
    if (cleaned.length > CATEGORY_NAME_MAX_LENGTH) return null;
    if (!/[\p{L}\p{N}]/u.test(cleaned)) return null;
    return cleaned;
}

/**
 * Reduce one lower-cased, accent-free token to its singular key.
 *
 * Order matters — the longer endings are tested first, so "chapeaux" meets `-eaux`
 * before `-aux` and "glasses" meets `-sses` before the bare `-s`. Short tokens (≤ 3)
 * are left alone: "bus", "gas" and "pie" are not plurals of anything.
 */
export function singularToken(token: string): string {
    const n = token.length;
    if (n <= 3) return token;
    // EN -ies / FR -ie → y. Paired, so "movie"/"movies" and "série"/"series" agree.
    if (n >= 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
    if (n >= 5 && token.endsWith('ie')) return `${token.slice(0, -2)}y`;
    // EN sibilant plurals: boxes, watches, brushes, glasses, quizzes.
    if (/(?:x|ch|sh|ss|z)es$/.test(token)) return token.slice(0, -2);
    // FR -eaux / -eux / -oux: chapeaux, jeux, bijoux.
    if (/(?:eau|eu|ou)x$/.test(token)) return token.slice(0, -1);
    // FR -aux → -al: journaux, animaux.
    if (token.endsWith('aux')) return `${token.slice(0, -3)}al`;
    // Words that end in s without being plurals.
    if (/(?:ss|us|is)$/.test(token)) return token;
    if (token.endsWith('s')) return token.slice(0, -1);
    return token;
}

/**
 * The comparable tokens of a name: lower-case, accent-free, punctuation as spaces,
 * connectors dropped, each reduced to its singular. A possessive's dangling "s"
 * ("men's") is dropped with the punctuation that separated it.
 */
export function categoryTokens(name: string): string[] {
    const flat = stripAccents(name.toLowerCase())
        .replace(/&/g, ' & ')
        .replace(/[^\p{L}\p{N}&]+/gu, ' ');
    return flat
        .split(' ')
        .filter((t) => t.length > 0 && !CONNECTOR_TOKENS.has(t) && t !== 's')
        .map(singularToken);
}

/**
 * The canonical key the uniqueness index is built on.
 *
 * The tokens are joined with NO separator, so "T-shirt", "T shirt" and "Tshirt" are
 * one category — hyphenation and spacing of compound words is the commonest variant
 * there is. The cost is that two names differing only in where a space falls would
 * collide, which in a category list is the same shelf anyway.
 */
export function matchKey(name: string): string {
    return categoryTokens(name).join('');
}

/**
 * A URL key. ASCII, lower-case, hyphenated. Uniqueness is the caller's job (it
 * appends `-2`, `-3`… against the live list).
 */
export function slugifyCategory(name: string): string {
    const slug = stripAccents(name.toLowerCase())
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
    return slug.length > 0 ? slug.slice(0, 80) : 'category';
}

// ─────────────────────────────────────────────────────────────────────────────
//  Distance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optimal string alignment distance (Levenshtein + adjacent transposition), with an
 * early exit once every cell in a row exceeds `max`. A transposition costs 1 because
 * "Shose" for "Shoes" is one slip of the fingers, not two.
 */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const rows = a.length + 1;
    const cols = b.length + 1;
    const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
    for (let i = 0; i < rows; i++) d[i][0] = i;
    for (let j = 0; j < cols; j++) d[0][j] = j;
    for (let i = 1; i < rows; i++) {
        let rowMin = Number.POSITIVE_INFINITY;
        for (let j = 1; j < cols; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                v = Math.min(v, d[i - 2][j - 2] + 1);
            }
            d[i][j] = v;
            if (v < rowMin) rowMin = v;
        }
        if (rowMin > max) return max + 1;
    }
    return d[rows - 1][cols - 1];
}

/**
 * How many typos two keys may differ by and still be suggested.
 *
 * Measured on the SHORTER key. Under 4 characters nothing is suggested: "cap"/"cup",
 * "bag"/"bra", "tv"/"pc" are one edit apart and are different shelves, and a
 * suggestion that is wrong half the time trains vendors to dismiss the prompt.
 */
export function typoAllowance(a: string, b: string): number {
    const shorter = Math.min(a.length, b.length);
    if (shorter < 4) return 0;
    if (shorter < 8) return 1;
    return 2;
}

function sameTokenSet(a: readonly string[], b: readonly string[]): boolean {
    if (a.length < 2 || a.length !== b.length) return false;
    const sa = [...a].sort().join(' ');
    const sb = [...b].sort().join(' ');
    return sa === sb;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The verdict
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compare one typed name against the live list.
 *
 * `exact` beats everything and an own-name hit beats an alias hit (two live categories
 * can never share a `matchKey` — the unique index — but an alias could in principle
 * equal another category's own key after a rename; the own name is the better answer).
 *
 * `name` should already have passed `cleanCategoryName`; an empty key is `new` so the
 * caller's own validation produces the error rather than a match against nothing.
 */
export function matchCategory<C extends CategoryCandidate>(
    name: string,
    catalog: readonly C[],
): CategoryMatchVerdict<C> {
    const key = matchKey(name);
    if (key.length === 0) return { kind: 'new' };

    const ownHit = catalog.find((c) => c.matchKey === key);
    if (ownHit) return { kind: 'exact', category: ownHit, via: 'name' };
    const aliasHit = catalog.find((c) => c.aliasKeys.includes(key));
    if (aliasHit) return { kind: 'exact', category: aliasHit, via: 'alias' };

    const tokens = categoryTokens(name);
    const scored: Array<{ category: C; score: number }> = [];
    for (const candidate of catalog) {
        const keys = [candidate.matchKey, ...candidate.aliasKeys];
        let best = Number.POSITIVE_INFINITY;
        for (const k of keys) {
            const allowance = typoAllowance(key, k);
            if (allowance === 0) continue;
            const distance = editDistance(key, k, allowance);
            if (distance <= allowance && distance < best) best = distance;
        }
        // Same words, another order ("Shoes Men" / "Men Shoes"). Scored below one typo
        // because it is the more certain of the two.
        if (sameTokenSet(tokens, categoryTokens(candidate.name))) best = Math.min(best, 0.5);
        if (Number.isFinite(best)) scored.push({ category: candidate, score: best });
    }

    if (scored.length === 0) return { kind: 'new' };
    scored.sort((x, y) => x.score - y.score || x.category.name.localeCompare(y.category.name));
    return {
        kind: 'similar',
        suggestions: scored.slice(0, MAX_CATEGORY_SUGGESTIONS).map((s) => s.category),
    };
}

/**
 * The autocomplete ranking for `GET /api/vendor/categories?q=`.
 *
 * Returns, in order: exact/alias matches, prefix matches on the key, substring
 * matches on the key, then typo suggestions. A category appears once. Pure, so the
 * ranking is testable without the list ever touching a database.
 */
export function searchCategories<C extends CategoryCandidate>(
    query: string,
    catalog: readonly C[],
    limit: number,
): Array<{ category: C; match: 'exact' | 'prefix' | 'contains' | 'similar' }> {
    const key = matchKey(query);
    if (key.length === 0) return [];
    const seen = new Set<string>();
    const out: Array<{ category: C; match: 'exact' | 'prefix' | 'contains' | 'similar' }> = [];
    const push = (category: C, match: 'exact' | 'prefix' | 'contains' | 'similar') => {
        if (seen.has(category.id) || out.length >= limit) return;
        seen.add(category.id);
        out.push({ category, match });
    };
    const byName = [...catalog].sort((a, b) => a.name.localeCompare(b.name));
    for (const c of byName) if (c.matchKey === key || c.aliasKeys.includes(key)) push(c, 'exact');
    for (const c of byName) if (c.matchKey.startsWith(key)) push(c, 'prefix');
    for (const c of byName) if (c.matchKey.includes(key)) push(c, 'contains');
    const verdict = matchCategory(query, catalog);
    if (verdict.kind === 'similar') for (const c of verdict.suggestions) push(c, 'similar');
    return out;
}
