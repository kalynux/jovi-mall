import { CategoryCandidate } from '../domain/category-match';
import { productCategoryRepository, ProductCategoryRepository } from '../repositories/product-category.repository';

/** What a product read needs to render one of its categories. */
export interface CategoryRef {
    id: string;
    name: string;
    slug: string;
}

export interface CategoryEntry extends CategoryCandidate {
    createdAt: Date;
}

/** How long a loaded list is trusted before it is re-read. */
const TTL_MS = 60_000;

/**
 * The live category list, held IN PROCESS.
 *
 * Why not a query per lookup: the matcher's typo check compares a name against every
 * category, so it needs the whole list on every product save anyway, and at the
 * expected size (hundreds to low thousands) one cached array is cheaper than any
 * query shape that could answer "anything within two edits of this". Revisit at
 * roughly 10 000 categories (PRODUCT-CATEGORIES-PLAN.md).
 *
 * Why it is safe to be stale: the matcher is a pre-check. The partial unique index
 * on `match_key` is the guarantee, and `CategoryResolutionService` turns an E11000
 * into "reuse the row that won" — so a list sixty seconds behind another instance
 * can, at worst, ask a vendor a question one instance would not have. Local writes
 * `invalidate()` immediately, so the instance that wrote never sees its own past.
 *
 * Name resolution for product reads also goes through here (`refsFor`), which is
 * what lets products store ids alone: a rename is one row, not a catalogue rewrite.
 */
export class CategoryCatalogCache {
    private entries: CategoryEntry[] | null = null;
    private byId = new Map<string, CategoryEntry>();
    private loadedAt = 0;
    private inflight: Promise<CategoryEntry[]> | null = null;

    constructor(private readonly repo: ProductCategoryRepository = productCategoryRepository) {}

    invalidate(): void {
        this.entries = null;
        this.byId.clear();
        this.loadedAt = 0;
    }

    async list(): Promise<CategoryEntry[]> {
        if (this.entries && Date.now() - this.loadedAt < TTL_MS) return this.entries;
        if (this.inflight) return this.inflight;
        this.inflight = (async () => {
            try {
                const rows = await this.repo.listLive();
                const entries: CategoryEntry[] = rows.map((r) => ({
                    id: r._id.toString(),
                    name: r.name,
                    slug: r.slug,
                    matchKey: r.match_key,
                    aliasKeys: r.alias_keys ?? [],
                    createdAt: r.createdAt,
                }));
                this.entries = entries;
                this.byId = new Map(entries.map((e) => [e.id, e]));
                this.loadedAt = Date.now();
                return entries;
            } finally {
                this.inflight = null;
            }
        })();
        return this.inflight;
    }

    async get(id: string): Promise<CategoryEntry | null> {
        await this.list();
        return this.byId.get(id) ?? null;
    }

    async getBySlug(slug: string): Promise<CategoryEntry | null> {
        const list = await this.list();
        return list.find((e) => e.slug === slug) ?? null;
    }

    /**
     * Resolve a product's stored ids to display refs, in the product's own order.
     *
     * An id the list does not know is DROPPED rather than rendered as a blank chip.
     * That only happens inside the TTL window after another instance created a
     * category, or after a category a product still held was deleted — and delete is
     * refused while any live product holds one (`CATEGORY_IN_USE`), so in practice
     * this is the first case, and a missing chip for under a minute is the honest cost.
     * One re-read is attempted first so the common case of a brand-new category does
     * not even pay that.
     */
    async refsFor(ids: ReadonlyArray<string | { toString(): string }> | null | undefined): Promise<CategoryRef[]> {
        if (!ids || ids.length === 0) return [];
        await this.list();
        const wanted = ids.map((id) => id.toString());
        if (wanted.some((id) => !this.byId.has(id)) && Date.now() - this.loadedAt > 1_000) {
            this.invalidate();
            await this.list();
        }
        const out: CategoryRef[] = [];
        for (const id of wanted) {
            const entry = this.byId.get(id);
            if (entry) out.push({ id: entry.id, name: entry.name, slug: entry.slug });
        }
        return out;
    }

    /** The many-products form of `refsFor`, one list load for the whole page. */
    async refsForMany(
        idLists: ReadonlyArray<ReadonlyArray<string | { toString(): string }> | null | undefined>,
    ): Promise<CategoryRef[][]> {
        return Promise.all(idLists.map((ids) => this.refsFor(ids)));
    }
}

export const categoryCatalogCache = new CategoryCatalogCache();
