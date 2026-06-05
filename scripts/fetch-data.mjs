/**
 * fetch-data.mjs
 * Pulls data from all sources and writes data/data.json
 *
 * Sources:
 *  1. Triple Whale Summary API — daily revenue, spend, ROAS, CPA, CPM, orders
 *  2. Breezeway Bad Day Detector — scrape for platform health status
 *  3. EIA API — weekly US gas prices
 *  4. StatusGator — Meta platform outage incidents
 *  5. Gemini API + web search — auto-curated macro events
 */

import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { scrapeBreezeway } from './scrape-breezeway.mjs';

const TW_API_KEY = process.env.TW_API_KEY;
const TW_SHOP_DOMAIN = process.env.TW_SHOP_DOMAIN || 'gardners-wisconsin-cheese.myshopify.com';
const EIA_API_KEY = process.env.EIA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const STATUSGATOR_API_KEY = process.env.STATUSGATOR_API_KEY;

// Rolling 30-day window ending yesterday (today's data isn't finalized when the job runs)
const now = new Date();
const endD = new Date(now);
endD.setDate(now.getDate() - 1);
const startD = new Date(now);
startD.setDate(now.getDate() - 30);

const startDate = startD.toISOString().split('T')[0];
const endDate = endD.toISOString().split('T')[0];
const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

console.log(`📊 Fetching data for ${startDate} to ${endDate}`);

// ============================================================
// 1. TRIPLE WHALE — Summary Page API
// ============================================================
async function fetchTripleWhale() {
  console.log('🐋 Fetching Triple Whale data...');
  if (!TW_API_KEY) {
    console.warn('⚠️  TW_API_KEY not set, skipping Triple Whale');
    return null;
  }

  const shopDomain = TW_SHOP_DOMAIN.trim();
  console.log(`  Shop domain: ${shopDomain}`);
  console.log(`  Date range: ${startDate} → ${endDate}`);

  const todayHour = new Date().getUTCHours() + 1; // base-1, 1–25

  // Correct endpoint and body format per TW API v2 docs
  const res = await fetch('https://api.triplewhale.com/api/v2/summary-page/get-data', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TW_API_KEY,
    },
    body: JSON.stringify({
      shopDomain,
      period: { start: startDate, end: endDate },
      todayHour,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`  Triple Whale API error ${res.status}: ${text.slice(0, 400)}`);
    return null;
  }

  const data = await res.json();
  const metrics = data?.metrics;
  if (!Array.isArray(metrics)) {
    console.error(`  Unexpected TW response shape: ${JSON.stringify(data).slice(0, 200)}`);
    return null;
  }

  // Each metric has charts.current = [{x: dayOfYear, y: value}]
  // x is 1-indexed day of year. Map back to calendar date using startDate's year.
  const year = new Date(startDate).getFullYear();
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

  function dayOfYearToDate(doy) {
    const d = new Date(year, 0, 1);
    d.setDate(d.getDate() + doy - 1);
    return d.toISOString().split('T')[0];
  }

  // Index metrics by metricId for easy lookup
  const byId = {};
  for (const m of metrics) {
    byId[m.metricId || m.id] = m;
  }
  console.log(`  TW metric IDs: ${Object.keys(byId).join(', ')}`);

  // Build day-indexed map
  const dayMap = {};
  function applyMetric(metricKey, field, transform) {
    const m = byId[metricKey];
    if (!m) return;
    for (const pt of (m.charts?.current || [])) {
      const date = dayOfYearToDate(pt.x);
      if (date < startDate || date > endDate) continue;
      if (!dayMap[date]) dayMap[date] = { date };
      dayMap[date][field] = transform ? transform(pt.y) : (pt.y ?? 0);
    }
  }

  applyMetric('totalSales', 'revenue');
  applyMetric('totalOrders', 'orders');
  applyMetric('adsSpend', 'adSpend');
  applyMetric('totalRoas', 'blendedRoas');
  applyMetric('fb_ads_spend', 'metaSpend');
  applyMetric('fb_ads_purchase_roas', 'metaRoas');
  applyMetric('facebookCpa', 'metaCpa');
  applyMetric('averageFacebookCpm', 'metaCpm');

  const days = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));
  console.log(`  ✅ Got ${days.length} days of TW data`);
  return days.length > 0 ? days : null;
}

// ============================================================
// 2. BREEZEWAY — Scrape Bad Day Detector
// ============================================================
async function fetchBreezeway() {
  console.log('⚡ Fetching Breezeway Bad Day Detector...');
  try {
    const statuses = await scrapeBreezeway(startDate, endDate);
    console.log(`  ✅ Got ${statuses.length} days of Breezeway data`);
    return statuses;
  } catch (err) {
    console.error('Breezeway fetch failed:', err.message);
    return null;
  }
}

