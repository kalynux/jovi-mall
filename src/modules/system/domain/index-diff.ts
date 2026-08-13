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

export function normaliseIndex(key: Record<string, unknown>, options: RawSpec): NormalisedIndex {
    const opts = options ?? {};
    const orderedKey: Record<string, number | string> = {};
    for (const [field, direction] of Object.entries(key)) {
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
