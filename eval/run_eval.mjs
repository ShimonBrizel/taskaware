#!/usr/bin/env node
// TaskAware AI evaluation harness.
// Sends every case in cases.json to the real /api/ask-ai/ endpoint (the same
// code path the app uses: prompt + Gemini + server post-processing), scores the
// result field by field, and writes a JSON + Markdown report to eval/results/.
//
// Usage:
//   node eval/run_eval.mjs                 run all cases against the server
//   node eval/run_eval.mjs --dry-run       no network: self-test the scorer
//   node eval/run_eval.mjs --limit 5       run only the first 5 cases
//   node eval/run_eval.mjs --tag multi     run only cases with this tag
//   node eval/run_eval.mjs --delay 7000    ms between calls (Gemini free tier ~10 RPM)
//   node eval/run_eval.mjs --repeat 3      run each case 3 times (consistency)
//
// Auth (eval/.env): TASKAWARE_TOKEN=..., or EVAL_USERNAME + EVAL_PASSWORD.
// Optional: TASKAWARE_BASE_URL (default https://taskaware-shimon.onrender.com).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ISRAEL_OFFSET_HOURS = 2; // November = winter time (+02:00)

// Same category resolution as resolve_google_place_config() in views_helpers.py,
// so "grocery" counts as supermarket exactly like it does on the server.
const CATALOG = [
  ['supermarket', ['grocery', 'grocer', 'market', 'convenience']],
  ['pharmacy', ['chemist', 'drugstore']],
  ['post_office', ['postoffice']],
  ['bank', []],
  ['atm', []],
  ['cafe', []],
  ['restaurant', []],
  ['gym', []],
  ['bakery', []],
  ['hardware_store', ['hardwarestore']],
  ['electronics_store', ['electronicsstore']],
  ['library', []],
  ['print_shop', ['printing', 'copyshop', 'print']],
  ['park', []],
];

// ---------- helpers ----------
function parseArgs(argv) {
  const args = { dryRun: false, limit: Infinity, tag: null, delay: 7000, repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--tag') args.tag = argv[++i];
    else if (a === '--delay') args.delay = Number(argv[++i]);
    else if (a === '--repeat') args.repeat = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9֐-׿]+/g, ' ').trim().replace(/ /g, '_');
}

function resolveCategory(query) {
  if (query == null || query === '') return null;
  const n = normalize(query);
  for (const [key, extra] of CATALOG) {
    const aliases = [key, key.replace(/_/g, ''), ...extra];
    if (aliases.some((a) => n.includes(a))) return key;
  }
  return `other:${n}`;
}

const isEmpty = (v) => v === null || v === undefined || v === '' || (typeof v === 'string' && v.toLowerCase() === 'null');

// Returns { date: 'YYYY-MM-DD', hour: n } in Israel local time.
function toLocal(due) {
  if (isEmpty(due)) return null;
  const s = String(due);
  if (/(Z|[+-]\d\d:?\d\d)$/.test(s)) {
    const d = new Date(s);
    if (isNaN(d)) return { date: 'invalid', hour: -1 };
    const local = new Date(d.getTime() + ISRAEL_OFFSET_HOURS * 3600e3);
    return { date: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}))?/);
  if (!m) return { date: 'invalid', hour: -1 };
  return { date: m[1], hour: m[2] ? Number(m[2]) : null };
}

// ---------- scoring ----------
function scoreField(field, expected, pred) {
  if (expected === 'ANY') return null; // not scored
  if (field === 'location') {
    if (expected === null) return isEmpty(pred);
    if (expected === 'ANY_NON_NULL') return !isEmpty(pred);
    return expected.includes(resolveCategory(pred));
  }
  if (field === 'context' || field === 'condition') {
    if (expected === null) return isEmpty(pred);
    return !isEmpty(pred) && expected.includes(String(pred).toLowerCase());
  }
  if (field === 'due') {
    const local = toLocal(pred);
    if (expected === null) return local === null;
    if (!local || local.date !== expected.date) return false;
    if (!expected.hours) return true;
    return local.hour !== null && local.hour >= expected.hours[0] && local.hour <= expected.hours[1];
  }
  throw new Error(field);
}

function predFields(p) {
  return { location: p.locationQuery, context: p.requiredContext, condition: p.contextCondition, due: p.dueDate };
}

const FIELDS = ['location', 'context', 'condition', 'due'];

function scoreTask(exp, pred) {
  const f = predFields(pred || {});
  const out = {};
  for (const k of FIELDS) out[k] = pred ? scoreField(k, exp[k], f[k]) : (exp[k] === 'ANY' ? null : false);
  return out;
}

