/**
 * Dev helper: dump what the vectoriser would actually be sent, for REAL products.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The n8n `wi-mall-vectoriser` workflow was first exercised against hand-written
 * fixtures. Fixtures prove the code path; they cannot prove the SHAPE, because
 * the person who wrote the fixture and the person who wrote the payload builder
 * were the same, working from the same assumption. A real vendor's product is
 * the only thing that can disagree with `buildPayload`.
 *
 * So this calls the production `VectorisationService.buildPayload` — not a copy
 * of it, not a re-derivation from the model — and writes the result to a file.
 * That file is byte-for-byte what `POST <VECTORISER_BASE_URL>` would receive.
 *
 * It also prints what a human needs to judge the sample: which types are
 * present, how many variants each product has, and whether the fields the
 * embedded text leans on (description, category, tags, images, bargain window)
 * are actually populated. An indexer tested only against fully-filled products
 * is an indexer nobody has tested.
 *
 * ── It only ever READS ───────────────────────────────────────────────────────
 *
 * No status is written, no credit is debited, nothing is enqueued, and the
 * vectoriser is never called. It is not registered in `scripts/migrate.ts` and
 * must never be: it changes nothing, so there is nothing to ledger.
 *
 * Run:
 *   npx ts-node scripts/dev-dump-vectoriser-payloads.ts
 *   npx ts-node scripts/dev-dump-vectoriser-payloads.ts --limit 8 --out ./payloads.json
 *   npx ts-node scripts/dev-dump-vectoriser-payloads.ts --status any   (include drafts)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { writeFileSync } from 'fs';
import { ProductModel } from '../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../src/modules/catalog/models/product-variant.model';
import { vectorisationService } from '../src/modules/catalog/domain/services/VectorisationService';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
}

const LIMIT = parseInt(arg('limit') ?? '8', 10);
const OUT = arg('out') ?? './vectoriser-payloads.json';
const STATUS = arg('status') ?? 'active';

/**
 * Pick a spread rather than the first N.
 *
 * Taking `.limit(8)` off an unsorted find returns eight products from one
 * vendor with one shape, which is the sample most likely to pass and least
 * likely to teach anything. This takes every product TYPE present first — so a
 * lone digital product cannot be crowded out by two dozen physical ones — and
 * only then fills the remainder, preferring products with the most variants,
 * because a multi-variant product exercises the option-axis and price-range
 * branches that a single-variant one never reaches.
 */
async function pickProductIds(): Promise<string[]> {
    const filter: Record<string, unknown> = { deletedAt: null };
    if (STATUS !== 'any') filter.status = STATUS;

    const products = await ProductModel.find(filter).select('_id type title').lean();
    if (products.length === 0) return [];

    const variantCounts = await ProductVariantModel.aggregate([
        { $match: { status: 'active', deletedAt: null } },
        { $group: { _id: '$productId', n: { $sum: 1 } } },
    ]);
    const variantsById = new Map<string, number>(
        variantCounts.map((row: { _id: mongoose.Types.ObjectId; n: number }) => [row._id.toString(), row.n]),
    );

    const byType = new Map<string, Array<{ id: string; variants: number }>>();
    for (const p of products) {
        const id = p._id.toString();
        const entry = { id, variants: variantsById.get(id) ?? 0 };
        const bucket = byType.get(p.type) ?? [];
        bucket.push(entry);
        byType.set(p.type, bucket);
    }
    for (const bucket of byType.values()) {
        bucket.sort((a, b) => b.variants - a.variants || a.id.localeCompare(b.id));
    }

    // One pass per type, round-robin, richest first. Deterministic: a re-run
    // against unchanged data selects the same eight, so a difference in the
    // output is a difference in the DATA and not in the sampler.
    const picked: string[] = [];
    const types = [...byType.keys()].sort();
    let round = 0;
    while (picked.length < LIMIT) {
        let addedThisRound = false;
        for (const type of types) {
            if (picked.length >= LIMIT) break;
            const bucket = byType.get(type)!;
            if (round < bucket.length) {
                picked.push(bucket[round].id);
                addedThisRound = true;
            }
        }
        if (!addedThisRound) break;
        round += 1;
    }
    return picked;
}

async function main() {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected to ${mongoose.connection.name}`);

    const ids = await pickProductIds();
    if (ids.length === 0) {
        console.log(`No products matched (status=${STATUS}).`);
        await mongoose.disconnect();
        return;
    }

    const payloads = [];
    for (const id of ids) {
        const payload = await vectorisationService.buildPayload(id);
        if (!payload) {
            console.log(`  ${id}  — buildPayload returned null, skipped`);
            continue;
        }
        payloads.push(payload);
    }

    writeFileSync(OUT, JSON.stringify({ products: payloads }, null, 2), 'utf8');

    console.log(`\n${payloads.length} payload(s) → ${OUT}\n`);
    console.log(
        'type      variants  desc  cat  tags  imgs  bargain  title',
    );
    for (const p of payloads) {
        const variants = p.variants ?? [];
        const bargain = variants.some((v) => (v as Record<string, unknown>).bargain);
        const row = [
            (p.type ?? '?').padEnd(9),
            String(variants.length).padEnd(9),
            (p.description ? 'yes' : 'NO ').padEnd(5),
            (p.category ? 'yes' : 'NO ').padEnd(4),
            String((p.tags ?? []).length).padEnd(5),
            String((p.images ?? []).length).padEnd(5),
            (bargain ? 'yes' : 'no ').padEnd(8),
            p.title,
        ].join(' ');
        console.log(row);
    }

    const missing = payloads.filter((p) => !p.description || !p.category);
    if (missing.length > 0) {
        console.log(
            `\n⚠ ${missing.length} of ${payloads.length} are missing a description or a category.` +
            `\n  Those are the products whose embedded text will be thin, and they are the ones` +
            `\n  worth reading in the debug table.`,
        );
    }

    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
});
