/**
 * verify:role-closure — the whole lifecycle against REAL Mongo (ADR-A10).
 *
 * NEEDS A REPLICA SET (the confirm is one transaction). Its subject is what the DB-free
 * `test:role-closure` structurally cannot see: that every raw update in the manifest is one
 * Mongo actually accepts and applies (`$[]` on the depot contacts, `$unset` of required
 * sub-documents, the `$pull` of the role), that the request's compare-and-set really admits
 * exactly one of two concurrent confirms, and that the partial unique index binds.
 *
 * It builds its own world from fresh ObjectIds and deletes it, pass or fail, so it touches no
 * real party. Point it at a scratch database:
 *
 *   MONGO_URI="mongodb://127.0.0.1:27117/jovi_rc_verify?replicaSet=rc0" npm run verify:role-closure
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { Types } from 'mongoose';
import { COLLECTIONS } from '../../src/core/database/collections';
import { RoleClosureRequestModel } from '../../src/modules/role-closure/models/role-closure-request.model';
import { RoleClosureService } from '../../src/modules/role-closure/services/role-closure.service';
import { ActorRef } from '../../src/core/types/actor-source.types';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

let passed = 0;
let failed = 0;
async function assert(name: string, fn: () => Promise<boolean> | boolean): Promise<void> {
    try {
        if (await fn()) { console.log(`  ✅ ${name}`); passed++; } else { console.error(`  ❌ FAIL: ${name}`); failed++; }
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
    }
}
async function refusedWith(code: string, fn: () => Promise<unknown>): Promise<boolean> {
    try { await fn(); return false; } catch (err) {
        const got = (err as { code?: string }).code;
        if (got !== code) console.error(`      expected ${code}, got ${got}: ${(err as Error).message}`);
        return got === code;
    }
}

const db = () => mongoose.connection.db!;
const col = (name: string) => db().collection(name);
const oid = () => new Types.ObjectId();
const created: Array<{ collection: string; id: Types.ObjectId }> = [];
async function insert(collection: string, doc: Record<string, unknown>): Promise<Types.ObjectId> {
    const _id = (doc._id as Types.ObjectId) ?? oid();
    await col(collection).insertOne({ ...doc, _id, created_at: new Date(), updated_at: new Date() });
    created.push({ collection, id: _id });
    return _id;
}

const ADMIN: ActorRef = { userId: oid().toString(), source: 'admin', name: 'Verify Admin' };
const service = new RoleClosureService();

async function user(roles: string[], email: string): Promise<Types.ObjectId> {
    return insert(COLLECTIONS.USER, {
        login_email: email, login_phone: `+2376${Math.floor(10000000 + Math.random() * 89999999)}`,
        password_hash: '$2b$12$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvwxyzABCDE', roles, status: 'active',
    });
}

async function main(): Promise<void> {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected to ${MONGO_URI.replace(/\/\/[^@]*@/, '//***@')}`);
    // The partial unique index is what § 4 proves binds — build it as the migration does.
    await col(COLLECTIONS.ROLE_CLOSURE_REQUEST).createIndex(
        { user_id: 1, role: 1 },
        { name: 'role_closure_one_pending_per_role', unique: true, partialFilterExpression: { status: 'pending' } },
    );

    try {
        // ── World ───────────────────────────────────────────────────────────────
        const vendorUser = await user(['customer', 'vendor'], `rc-vendor-${Date.now()}@verify.test`);
        const customerOfVendor = await insert(COLLECTIONS.CUSTOMER, { user_id: vendorUser, name: 'Vee Customer', status: 'active' });
        const vendorId = await insert(COLLECTIONS.VENDOR, {
            user_id: vendorUser, display_name: 'Vee', email: `shop-${Date.now()}@verify.test`, phone: '+237600000001',
            status: 'active', payout_details: [{ type: 'mobile_money', phone_number: '+237600000001', account_name: 'Vee' }],
        });
        const storeId = await insert(COLLECTIONS.STORE, { vendor_id: vendorId, name: 'Vee Shop', slug: `vee-${Date.now()}`, support_phone: '+237600000001', is_open: true, version: 0 });

        const agencyUser = await user(['agency'], `rc-agency-${Date.now()}@verify.test`);
        const agencyId = await insert(COLLECTIONS.DELIVERY_AGENCY, { user_id: agencyUser, display_name: 'Ag', email: `ag-${Date.now()}@verify.test`, phone: '+237600000002', status: 'active' });
        const depotId = oid();
        await insert(COLLECTIONS.AGENCY_MAGAZIN, {
            agency_id: agencyId, name: 'Fast Agency', support_phone: '+237600000002', version: 0,
            headquarters_addresses: [{ _id: depotId, label: 'Depot', address_description: 'Akwa', support_contact: { phone: '+237600000002', email: 'd@x.test' } }],
        });
        const otherAgencyId = await insert(COLLECTIONS.DELIVERY_AGENCY, { user_id: oid(), display_name: 'Other', status: 'active' });

        const agentUser = await user(['agent'], `rc-agent-${Date.now()}@verify.test`);
        const agentId = await insert(COLLECTIONS.DELIVERY_AGENT, {
            user_id: agentUser, name: 'Andy Agent', email: `andy-${Date.now()}@verify.test`, phone: '+237600000003', status: 'active',
            tracking: { allowed: true }, vehicle_info: { vehicle_type: 'motorbike', plate_number: 'LT-123' },
        });
        const contractWithAgency = await insert(COLLECTIONS.AGENT_AGENCY_CONTRACT, { agent_id: agentId, agency_id: agencyId, status: 'active', is_primary: true });
        const contractWithOther = await insert(COLLECTIONS.AGENT_AGENCY_CONTRACT, { agent_id: agentId, agency_id: otherAgencyId, status: 'active', is_primary: false });
        const connectionId = await insert(COLLECTIONS.VENDOR_AGENCY_CONNECTION, { vendor_id: vendorId, agency_id: agencyId, status: 'active', status_history: [] });

        // ── 1. Request refusals ─────────────────────────────────────────────────
        console.log('\n1. Refused up front');
        await assert('a role the user does not hold → ROLE_CLOSURE_ROLE_NOT_HELD', () =>
            refusedWith('ROLE_CLOSURE_ROLE_NOT_HELD', () => service.request({ userId: agencyUser.toString(), role: 'vendor', reason: 'Asked', actor: ADMIN })));

        const offerId = await insert(COLLECTIONS.SHIPMENT_ASSIGNMENT_OFFER, { agent_id: agentId, status: 'pending' });
        let blockers: unknown = null;
        await assert('an agent with a pending offer → ROLE_CLOSURE_BLOCKED, itemised', async () => {
            try { await service.request({ userId: agentUser.toString(), role: 'agent', reason: 'Asked', actor: ADMIN }); return false; } catch (err) {
                blockers = (err as { details?: { blockers?: unknown } }).details?.blockers;
                return (err as { code?: string }).code === 'ROLE_CLOSURE_BLOCKED'
                    && Array.isArray(blockers) && (blockers as Array<{ code: string }>).some((b) => b.code === 'offers_pending');
            }
        });
        await col(COLLECTIONS.SHIPMENT_ASSIGNMENT_OFFER).deleteOne({ _id: offerId });

        // ── 2. Vendor: dual-role closes ONE role ────────────────────────────────
        console.log('\n2. A vendor who is also a customer closes the shop only');
        const vendorRequest = await service.request({ userId: vendorUser.toString(), role: 'vendor', reason: 'Owner asked', actor: ADMIN });
        await assert('the request is pending, 7 days out, stamped with the administrator', () =>
            vendorRequest.status === 'pending'
            && Math.round((vendorRequest.expires_at.getTime() - vendorRequest.requested_at.getTime()) / 86400000) === 7
            && vendorRequest.requested_by_source === 'admin' && vendorRequest.requested_by_name === 'Verify Admin');
        await assert('a second request for the same role → ROLE_CLOSURE_ALREADY_PENDING', () =>
            refusedWith('ROLE_CLOSURE_ALREADY_PENDING', () => service.request({ userId: vendorUser.toString(), role: 'vendor', reason: 'Again', actor: ADMIN })));
        await assert('the partial unique index BINDS — a raw second pending row is refused by Mongo', async () => {
            try {
                await col(COLLECTIONS.ROLE_CLOSURE_REQUEST).insertOne({ user_id: vendorUser, role: 'vendor', status: 'pending' });
                return false;
            } catch (err) { return (err as { code?: number }).code === 11000; }
        });
        await assert('nothing about the role changed while pending', async () =>
            (await col(COLLECTIONS.VENDOR).findOne({ _id: vendorId }))?.status === 'active');
        await assert('the customer session cannot answer the vendor request', () =>
            refusedWith('ROLE_CLOSURE_REQUEST_NOT_FOUND', () => service.confirm(vendorUser.toString(), 'customer', customerOfVendor.toString())));

        const { outcome: vendorOutcome } = await service.confirm(vendorUser.toString(), 'vendor', vendorId.toString());
        const vendorRow = await col(COLLECTIONS.VENDOR).findOne({ _id: vendorId });
        const storeRow = await col(COLLECTIONS.STORE).findOne({ _id: storeId });
        const vendorAccount = await col(COLLECTIONS.USER).findOne({ _id: vendorUser });
        await assert('the vendor is inactive + closed_at, anonymised, email unset, payout cleared', () =>
            vendorRow?.status === 'inactive' && vendorRow?.closed_at instanceof Date
            && vendorRow?.display_name === 'Closed account' && vendorRow?.email === undefined
            && Array.isArray(vendorRow?.payout_details) && vendorRow.payout_details.length === 0);
        await assert('the store is anonymised and its slug KEPT', () =>
            storeRow?.name === 'Closed store' && storeRow?.support_phone === null && typeof storeRow?.slug === 'string');
        await assert('the account stays ACTIVE with only `customer` left, identifiers intact', () =>
            vendorAccount?.status === 'active' && JSON.stringify(vendorAccount?.roles) === '["customer"]'
            && typeof vendorAccount?.login_email === 'string' && vendorOutcome.accountClosed === false);
        await assert('the vendor↔agency connection is terminated with reason `role_closed`', async () => {
            const c = await col(COLLECTIONS.VENDOR_AGENCY_CONNECTION).findOne({ _id: connectionId });
            return c?.status === 'terminated' && c?.termination?.reason === 'role_closed' && c?.termination?.terminated_by_role === 'vendor';
        });
        await assert('the request is confirmed with its outcome recorded', async () => {
            const r = await RoleClosureRequestModel.findById(vendorRequest._id);
            return r?.status === 'confirmed' && r?.outcome?.account_closed === false && r?.outcome?.ended_relationships === 1;
        });
        await assert('the closed vendor role cannot be requested again → ROLE_CLOSURE_ROLE_NOT_HELD', () =>
            refusedWith('ROLE_CLOSURE_ROLE_NOT_HELD', () => service.request({ userId: vendorUser.toString(), role: 'vendor', reason: 'Again', actor: ADMIN })));

        // ── 3. Agency: contracts end, the agent's other contract becomes primary ──
        console.log('\n3. An agency closes: depots keep their ids, contracts end, the agent is re-primaried');
        await service.request({ userId: agencyUser.toString(), role: 'agency', reason: 'Business closed', actor: ADMIN });
        const { outcome: agencyOutcome } = await service.confirm(agencyUser.toString(), 'agency', agencyId.toString());
        const magazin = await col(COLLECTIONS.AGENCY_MAGAZIN).findOne({ agency_id: agencyId });
        await assert('the magazin is anonymised; the depot keeps its _id; its contact is replaced', () =>
            magazin?.name === 'Closed agency'
            && magazin?.headquarters_addresses?.[0]?._id?.toString() === depotId.toString()
            && magazin?.headquarters_addresses?.[0]?.support_contact?.phone === 'closed'
            && magazin?.headquarters_addresses?.[0]?.address_description === 'Akwa');
        await assert('the agent↔agency contract is deactivated with reason `role_closed`', async () => {
            const c = await col(COLLECTIONS.AGENT_AGENCY_CONTRACT).findOne({ _id: contractWithAgency });
            return c?.status === 'deactivated' && c?.deactivation_reason === 'role_closed' && c?.is_primary === false;
        });
        await assert('...and the agent\'s OTHER active contract was promoted to primary', async () =>
            (await col(COLLECTIONS.AGENT_AGENCY_CONTRACT).findOne({ _id: contractWithOther }))?.is_primary === true);
        await assert('the agency was the last role → the whole account closed (ADR-A02)', async () => {
            const u = await col(COLLECTIONS.USER).findOne({ _id: agencyUser });
            return agencyOutcome.accountClosed === true && u?.status === 'closed'
                && u?.login_email === undefined && JSON.stringify(u?.roles) === '[]';
        });

        // ── 4. Agent: tracking off + the outbox row, in the transaction ──────────
        console.log('\n4. An agent closes: Tracking Allow off, geo-tracker told, last role → account closed');
        const outboxBefore = await col(COLLECTIONS.TRACKING_OUTBOX).countDocuments({ agent_id: agentId.toString(), type: 'agent.tracking_allow_changed' });
        await service.request({ userId: agentUser.toString(), role: 'agent', reason: 'Left the platform', actor: ADMIN });
        await service.confirm(agentUser.toString(), 'agent', agentId.toString());
        const agentRow = await col(COLLECTIONS.DELIVERY_AGENT).findOne({ _id: agentId });
        await assert('the agent is inactive + closed_at, renamed, vehicle and phone gone', () =>
            agentRow?.status === 'inactive' && agentRow?.closed_at instanceof Date && agentRow?.name === 'Closed account'
            && agentRow?.vehicle_info === null && agentRow?.phone === undefined);
        await assert('Tracking Allow is OFF', () => agentRow?.tracking?.allowed === false);
        await assert('an `agent.tracking_allow_changed` outbox row was written', async () =>
            (await col(COLLECTIONS.TRACKING_OUTBOX).countDocuments({ agent_id: agentId.toString(), type: 'agent.tracking_allow_changed' })) === outboxBefore + 1);
        await assert('its remaining contract is deactivated', async () =>
            (await col(COLLECTIONS.AGENT_AGENCY_CONTRACT).findOne({ _id: contractWithOther }))?.status === 'deactivated');

        // ── 5. Decline, cancel, expiry ──────────────────────────────────────────
        console.log('\n5. Decline · cancel · expiry · the race');
        const custUser = await user(['customer'], `rc-cust-${Date.now()}@verify.test`);
        const custId = await insert(COLLECTIONS.CUSTOMER, { user_id: custUser, name: 'Cee', status: 'active' });

        await service.request({ userId: custUser.toString(), role: 'customer', reason: 'Asked', actor: ADMIN });
        const declined = await service.decline(custUser.toString(), 'customer', custId.toString(), 'Keep it');
        await assert('decline → declined, note kept, customer untouched', async () =>
            declined.status === 'declined' && declined.decline_note === 'Keep it'
            && (await col(COLLECTIONS.CUSTOMER).findOne({ _id: custId }))?.name === 'Cee');

        await service.request({ userId: custUser.toString(), role: 'customer', reason: 'Asked again', actor: ADMIN });
        const cancelled = await service.cancel(custUser.toString(), 'customer', ADMIN);
        await assert('cancel → cancelled, by the administrator', () => cancelled.status === 'cancelled' && cancelled.resolved_by_source === 'admin');

        const stale = await service.request({ userId: custUser.toString(), role: 'customer', reason: 'Third', actor: ADMIN });
        await RoleClosureRequestModel.updateOne({ _id: stale._id }, { $set: { expires_at: new Date(Date.now() - 1000) } });
        await assert('confirming after the expiry → ROLE_CLOSURE_REQUEST_EXPIRED, nothing closes', async () =>
            (await refusedWith('ROLE_CLOSURE_REQUEST_EXPIRED', () => service.confirm(custUser.toString(), 'customer', custId.toString())))
            && (await col(COLLECTIONS.CUSTOMER).findOne({ _id: custId }))?.closed_at == null);
        await assert('a new request retires the stale one, so the unique index admits it', async () => {
            await service.request({ userId: custUser.toString(), role: 'customer', reason: 'Fourth', actor: ADMIN });
            return (await RoleClosureRequestModel.findById(stale._id))?.status === 'expired';
        });

        const results = await Promise.allSettled([
            service.confirm(custUser.toString(), 'customer', custId.toString()),
            service.confirm(custUser.toString(), 'customer', custId.toString()),
        ]);
        await assert('two concurrent confirms: exactly ONE closes the role', () =>
            results.filter((r) => r.status === 'fulfilled').length === 1);
        await assert('the customer was the last role → the account is closed', async () =>
            (await col(COLLECTIONS.USER).findOne({ _id: custUser }))?.status === 'closed'
            && (await col(COLLECTIONS.CUSTOMER).findOne({ _id: custId }))?.name === 'Closed account');
    } finally {
        for (const { collection, id } of created) await col(collection).deleteOne({ _id: id }).catch(() => undefined);
        await RoleClosureRequestModel.deleteMany({ requested_by_user_id: new Types.ObjectId(ADMIN.userId) }).catch(() => undefined);
        await mongoose.disconnect();
    }

    console.log('\n' + '─'.repeat(72));
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('─'.repeat(72) + '\n');
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('verify:role-closure crashed:', err);
    process.exit(1);
});
