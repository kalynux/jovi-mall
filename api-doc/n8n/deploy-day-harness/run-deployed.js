// The proofs, run against the bodies that are ACTUALLY on the server — not the full deploy-day
// build, which still contains sections that need nodes the server does not have yet (§ 4.6's
// `recall awaiting`). Record: ../N8N-DEPLOY-DAY-CHANGES.md § 5.1.
//   compose agent input  = live + § 6 only        (new/s6only_compose_agent_input.txt)
//   compose agent reply  = § 5 + § 6 + § 5.1      (build-live-fixes.js)
//   drop duplicate reply = § 5                     (build-new.js, unchanged)
// Run: node run-deployed.js   Exit code = number of failures.
const fs = require('fs');
const path = require('path');
const build = require('./build-new');
const { FIX } = require('./build-live-fixes');

// compose agent input = live § 6 body + § 4.6 (since 2026-09-21, the § 4.6 apply).
build.NEW['core:compose agent input'] = FIX['compose agent input'];
build.NEW['core:compose agent reply'] = FIX['compose agent reply'];

require('./test-s46');
require('./test-s5');
require('./test-s6');
require('./test-live-fixes');
process.exitCode = require('./n8n-sim').report();
