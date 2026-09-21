import { ClientSession } from 'mongoose';
import { INegotiationPlaybook, NegotiationPlaybookModel } from '../models/negotiation-playbook.model';
import { ParsedPlaybook } from '../domain/playbook-document';
import { transactionManager } from '../../../core/database/transaction.manager';

/** What a reader gets. A lean projection — never the Mongoose document. */
export interface PlaybookRecord {
    key: string;
    version: number;
    description: string;
    compatibility?: string;
    content: string;
    checksum: string;
    updatedAt: Date;
}

/**
 * Reads and publishes negotiation playbooks.
 *
 * Two operations, and only one of them writes. `publish` is the append-and-demote
 * that both the seed and (later) the dashboard editor go through — there is
 * deliberately no `update`, because the version history is the point and an
 * in-place edit would erase the row that was live when a price was agreed.
 */
export class NegotiationPlaybookRepository {
    /** The live playbook for a key, or null when none has been published. */
    async findActive(key: string): Promise<PlaybookRecord | null> {
        const doc = await NegotiationPlaybookModel.findOne({
            key,
            status: 'active',
            deletedAt: null,
        }).lean();

        return doc ? toRecord(doc) : null;
    }

    /** The current version number for a key, or 0 when it has never been published. */
    async latestVersion(key: string): Promise<number> {
        const doc = await NegotiationPlaybookModel.findOne({ key })
            .sort({ version: -1 })
            .select('version')
            .lean();

        return doc?.version ?? 0;
    }

    /**
     * Publish a parsed playbook as the new active version.
     *
     * ⚠ **The demote and the insert are ONE transaction, and they have to be.**
     * `playbook_one_active_per_key` is a unique partial index, so inserting the new
     * active row before demoting the old one is refused outright — and demoting
     * first without a transaction leaves a window where the key has NO active row,
     * during which every bargaining turn is refused. A crash inside that window
     * would leave it that way permanently, and the symptom (bargaining silently
     * stops working) points at nothing.
     *
     * Returns null when `checksum` already matches the live row: re-running the
     * seed against an unchanged file must not mint a version nobody authored.
     */
    async publish(
        parsed: ParsedPlaybook,
        source: 'seed' | 'dashboard',
    ): Promise<PlaybookRecord | null> {
        const key = parsed.frontmatter.name;

        const live = await this.findActive(key);
        if (live && live.checksum === parsed.checksum) return null;

        const nextVersion = (await this.latestVersion(key)) + 1;

        // RETRYING, because the first write to a fresh database can race the collection's own
        // creation and MongoDB answers that with "please retry" (a TransientTransactionError).
        // Safe to re-run: an aborted attempt leaves nothing behind, and `nextVersion` is fixed above.
        return transactionManager.runInTransactionWithRetry(async (session: ClientSession) => {
            await NegotiationPlaybookModel.updateMany(
                { key, status: 'active' },
                { $set: { status: 'superseded' } },
                { session },
            );

            // ⚠ ARRAY form. Mongoose reads `{ session }` only when the first argument
            // is an array — `create(doc, { session })` writes OUTSIDE the transaction
            // and produces exactly the half-applied state this method exists to
            // prevent. The same trap `TrackingOutboxRepository.enqueue` documents.
            await NegotiationPlaybookModel.create(
                [
                    {
                        key,
                        version: nextVersion,
                        status: 'active',
                        description: parsed.frontmatter.description,
                        compatibility: parsed.frontmatter.compatibility,
                        frontmatter_extra: parsed.frontmatter.extra,
                        content: parsed.content,
                        checksum: parsed.checksum,
                        source,
                    },
                ],
                { session },
            );

            // Built from what was just written rather than read back: the transaction
            // has not committed, so a read here would either see nothing or need the
            // session threaded into it for no gain.
            return {
                key,
                version: nextVersion,
                description: parsed.frontmatter.description,
                ...(parsed.frontmatter.compatibility
                    ? { compatibility: parsed.frontmatter.compatibility }
                    : {}),
                content: parsed.content,
                checksum: parsed.checksum,
                updatedAt: new Date(),
            };
        });
    }
}

/**
 * The fields `toRecord` reads, and nothing else.
 *
 * `Pick` rather than `INegotiationPlaybook` because that interface extends Mongoose's
 * `Document`, and a `.lean()` result is `FlattenMaps<...>` — structurally incompatible
 * with the Document internals it does not carry. Picking the seven fields makes the
 * function take what it actually needs, so a lean read and a hydrated one both satisfy
 * it without a cast.
 */
type PlaybookFields = Pick<
    INegotiationPlaybook,
    'key' | 'version' | 'description' | 'compatibility' | 'content' | 'checksum' | 'updatedAt'
>;

function toRecord(doc: PlaybookFields): PlaybookRecord {
    return {
        key: doc.key,
        version: doc.version,
        description: doc.description,
        ...(doc.compatibility ? { compatibility: doc.compatibility } : {}),
        content: doc.content,
        checksum: doc.checksum,
        updatedAt: doc.updatedAt,
    };
}

export const negotiationPlaybookRepository = new NegotiationPlaybookRepository();
