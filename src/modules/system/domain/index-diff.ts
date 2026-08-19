/**
 * Comparing the indexes a model DECLARES against the ones the database actually HAS.
 *
 * ── Why this read earns its place ─────────────────────────────────────────────
 * `autoIndex` is on in this service, and a failed index build **fails silently at boot** —
 * several model headers say so, and so does CLAUDE.md. Until now the only detector was
 * `verify:live-parity`, which covers a handful of models and needs someone to run it. A missing
 * unique index does not throw; it lets a duplicate through, months later, in a collection nobody
 * was watching.
 *
 * ── The canonical shape is deliberately NARROW ────────────────────────────────
 * `background`, `v`, `ns`, `2dsphereIndexVersion`, generated names and default collations differ
 * between what Mongoose declares and what MongoDB reports, harmlessly, on almost every index. A
 * diff that reported those would be a wall of noise — and a report nobody reads is worth less
 * than no report, because it also carries the ones that matter. Start narrow; widen only when a
 * real drift is proven to hide in a field that is not compared.
 *
 * Pure and DB-free so `test:system` can drive it from literals.
 */

export interface NormalisedIndex {
    /** Ordered key spec. Order is part of the identity of a compound index. */
    key: Record<string, number | string>;
    unique: boolean;
    sparse: boolean;
    partialFilterExpression: string | null;
    expireAfterSeconds: number | null;
    /** Reported for legibility; never compared — MongoDB generates one if you do not. */
    name: string | null;
}

export interface IndexDrift {
    /** Declared in the schema, absent from the database. **The actionable bucket.** */
    missing: NormalisedIndex[];
    /** Present in the database, declared nowhere. Usually migration residue. */
    extra: NormalisedIndex[];
    /** Same key, different options — a "unique" index that is not unique in production. */
    mismatched: Array<{ key: Record<string, number | string>; declared: NormalisedIndex; live: NormalisedIndex }>;
}

type RawSpec = Record<string, unknown> | undefined | null;

/**
 * A `$text` index is REPORTED in a different shape than it is DECLARED, and comparing the two
 * verbatim reports a false `missing` plus a false `extra` for every one of them, forever.
 *
 * A schema declares `{ title: 'text', tags: 'text', description: 'text' }`. `listIndexes()`
 * answers with the internal sentinel `{ _fts: 'text', _ftsx: 1 }` and puts the real fields in a
 * sibling `weights` document — alphabetised, and therefore in a different order from the
 * declaration as well. So both halves of the identity disagree.
 *
 * This was live: `products` carries the one `$text` index in this codebase, `verify:storefront`
 * proves it exists, and `GET /system/database` reported it as missing. It surfaced when plan
 * step 2.C.4 put this diff on the boot path — a warning that is always wrong is worse than no
 * warning, because it is what teaches an operator to skip the one that is right.
 *
 * Both sides are rewritten to the same canonical form: the text fields, **sorted**, each mapped
 * to `'text'`, in the position the sentinel occupied. Sorting is correct here specifically
 * because a text index has no prefix semantics — unlike a compound b-tree index, where key order
 * IS the identity and `indexIdentity` must keep it.
 *
 * Field WEIGHTS are deliberately not compared, consistent with the narrowness this file argues
 * for elsewhere: a re-weighted text index is a relevance change, not a missing constraint.
 */
function canonicaliseTextKey(
    key: Record<string, unknown>,
    options: Record<string, unknown>,
): Record<string, unknown> {
    // The LIVE shape: expand the sentinel back into the fields `weights` names.
    if (key._fts === 'text') {
        const weights = options.weights;
        if (!weights || typeof weights !== 'object') return key;
        const out: Record<string, unknown> = {};
        for (const [field, direction] of Object.entries(key)) {
            if (field === '_ftsx') continue;
            if (field === '_fts') {
                for (const weighted of Object.keys(weights as Record<string, unknown>).sort()) {
                    out[weighted] = 'text';
                }
                continue;
            }
            out[field] = direction;
        }
        return out;
    }

    // The DECLARED shape: sort the text-valued fields so it matches the expansion above.
    const textFields = Object.keys(key).filter((field) => key[field] === 'text');
    if (textFields.length === 0) return key;

    const sorted = [...textFields].sort();
    const out: Record<string, unknown> = {};
    let taken = 0;
    for (const field of Object.keys(key)) {
        if (key[field] === 'text') {
            out[sorted[taken]] = 'text';
            taken += 1;
        } else {
            out[field] = key[field];
        }
    }
    return out;
}

export function normaliseIndex(key: Record<string, unknown>, options: RawSpec): NormalisedIndex {
    const opts = options ?? {};
    const orderedKey: Record<string, number | string> = {};
    for (const [field, direction] of Object.entries(canonicaliseTextKey(key, opts))) {
        orderedKey[field] = typeof direction === 'number' || typeof direction === 'string'
            ? direction
            : Number(direction);
    }

    return {
        key: orderedKey,
        unique: opts.unique === true,
        sparse: opts.sparse === true,
        // Stringified so a nested filter compares structurally without a deep-equal helper.
        // Key order inside the filter is stable because it comes from one declaration site.
        partialFilterExpression: opts.partialFilterExpression
            ? JSON.stringify(opts.partialFilterExpression)
            : null,
        expireAfterSeconds:
            typeof opts.expireAfterSeconds === 'number' ? opts.expireAfterSeconds : null,
        name: typeof opts.name === 'string' ? opts.name : null,
    };
}

/**
 * The identity of an index, for matching declared against live.
 *
 * **Key ORDER is significant** — `{a:1,b:1}` and `{b:1,a:1}` are different indexes with
 * different prefix behaviour, and treating them as one would report "no drift" for a genuinely
 * missing index. So this serialises in declaration order rather than sorting.
 */
export function indexIdentity(index: NormalisedIndex): string {
    return Object.entries(index.key)
        .map(([field, direction]) => `${field}:${direction}`)
        .join(',');
}

function sameOptions(a: NormalisedIndex, b: NormalisedIndex): boolean {
    return a.unique === b.unique
        && a.sparse === b.sparse
        && a.partialFilterExpression === b.partialFilterExpression
        && a.expireAfterSeconds === b.expireAfterSeconds;
}

export function diffIndexes(
    declared: NormalisedIndex[],
    live: NormalisedIndex[],
): IndexDrift {
    /**
     * `_id_` is never reported. MongoDB creates it unconditionally and no schema declares it, so
     * it would appear as `extra` on all 182 collections — one guaranteed false positive per
     * collection is exactly the noise that gets a report ignored.
     */
    const liveReal = live.filter((index) => indexIdentity(index) !== '_id:1');

    const declaredBy = new Map(declared.map((index) => [indexIdentity(index), index]));
    const liveBy = new Map(liveReal.map((index) => [indexIdentity(index), index]));

    const missing: NormalisedIndex[] = [];
    const extra: NormalisedIndex[] = [];
    const mismatched: IndexDrift['mismatched'] = [];

    for (const [identity, declaredIndex] of declaredBy) {
        const liveIndex = liveBy.get(identity);
        if (!liveIndex) {
            missing.push(declaredIndex);
        } else if (!sameOptions(declaredIndex, liveIndex)) {
            mismatched.push({ key: declaredIndex.key, declared: declaredIndex, live: liveIndex });
        }
    }

    for (const [identity, liveIndex] of liveBy) {
        if (!declaredBy.has(identity)) extra.push(liveIndex);
    }

    return { missing, extra, mismatched };
}
