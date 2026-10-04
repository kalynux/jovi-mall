import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import {
    cleanCategoryName,
    matchCategory,
    matchKey,
    slugifyCategory,
    MAX_CATEGORIES_PER_PRODUCT,
    CategoryCandidate,
} from '../domain/category-match';
import { CategoryCreatedSource } from '../models/product-category.model';
import {
    productCategoryRepository,
    ProductCategoryRepository,
    ProductCategoryRow,
} from '../repositories/product-category.repository';
import { categoryCatalogCache, CategoryCatalogCache, CategoryRef } from './category-catalog.cache';

/**
 * One entry of a product write's `categories` array. Either a category the client
 * already has (from the autocomplete) or a name the vendor typed.
 */
export type CategoryInputRef =
    | { id: string }
    | { name: string; confirmNew?: boolean };

/** What `check` answers for one typed name — the "before saving" probe. */
export type CategoryNameVerdict =
    | { name: string; status: 'existing'; category: CategoryRef; via: 'name' | 'alias' }
    | { name: string; status: 'similar'; suggestions: CategoryRef[] }
    | { name: string; status: 'new'; displayName: string }
    | { name: string; status: 'invalid' };

export interface CategoryWriteContext {
    source: CategoryCreatedSource;
    vendorId: string | null;
}

function toRef(c: CategoryCandidate): CategoryRef {
    return { id: c.id, name: c.name, slug: c.slug };
}

function rowToCandidate(r: ProductCategoryRow): CategoryCandidate {
    return { id: r._id.toString(), name: r.name, slug: r.slug, matchKey: r.match_key, aliasKeys: r.alias_keys ?? [] };
}

function isDuplicateKey(err: unknown, field: string): boolean {
    const e = err as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
    if (e?.code !== 11000) return false;
    if (e.keyPattern) return Object.prototype.hasOwnProperty.call(e.keyPattern, field);
    return typeof e.message === 'string' && e.message.includes(field);
}

/**
 * Turns what a product write sent into category ids — the one door through which a
 * category can be CREATED by a vendor (owner decision C-2).
 *
 * Two phases, and the order is the whole contract:
 *
 *  1. **Judge everything, write nothing.** Every `{ id }` is checked live, every name
 *     cleaned and run through the matcher. If any name is only `similar` to an
 *     existing category and the vendor did not say `confirmNew`, the whole write is
 *     refused with `CATEGORY_SIMILAR_EXISTS` carrying every conflict at once — so the
 *     dashboard asks all its questions in one dialog, and a refused save never leaves
 *     half its new categories behind.
 *  2. **Create what is genuinely new.** Each creation re-matches against the list as
 *     it stands *after* the previous one, so "Shoe" and "Shoes" in one request make
 *     one category. A unique-index collision on `match_key` (another instance won a
 *     race) is answered by reusing the winner — a duplicate is never the outcome.
 *
 * Accepted cost, stated: categories are created BEFORE the product write, outside its
 * transaction. If the product write then fails, the new category stays, unused. It is
 * invisible on the storefront (the public list counts publishable products only), an
 * administrator can delete it (`CATEGORY_IN_USE` does not apply to it), and it is the
 * category the vendor will be offered again on their retry — which is the right answer.
 */
export class CategoryResolutionService {
    constructor(
        private readonly repo: ProductCategoryRepository = productCategoryRepository,
        private readonly cache: CategoryCatalogCache = categoryCatalogCache,
    ) {}

    /** The "before saving" probe — `POST /api/vendor/categories/check`. Writes nothing. */
    async check(names: string[]): Promise<CategoryNameVerdict[]> {
        const catalog = await this.cache.list();
        return names.map((raw): CategoryNameVerdict => {
            const cleaned = cleanCategoryName(raw);
            if (!cleaned) return { name: raw, status: 'invalid' };
            const verdict = matchCategory(cleaned, catalog);
            if (verdict.kind === 'exact') {
                return { name: raw, status: 'existing', category: toRef(verdict.category), via: verdict.via };
            }
            if (verdict.kind === 'similar') {
                return { name: raw, status: 'similar', suggestions: verdict.suggestions.map(toRef) };
            }
            return { name: raw, status: 'new', displayName: cleaned };
        });
    }

