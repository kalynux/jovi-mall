// A minimal stand-in for the n8n runtime, enough to execute a Code node's jsCode and an
// expression exactly as they are stored on the live workflow. No n8n, no network.
//
// ⚠ Faithful where it matters to these proofs, and deliberately strict:
//   · `$('X')` on a node that did NOT run throws on .first()/.all()/.item, as n8n does —
//     so a new node that forgets its `isExecuted` guard fails here, not in production.
//   · `isExecuted` is true only for nodes the scenario lists.
function nodeAccessor(nodes) {
  return function $(name) {
    const ran = Object.prototype.hasOwnProperty.call(nodes, name);
    const items = ran ? nodes[name] : null;
    const refuse = () => { throw new Error(`Referenced node "${name}" is unexecuted`); };
    return {
      isExecuted: ran,
      first: () => (ran ? items[0] : refuse()),
      last: () => (ran ? items[items.length - 1] : refuse()),
      all: () => (ran ? items : refuse()),
      get item() { return ran ? items[0] : refuse(); },
    };
  };
}

/**
 * `$now`, as n8n exposes it: a Luxon DateTime, not a JS Date.
 *
 * ⚠ **`toISO()` emits a ZONE OFFSET**, not a `Z`; `toUTC().toISO()` is what emits `Z`. That
 * distinction is not pedantry here — it once made every automation failure report on this
 * platform refuse with `400 AUTOMATION_REPORT_MALFORMED` for eight days, against a validator
 * that accepted only `Z`. The stub keeps the difference rather than smoothing it away.
 */
function luxonNow(atMs) {
  const shift = (d) => (d.milliseconds || 0) + (d.seconds || 0) * 1000 + (d.minutes || 0) * 60000
    + (d.hours || 0) * 3600000 + (d.days || 0) * 86400000;
  const make = (ms) => ({
    plus: (d = {}) => make(ms + shift(d)),
    minus: (d = {}) => make(ms - shift(d)),
    toMillis: () => ms,
    toUTC: () => ({ toISO: () => new Date(ms).toISOString(), toMillis: () => ms }),
    toISO: () => {
      const offsetMinutes = -new Date(ms).getTimezoneOffset();
      const sign = offsetMinutes >= 0 ? '+' : '-';
      const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
      const local = new Date(ms + offsetMinutes * 60000).toISOString().slice(0, 23);
      return `${local}${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
    },
  });
  return make(atMs === undefined ? Date.now() : atMs);
}

/** Run a Code node. mode 'all' returns an item array; mode 'each' runs per input item. */
function runCode(jsCode, { nodes = {}, input = [], mode = 'all' } = {}) {
  const $ = nodeAccessor(nodes);
  if (mode === 'each') {
    return input.map((item) => {
      const $input = { item, first: () => item, all: () => [item] };
      // eslint-disable-next-line no-new-func
      const fn = new Function('$', '$input', '$json', '$now', jsCode);
      return fn($, $input, item.json, luxonNow());
    });
  }
  const $input = { first: () => input[0], all: () => input, get item() { return input[0]; } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('$', '$input', '$json', '$now', jsCode);
  return fn($, $input, input[0] ? input[0].json : undefined, luxonNow());
}

/** Evaluate a stored n8n expression (`={{ … }}`) as the node would. */
function evalExpr(expr, { nodes = {}, json = {}, env = {} } = {}) {
  const m = /^=\{\{([\s\S]*)\}\}$/.exec(String(expr).trim());
  if (!m) throw new Error('not a single {{ }} expression: ' + String(expr).slice(0, 80));
  const $ = nodeAccessor(nodes);
  // eslint-disable-next-line no-new-func
  const fn = new Function('$', '$json', '$env', '$execution', '$now', `return (${m[1]});`);
  return fn($, json, env, { id: 'sim' }, luxonNow());
}

let passed = 0;
let failed = 0;
const rows = [];
function check(section, name, ok, detail) {
  if (ok) passed += 1; else failed += 1;
  rows.push({ section, name, ok: !!ok, detail: detail || '' });
}
function report() {
  let current = null;
  for (const r of rows) {
    if (r.section !== current) { current = r.section; console.log(`\n── ${current}`); }
    console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok || !r.detail ? '' : '\n      ' + r.detail}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed;
}

module.exports = { runCode, evalExpr, luxonNow, check, report, j: (json) => ({ json }) };
