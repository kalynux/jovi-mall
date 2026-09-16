import { ClientSession } from 'mongoose';
import { AppReleaseModel, IAppRelease } from '../models/app-release.model';
import { AppKey } from '../app-distribution.types';

/**
 * Reads and writes over `app_releases`.
 *
 * The read half serves an unauthenticated route and is the only part this service calls at
 * runtime; the write half exists for `scripts/publish-app-release.ts` and is reachable from
 * no controller. Keeping both here rather than splitting them means the script and the reader
 * agree about `status` without either restating the rule.
 */
export class AppReleaseRepository {
    /**
     * The build a downloader should get: highest `versionCode` among published rows.
     *
     * ⚠ Ordered by `versionCode`, never by `publishedAt` — see the field's note on the model.
     * A rollback is published *after* the build it replaces and must not win on recency.
     */
    async findLatestPublished(app: AppKey): Promise<IAppRelease | null> {
        return AppReleaseModel
            .findOne({ app, status: 'published', deletedAt: null })
            .sort({ versionCode: -1 })
            .exec();
    }

    async findByVersionCode(app: AppKey, versionCode: number): Promise<IAppRelease | null> {
        return AppReleaseModel.findOne({ app, versionCode, deletedAt: null }).exec();
    }

    /** Every row for one app, newest first. The publish script's "what is already there". */
    async listForApp(app: AppKey): Promise<IAppRelease[]> {
        return AppReleaseModel.find({ app, deletedAt: null }).sort({ versionCode: -1 }).exec();
    }

    /**
     * ⚠ **`create` takes an ARRAY.** Mongoose reads `{ session }` only when the first argument
     * is an array — `create(doc, { session })` treats the options object as a SECOND DOCUMENT
     * and writes outside the transaction, silently. Same trap, and the same fix, as
     * `TrackingOutboxRepository.enqueue`; `test:tracking-outbox` § 2 pins the array form there
     * for exactly this reason.
     */
    async create(doc: Partial<IAppRelease>, session?: ClientSession): Promise<IAppRelease> {
        const [created] = await AppReleaseModel.create([doc], session ? { session } : {});
        return created;
    }

    /**
     * Demote every other published row for this app.
     *
     * Run inside the publishing transaction so "exactly one published row per app" is a state
     * the database passes through rather than one it converges on. It is not load-bearing for
     * the read — `findLatestPublished` sorts and takes one, so two published rows would still
     * answer correctly — which is the intended belt-and-braces: the invariant is maintained
     * here and not depended on there.
     */
    async supersedeOthers(app: AppKey, keepVersionCode: number, session?: ClientSession): Promise<number> {
        const result = await AppReleaseModel.updateMany(
            { app, status: 'published', versionCode: { $ne: keepVersionCode }, deletedAt: null },
            { $set: { status: 'superseded' } },
            session ? { session } : {},
        ).exec();
        return result.modifiedCount ?? 0;
    }
}

export const appReleaseRepository = new AppReleaseRepository();
