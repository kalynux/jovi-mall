/**
 * verify:negotiation-lock — Stream A's resolver against a real database.
 *
 * `test:negotiation-lock` proves the verdict and the wiring offline. Three things
 * it structurally cannot reach are the reason this exists:
 *
 *   - the lock is found by its handle through the sparse `negotiation_lock_ref`
 *     index, on a real document Mongoose actually round-tripped;
 *   - the window re-read resolves against the LIVE catalogue, including the
 *     `isBargainEffective` gate that needs a real product and variant;
 *   - **a rolled-back checkout leaves the lock spendable** (plan D-12). That is a
 *     claim about MongoDB transaction semantics, and only a transaction can make it.
 *
 * Needs a running Mongo replica set (dev is `rs0`) and at least one bargainable
 * variant — `npm run seed:bargain-windows` if there is none.
 *
 * ⚠ Creates its own negotiation sessions and deletes them again. The customer and
 * user ids are synthetic: the resolver compares the id on the session against the
 * one presented, so no real customer needs to be touched to exercise every branch.
 * The VARIANT is real, because the window re-read is the half worth verifying.
 *
 * Run: npm run verify:negotiation-lock
 */
import 'dotenv/config';
import mongoose, { Types } from 'mongoose';

import { initializeNegotiationDomain } from '../../src/modules/negotiation/negotiation.bootstrap';
import {
    getNegotiatedPriceResolver,
    NegotiatedPriceContext,
} from '../../src/modules/catalog/domain/ports/negotiated-price.port';
import { NegotiationSessionModel } from '../../src/modules/negotiation/models/negotiation-session.model';
import { ProductModel } from '../../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../../src/modules/catalog/models/product-variant.model';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

let passed = 0;
let failed = 0;

function assert(label: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            passed += 1;
            console.log(`  ✅ ${label}`);
        })
        .catch((error: unknown) => {
            failed += 1;
            console.log(`  ❌ FAIL: ${label}`);
            console.log(`     ${error instanceof Error ? error.message : String(error)}`);
        });
}

