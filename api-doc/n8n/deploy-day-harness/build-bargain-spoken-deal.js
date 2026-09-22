// THE SPOKEN DEAL — the n8n half of "a deal agreed in words does what the Lock it in press does"
// (owner, 2026-09-22; executions 1914 → 1934 on UP-wi-mall-bargain 58c25a1a).
//
// ⭐ The backend now does the work: when the gate approves a close (`lock: true`) it puts the item in
// the basket at the locked price, through the same core the press uses, and returns `data.outbound`
// = the approved sentence + "Deal — it's in your basket at that price." + View basket · Checkout ·
// Keep shopping. The LIVE `decide send` already prefers `data.outbound` on every approved turn, lock
// or not — so the message and its buttons need NO workflow change (test-bargain-spoken-deal.js § B
// proves it by feeding the backend's body to the live node code).
//
// ONE node changes, for the failure that preceded the close in exec 1914:
//
//   UP-wi-mall-bargain → `negotiation_record` → workflowInputs.value.args
//     `traits` was declared `$fromAI(…, 'json')`. n8n builds that as "a non-empty object or a
//     non-empty array", and the model sent the object as a JSON STRING — so the first call failed the
//     tool schema ("Value must be a non-empty object or a non-empty array → at traits") and the turn
//     cost a retry. Declared 'string' now, and described as one JSON object written as a string.
//     `UP-wi-mall-bargain-tools` → `build request` already parses a string with `obj()` — measured
//     against execution 1916 — so the backend still receives an OBJECT, which its validator requires.
//
// Built from the LIVE snapshots by anchored replacement: an anchor that misses or repeats throws.
// Keep every body backslash-free — a backslash is what gets lost when a body is carried by hand.
const fs = require('fs');

const BARGAIN_SNAPSHOT = 'C:/Users/Fante/Desktop/wi-mall-deploy/wi-mall-bargain-58c25a1a.json';
const TOOLS_SNAPSHOT = 'C:/Users/Fante/Desktop/wi-mall-deploy/wi-mall-bargain-tools-61d1a511.json';

const bargainWf = JSON.parse(fs.readFileSync(BARGAIN_SNAPSHOT, 'utf8'));
if (!String(bargainWf.versionId).startsWith('58c25a1a')) {
  throw new Error(`bargain snapshot is ${bargainWf.versionId}, not the live 58c25a1a — re-fetch before building`);
}
const liveBargain = Object.fromEntries(bargainWf.nodes.map((n) => [n.name, n]));

const toolsWf = JSON.parse(fs.readFileSync(TOOLS_SNAPSHOT, 'utf8'));
if (!String(toolsWf.versionId).startsWith('61d1a511')) {
  throw new Error(`bargain-tools snapshot is ${toolsWf.versionId}, not the live 61d1a511`);
}
const liveTools = toolsWf.nodes;

/** Exact, single-occurrence replacement — an anchor that misses or repeats is an error, never a no-op. */
function patch(label, src, pairs) {
  let out = src;
  for (const [from, to] of pairs) {
    const count = out.split(from).length - 1;
    if (count !== 1) throw new Error(`${label}: anchor occurs ${count} times: ${JSON.stringify(from.slice(0, 60))}`);
    out = out.replace(from, () => to);
  }
  return out;
}

const LIVE_ARGS = liveBargain.negotiation_record.parameters.workflowInputs.value.args;

const TRAITS_OLD_HEAD = "$fromAI('traits', 'A flat object holding your read of this customer: lower_snake_case keys, short string, number or boolean values.";
const TRAITS_NEW_HEAD = "$fromAI('traits', 'Your read of this customer as ONE JSON object written as a string: lower_snake_case keys, short string, number or boolean values, nothing nested.";
const TRAITS_OLD_TAIL = "so write what you would want to know then.', 'json')";
const TRAITS_NEW_TAIL = "so write what you would want to know then.', 'string')";

const NEW = {};
NEW['negotiation_record.args'] = patch('negotiation_record.args', LIVE_ARGS, [
  [TRAITS_OLD_HEAD, TRAITS_NEW_HEAD],
  [TRAITS_OLD_TAIL, TRAITS_NEW_TAIL],
]);

module.exports = {
  BARGAIN_SNAPSHOT,
  TOOLS_SNAPSHOT,
  liveBargain,
  liveTools,
  LIVE_ARGS,
  NEW,
  patch,
  TRAITS_OLD_HEAD,
  TRAITS_NEW_HEAD,
};
