import { Schema, model } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * The bargaining agent's playbook — the instructions served to the negotiation
 * sub-agent as its system prefix.
 *
 * ── Why the database rather than the file on disk ────────────────────────────
 *
 * The playbook is authored as a SKILL.md in git (`../playbook/`), which is what
 * makes it reviewable and diffable. The DATABASE is what the running service
 * reads, so the wording can be changed from a dashboard without a deploy — prompt
 * tuning is an iterate-and-measure loop, and a release cycle per sentence is how
 * that loop stops happening.
 *
 * The file therefore SEEDS this collection (`npm run seed:negotiation-playbook`)
 * and is never read at request time. One direction only: nothing writes back to
 * the file, so a dashboard edit and a git edit cannot silently diverge into two
 * live copies — the seed is an explicit act that supersedes whatever is live.
 *
 * ── Append-only versions, one active row ─────────────────────────────────────
 *
 * A change writes a NEW row at `version + 1` and demotes the previous one to
 * `superseded`; nothing is ever updated in place. That buys the history for free,
 * which matters more here than for most configuration: this document is the only
 * thing standing between a model that knows a vendor's floor and a bad price, so
 * "what were the instructions on the day of that sale" is a question somebody
 * will eventually ask.
 *
 * `playbook_one_active_per_key` is a PARTIAL unique index rather than application
 * code, for the reason every uniqueness rule in this codebase is an index: a
 * service-level check is a race, and two active rows means the reader picks one
 * arbitrarily and the two halves of a deploy disagree about what the agent was
 * told.
 *
 * ── What is deliberately NOT here yet ────────────────────────────────────────
 *
 * No actor stamp. Editing is a dashboard feature that does not exist, and the
 * columns it needs (`actorStampFields()` from `core/types/actor-source.types.ts`,
 * because an administrator holds no `users` row here) should be added by the
 * change that introduces the writer — added now they would be null on every row
 * and prove nothing. `source` records where a row came from, which is the part
 * that is already true.
 */
export interface INegotiationPlaybook extends IBaseDocument {
    /**
     * Stable identifier, taken from the authored file's frontmatter `name`
     * (`market-vendor-negotiation`). The reader addresses a playbook by this, never
     * by id — an id would have to change on every version.
     */
    key: string;
    /** 1-based, monotonic per `key`. Never reused, never renumbered. */
    version: number;
    /** Exactly one `active` row per key; everything else is history. */
    status: 'active' | 'superseded';

    /** Frontmatter `description` — for the dashboard's list view. Never sent to a model. */
    description: string;
    /** Frontmatter `compatibility` — the tools the body assumes. Advisory prose. */
    compatibility?: string;
    /** Any other frontmatter key, preserved verbatim so a seed cannot drop one. */
    frontmatter_extra?: Record<string, string>;

    /**
     * The markdown body — the string handed to the sub-agent, verbatim.
     *
     * ⚠ It goes into the SYSTEM position of the model request and must therefore be
     * byte-identical across turns, or Anthropic prompt caching never hits and every
     * bargaining turn pays full price for the whole playbook. Nothing may
     * interpolate a customer, a product or a price into it.
     */
    content: string;

    /**
     * `sha256(content)` over LF line endings (`domain/playbook-document.ts`).
     * The seed compares it to decide whether there is anything to write at all, so
     * re-running against an unchanged file is a no-op rather than a new version.
     */
    checksum: string;

    /** Where this row came from. `dashboard` is reserved for the editor. */
    source: 'seed' | 'dashboard';
}

const NegotiationPlaybookSchema = new Schema<INegotiationPlaybook>(
    {
        key: { type: String, required: true, trim: true },
        version: { type: Number, required: true, min: 1 },
        status: {
            type: String,
            enum: ['active', 'superseded'],
            required: true,
            default: 'active',
        },

        description: { type: String, required: true },
        compatibility: { type: String },
        // `Mixed`-free: a flat string map, so an unexpected frontmatter key is
        // preserved without giving anybody a place to store a nested structure the
        // parser cannot produce.
        frontmatter_extra: { type: Map, of: String },

        content: { type: String, required: true },
        checksum: { type: String, required: true },

        source: { type: String, enum: ['seed', 'dashboard'], required: true, default: 'seed' },

        ...BaseSchemaFields,
    },
    BaseSchemaOptions,
);

/** History for one playbook, newest first. */
NegotiationPlaybookSchema.index({ key: 1, version: -1 });

/**
 * One active row per key — the invariant the reader depends on.
 *
 * Partial rather than plain, because every superseded row shares the same `key`
 * and a plain unique index could not be built at all past the first version.
 */
NegotiationPlaybookSchema.index(
    { key: 1 },
    {
        unique: true,
        partialFilterExpression: { status: 'active' },
        name: 'playbook_one_active_per_key',
    },
);

export const NegotiationPlaybookModel = model<INegotiationPlaybook>(
    MODELS.NEGOTIATION_PLAYBOOK,
    NegotiationPlaybookSchema,
    COLLECTIONS.NEGOTIATION_PLAYBOOK,
);
