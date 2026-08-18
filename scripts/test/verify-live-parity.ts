/**
 * Live-DB smoke test for the agent↔agency contract surface.
 *
 * Unlike the other scripts in this folder this one NEEDS Mongo — it exists to
 * cover exactly what `tsc` and the DB-free suites cannot see:
 *
 *   1. the schema indexes actually BUILD against real data (`autoIndex` is on,
 *      so a 2dsphere that fails here fails silently at boot in production)
 *   2. the directory aggregation, including `$geoWithin`/`$centerSphere`,
 *      actually RUNS — Mongo validates pipelines at execution time
 *   3. the contract lists page, and return terminal rows by default
 *   4. the Express route table resolves the renamed/added paths in the right
 *      order, and the removed ones are really gone
 *
 * Read-only: it inspects existing data and never writes.
 *
 * Run: npx ts-node scripts/test/verify-live-parity.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { DeliveryAgentModel } from '../../src/modules/agents/models/agent.model';
import { AgentAgencyContractModel } from '../../src/modules/agents/models/agent-agency-membership.model';
import { agentContractRepository } from '../../src/modules/agents/repositories/agent-contract.repository';
import { agentRepository } from '../../src/modules/agents/repositories/agent.repository';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
    if (ok) {
        console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
        pass++;
    } else {
        console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
        fail++;
    }
}

async function main(): Promise<void> {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected: ${MONGO_URI}\n`);

    // ── 1. Index builds ───────────────────────────────────────────────────────
    console.log('── Index builds (autoIndex is ON — a failure here is silent at boot) ──');
    try {
        await DeliveryAgentModel.createIndexes();
        check('DeliveryAgent indexes build', true);
    } catch (err) {
        check('DeliveryAgent indexes build', false, (err as Error).message);
    }
    try {
        await AgentAgencyContractModel.createIndexes();
        check('AgentAgencyContract indexes build', true);
    } catch (err) {
        check('AgentAgencyContract indexes build', false, (err as Error).message);
    }

    const names = (await DeliveryAgentModel.collection.indexes()).map((i) => String(i.name));
    check(
        '2dsphere on home_base.location exists',
        names.some((n) => n.startsWith('home_base.location_')),
        names.filter((n) => n.includes('home_base')).join(', ') || 'MISSING'
    );
    check(
        'directory compound index exists',
        names.some((n) => n.includes('kyc.status') && n.includes('cod.trust_score')),
        names.find((n) => n.includes('kyc.status')) ?? 'MISSING'
    );

    // ── 2. The directory aggregation actually runs ────────────────────────────
    console.log('\n── Directory aggregation ──');
    try {
        const plain = await agentRepository.findAvailableForAgencies({ sort: 'trust', page: 1, limit: 5 });
        check('findAvailableForAgencies runs', true, `${plain.total} contractable agent(s)`);
    } catch (err) {
        check('findAvailableForAgencies runs', false, (err as Error).message);
    }

    try {
        const geo = await agentRepository.findAvailableForAgencies({
            lng: 9.7043, lat: 4.0511, radius_km: 25, sort: 'trust', page: 1, limit: 5,
        });
        check('$geoWithin / $centerSphere runs', true, `${geo.total} within 25km of Douala`);
    } catch (err) {
        check('$geoWithin / $centerSphere runs', false, (err as Error).message);
    }

    try {
        const filtered = await agentRepository.findAvailableForAgencies({
            search: 'a', vehicle_type: 'bike', availability: 'online',
            min_trust_score: 50, sort: 'name', page: 1, limit: 5,
        });
        check('every optional filter composes', true, `${filtered.total} match(es)`);
    } catch (err) {
        check('every optional filter composes', false, (err as Error).message);
    }

    // ── 3. Pagination + the terminal-rows default ─────────────────────────────
    console.log('\n── Contract lists: pagination + history default ──');
    const anyContract = await AgentAgencyContractModel.findOne().lean();
    if (!anyContract) {
        console.log('  ⏭  no contracts in this database — seed one to exercise these');
    } else {
        const agentId = String(anyContract.agent_id);
        const agencyId = String(anyContract.agency_id);

        const page = await agentContractRepository.listForAgent(agentId, {}, { page: 1, limit: 2 });
        check(
            'listForAgent returns a Page with meta',
            typeof page.meta?.total === 'number' && Array.isArray(page.data),
            `total=${page.meta.total} pages=${page.meta.pages} returned=${page.data.length}`
        );
        check('limit is honoured', page.data.length <= 2, `${page.data.length} <= 2`);

        const rawAll = await AgentAgencyContractModel.countDocuments({ agent_id: agentId });
        check(
            'unfiltered list counts EVERY status (history default)',
            page.meta.total === rawAll,
            `list=${page.meta.total} raw=${rawAll}`
        );

        const agencyPage = await agentContractRepository.listForAgency(agencyId, {}, { page: 1, limit: 2 });
        const rawAgency = await AgentAgencyContractModel.countDocuments({ agency_id: agencyId });
        check('listForAgency counts EVERY status', agencyPage.meta.total === rawAgency,
            `list=${agencyPage.meta.total} raw=${rawAgency}`);

        const activeOnly = await agentContractRepository.listForAgent(agentId, { status: 'active' }, { page: 1, limit: 50 });
        check('status filter still narrows', activeOnly.data.every((c) => c.status === 'active'),
            `${activeOnly.meta.total} active`);

        const all = await agentContractRepository.listAllForAgent(agentId);
        check('listAllForAgent (admin) is unpaginated', all.length === rawAll, `${all.length} of ${rawAll}`);
    }

    // ── 4. Route table ────────────────────────────────────────────────────────
    console.log('\n── Express route table ──');
    const app = (await import('../../src/app')).app as unknown as {
        _router: { stack: unknown[] };
    };

    const routes: string[] = [];
     
    const walk = (stack: any[], prefix: string): void => {
        for (const layer of stack) {
            if (layer.route) {
                for (const m of Object.keys(layer.route.methods)) {
                    if (layer.route.methods[m]) routes.push(`${m.toUpperCase()} ${prefix}${layer.route.path}`);
                }
            } else if (layer.name === 'router' && layer.handle?.stack) {
                const seg = String(layer.regexp?.source ?? '')
                    .replace('^\\/', '/')
                    .replace('\\/?(?=\\/|$)', '')
                    .replace(/\\\//g, '/')
                    .replace(/\$$/, '');
                walk(layer.handle.stack, prefix + (seg === '/' ? '' : seg));
            }
        }
    };
     
    walk(app._router.stack as any[], '');

    const has = (r: string): boolean => routes.includes(r);

    check('GET  /api/agent/memberships/:membershipId', has('GET /api/agent/memberships/:membershipId'));
    check('POST /api/agent/memberships/:membershipId/approve', has('POST /api/agent/memberships/:membershipId/approve'));
    check('POST /api/agent/memberships/:membershipId/terminate', has('POST /api/agent/memberships/:membershipId/terminate'));
    check('GET  /api/agent/agencies/browse', has('GET /api/agent/agencies/browse'));
    check('POST /api/agency/agents/:membershipId/reject', has('POST /api/agency/agents/:membershipId/reject'));
    check('POST /api/agency/agents/:membershipId/terminate', has('POST /api/agency/agents/:membershipId/terminate'));
    check('DELETE /api/agency/agents/:membershipId (alias kept)', has('DELETE /api/agency/agents/:membershipId'));
    check('GET  /api/agency/agents/browse', has('GET /api/agency/agents/browse'));
    check('POST /api/agency/agents/requests', has('POST /api/agency/agents/requests'));

    check('old /accept is GONE', !routes.some((r) => r.includes('/memberships/:membershipId/accept')));
    check('old /decline is GONE', !routes.some((r) => r.includes('/agents/:membershipId/decline')));
    check('old /invites are GONE', !routes.some((r) => r.includes('/invites')));

    // Literal segments must be registered BEFORE the :membershipId param, or
    // Express matches "history" as an id.
    const idxOf = (r: string): number => routes.indexOf(r);
    const paramGet = idxOf('GET /api/agent/memberships/:membershipId');
    for (const literal of ['GET /api/agent/memberships/history', 'GET /api/agent/memberships/status-requests']) {
        check(`${literal} declared before :membershipId`,
            idxOf(literal) !== -1 && idxOf(literal) < paramGet,
            `${idxOf(literal)} < ${paramGet}`);
    }
    const agencyParamGet = idxOf('GET /api/agency/agents/:membershipId');
    for (const literal of ['GET /api/agency/agents/browse', 'GET /api/agency/agents/eligible', 'GET /api/agency/agents/history']) {
        check(`${literal} declared before :membershipId`,
            idxOf(literal) !== -1 && idxOf(literal) < agencyParamGet,
            `${idxOf(literal)} < ${agencyParamGet}`);
    }

    console.log('\n  agent membership routes:');
    routes.filter((r) => r.includes('/memberships') || r.includes('/agencies/browse')).forEach((r) => console.log(`    ${r}`));
    console.log('\n  agency roster routes:');
    routes.filter((r) => r.includes('/agency/agents')).forEach((r) => console.log(`    ${r}`));

    console.log(`\n${'─'.repeat(72)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(72)}`);
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
});
