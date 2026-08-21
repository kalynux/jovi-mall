import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { agentTrustService } from '../src/modules/agents/domain/services/agent-trust.service';
import { agentRepository } from '../src/modules/agents/repositories/agent.repository';
import { DeliveryAgentModel } from '../src/modules/agents/models/agent.model';

async function main(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall');
  const ids = await agentRepository.listAllIds();
  console.log(`agents: ${ids.length}\n`);
  console.log('  live  shadow  delta   cod  actv  cust   signals');
  let crossers = 0;
  for (const id of ids) {
    const { signals, composite } = await agentTrustService.recompute(id);
    const agent = await DeliveryAgentModel.findById(id, { 'cod.trust_score': 1, name: 1 });
    const live = agent?.cod?.trust_score ?? 100;
    const d = composite.score - live;
    const crossed =
      (live >= 80) !== (composite.score >= 80) || (live >= 50) !== (composite.score >= 50);
    if (crossed) crossers++;
    console.log(
      `  ${String(live).padStart(4)}  ${String(composite.score).padStart(6)}  ${String(d).padStart(5)}` +
        `  ${composite.factors.cod.toFixed(2)}  ${composite.factors.activity.toFixed(2)}  ${composite.factors.customer.toFixed(2)}` +
        `   clean=${signals.cod_clean_return_count} disc=${signals.cod_discrepancy_count} vol=${signals.cod_volume_returned}` +
        ` resp=${signals.assignment_response_rate === null ? 'null' : signals.assignment_response_rate.toFixed(2)}` +
        ` done=${signals.completed_shipments}${crossed ? '   ⚠ CROSSES A COD THRESHOLD' : ''}`
    );
  }
  console.log(`\n${crossers} agent(s) would change COD exposure tier if the composite went live today.`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