// Greedy alignment: each expected task takes the unused prediction that scores best
// (ties keep original order), so a correct answer in a different order is not punished.
function scoreCase(c, predictions) {
  const used = new Set();
  const perTask = c.expected.map((exp) => {
    let best = null;
    predictions.forEach((p, idx) => {
      if (used.has(idx)) return;
      const s = scoreTask(exp, p);
      const hits = Object.values(s).filter((v) => v === true).length;
      if (!best || hits > best.hits) best = { idx, s, hits };
    });
    if (best) used.add(best.idx);
    return { expected: exp, predIndex: best ? best.idx : null, fields: best ? best.s : scoreTask(exp, null) };
  });
  const countOk = predictions.length === c.expected.length;
  const allOk = countOk && perTask.every((t) => Object.values(t.fields).every((v) => v !== false));
  return { countOk, allOk, perTask };
}

// ---------- network ----------
async function getToken(base) {
  if (process.env.TASKAWARE_TOKEN) return process.env.TASKAWARE_TOKEN;
  const { EVAL_USERNAME: username, EVAL_PASSWORD: password } = process.env;
  if (!username || !password) throw new Error('Set TASKAWARE_TOKEN or EVAL_USERNAME + EVAL_PASSWORD in eval/.env');
  const res = await fetch(`${base}/api/login/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Login failed: HTTP ${res.status}`);
  return (await res.json()).token;
}

async function warmUp(base) {
  // Render free instances sleep; the first request can take ~1 minute. Not timed.
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(`${base}/api/health/`, { signal: AbortSignal.timeout(90_000) });
      if (res.status < 500) { console.log(`Server awake (${Math.round((Date.now() - t0) / 1000)}s)`); return; }
    } catch { /* retry */ }
    await sleep(10_000);
  }
  throw new Error(`Server at ${base} did not respond`);
}

