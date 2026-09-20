// Deploy-day change set proofs — the record is ../N8N-DEPLOY-DAY-CHANGES.md § 11.
// Run: node run.js   (no n8n, no network, no database). Exit code = number of failures.
require('./test-s1-s2');
require('./test-s3');
require('./test-s4');
require('./test-s5');
require('./test-s6');
process.exitCode = require('./n8n-sim').report();
