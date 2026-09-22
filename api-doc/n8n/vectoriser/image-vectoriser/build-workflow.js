// Assembles wi-mall-image-vectoriser.json from nodes/*.js.
//
//   node build-workflow.js          writes ./wi-mall-image-vectoriser.json
//
// The Code node bodies live in nodes/ so test.js can execute them offline; this
// script is the only thing that copies them into the workflow. Edit the .js,
// re-run this, re-import -- never edit the JSON's jsCode by hand, or the tested
// code and the shipped code become two things.
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, 'nodes', f), 'utf8');

// ⚠ THE TWO FREE-TIER NUMBERS. Voyage without a payment method allows 3 requests
// and 10K tokens a minute, and bills a full-size photo at up to ~3,572 tokens
// (2M pixels / 560). One request a minute of at most two photos is ~7.1K tokens,
// which leaves room for the live search's own multimodal calls inside the same
// minute. On a paid tier, raise BATCH (Voyage takes up to 1,000 inputs and 320K
// tokens a request); nothing else changes shape.
const EVERY_MINUTES = 1;
const BATCH = 2;

const VOYAGE_CREDENTIAL = { id: 'aIUCGerxuUIrWTtO', name: 'Voyage Bearer' };   // README § 11
const POSTGRES_CREDENTIAL = { id: 'ZsOTxlRX7LiLABjX', name: 'Postgres account' }; // vector_db; README § 6
const ERROR_WORKFLOW = 'd2JZ7jA2jJCg0O9S';   // the ADR-022 failure reporter; see ../../../../CLAUDE.md

let x = 0;
const at = () => [(x += 220) - 220, 300];

const nodes = [
  {
    name: 'every minute',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: at(),
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: EVERY_MINUTES }] } },
  },
  {
    name: 'mint claim id',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: at(),
    parameters: {
      jsCode:
        "// One id per run, read by every later node through $('mint claim id') -- one\n" +
        '// source, so the claim and the settle can never disagree about which run they are.\n' +
        "return [{ json: { claim_id: 'img-' + $execution.id + '-' + Date.now() } }];\n",
    },
  },
  {
    name: 'claim images',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.7,
    position: at(),
    parameters: {
      operation: 'executeQuery',
      query:
        `-- At most ${BATCH} images: the free tier's per-minute budget. product_vectors.sql explains the order.\n` +
        'SELECT * FROM product_image_claim(p_claim_id => $1, p_max_images => $2::int);',
      options: { queryReplacement: `={{ [ $json.claim_id, ${BATCH} ] }}` },
    },
    credentials: { postgres: POSTGRES_CREDENTIAL },
  },
  {
    name: 'build embed request',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: at(),
    parameters: { jsCode: read('build-embed-request.js') },
  },
  {
    name: 'embed images',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.5,
    position: at(),
    // No retryOnFail: with neverError a non-2xx is not a failure, so it would be
    // inert for exactly the 429 it would be added for (README § 11). The next
    // minute's run IS the retry.
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://api.voyageai.com/v1/multimodalembeddings',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.body) }}',
      options: {
        response: { response: { fullResponse: true, neverError: true } },
        timeout: 60000,
      },
    },
    credentials: { httpHeaderAuth: VOYAGE_CREDENTIAL },
  },
  {
    name: 'assemble results',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: at(),
    parameters: { jsCode: read('assemble-results.js') },
  },
  {
    name: 'settle images',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.7,
    position: at(),
    // Zero rows written must still reach `verify settled` -- that is the case it checks.
    alwaysOutputData: true,
    parameters: {
      operation: 'executeQuery',
      query: 'SELECT * FROM product_image_settle(p_claim_id => $1, p_results => $2::jsonb);',
      // ⚠ An ARRAY expression: the results JSON is full of commas and the
      // comma-separated form would shred it (README § 8).
      options: { queryReplacement: '={{ [ $json.claim_id, JSON.stringify($json.results) ] }}' },
    },
    credentials: { postgres: POSTGRES_CREDENTIAL },
  },
  {
    name: 'verify settled',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: at(),
    parameters: { jsCode: read('verify-settled.js') },
  },
];

const connections = {};
for (let i = 0; i < nodes.length - 1; i++) {
  connections[nodes[i].name] = { main: [[{ node: nodes[i + 1].name, type: 'main', index: 0 }]] };
}

const workflow = {
  name: 'UP-wi-mall-image-vectoriser',
  nodes,
  connections,
  settings: {
    executionOrder: 'v1',
    errorWorkflow: ERROR_WORKFLOW,
    // 1,440 runs a day, nearly all of them "nothing to claim". Keeping every
    // successful one would fill n8n's execution store with noise; failures are
    // kept, and they are the ones that report to the automation board.
    saveDataSuccessExecution: 'none',
    saveDataErrorExecution: 'all',
    saveManualExecutions: true,
  },
};

const out = path.join(__dirname, 'wi-mall-image-vectoriser.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2) + '\n');
console.log(`wrote ${path.relative(process.cwd(), out)} — ${nodes.length} nodes, batch ${BATCH} every ${EVERY_MINUTES} min`);
