/**
 * gen-macro.mjs  (one-off / manual seeding tool)
 * Two steps so it works cross-platform (Node can't spawn bash on Windows):
 *   1) node scripts/gen-macro.mjs build              -> writes scripts/.macro-prompt.txt
 *      gemini -p "$(cat scripts/.macro-prompt.txt)" > scripts/.macro-raw.txt   (run in bash)
 *   2) node scripts/gen-macro.mjs inject             -> validates .macro-raw.txt, writes data.json
 *
 * Uses the local Gemini CLI (OAuth, no API key) WITH web search so events are REAL for the
 * current window — the dashboard date range is "now", which is past the model's training
 * cutoff, so ungrounded generation would hallucinate. Validated with the pipeline validator.
 */
import { readFileSync, writeFileSync } from 'fs';
import { parseAndValidateEvents } from './fetch-data.mjs';

const MODE = process.argv[2] || 'build';
const data = JSON.parse(readFileSync('data/data.json', 'utf8'));
const start = data.meta?.dateRange?.start, end = data.meta?.dateRange?.end;
const PROMPT_FILE = 'scripts/.macro-prompt.txt';
const RAW_FILE = 'scripts/.macro-raw.txt';

function anomalyContext(tw) {
  const roas = (tw || []).filter(d => d.metaRoas > 0.1);
  const cpa = (tw || []).filter(d => d.metaCpa > 1);
  if (roas.length < 3) return '';
  const avgR = roas.reduce((s, d) => s + d.metaRoas, 0) / roas.length;
  const avgC = cpa.length ? cpa.reduce((s, d) => s + d.metaCpa, 0) / cpa.length : 0;
  const rows = (tw || []).filter(d => {
    const r = d.metaRoas > 0.1 && Math.abs(d.metaRoas - avgR) / avgR > 0.25;
    const c = avgC > 0 && d.metaCpa > 1 && Math.abs(d.metaCpa - avgC) / avgC > 0.30;
    return r || c;
  }).map(d => {
    const p = [];
    if (d.metaRoas > 0.1) p.push(`ROAS ${d.metaRoas.toFixed(2)}× (avg ${avgR.toFixed(2)}×)`);
    if (d.metaCpa > 1 && avgC > 0) p.push(`CPA $${d.metaCpa.toFixed(0)} (avg $${avgC.toFixed(0)})`);
    return `  ${d.date}: ${p.join(', ')}`;
  });
  return rows.length ? `\n\nOUR ANOMALOUS PERFORMANCE DAYS — prioritize explaining these specific dates:\n${rows.join('\n')}` : '';
}

if (MODE === 'build') {
  if (!start || !end) { console.error('No date range in data.json'); process.exit(1); }
  const holidayCtx = (data.holidays || []).length
    ? `\n\nKNOWN HOLIDAYS IN THIS WINDOW: ${data.holidays.map(h => `${h.date} ${h.name}`).join(', ')}` : '';
  const anomalyCtx = anomalyContext(data.tripleWhale);

  const prompt = `Use the google_web_search tool to research what REALLY happened, then return JSON. This is for Gardner's Wisconsin Cheese — a US DTC specialty food brand (artisan cheese shipped nationally, avg order ~$45, gifting-heavy).

GOAL: real events from ${start} to ${end} (and gift occasions up to ~2 weeks after) that would affect Meta ad performance or US consumer spending mood.${anomalyCtx}${holidayCtx}

STEP 1 — SEARCH the web for each of these in the ${start}..${end} window and use the actual findings:
  • US gas prices / AAA average, CPI / inflation print, U. of Michigan or Conference Board consumer sentiment, major tariff/trade or jobs/layoff news
  • the biggest news / political / tragedy / viral / sports / celebrity stories that dominated US social feeds
  • any Meta / Facebook / Instagram ad-platform outages, auction or policy changes reported by advertisers
STEP 2 — return 8–14 events. EVERY event must be a REAL event you found, with its real date and a real source. Do NOT invent events or numbers. If you cannot verify enough, return fewer.

Each event = ALL fields:
- date (YYYY-MM-DD, within ${start}..${end} or just after for seasonal)
- description (<=15 words; include the real data point, e.g. "U. of Michigan sentiment fell to 52.2")
- details (3–4 sentences: what the metric/event IS + baseline; what actually happened; expected impact on Meta ROAS/CPA for a DTC food-gifting brand; optional action)
- intensity (1 minor | 2 notable | 3 major)
- category (wallet | feed | platform | seasonal)
- icon (💰 wallet | 📱 feed | 🔴 platform | 🗓️ seasonal)
- mood_impact (suppresses_spending | boosts_spending | neutral)
- feed_dominance (high | medium | low)
- source (the real publication/agency you found it in)
${anomalyCtx ? 'Prioritize explaining the anomalous performance days listed above.' : ''}

Output ONLY a valid JSON array, no markdown fences, no preamble, no trailing text.
[{"date":"YYYY-MM-DD","description":"...","details":"...","intensity":2,"category":"feed","icon":"📱","mood_impact":"suppresses_spending","feed_dominance":"high","source":"AP News"}]`;

  writeFileSync(PROMPT_FILE, prompt);
  console.log(`Built prompt for ${start} → ${end} (anomaly:${anomalyCtx ? 'yes' : 'no'}, holidays:${(data.holidays || []).length}).`);
  console.log(`Now run:  gemini -p "$(cat ${PROMPT_FILE})" > ${RAW_FILE}`);
} else if (MODE === 'inject') {
  const raw = readFileSync(RAW_FILE, 'utf8');
  const events = parseAndValidateEvents(raw);
  console.log(`Validated events: ${events?.length || 0}`);
  if (!events?.length) { console.log('Raw (first 800):\n', raw.slice(0, 800)); process.exit(1); }
  events.forEach(e => console.log(`  ${e.date} [${e.category}/${e.mood_impact}/${e.feed_dominance}] ${e.description.slice(0, 64)} — ${e.source}`));
  if (process.argv.includes('--dry')) { console.log('\n--dry: not writing.'); process.exit(0); }
  data.macroEvents = events;
  data.meta.sources = data.meta.sources || {};
  data.meta.sources.macroEvents = { ok: true, updatedAt: new Date().toISOString(), stale: false, source: 'gemini-cli-manual' };
  writeFileSync('data/data.json', JSON.stringify(data, null, 2));
  console.log(`\n✅ Injected ${events.length} macro events into data/data.json`);
} else {
  console.error(`Unknown mode "${MODE}" (use: build | inject)`);
  process.exit(1);
}