    /**
     * Resolve a product write's `categories` to ordered, de-duplicated ids.
     *
     * The order the vendor gave is kept; the first is the product's "primary"
     * category, which is what the deprecated single-value `category` field reports.
     */
    async resolveForWrite(refs: CategoryInputRef[], ctx: CategoryWriteContext): Promise<Types.ObjectId[]> {
        const catalog = await this.cache.list();

        type Planned = { kind: 'id'; id: string } | { kind: 'create'; name: string };
        const planned: Planned[] = [];
        const conflicts: Array<{ name: string; suggestions: CategoryRef[] }> = [];

        for (const ref of refs) {
            if ('id' in ref) {
                planned.push({ kind: 'id', id: await this.assertLiveId(ref.id) });
                continue;
            }
            const cleaned = cleanCategoryName(ref.name);
            if (!cleaned) {
                throw createAppError(ERROR_CODES.CATEGORY_NAME_INVALID, 400, undefined, { name: ref.name });
            }
            const verdict = matchCategory(cleaned, catalog);
            if (verdict.kind === 'exact') {
                planned.push({ kind: 'id', id: verdict.category.id });
            } else if (verdict.kind === 'similar' && ref.confirmNew !== true) {
                conflicts.push({ name: ref.name, suggestions: verdict.suggestions.map(toRef) });
            } else {
                planned.push({ kind: 'create', name: cleaned });
            }
        }

        if (conflicts.length > 0) {
            throw createAppError(ERROR_CODES.CATEGORY_SIMILAR_EXISTS, 422, undefined, { conflicts });
        }

        const ids: string[] = [];
        let created = false;
        // Names created in THIS request, so a later name in the same request can match
        // an earlier one even though the cache has not been reloaded.
        const createdHere: CategoryCandidate[] = [];
        for (const p of planned) {
            if (p.kind === 'id') {
                ids.push(p.id);
                continue;
            }
            const sibling = matchCategory(p.name, createdHere);
            if (sibling.kind === 'exact') {
                ids.push(sibling.category.id);
                continue;
            }
            const row = await this.createOrReuse(p.name, ctx);
            created = true;
            createdHere.push(rowToCandidate(row));
            ids.push(row._id.toString());
        }
        if (created) this.cache.invalidate();

        const unique = [...new Set(ids)];
        if (unique.length === 0 || unique.length > MAX_CATEGORIES_PER_PRODUCT) {
            // Unreachable through the validators (1–5 entries); kept so a future caller
            // that skips them cannot persist a product with no category.
            throw createAppError(ERROR_CODES.CATEGORY_NAME_INVALID, 400,
                `A product needs between 1 and ${MAX_CATEGORIES_PER_PRODUCT} categories`);
        }
        return unique.map((id) => new Types.ObjectId(id));
    }

    /**
     * Resolve ONE name with no one to ask — used by the data conversion (C-5).
     * A `similar` verdict is treated as the same category (its best suggestion),
     * because the alternative is a duplicate created by a script.
     */
    async resolveUnattended(rawName: string, ctx: CategoryWriteContext): Promise<{
        id: Types.ObjectId;
        outcome: 'existing' | 'similar' | 'created';
        name: string;
    } | null> {
        const cleaned = cleanCategoryName(rawName);
        if (!cleaned) return null;
        const catalog = await this.cache.list();
        const verdict = matchCategory(cleaned, catalog);
        if (verdict.kind === 'exact') {
            return { id: new Types.ObjectId(verdict.category.id), outcome: 'existing', name: verdict.category.name };
        }
        if (verdict.kind === 'similar') {
            const best = verdict.suggestions[0];
            return { id: new Types.ObjectId(best.id), outcome: 'similar', name: best.name };
        }
        const row = await this.createOrReuse(cleaned, ctx);
        this.cache.invalidate();
        return { id: row._id, outcome: 'created', name: row.name };
    }

    /**
     * Resolve a filter value from a URL or a chat — an id, a slug or a name — to a
     * live category, or `null`. A name resolves only on an EXACT verdict: a filter that
     * silently picked the nearest typo would show a shopper a shelf they did not ask
     * for. A merged-away id is followed to its survivor, so an old link still works.
     */
    async resolveFilter(value: string): Promise<CategoryRef | null> {
        const trimmed = value.trim();
        if (trimmed.length === 0) return null;
        if (/^[0-9a-fA-F]{24}$/.test(trimmed)) {
            const live = await this.cache.get(trimmed);
            if (live) return toRef(live);
            const any = await this.repo.findAnyById(trimmed);
            if (any?.merged_into) {
                const survivor = await this.cache.get(any.merged_into.toString());
                if (survivor) return toRef(survivor);
            }
            return null;
        }
        const bySlug = await this.cache.getBySlug(trimmed.toLowerCase());
        if (bySlug) return toRef(bySlug);
        const cleaned = cleanCategoryName(trimmed);
        if (!cleaned) return null;
        const verdict = matchCategory(cleaned, await this.cache.list());
        return verdict.kind === 'exact' ? toRef(verdict.category) : null;
    }

    private async assertLiveId(id: string): Promise<string> {
        if (!Types.ObjectId.isValid(id)) {
            throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, 404, undefined, { id });
        }
        if (await this.cache.get(id)) return id;
        // Created on another instance inside the cache TTL.
        const row = await this.repo.findLiveById(id);
        if (!row) throw createAppError(ERROR_CODES.CATEGORY_NOT_FOUND, 404, undefined, { id });
        return id;
    }

    /** Insert, or reuse whichever row won a race on the same key. */
    private async createOrReuse(name: string, ctx: CategoryWriteContext): Promise<ProductCategoryRow> {
        const key = matchKey(name);
        const existing = await this.repo.findLiveByMatchKey(key);
        if (existing) return existing;

        const base = slugifyCategory(name);
        for (let attempt = 0; attempt < 20; attempt++) {
            const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
            if (await this.repo.slugTaken(slug)) continue;
            try {
                return await this.repo.create({
                    name,
                    slug,
                    match_key: key,
                    created_source: ctx.source,
                    created_by_vendor_id: ctx.vendorId,
                });
            } catch (err) {
                if (isDuplicateKey(err, 'match_key')) {
                    const winner = await this.repo.findLiveByMatchKey(key);
                    if (winner) return winner;
                }
                if (isDuplicateKey(err, 'slug')) continue;
                throw err;
            }
        }
        // Twenty slug collisions on one base is not a real catalogue; fall back to a
        // slug that cannot collide rather than failing a product save over a URL.
        return this.repo.create({
            name,
            slug: `${base}-${new Types.ObjectId().toString().slice(-6)}`,
            match_key: key,
            created_source: ctx.source,
            created_by_vendor_id: ctx.vendorId,
        });
    }
}

export const categoryResolutionService = new CategoryResolutionService();
