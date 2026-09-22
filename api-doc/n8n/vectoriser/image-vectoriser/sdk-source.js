// Emits the n8n Workflow-SDK source for wi-mall-image-vectoriser from the SAME
// definition build-workflow.js writes to JSON -- so the workflow created through
// the MCP (which only accepts SDK code) ships the tested node bodies byte for byte.
//   node build-workflow.js && node sdk-source.js > wi-mall-image-vectoriser.sdk.js
const wf = require('./wi-mall-image-vectoriser.json');
const lit = (v) => JSON.stringify(v, null, 2);
const ident = (name) => 'n_' + name.replace(/[^A-Za-z0-9]/g, '_');
const out = [];
out.push("import { workflow, node, trigger } from '@n8n/workflow-sdk';", '');
for (const n of wf.nodes) {
  const isTrigger = /Trigger$/.test(n.type);
  const config = { name: n.name, parameters: n.parameters, position: n.position };
  if (n.credentials) config.credentials = n.credentials;
  if (n.onError) config.onError = n.onError;
  if (n.alwaysOutputData) config.alwaysOutputData = n.alwaysOutputData;
  out.push(`const ${ident(n.name)} = ${isTrigger ? 'trigger' : 'node'}(${lit({ type: n.type, version: n.typeVersion, config })});`, '');
}
let chain = `export default workflow('wi-mall-image-vectoriser', ${JSON.stringify(wf.name)})\n  .add(${ident(wf.nodes[0].name)})`;
for (const n of wf.nodes.slice(1)) chain += `\n  .to(${ident(n.name)})`;
out.push(chain + ';');
process.stdout.write(out.join('\n') + '\n');
