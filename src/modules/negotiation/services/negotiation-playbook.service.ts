import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { NEGOTIATION_CONFIG } from '../config/negotiation.config';
import {
    NegotiationPlaybookRepository,
    PlaybookRecord,
    negotiationPlaybookRepository,
} from '../repositories/negotiation-playbook.repository';

interface CacheEntry {
    record: PlaybookRecord;
    expiresAt: number;
}

/**
 * Serves the live playbook to the bargaining sub-agent.
 *
 * ── It FAILS CLOSED, and that is the important property ──────────────────────
 *
 * When no playbook has been published there is no fallback — not to the file on
 * disk, not to a built-in default, not to an empty string. The request is refused
 * with `NEGOTIATION_PLAYBOOK_NOT_PUBLISHED` (503) and the automation layer hands
 * the conversation back to the main agent, so no bargaining happens.
 *
 * The alternative is worse than it looks. The sub-agent is given the vendor's real
 * floor in its context (the owner's decision), and the playbook is the entire set
 * of rules governing what it may do with that number. A model holding a floor and
 * no instructions is not a degraded bargainer; it is an unbounded one, negotiating
 * with somebody else's money. "No instructions" must therefore mean "do not
 * negotiate", never "improvise".
 *
 * A disk fallback was considered and rejected for a second reason: it would make
 * the file and the database two live sources, and the whole point of moving the
 * playbook into Mongo is that a dashboard edit is what takes effect.
 */
export class NegotiationPlaybookService {
    private readonly cache = new Map<string, CacheEntry>();

    constructor(private readonly repository: NegotiationPlaybookRepository = negotiationPlaybookRepository) {}

    /**
     * The live playbook, from cache when warm.
     *
     * @param key defaults to `NEGOTIATION_CONFIG.DEFAULT_PLAYBOOK_KEY`.
     * @throws 503 when nothing has been published under that key.
     */
    async resolve(key?: string): Promise<PlaybookRecord> {
        const resolvedKey = key?.trim() || NEGOTIATION_CONFIG.DEFAULT_PLAYBOOK_KEY;

        const cached = this.cache.get(resolvedKey);
        if (cached && cached.expiresAt > Date.now()) return cached.record;

        const record = await this.repository.findActive(resolvedKey);
        if (!record) {
            // Evict rather than serve a stale copy of something that has since been
            // withdrawn. A playbook that stops existing must stop being served.
            this.cache.delete(resolvedKey);
            throw createAppError(
                ERROR_CODES.NEGOTIATION_PLAYBOOK_NOT_PUBLISHED,
                503,
                undefined,
                { key: resolvedKey },
            );
        }

        this.cache.set(resolvedKey, {
            record,
            expiresAt: Date.now() + NEGOTIATION_CONFIG.PLAYBOOK_CACHE_TTL_SECONDS * 1000,
        });

        return record;
    }

    /**
     * Drop the in-process copy. Called by the seed so a publish in the same process
     * is visible immediately; the dashboard editor will want it too.
     */
    invalidate(key?: string): void {
        if (key) this.cache.delete(key);
        else this.cache.clear();
    }
}

export const negotiationPlaybookService = new NegotiationPlaybookService();
