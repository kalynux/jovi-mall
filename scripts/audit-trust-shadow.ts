/**
 * audit:trust-shadow — the live trust score beside the shadow composite, per agent.
 *
 * READ-ONLY. Writes nothing, changes nothing, and is safe against production.
 * It recomputes in memory and prints; it does not persist, so it does not even
 * refresh `trust_signals.composite_score` (the nightly worker does that).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `AgentTrustService` computes a composite that is deliberately not live: it
 * writes `trust_signals.composite_score` while `CodTrustService.applyEvent` goes
 * on owning `cod.trust_score`, the number `CodExposureService` turns into an
 * agent's COD cash limit (Phase 6 D-2).
 *
 * Making the composite live is therefore a decision with a measurable blast
 * radius, and this script is the measurement. The number that matters is not the
 * average delta — it is **how many agents cross `TRUST_FULL_THRESHOLD` (80) or
 * `TRUST_REDUCED_THRESHOLD` (50)**, because those two lines are where an agent's
 * permitted cash actually changes.
 *
 * ── WHAT TO EXPECT WHILE RATINGS ARE STILL SPARSE ────────────────────────────
 * Three of the five factors are ratings (50 of 100 weight). Phase 6 Step 10 gave
 * them a source — `modules/reviews`, via `review_aggregates` — but an agent nobody
 * has reviewed still blends to the seed, so on a roster with no delivery reviews
 * **every delta is ≥ 0**: the composite can only raise a score, never lower one, and
 * an agent penalised under the delta model reads as a large positive delta.
 *
 * That is now a fact about the DATA rather than about the code, which is exactly the
 * state Step 11 has to be decided in: run this after real delivery ratings have
 * accumulated and the ≥ 0 property should stop holding. If it still holds, the
 * ratings are not flowing and the flip is not ready — the footer below says so.
 *
 * Run: npm run audit:trust-shadow [-- --json]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

import { agentTrustService } from '../src/modules/agents/domain/services/agent-trust.service';
import { agentRepository } from '../src/modules/agents/repositories/agent.repository';
import { DeliveryAgentModel } from '../src/modules/agents/models/agent.model';
import { COD_CONFIG } from '../src/modules/cod/config/cod.config';

interface Row {
    agentId: string;
    name: string | null;
    live: number;
    shadow: number;
    delta: number;
    crossesThreshold: boolean;
    factors: Record<string, number>;
    /**
     * How many delivery reviews stand behind this agent's three rating factors.
     *
     * Reported because Step 11's decision turns on it: a threshold crossing driven
     * by a seeded factor is not evidence of anything, and a table without these
     * numbers cannot tell the two apart.
     */
    ratingCounts: { customer: number; agency: number; vendor: number };
}

/** Which side of each COD exposure line a score falls on. */
function tierOf(score: number): 'full' | 'reduced' | 'blocked' {
    if (score >= COD_CONFIG.TRUST_FULL_THRESHOLD) return 'full';
    if (score >= COD_CONFIG.TRUST_REDUCED_THRESHOLD) return 'reduced';
    return 'blocked';
}

async function main(): Promise<void> {
    const json = process.argv.includes('--json');

    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall');

    const ids = await agentRepository.listAllIds();
    const rows: Row[] = [];

    for (const id of ids) {
        const { signals, composite } = await agentTrustService.recompute(id);
        const agent = await DeliveryAgentModel.findById(id, { 'cod.trust_score': 1, name: 1 });
        const live = agent?.cod?.trust_score ?? 100;

        rows.push({
            agentId: id,
            name: agent?.name ?? null,
            live,
            shadow: composite.score,
            delta: composite.score - live,
            crossesThreshold: tierOf(live) !== tierOf(composite.score),
            factors: { ...composite.factors },
            ratingCounts: {
                customer: signals.customer_rating_count,
                agency: signals.agency_rating_count,
                vendor: signals.vendor_rating_count,
            },
        });
    }

    const crossers = rows.filter((r) => r.crossesThreshold);
    const totalRatings = rows.reduce(
        (n, r) => n + r.ratingCounts.customer + r.ratingCounts.agency + r.ratingCounts.vendor,
        0,
    );
    const ratedAgents = rows.filter(
        (r) => r.ratingCounts.customer + r.ratingCounts.agency + r.ratingCounts.vendor > 0,
    ).length;

    if (json) {
        console.log(
            JSON.stringify(
                { agents: rows.length, crossers: crossers.length, ratedAgents, totalRatings, rows },
                null,
                2,
            ),
        );
    } else {
        console.log(`\nAgents: ${rows.length}   ·   COD tiers at ${COD_CONFIG.TRUST_REDUCED_THRESHOLD} and ${COD_CONFIG.TRUST_FULL_THRESHOLD}\n`);
        console.log('  live  shadow  delta   tier (live → shadow)      cod  actv  cust  agcy  vend   reviews c/a/v');
        for (const r of rows) {
            const tiers = `${tierOf(r.live)} → ${tierOf(r.shadow)}`;
            const reviews = `${r.ratingCounts.customer}/${r.ratingCounts.agency}/${r.ratingCounts.vendor}`;
            console.log(
                `  ${String(r.live).padStart(4)}  ${String(r.shadow).padStart(6)}  ${String(r.delta).padStart(5)}` +
                    `   ${tiers.padEnd(22)}  ${r.factors.cod.toFixed(2)}  ${r.factors.activity.toFixed(2)}` +
                    `  ${r.factors.customer.toFixed(2)}  ${r.factors.agency.toFixed(2)}  ${r.factors.vendor.toFixed(2)}` +
                    `   ${reviews.padStart(12)}` +
                    (r.crossesThreshold ? '   ⚠' : '')
            );
        }
        console.log(
            `\n⚠ ${crossers.length} of ${rows.length} agent(s) would change COD exposure tier if the composite went live today.`
        );
        console.log(
            `   Rating coverage: ${ratedAgents} of ${rows.length} agent(s) carry any delivery review; ${totalRatings} review(s) in total.`
        );
        if (rows.length > 0 && totalRatings === 0) {
            console.log(
                '   NO delivery reviews exist yet, so all three rating factors (50 of 100 weight) blend\n' +
                    '   to the seed on every agent. The composite can therefore only RAISE a score. Step 11\n' +
                    '   must not be decided on this table — it measures the seed, not the roster.'
            );
        } else if (rows.length > 0 && rows.every((r) => r.delta >= 0)) {
            console.log(
                '   Every delta is ≥ 0 — with reviews present that is a finding about the roster rather\n' +
                    '   than about the seed, but check the coverage column before reading it that way.'
            );
        }
        console.log();
    }

    await mongoose.disconnect();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