async function askAi(base, token, c, deviceTime) {
  const body = { title: c.text, deviceTime };
  if (c.coords) { body.latitude = c.coords[0]; body.longitude = c.coords[1]; }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = performance.now();
    let res, data, err = null;
    try {
      res = await fetch(`${base}/api/ask-ai/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      data = await res.json().catch(() => null);
    } catch (e) { err = e.message; }
    const ms = Math.round(performance.now() - t0);
    if (!err && res.ok && Array.isArray(data)) return { ok: true, ms, data };
    const reason = err || `HTTP ${res.status} ${JSON.stringify(data)}`;
    if (attempt === 2) return { ok: false, ms, error: reason };
    console.log(`  retrying ${c.id} after error: ${reason}`);
    await sleep(15_000); // usually a Gemini rate limit surfaced as HTTP 500
  }
}

// ---------- report ----------
function pct(n, d) { return d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a'; }
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function summarize(runs) {
  const field = Object.fromEntries(FIELDS.map((f) => [f, { ok: 0, n: 0 }]));
  const tags = {};
  let cases = 0, exact = 0, countOk = 0, errors = 0, supermarketDefault = 0;
  const latencies = [];
  for (const r of runs) {
    cases++;
    if (!r.ok) errors++; else latencies.push(r.ms);
    if (r.score.allOk) exact++;
    if (r.score.countOk) countOk++;
    for (const t of r.score.perTask) {
      for (const f of FIELDS) {
        if (t.fields[f] === null) continue;
        field[f].n++; if (t.fields[f]) field[f].ok++;
      }
      const p = r.ok && t.predIndex !== null ? r.data[t.predIndex] : null;
      if (t.expected.location === null && p && resolveCategory(p.locationQuery) === 'supermarket') supermarketDefault++;
    }
    for (const tag of r.case.tags) {
      tags[tag] ??= { ok: 0, n: 0 };
      tags[tag].n++; if (r.score.allOk) tags[tag].ok++;
    }
  }
  return {
    cases, exact, countOk, errors, supermarketDefault, field, tags,
    latency: { n: latencies.length, p50: percentile(latencies, 50), p90: percentile(latencies, 90), max: latencies.length ? Math.max(...latencies) : null },
  };
}

function markdown(sum, runs, meta) {
  const L = [];
  L.push(`# TaskAware AI eval: ${meta.startedAt}`, '');
  L.push(`Endpoint: \`${meta.base}/api/ask-ai/\` · cases: ${sum.cases} · repeat: ${meta.repeat} · device time: ${meta.deviceTime}`, '');
  L.push('## Headline', '');
  L.push('| Metric | Result |', '|---|---|');
  L.push(`| Cases fully correct (every field + task count) | **${pct(sum.exact, sum.cases)}** (${sum.exact}/${sum.cases}) |`);
  L.push(`| Task count correct (multi-task splitting) | ${pct(sum.countOk, sum.cases)} |`);
  for (const f of FIELDS) L.push(`| Field accuracy: ${f} | ${pct(sum.field[f].ok, sum.field[f].n)} (${sum.field[f].ok}/${sum.field[f].n}) |`);
  L.push(`| Latency p50 / p90 / max | ${sum.latency.p50 ?? '-'} / ${sum.latency.p90 ?? '-'} / ${sum.latency.max ?? '-'} ms |`);
  L.push(`| Request errors | ${sum.errors} |`);
  L.push(`| No-place tasks forced to "supermarket" | ${sum.supermarketDefault} |`, '');
  L.push('## By tag (fully correct cases)', '', '| Tag | Result |', '|---|---|');
  for (const [t, v] of Object.entries(sum.tags).sort()) L.push(`| ${t} | ${pct(v.ok, v.n)} (${v.ok}/${v.n}) |`);
  L.push('', '## Failures', '');
  const fails = runs.filter((r) => !r.score.allOk);
  if (!fails.length) L.push('None.');
  for (const r of fails) {
    L.push(`### ${r.case.id}: ${r.case.text}`);
    if (!r.ok) { L.push(`- request error: ${r.error}`, ''); continue; }
    if (!r.score.countOk) L.push(`- task count: expected ${r.case.expected.length}, got ${r.data.length}`);
    r.score.perTask.forEach((t, i) => {
      const bad = FIELDS.filter((f) => t.fields[f] === false);
      if (!bad.length) return;
      const p = t.predIndex !== null ? predFields(r.data[t.predIndex]) : {};
      for (const f of bad) L.push(`- task ${i + 1} ${f}: expected \`${JSON.stringify(t.expected[f])}\`, got \`${JSON.stringify(p[f] ?? null)}\``);
    });
    L.push(`- raw: \`${JSON.stringify(r.data)}\``, '');
  }
  return L.join('\n');
}

// ---------- dry run ----------
function fakeFromExpected(exp) {
  const loc = exp.location === null ? null : exp.location === 'ANY_NON_NULL' || exp.location === 'ANY' ? 'Aroma' : exp.location[0];
  const pick = (v) => (v === null || v === 'ANY' ? null : v[0]);
  let due = null;
  if (exp.due && exp.due !== 'ANY') due = `${exp.due.date}T${String(exp.due.hours ? exp.due.hours[0] : 12).padStart(2, '0')}:00:00`;
  return { title: 'x', locationQuery: loc, requiredContext: pick(exp.context), contextCondition: pick(exp.condition), dueDate: due };
}

function selfTest(cases) {
  let bad = 0;
  for (const c of cases) {
    const perfect = c.expected.map(fakeFromExpected).reverse(); // reversed: alignment must still match
    if (!scoreCase(c, perfect).allOk) { bad++; console.log(`  perfect answer scored wrong: ${c.id}`); }
    const broken = [{ title: 'x', locationQuery: 'zzz', requiredContext: 'gym', contextCondition: 'during', dueDate: '1999-01-01T00:00:00' }];
    if (scoreCase(c, broken).allOk) { bad++; console.log(`  broken answer scored right: ${c.id}`); }
  }
  // spot checks of the parsing helpers
  const checks = [
    [resolveCategory('Grocery store'), 'supermarket'],
    [resolveCategory('post office'), 'post_office'],
    [toLocal('2026-11-12T06:00:00Z').hour, 8],
    [toLocal('2026-11-12T08:00:00+02:00').hour, 8],
    [toLocal('2026-11-12').hour, null],
    [isEmpty('null'), true],
  ];
  checks.forEach(([got, want], i) => { if (got !== want) { bad++; console.log(`  helper check ${i} got ${got}, want ${want}`); } });
  console.log(bad ? `Self-test FAILED (${bad})` : `Self-test passed: ${cases.length} cases, scorer and helpers OK`);
  return bad === 0;
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv(path.join(HERE, '.env'));
  const { meta, cases: all } = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const ids = new Set();
  for (const c of all) { if (ids.has(c.id)) throw new Error(`Duplicate id ${c.id}`); ids.add(c.id); }
  const cases = all.filter((c) => !args.tag || c.tags.includes(args.tag)).slice(0, args.limit);

  if (args.dryRun) process.exit(selfTest(cases) ? 0 : 1);

  const base = (process.env.TASKAWARE_BASE_URL || 'https://taskaware-shimon.onrender.com').replace(/\/$/, '');
  await warmUp(base);
  const token = await getToken(base);

  const runs = [];
  const total = cases.length * args.repeat;
  for (let rep = 0; rep < args.repeat; rep++) {
    for (const c of cases) {
      const r = await askAi(base, token, c, meta.deviceTime);
      const score = scoreCase(c, r.ok ? r.data : []);
      runs.push({ case: c, rep, ...r, score });
      console.log(`[${runs.length}/${total}] ${score.allOk ? 'PASS' : 'FAIL'} ${c.id} (${r.ms} ms)${r.ok ? '' : ' ERROR ' + r.error}`);
      if (runs.length < total) await sleep(args.delay);
    }
  }

  const sum = summarize(runs);
  const startedAt = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(HERE, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `run-${startedAt}.json`), JSON.stringify({ meta: { base, repeat: args.repeat }, summary: sum, runs }, null, 2));
  const md = markdown(sum, runs, { base, repeat: args.repeat, deviceTime: meta.deviceTime, startedAt });
  fs.writeFileSync(path.join(outDir, `run-${startedAt}.md`), md);
  console.log('\n' + md.split('## By tag')[0]);
  console.log(`Report: eval/results/run-${startedAt}.md`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
