import { Types } from 'mongoose';
import { INegotiationProfile, NegotiationProfileModel } from '../models/negotiation-profile.model';

/** What the service reads. Plain, never a Mongoose document, never a Map. */
export interface NegotiationProfileView {
    traits: Record<string, string | number | boolean>;
    sessions_started: number;
    sessions_agreed: number;
    last_session_at: Date | null;
}

const EMPTY: NegotiationProfileView = {
    traits: {},
    sessions_started: 0,
    sessions_agreed: 0,
    last_session_at: null,
};

/**
 * The durable customer negotiation profile.
 *
 * Every write is an idempotent upsert, because the profile is a side effect of a
 * conversation rather than something anybody creates: the first turn a customer
 * ever takes has to work without a registration step.
 */
export class NegotiationProfileRepository {
    /**
     * The profile, or an empty one.
     *
     * ⚠ Returns a **zeroed view rather than null**, and that is deliberate. The
     * service hands this straight to the model, and a `null` here would leave the
     * automation layer to decide what an absent profile means — which is exactly the
     * kind of decision that ends up implemented three different ways. "Never haggled
     * here" and "haggled and revealed nothing" are the same thing to the agent.
     */
    async findOrEmpty(customerId: string): Promise<NegotiationProfileView> {
        const doc = await NegotiationProfileModel.findOne({
            customer_id: new Types.ObjectId(customerId),
            deletedAt: null,
        }).lean();

        return doc ? toView(doc) : { ...EMPTY };
    }

    /**
     * Replace the model's traits wholesale.
     *
     * ⚠ **Replace, never merge.** A merge would keep a trait the model has since
     * stopped believing — a customer read as `demanding` in March would stay
     * `demanding` forever unless the model happened to send a contradicting value,
     * and "stopped mentioning it" is the normal way a judgement is withdrawn.
     */
    async replaceTraits(
        customerId: string,
        traits: Record<string, string | number | boolean>,
    ): Promise<void> {
        await NegotiationProfileModel.updateOne(
            { customer_id: new Types.ObjectId(customerId) },
            { $set: { traits } },
            { upsert: true },
        );
    }

    /** A session was opened. Counters are ours; the model never writes them. */
    async recordSessionStart(customerId: string): Promise<void> {
        await NegotiationProfileModel.updateOne(
            { customer_id: new Types.ObjectId(customerId) },
            { $inc: { sessions_started: 1 }, $set: { last_session_at: new Date() } },
            { upsert: true },
        );
    }

    /** A price was locked. */
    async recordAgreement(customerId: string): Promise<void> {
        await NegotiationProfileModel.updateOne(
            { customer_id: new Types.ObjectId(customerId) },
            { $inc: { sessions_agreed: 1 } },
            { upsert: true },
        );
    }
}

type ProfileFields = Pick<
    INegotiationProfile,
    'traits' | 'sessions_started' | 'sessions_agreed' | 'last_session_at'
>;

function toView(doc: ProfileFields): NegotiationProfileView {
    // A Mongoose `Map` survives `.lean()` as a plain object on modern drivers, but a
    // real Map on some paths. Normalising here is what keeps `JSON.stringify` in the
    // controller from emitting `{}` for a populated profile.
    const raw = doc.traits as unknown;
    const traits =
        raw instanceof Map
            ? (Object.fromEntries(raw) as Record<string, string | number | boolean>)
            : ((raw ?? {}) as Record<string, string | number | boolean>);

    return {
        traits,
        sessions_started: doc.sessions_started ?? 0,
        sessions_agreed: doc.sessions_agreed ?? 0,
        last_session_at: doc.last_session_at ?? null,
    };
}

export const negotiationProfileRepository = new NegotiationProfileRepository();
