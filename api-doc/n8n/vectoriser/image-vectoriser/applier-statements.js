// The statements `wi-mall-vectoriser-schema` runs, cut out of product_vectors.sql
// -- the SOURCE OF TRUTH -- so the applier's node queries can be checked against
// the file rather than trusted to have been pasted correctly.
//
//   node applier-statements.js                       list the applier's statements
//   node applier-statements.js --check <details.json>
//        compare a `get_workflow_details` dump of wi-mall-vectoriser-schema with
//        the file; exit code = number of nodes that differ or are missing
const fs = require('fs');
const path = require('path');

// A minimal splitter: top-level `;` ends a statement; dollar-quoted bodies,
// quoted strings and -- comments are skipped over.
function splitSql(sql) {
  const out = [];
  let start = 0, i = 0, dollar = null;
  while (i < sql.length) {
    if (dollar) {
      if (sql.startsWith(dollar, i)) { i += dollar.length; dollar = null; } else i++;
      continue;
    }
    if (sql.startsWith('--', i)) { const nl = sql.indexOf('\n', i); i = nl < 0 ? sql.length : nl + 1; continue; }
    if (sql[i] === "'") { i++; while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1; i++; continue; }
    const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
    if (m) { dollar = m[0]; i += dollar.length; continue; }
    if (sql[i] === ';') { out.push(sql.slice(start, i + 1)); start = i + 1; }
    i++;
  }
  // Leading comment lines belong to the file's prose, not to the statement.
  return out.map(s => s.replace(/^(\s*--[^\n]*\n|\s*\n)*/, '').trim()).filter(Boolean);
}

// Node name → the statement's opening, in the order the applier runs them.
// ⚠ product_search() now reads product_image_vectors, and a LANGUAGE sql body is
// checked at CREATE time -- so every image statement must run BEFORE step 3/4.
const APPLIER = [
  ['1. Query Cache Table', /^CREATE TABLE IF NOT EXISTS product_search_query_cache\b/],
  ['2. Query Cache Index', /^CREATE INDEX IF NOT EXISTS product_search_query_cache_last_used_idx\b/],
  ['2a. Image Vectors Table', /^CREATE TABLE IF NOT EXISTS product_image_vectors\b/],
  ['2b. Image Work Index', /^CREATE INDEX IF NOT EXISTS product_image_vectors_work_idx\b/],
  ['2c. Image Sync Function', /^CREATE OR REPLACE FUNCTION product_image_vectors_sync\b/],
  ['2d. Image Insert Trigger', /^CREATE OR REPLACE TRIGGER product_vectors_images_insert\b/],
  ['2e. Image Update Trigger', /^CREATE OR REPLACE TRIGGER product_vectors_images_update\b/],
  ['2f. Drop Claim/Settle Overloads', /^DO \$drop_image_fns\$/],
  ['2g. Create product_image_claim', /^CREATE FUNCTION product_image_claim\b/],
  ['2h. Create product_image_settle', /^CREATE FUNCTION product_image_settle\b/],
  ['2i. Image Query Cache Table', /^CREATE TABLE IF NOT EXISTS product_image_query_cache\b/],
  ['2j. Image Query Cache Index', /^CREATE INDEX IF NOT EXISTS product_image_query_cache_last_used_idx\b/],
  ['3. Drop Every product_search Overload', /^DO \$drop_search\$/],
  ['4. Create product_search', /^CREATE OR REPLACE FUNCTION product_search\b/],
];

function applierStatements(file = path.join(__dirname, '..', 'product_vectors.sql')) {
  const stmts = splitSql(fs.readFileSync(file, 'utf8'));
  return APPLIER.map(([name, re]) => {
    const hits = stmts.filter(s => re.test(s));
    if (hits.length !== 1) throw new Error(`${name}: ${hits.length} statements match ${re} -- expected exactly 1`);
    return { name, sql: hits[0] };
  });
}

if (require.main === module) {
  const list = applierStatements();
  const i = process.argv.indexOf('--check');
  if (i < 0) {
    for (const s of list) console.log(`${s.name.padEnd(40)} ${String(s.sql.length).padStart(6)} chars  ${s.sql.split('\n')[0].slice(0, 70)}`);
  } else {
    const raw = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
    const wf = raw.workflow || raw;
    let bad = 0;
    for (const s of list) {
      const node = wf.nodes.find(n => n.name === s.name);
      const same = node && node.parameters.query.trim() === s.sql;
      if (!same) bad++;
      console.log(`${same ? '  ✔' : '  ✘'} ${s.name}${node ? '' : '  (MISSING)'}`);
    }
    // and the chain runs them in this order
    const chain = []; let cur = 'Apply Schema';
    while (cur) { chain.push(cur); cur = wf.connections[cur]?.main?.[0]?.[0]?.node; }
    const want = ['Apply Schema', ...list.map(s => s.name), '5. Verify', '6. Calibrate Relevance Floor'];
    const ordered = JSON.stringify(chain.slice(0, want.length)) === JSON.stringify(want);
    if (!ordered) bad++;
    console.log(`${ordered ? '  ✔' : '  ✘'} chain order${ordered ? '' : ': ' + chain.join(' → ')}`);
    process.exit(bad);
  }
}

module.exports = { splitSql, applierStatements };
