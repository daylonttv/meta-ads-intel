/**
 * health-gate.mjs
 * Post-deploy staleness alarm. Reads data/data.json and EXITS NON-ZERO if any
 * monitored data source is unhealthy — which marks the GitHub Actions run as
 * failed, triggering GitHub's built-in failure email to the repo owner. No new
 * infrastructure needed.
 *
 * IMPORTANT: this is wired as the LAST step in update-dashboard.yml, AFTER the
 * data is committed and the dashboard is deployed. So a stale source still
 * publishes (dashboard keeps showing last-known-good data) — this step only
 * raises the alarm.
 *
 * A monitored source is UNHEALTHY for a run if any of these hold:
 *   - fetch failed this run            (meta.sources[name].ok === false)
 *   - it carried forward old data      (meta.sources[name].stale === true)
 *   - last successful refresh is older than the source's cadence window
 *     (now - meta.sources[name].updatedAt > refreshMaxDays)
 *   - its newest data point is older than its cadence allows (dataMaxDays)
 *
 * Thresholds are per-source so legitimately-slow feeds don't false-alarm
 * (e.g. EIA gas prices publish weekly). googleTrends is intentionally NOT
 * monitored — it's a known-broken unofficial source awaiting a paid
 * replacement (Daylon's call) and would otherwise fail every run.
 */
import { readFile } from 'fs/promises';

const DAY = 86400000;

// refreshMaxDays = how old the last SUCCESSFUL fetch may be (every source is
//   fetched daily, so this catches a feed that's been silently failing).
// dataMaxDays   = how old the newest DATA POINT may be (null = skip this check,
//   used where a date check is misleading: macroEvents can contain future
//   seasonal dates; outages can be legitimately empty).
const MONITORS = [
  { key: 'tripleWhale', label: 'Triple Whale (ad metrics)',   refreshMaxDays: 2, dataMaxDays: 3 },
  { key: 'breezeway',   label: 'Breezeway (platform health)', refreshMaxDays: 2, dataMaxDays: 3 },
  { key: 'gasPrices',   label: 'EIA gas prices (weekly)',     refreshMaxDays: 3, dataMaxDays: 14 },
  { key: 'macroEvents', label: 'Macro / social-news events',  refreshMaxDays: 3, dataMaxDays: null },
  { key: 'outages',     label: 'Meta outages',                refreshMaxDays: 3, dataMaxDays: null },
];

function newestDate(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr.map(d => d?.date).filter(Boolean).sort().at(-1) || null;
}

const data = JSON.parse(await readFile('data/data.json', 'utf-8'));
const sources = data.meta?.sources || {};
const now = Date.now();
const problems = [];

for (const m of MONITORS) {
  const s = sources[m.key];
  if (!s) { problems.push(`${m.label}: no status recorded`); continue; }
  if (s.ok === false) { problems.push(`${m.label}: fetch FAILED this run (ok=false)`); continue; }
  if (s.stale === true) { problems.push(`${m.label}: STALE — carried forward old data`); continue; }

  if (!s.updatedAt) { problems.push(`${m.label}: never successfully refreshed (no timestamp)`); continue; }
  const refreshAge = (now - new Date(s.updatedAt).getTime()) / DAY;
  if (refreshAge > m.refreshMaxDays) {
    problems.push(`${m.label}: last refreshed ${refreshAge.toFixed(1)}d ago (max ${m.refreshMaxDays}d)`);
    continue;
  }

  if (m.dataMaxDays != null) {
    const nd = newestDate(data[m.key]);
    if (!nd) { problems.push(`${m.label}: no data points`); continue; }
    const dataAge = (now - new Date(nd + 'T00:00:00Z').getTime()) / DAY;
    if (dataAge > m.dataMaxDays) {
      problems.push(`${m.label}: newest data ${nd} is ${dataAge.toFixed(1)}d old (max ${m.dataMaxDays}d)`);
    }
  }
}

if (problems.length) {
  console.error('::error::Dashboard health gate FAILED — stale/failed data source(s)');
  console.error('\n❌ HEALTH GATE FAILED — the following source(s) need attention:\n');
  for (const p of problems) console.error(`   • ${p}`);
  console.error('\nThe dashboard still deployed with last-known-good data; this run is marked');
  console.error('failed only to ALERT you (you should get a GitHub failure email). Investigate above.\n');
  process.exit(1);
}

console.log('✅ Health gate passed — all monitored sources fresh:');
for (const m of MONITORS) {
  const s = sources[m.key] || {};
  console.log(`   • ${m.label}: ok=${s.ok} stale=${s.stale} updatedAt=${s.updatedAt || 'n/a'}`);
}
console.log('\n(Note: googleTrends is intentionally not monitored — known-broken pending a paid source.)');