// ============================================================
// 3. EIA — US Gas Prices (weekly)
// ============================================================
async function fetchGasPrices() {
  console.log('⛽ Fetching EIA gas prices...');
  if (!EIA_API_KEY) {
    console.warn('⚠️  EIA_API_KEY not set, skipping gas prices');
    return null;
  }

  try {
    const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${EIA_API_KEY}&frequency=weekly&data[0]=value&facets[series][]=${encodeURIComponent('EMM_EPMR_PTE_NUS_DPG')}&sort[0][column]=period&sort[0][direction]=desc&length=12`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error(`EIA API error ${res.status}`);
      return null;
    }

    const data = await res.json();
    const prices = (data?.response?.data || []).map(d => ({
      date: d.period,
      price: parseFloat(d.value),
    }));

    console.log(`  ✅ Got ${prices.length} weeks of gas price data`);
    return prices;
  } catch (err) {
    console.error('EIA fetch failed:', err.message);
    return null;
  }
}

// ============================================================
// 4. STATUSGATOR — Meta Outage Incidents
// ============================================================
async function fetchOutages() {
  console.log('🐊 Fetching outage data...');

  if (STATUSGATOR_API_KEY) {
    try {
      const res = await fetch('https://api.statusgator.com/v2/services/meta/incidents', {
        headers: { 'Authorization': `Bearer ${STATUSGATOR_API_KEY}` },
      });

      if (res.ok) {
        const data = await res.json();
        const incidents = (data || [])
          .filter(i => {
            const d = new Date(i.created_at || i.started_at);
            return d >= new Date(startDate) && d <= new Date(endDate + 'T23:59:59Z');
          })
          .map(i => ({
            date: (i.created_at || i.started_at || '').split('T')[0],
            title: i.title || i.name,
            status: i.status,
            service: i.service?.name || 'Meta',
          }));
        console.log(`  ✅ Got ${incidents.length} outage incidents from StatusGator`);
        return incidents;
      }
      console.warn(`StatusGator API error ${res.status}, falling back to public sources`);
    } catch (err) {
      console.warn(`StatusGator fetch failed: ${err.message}`);
    }
  } else {
    console.warn('⚠️  STATUSGATOR_API_KEY not set, trying public sources...');
  }

  return await scrapeMetaStatus();
}

async function scrapeMetaStatus() {
  // Try Meta's developer status API
  try {
    const devRes = await fetch('https://developers.facebook.com/status/summary/');
    if (devRes.ok) {
      const devData = await devRes.json();
      const devIncidents = (devData?.incidents || devData?.data || [])
        .filter(i => {
          const d = new Date(i.created_at || i.start_time || '');
          return d >= new Date(startDate) && d <= new Date(endDate + 'T23:59:59Z');
        })
        .map(i => ({
          date: (i.created_at || i.start_time || '').split('T')[0],
          title: i.title || i.name || 'Meta platform incident',
          status: i.status || 'investigating',
          service: 'Meta',
        }));
      if (devIncidents.length) {
        console.log(`  ✅ Got ${devIncidents.length} incidents from developers.facebook.com`);
        return devIncidents;
      }
    }
  } catch (e) {
    console.warn(`  developers.facebook.com failed: ${e.message}`);
  }

  // Try Meta's graph API status endpoint
  try {
    const graphRes = await fetch('https://www.metastatus.com/api/v2/summary.json');
    if (graphRes.ok) {
      const graphData = await graphRes.json();
      const status = graphData?.status?.indicator;
      if (status && status !== 'none') {
        console.log(`  ✅ Got Meta status from metastatus.com: ${status}`);
        return [{
          date: endDate,
          title: `Meta platform status: ${status}`,
          status: graphData?.status?.description || status,
          service: 'Meta',
        }];
      }
    }
  } catch (e) { /* silent */ }

  console.warn('  ⚠️  No outage data available from any public source');
  return [];
}

// ============================================================
// 5. GEMINI API — Auto-curate Macro Events (with retry)
// ============================================================
async function fetchMacroEvents() {
  console.log('🌍 Generating macro events via Gemini API...');
  if (!GEMINI_API_KEY) {
    console.warn('⚠️  GEMINI_API_KEY not set, skipping macro events');
    return null;
  }

  const prompt = `You are analyzing macro events that could affect US e-commerce ad performance for a specialty food brand (artisan cheese shipped nationally, avg order ~$45, gifting-heavy).

For the date range ${startDate} to ${endDate}, identify the major events in each of these categories:
1. WALLET IMPACT (💰) — gas prices, CPI/inflation data, consumer confidence surveys, tariffs, retail spending reports
2. FEED DOMINATION (📱) — news events that dominated social media feeds (political, cultural, disasters, major sports)
3. PLATFORM ISSUE (🔴) — any known Meta/Facebook/Instagram ad platform outages or delivery issues

For each event, provide:
- date: exact date (YYYY-MM-DD)
- description: one punchy headline sentence (max 15 words)
- details: 3-4 sentences that FIRST explain what the event/metric actually IS (e.g. "The U of Michigan Consumer Sentiment Index is a monthly survey of 500 households measuring financial confidence — it has run since 1952 and a score below 60 signals meaningful pessimism"), THEN explain what this specific reading/development means in historical context, THEN explain the expected impact on Meta ROAS and CPA for a DTC food brand in plain language a marketing manager would understand. Do NOT use generic phrases like "wallets feel tight" or "expect lower conversion rates" without first establishing what the event actually is and why this instance is noteworthy.
- intensity: 1 (minor), 2 (notable), 3 (major)
- category: wallet | feed | platform
- icon: 💰 | 📱 | 🔴
- source: publication or agency name

Respond ONLY with a valid JSON array, no markdown fences, no preamble:
[{"date":"YYYY-MM-DD","description":"...","details":"...","intensity":1,"category":"wallet","icon":"💰","source":"..."}]`;

  // Retry up to 3 times with exponential backoff on rate limit (429)
  const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];
  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1) {
          const wait = attempt * 20000; // 20s, 40s
          console.log(`  Retrying Gemini (attempt ${attempt}/3, waiting ${wait / 1000}s)...`);
          await new Promise(r => setTimeout(r, wait));
        }

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
            }),
          }
        );

        if (res.status === 429) {
          console.warn(`  Gemini ${model} rate limited (429), attempt ${attempt}/3`);
          continue;
        }

        if (!res.ok) {
          const errText = await res.text();
          console.error(`Gemini ${model} error ${res.status}: ${errText.slice(0, 200)}`);
          break; // Non-429 error — don't retry this model
        }

        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';

        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const events = JSON.parse(jsonMatch[0]);
          console.log(`  ✅ Got ${events.length} macro events (${model})`);
          return events;
        }

        console.warn('  ⚠️  Could not parse macro events from Gemini response');
        console.warn(`  Raw text: ${text.slice(0, 300)}`);
        return null;
      } catch (err) {
        console.error(`Gemini ${model} attempt ${attempt} threw: ${err.message}`);
      }
    }
    console.warn(`  ${model} exhausted retries, trying next model...`);
  }

  console.error('Gemini: all models and retries failed');
  return null;
}

// ============================================================
// MAIN — Fetch all, merge, write data.json
// ============================================================
async function main() {
  // Load existing data as fallback
  let existing = {};
  const dataPath = 'data/data.json';
  if (existsSync(dataPath)) {
    try {
      existing = JSON.parse(await readFile(dataPath, 'utf-8'));
    } catch (e) { /* fresh start */ }
  }

  // Skip Gemini if we have events that are less than 25h old with reasonable coverage.
  // The rolling window shifts by 1 day each run so we intentionally ignore exact date range
  // equality — events covering "last month" are still valid the next day.
  // Gemini free tier has a tight daily quota; re-fetching every run burns it fast.
  const existingMacroAge = existing.meta?.updatedAt
    ? (Date.now() - new Date(existing.meta.updatedAt).getTime()) / 3600000
    : 999;
  const macroIsFresh = existingMacroAge < 25 && (existing.macroEvents?.length || 0) > 0;

  if (macroIsFresh) {
    console.log(`🌍 Skipping Gemini — cached macro events are ${existingMacroAge.toFixed(1)}h old`);
  }

  // Fetch all sources in parallel
  const [tripleWhale, breezeway, gasPrices, outages, macroEvents] = await Promise.allSettled([
    fetchTripleWhale(),
    fetchBreezeway(),
    fetchGasPrices(),
    fetchOutages(),
    macroIsFresh ? Promise.resolve(null) : fetchMacroEvents(),
  ]);

  const data = {
    meta: {
      updatedAt: new Date().toISOString(),
      dateRange: { start: startDate, end: endDate },
      monthLabel,
    },
    tripleWhale: tripleWhale.value || existing.tripleWhale || [],
    breezeway: breezeway.value || existing.breezeway || [],
    gasPrices: gasPrices.value || existing.gasPrices || [],
    outages: outages.value || existing.outages || [],
    macroEvents: macroEvents.value || existing.macroEvents || [],
  };

  // Write output
  await mkdir('data', { recursive: true });
  await writeFile(dataPath, JSON.stringify(data, null, 2));
  console.log(`\n✅ Data written to ${dataPath}`);
  console.log(`   TW days: ${data.tripleWhale?.length || 0}`);
  console.log(`   Breezeway days: ${data.breezeway?.length || 0}`);
  console.log(`   Gas prices: ${data.gasPrices?.length || 0}`);
  console.log(`   Outages: ${data.outages?.length || 0}`);
  console.log(`   Macro events: ${data.macroEvents?.length || 0}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
