/**
 * Migration: DeliveryAgent.agency_id → AgentAgencyMembership
 *
 * The agent domain replaced the single `agency_id` foreign key on the agent
 * with a membership collection, because an agent may now serve several
 * agencies. Existing agents still carry the old field, which the current model
 * no longer declares — so it is invisible to Mongoose and must be read raw.
 *
 * For every agent with an `agency_id`, this creates one APPROVED membership
 * (origin: 'migration', is_primary: true — it was their only agency, so it is
 * necessarily their primary) plus a history event, then unsets the dead field.
 *
 * Also backfills the state fields the old `live_state` fused together:
 *   live_state.current_capacity_status  →  availability.state
 *   live_state.last_known_location      →  last_known_tracking_state.last_position
 *
 * Idempotent: re-running skips agents that already have a live membership, so
 * a partial run can simply be repeated.
 *
 * Run:  npx ts-node scripts/migrate-agent-memberships.ts [--dry-run] [--drop-live-state]
 */
// import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { DeliveryAgentModel } from '../src/modules/agents/models/agent.model';
import { AgentAgencyMembershipModel } from '../src/modules/agents/models/agent-agency-membership.model';
import { AgentMembershipEventModel } from '../src/modules/agents/models/agent-membership-event.model';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');
/** Also remove the superseded live_state blob. Off by default — keep a rollback path. */
const DROP_LIVE_STATE = process.argv.includes('--drop-live-state');

interface LegacyAgent {
  _id: mongoose.Types.ObjectId;
  agency_id?: mongoose.Types.ObjectId | null;
  name?: string;
  updated_at?: Date;
  created_at?: Date;
  live_state?: {
    last_known_location?: { type: 'Point'; coordinates: [number, number] } | null;
    current_capacity_status?: 'available' | 'busy' | 'offline';
  };
}

/**
 * The old enum fused availability with load. Only the availability half
 * survives the split: 'busy' meant "has work", which the system now derives
 * from shipment counts rather than trusting a stored flag. A busy agent was by
 * definition working, hence online.
 */
function mapAvailability(status?: string): 'online' | 'offline' | 'on_break' {
  if (status === 'available' || status === 'busy') return 'online';
  return 'offline';
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}`);
  if (DRY_RUN) console.log('DRY RUN — no writes will be made\n');

  // Read raw: `agency_id` and `live_state` are no longer in the schema, so a
  // Mongoose-typed query would silently drop them.
  const collection = mongoose.connection.collection('delivery_agents');
  const legacyAgents = (await collection.find({}).toArray()) as unknown as LegacyAgent[];

  console.log(`Found ${legacyAgents.length} agent(s)\n`);

  let membershipsCreated = 0;
  let membershipsSkipped = 0;
  let availabilityBackfilled = 0;
  let positionsBackfilled = 0;
  let noAgency = 0;

  for (const agent of legacyAgents) {
    const agentId = agent._id.toString();
    const label = `${agent.name ?? 'unnamed'} (${agentId})`;

    // ── Membership ──────────────────────────────────────────────────────────
    if (agent.agency_id) {
      const existing = await AgentAgencyMembershipModel.findOne({
        agent_id: agent._id,
        agency_id: agent.agency_id,
        status: { $in: ['pending', 'approved', 'suspended'] },
      });

      if (existing) {
        membershipsSkipped++;
        console.log(`  = ${label} — membership already exists, skipping`);
      } else if (DRY_RUN) {
        membershipsCreated++;
        console.log(`  + ${label} → agency ${agent.agency_id.toString()} (would create)`);
      } else {
        // Approved at migration time: they were already working for this
        // agency under the old model, so anything else would revoke access
        // that people are actively relying on.
        const membership = await AgentAgencyMembershipModel.create({
          agent_id: agent._id,
          agency_id: agent.agency_id,
          status: 'approved',
          origin: 'migration',
          is_primary: true,
          approved_at: agent.updated_at ?? agent.created_at ?? new Date(),
        });

        await AgentMembershipEventModel.create({
          membership_id: membership._id,
          agent_id: agent._id,
          agency_id: agent.agency_id,
          type: 'approved',
          from_status: null,
          to_status: 'approved',
          actor_user_id: null,
          actor_role: 'system',
          reason: 'Migrated from DeliveryAgent.agency_id',
          metadata: { migration: 'agent-memberships' },
          occurred_at: agent.updated_at ?? agent.created_at ?? new Date(),
        });

        membershipsCreated++;
        console.log(`  + ${label} → agency ${agent.agency_id.toString()}`);
      }
    } else {
      noAgency++;
    }

    // ── State backfill ──────────────────────────────────────────────────────
    const set: Record<string, unknown> = {};

    if (agent.live_state?.current_capacity_status) {
      set['availability.state'] = mapAvailability(agent.live_state.current_capacity_status);
      set['availability.changed_at'] = agent.updated_at ?? new Date();
      availabilityBackfilled++;
    }
    if (agent.live_state?.last_known_location) {
      set['last_known_tracking_state.last_position'] = agent.live_state.last_known_location;
      set['last_known_tracking_state.status'] = 'unknown';
      set['last_known_tracking_state.source'] = 'migration';
      positionsBackfilled++;
    }

    const unset: Record<string, ''> = {};
    if (agent.agency_id) unset.agency_id = '';
    if (DROP_LIVE_STATE && agent.live_state) unset.live_state = '';

    if (!DRY_RUN && (Object.keys(set).length > 0 || Object.keys(unset).length > 0)) {
      await collection.updateOne({ _id: agent._id }, {
        ...(Object.keys(set).length > 0 ? { $set: set } : {}),
        ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
      });
    }
  }

  console.log('\n── Summary ─────────────────────────────');
  console.log(`  memberships created:      ${membershipsCreated}`);
  console.log(`  memberships skipped:      ${membershipsSkipped}`);
  console.log(`  agents with no agency:    ${noAgency}`);
  console.log(`  availability backfilled:  ${availabilityBackfilled}`);
  console.log(`  positions backfilled:     ${positionsBackfilled}`);
  if (!DROP_LIVE_STATE) {
    console.log('\n  live_state left in place. Re-run with --drop-live-state once verified.');
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