function eq<T>(actual: T, expected: T, what: string): void {
    if (actual !== expected) {
        throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

/** Every session this run created, so the database is left as it was found. */
const created: Types.ObjectId[] = [];

interface Bargainable {
    productId: Types.ObjectId;
    variantId: Types.ObjectId;
    vendorId: Types.ObjectId;
    floor: number;
    ask: number;
}

/**
 * A real variant with an EFFECTIVE window.
 *
 * Effective is the same derivation the vendor dashboard reports as `bargainable`
 * (`isBargainEffective`), so this query and `LiveWindowReader` must agree: an
 * active product that is vectorisation-enabled, with an active variant carrying a
 * `bargain` window.
 */
async function findBargainable(): Promise<Bargainable | null> {
    const variants = await ProductVariantModel.find({
        status: 'active',
        deletedAt: null,
        bargain: { $ne: null },
    })
        .limit(25)
        .lean();

    for (const variant of variants) {
        const bargain = (variant as any).bargain;
        if (!bargain) continue;

        const product = await ProductModel.findOne({
            _id: (variant as any).productId,
            status: 'active',
            deletedAt: null,
            vectorisationEnabled: true,
        }).lean();
        if (!product) continue;

        return {
            productId: (variant as any).productId,
            variantId: (variant as any)._id,
            vendorId: (product as any).vendorId,
            floor: (variant as any).price,
            ask: bargain.maxPrice,
        };
    }
    return null;
}

/** Mint a session carrying a lock at `unitPrice`, expiring at `expiresAt`. */
async function mintLock(
    subject: Bargainable,
    customerId: Types.ObjectId,
    quantity: number,
    unitPrice: number,
    expiresAt: Date,
): Promise<string> {
    const ref = `nlk_verify_${new Types.ObjectId().toString()}`;
    const now = new Date();

    const [doc] = await NegotiationSessionModel.create([
        {
            user_id: new Types.ObjectId(),
            customer_id: customerId,
            product_id: subject.productId,
            variant_id: subject.variantId,
            vendor_id: subject.vendorId,
            quantity,
            currency: 'XAF',
            status: 'agreed',
            round: 1,
            turns: [],
            lock: {
                ref,
                unit_price: unitPrice,
                // Deliberately NOT the live floor: if the resolver ever returns the
                // stored snapshot instead of the live one, this makes it visible.
                floor_snapshot: Math.max(0, subject.floor - 1000),
                issued_at: now,
                expires_at: expiresAt,
                consumed_at: null,
                consumed_by_order_id: null,
            },
            floor_at_open: subject.floor,
            ask_at_open: subject.ask,
            expires_at: new Date(now.getTime() + 30 * 60_000),
        },
    ]);

    created.push(doc._id as Types.ObjectId);
    return ref;
}

async function main(): Promise<void> {
    console.log('\n══ verify:negotiation-lock — the resolver against a live database ══\n');

    await mongoose.connect(MONGO_URI);
    console.log(`  Connected to ${mongoose.connection.name}`);

    initializeNegotiationDomain();
    const resolver = getNegotiatedPriceResolver();
    console.log(`  Resolver: ${resolver.name}\n`);

    if (resolver.name !== 'negotiation') {
        console.error('  ✖ the negotiation resolver did not register — nothing below would be meaningful');
        process.exitCode = 1;
        return;
    }

    const subject = await findBargainable();
    if (!subject) {
        console.error(
            '  ✖ no variant with an EFFECTIVE bargain window in this database.\n'
            + '    The feature is inert without one. Run: npm run seed:bargain-windows',
        );
        process.exitCode = 1;
        return;
    }

    const agreed = Math.round((subject.floor + subject.ask) / 2);
    console.log(
        `  Subject: variant ${subject.variantId.toString()} — floor ${subject.floor}, `
        + `ask ${subject.ask}, agreeing at ${agreed}\n`,
    );

    const customerId = new Types.ObjectId();
    const ctx = (over: Partial<NegotiatedPriceContext> = {}): NegotiatedPriceContext => ({
        customerId: customerId.toString(),
        variantId: subject.variantId.toString(),
        quantity: 2,
        ...over,
    });

    const future = new Date(Date.now() + 15 * 60_000);
    const past = new Date(Date.now() - 60_000);

    console.log('── 1 · peek — the read-only check ──────────────────────────────────────');

    const liveRef = await mintLock(subject, customerId, 2, agreed, future);

    await assert('a real lock is found by its handle and honoured', async () => {
        const verdict = await resolver.peek(liveRef, ctx());
        if (!verdict.ok) throw new Error(`refused: ${verdict.reason}`);
        eq(verdict.unitPrice, agreed, 'unitPrice');
    });

    await assert('⭐ floorSnapshot is the LIVE floor, not the stored agreement-time one', async () => {
        // The fixture stores `floor - 1000`. Returning that would silently
        // over-report the platform's share of the uplift and under-pay the vendor.
        const verdict = await resolver.peek(liveRef, ctx());
        if (!verdict.ok) throw new Error(`refused: ${verdict.reason}`);
        eq(verdict.floorSnapshot, subject.floor, 'floorSnapshot');
    });

    await assert('peek WRITES NOTHING — the lock is still unspent afterwards (D-12)', async () => {
        await resolver.peek(liveRef, ctx());
        const doc = await NegotiationSessionModel.findOne({ 'lock.ref': liveRef }).lean();
        if ((doc as any)?.lock?.consumed_at != null) {
            throw new Error('peek burned the lock — a customer would lose their price by re-adding the line');
        }
    });

    await assert('an unknown handle is not_found', async () => {
        const verdict = await resolver.peek('nlk_does_not_exist', ctx());
        eq(verdict.ok ? 'ok' : verdict.reason, 'not_found', 'verdict');
    });

    await assert('⭐ another customer probing a REAL handle is told not_found', async () => {
        const verdict = await resolver.peek(liveRef, ctx({ customerId: new Types.ObjectId().toString() }));
        eq(verdict.ok ? 'ok' : verdict.reason, 'not_found', 'verdict');
    });

    await assert('a different quantity is mismatch', async () => {
        const verdict = await resolver.peek(liveRef, ctx({ quantity: 5 }));
        eq(verdict.ok ? 'ok' : verdict.reason, 'mismatch', 'verdict');
    });

    await assert('a different variant is mismatch', async () => {
        const verdict = await resolver.peek(liveRef, ctx({ variantId: new Types.ObjectId().toString() }));
        eq(verdict.ok ? 'ok' : verdict.reason, 'mismatch', 'verdict');
    });

    await assert('a lapsed lock is expired', async () => {
        const ref = await mintLock(subject, customerId, 2, agreed, past);
        const verdict = await resolver.peek(ref, ctx());
        eq(verdict.ok ? 'ok' : verdict.reason, 'expired', 'verdict');
    });

    console.log('\n── 2 · D-10 — the window as it stands now ──────────────────────────────');

    await assert('⭐ a lock below the CURRENT floor is window_moved, against real catalogue data', async () => {
        // What a vendor raising their floor mid-lock looks like from here: the
        // agreed price is now under the minimum they will accept.
        const ref = await mintLock(subject, customerId, 2, Math.max(0, subject.floor - 1), future);
        const verdict = await resolver.peek(ref, ctx());
        eq(verdict.ok ? 'ok' : verdict.reason, 'window_moved', 'verdict');
    });

    await assert('a lock above the CURRENT ask is window_moved too', async () => {
        const ref = await mintLock(subject, customerId, 2, subject.ask + 1, future);
        const verdict = await resolver.peek(ref, ctx());
        eq(verdict.ok ? 'ok' : verdict.reason, 'window_moved', 'verdict');
    });

    await assert('a lock on a variant with NO window is window_moved (the gate is live)', async () => {
        // A synthetic variant id has no window at all, which is the strongest form
        // of "the window moved" — and proves the reader is really being consulted.
        const ref = await mintLock(
            { ...subject, variantId: new Types.ObjectId() },
            customerId,
            2,
            agreed,
            future,
        );
        const doc = await NegotiationSessionModel.findOne({ 'lock.ref': ref }).lean();
        const verdict = await resolver.peek(ref, ctx({ variantId: (doc as any).variant_id.toString() }));
        eq(verdict.ok ? 'ok' : verdict.reason, 'window_moved', 'verdict');
    });

    console.log('\n── 3 · consume — inside a real transaction (D-12) ──────────────────────');

    await assert('⭐ a ROLLED-BACK checkout leaves the lock spendable', async () => {
        // The whole reason `consume` takes a ClientSession. If the burn escaped the
        // transaction, a failed checkout would cost the customer the price they
        // haggled for and there would be no order to show for it.
        const ref = await mintLock(subject, customerId, 2, agreed, future);
        const session = await mongoose.startSession();
        try {
            session.startTransaction();
            const verdict = await resolver.consume(ref, ctx(), session);
            if (!verdict.ok) throw new Error(`consume refused inside the transaction: ${verdict.reason}`);
            await session.abortTransaction();
        } finally {
            await session.endSession();
        }

        const doc = await NegotiationSessionModel.findOne({ 'lock.ref': ref }).lean();
        if ((doc as any)?.lock?.consumed_at != null) {
            throw new Error('the burn survived a rollback — the lock was spent on an order that does not exist');
        }

        const after = await resolver.peek(ref, ctx());
        if (!after.ok) throw new Error(`the lock is no longer spendable after a rollback: ${after.reason}`);
    });

    await assert('⭐ a COMMITTED consume burns the lock exactly once', async () => {
        const ref = await mintLock(subject, customerId, 2, agreed, future);
        const session = await mongoose.startSession();
        try {
            session.startTransaction();
            const verdict = await resolver.consume(ref, ctx(), session);
            if (!verdict.ok) throw new Error(`consume refused: ${verdict.reason}`);
            eq(verdict.unitPrice, agreed, 'unitPrice');
            eq(verdict.floorSnapshot, subject.floor, 'floorSnapshot');
            await session.commitTransaction();
        } finally {
            await session.endSession();
        }

        const doc = await NegotiationSessionModel.findOne({ 'lock.ref': ref }).lean();
        if ((doc as any)?.lock?.consumed_at == null) throw new Error('consumed_at was not written');
        eq((doc as any).status, 'closed', 'session status');

        // And it cannot be spent twice — the single-use property, end to end.
        const again = await resolver.peek(ref, ctx());
        eq(again.ok ? 'ok' : again.reason, 'consumed', 'second presentation');
    });

    await assert('a second consume of a spent lock refuses rather than double-charging', async () => {
        const ref = await mintLock(subject, customerId, 2, agreed, future);

        const first = await mongoose.startSession();
        try {
            first.startTransaction();
            await resolver.consume(ref, ctx(), first);
            await first.commitTransaction();
        } finally {
            await first.endSession();
        }

        const second = await mongoose.startSession();
        try {
            second.startTransaction();
            const verdict = await resolver.consume(ref, ctx(), second);
            eq(verdict.ok ? 'ok' : verdict.reason, 'consumed', 'verdict');
            await second.abortTransaction();
        } finally {
            await second.endSession();
        }
    });

    await assert('consume refuses a stranded lock WITHOUT burning it', async () => {
        // A window_moved refusal must leave the lock alone: the chat reopens the
        // negotiation, and a burned lock would make that impossible to honour.
        const ref = await mintLock(subject, customerId, 2, Math.max(0, subject.floor - 1), future);
        const session = await mongoose.startSession();
        try {
            session.startTransaction();
            const verdict = await resolver.consume(ref, ctx(), session);
            eq(verdict.ok ? 'ok' : verdict.reason, 'window_moved', 'verdict');
            await session.commitTransaction();
        } finally {
            await session.endSession();
        }

        const doc = await NegotiationSessionModel.findOne({ 'lock.ref': ref }).lean();
        if ((doc as any)?.lock?.consumed_at != null) {
            throw new Error('a refused consume burned the lock anyway');
        }
    });

    console.log(`\n${'═'.repeat(76)}\n  ${passed} passed, ${failed} failed\n${'═'.repeat(76)}\n`);
    if (failed > 0) process.exitCode = 1;
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        if (created.length > 0) {
            const result = await NegotiationSessionModel.deleteMany({ _id: { $in: created } });
            console.log(`  Cleaned up ${result.deletedCount} fixture session(s).`);
        }
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
