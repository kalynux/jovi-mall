/**
 * The internal admin user surface, against a RUNNING server and a real database.
 *
 *   npm run verify:admin-users        # needs Mongo + this service on :8022
 *
 * ── Why this needs infrastructure ─────────────────────────────────────────────
 * Four of the properties below are structurally invisible to a DB-free suite, and each
 * one is a real failure mode rather than a hypothetical:
 *
 *   - the status compare-and-set actually MISSES on a second suspension (a plain update
 *     would return 200 and quietly overwrite the first administrator's reason)
 *   - a cleared identifier is `$unset` rather than `null` — a null is a value to a SPARSE
 *     unique index, so two nulled accounts would collide on the next write
 *   - the sparse unique index refuses an identifier another account holds, and the
 *     service turns that into a 409 rather than a duplicate-key 500
 *   - `requireAdminCaller` fails closed on a missing service token even when the actor
 *     headers are present and well-formed
 *
 * ── What it touches ───────────────────────────────────────────────────────────
 * Two users it creates itself, deleted in a `finally` whether it passes or fails — the
 * same shape as `verify:blog`. It never reads, writes or deletes a pre-existing row.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import axios from 'axios';

const BASE = `http://localhost:${process.env.PORT || 8022}/api/internal/admin/users`;
const HEADERS = {
    'X-Service-Token': process.env.INTERNAL_ADMIN_SERVICE_TOKEN as string,
    'X-Actor-Id': '65f0000000000000000000aa',
    'X-Actor-Name': 'Verification Admin',
    'X-Actor-Tier': '2',
    'X-Request-Id': 'verify-admin-users',
};

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
    console.log(`${ok ? '  ✅' : '  ❌ FAIL:'} ${name}${ok ? '' : ` — ${extra}`}`);
    if (ok) pass++; else fail++;
};

async function call(method: string, path: string, body?: unknown) {
    try {
        const res = await axios.request({ method, url: `${BASE}${path}`, data: body, headers: HEADERS });
        return { status: res.status, body: res.data };
    } catch (e: any) {
        return { status: e.response?.status ?? 0, body: e.response?.data ?? { message: e.message } };
    }
}

(async () => {
    await mongoose.connect(process.env.MONGO_URI as string);
    const users = mongoose.connection.db!.collection('users');

    const stamp = Date.now();
    const emailA = `verify-admin-users-${stamp}@example.test`;
    const emailB = `verify-admin-users-${stamp}-b@example.test`;
    const occupied = `verify-admin-users-${stamp}-occupied@example.test`;

    const mine = await users.insertOne({
        login_email: emailA, login_phone: `+23767${String(stamp).slice(-7)}`,
        password_hash: 'x', roles: ['customer'], status: 'active',
        created_at: new Date(), updated_at: new Date(),
    });
    const other = await users.insertOne({
        login_email: occupied, password_hash: 'x', roles: ['customer'], status: 'active',
        created_at: new Date(), updated_at: new Date(),
    });
    const id = mine.insertedId.toString();
    console.log(`\n━━━ internal admin users (live) — throwaway user ${id} ━━━\n`);

    try {
        let r = await call('POST', `/${id}/suspend`, { reason: 'verification run' });
        check('suspend returns 200', r.status === 200, JSON.stringify(r.body));
        check('...and the DTO reports the suspension', r.body?.data?.status === 'suspended'
            && r.body?.data?.suspendedReason === 'verification run');
        check('...stamping the actor as an ADMIN id, with a name snapshot',
            r.body?.data?.suspendedBy?.source === 'admin'
            && r.body?.data?.suspendedBy?.name === 'Verification Admin');
        check('...and never leaks the password hash', !JSON.stringify(r.body).includes('password_hash'));

        r = await call('POST', `/${id}/suspend`, { reason: 'second attempt' });
        check('suspending twice is a 409 compare-and-set miss, not a silent no-op',
            r.status === 409 && r.body?.error?.code === 'USER_STATUS_CONFLICT', JSON.stringify(r.body));

        r = await call('POST', `/${id}/suspend`, {});
        check('a suspension with no reason is refused', r.status === 400, String(r.status));

        r = await call('PATCH', `/${id}`, { email: 'not-an-email' });
        check('a malformed email is refused by jovi-mall’s own validator', r.status === 400,
            JSON.stringify(r.body));

        r = await call('PATCH', `/${id}`, { email: occupied });
        check('an email another account holds is a 409',
            r.status === 409 && r.body?.error?.code === 'AUTH_EMAIL_TAKEN', JSON.stringify(r.body));

        r = await call('PATCH', `/${id}`, { email: `  ${emailB.toUpperCase()}  ` });
        check('a valid email is normalised and stored', r.body?.data?.email === emailB,
            JSON.stringify(r.body?.data?.email));

        r = await call('PATCH', `/${id}`, { email: null, phone: null });
        check('clearing BOTH identifiers is refused — the account would be unreachable',
            r.status === 422 && r.body?.error?.code === 'USER_CONTACT_REQUIRED', JSON.stringify(r.body));

        r = await call('PATCH', `/${id}`, { phone: null });
        check('clearing ONE is allowed', r.status === 200 && r.body?.data?.phone === null);

        const doc = await users.findOne({ _id: mine.insertedId });
        check('...and the cleared field is $unset, not null — the sparse index stays clean',
            !('login_phone' in (doc ?? {})));

        r = await call('PATCH', `/${id}`, { roles: ['admin'] });
        check('a body naming another permission’s field is refused, never silently ignored',
            r.status === 400, JSON.stringify(r.body));

        r = await call('POST', `/${id}/restore`);
        check('restore returns 200 and clears the whole stamp',
            r.status === 200 && r.body?.data?.status === 'active'
            && r.body?.data?.suspendedReason === null && r.body?.data?.suspendedBy === null,
            JSON.stringify(r.body?.data));

        r = await call('POST', `/${id}/restore`);
        check('restoring an active account is a 409', r.status === 409, String(r.status));

        r = await call('POST', `/65f000000000000000000099/suspend`, { reason: 'nobody' });
        check('an unknown user is a 404', r.status === 404, String(r.status));

        const noToken = await axios.post(`${BASE}/${id}/suspend`, { reason: 'x' },
            { headers: { 'X-Actor-Id': HEADERS['X-Actor-Id'] }, validateStatus: () => true });
        check('no service token → 401, whatever the actor headers say', noToken.status === 401);
    } finally {
        await users.deleteMany({ _id: { $in: [mine.insertedId, other.insertedId] } });
        const left = await users.countDocuments({ login_email: /verify-admin-users-/ });
        check('both throwaway users were removed', left === 0, `${left} left behind`);
        await mongoose.disconnect();
    }

    console.log(`\n━━━ ${pass}/${pass + fail} passed${fail ? `, ${fail} FAILED` : ''} ━━━\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
