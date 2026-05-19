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

// Date range: current month to today
const now = new Date();
const year = now.getFullYear();
const month = now.getMonth(); // 0-indexed
const startDate = new Date(year, month, 1).toISOString().split('T')[0];
const endDate = now.toISOString().split('T')[0];
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

  try {
    const res = await fetch('https://api.triplewhale.com/api/v2/summary-page/summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TW_API_KEY,
      },
      body: JSON.stringify({
        start: startDate,
        end: endDate,
        period: 'day',
        shop_domain: TW_SHOP_DOMAIN,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Triple Whale API error ${res.status}: ${text}`);
      return null;
    }

    const data = await res.json();
    
    // Extract daily metrics
    const days = [];
    const dayData = data?.data || data?.summary || data;
    
    // The API returns data grouped by day — normalize to our format
    if (Array.isArray(dayData)) {
      for (const day of dayData) {
        days.push({
          date: day.date || day.day,
          revenue: day.totalRevenue || day.total_revenue || 0,
          orders: day.totalOrders || day.total_orders || 0,
          adSpend: day.totalAdSpend || day.total_ad_spend || 0,
          blendedRoas: day.blendedRoas || day.blended_roas || 0,
          metaSpend: day.facebookSpend || day.facebook_spend || day.metaSpend || 0,
          metaRoas: day.facebookRoas || day.facebook_roas || day.metaRoas || 0,
          metaCpa: day.facebookCpa || day.facebook_cpa || day.metaCpa || 0,
          metaCpm: day.facebookCpm || day.facebook_cpm || day.metaCpm || 0,
        });
      }
    }

    console.log(`  ✅ Got ${days.length} days of TW data`);
    return days;
  } catch (err) {
    console.error('Triple Whale fetch failed:', err.message);
    return null;
  }
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
    // Weekly US regular all formulations retail gasoline prices
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
  console.log('🐊 Fetching StatusGator outage data...');
  if (!STATUSGATOR_API_KEY) {
    console.warn('⚠️  STATUSGATOR_API_KEY not set, trying public scrape...');
    return await scrapeMetaStatus();
  }

  try {
    const res = await fetch('https://api.statusgator.com/v2/services/meta/incidents', {
      headers: { 'Authorization': `Bearer ${STATUSGATOR_API_KEY}` },
    });

    if (!res.ok) {
      console.warn(`StatusGator API error ${res.status}, falling back to scrape`);
      return await scrapeMetaStatus();
    }

    const data = await res.json();
    const incidents = (data || [])
      .filter(i => {
        const d = new Date(i.created_at || i.started_at);
        return d >= new Date(startDate) && d <= new Date(endDate);
      })
      .map(i => ({
        date: (i.created_at || i.started_at || '').split('T')[0],
        title: i.title || i.name,
        status: i.status,
        service: i.service?.name || 'Meta',
      }));

    console.log(`  ✅ Got ${incidents.length} outage incidents`);
    return incidents;
  } catch (err) {
    console.error('StatusGator fetch failed:', err.message);
    return [];
  }
}

// Fallback: scrape Meta's public status page
async function scrapeMetaStatus() {
  try {
    // Try Meta's developer status API first
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
    // Fallback: metastatus.com
    const msRes = await fetch('https://metastatus.com/');
    if (msRes.ok) {
      console.log(`  ℹ️  metastatus.com reachable but no JSON API — no incidents recorded`);
    }
  } catch (e) { /* silent */ }
  console.warn('  ⚠️  No outage data available');
  return [];
}

// ============================================================
// 5. GEMINI API — Auto-curate Macro Events
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

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
          tools: [{ googleSearch: {} }],
        }),
      }
    );

    if (!res.ok) {
      console.error(`Gemini API error ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data.candidates[0].content.parts.map(p => p.text).join('');

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const events = JSON.parse(jsonMatch[0]);
      console.log(`  ✅ Got ${events.length} macro events`);
      return events;
    }

    console.warn('  ⚠️  Could not parse macro events from Gemini response');
    return null;
  } catch (err) {
    console.error('Gemini API fetch failed:', err.message);
    return null;
  }
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

  // Fetch all sources in parallel
  const [tripleWhale, breezeway, gasPrices, outages, macroEvents] = await Promise.allSettled([
    fetchTripleWhale(),
    fetchBreezeway(),
    fetchGasPrices(),
    fetchOutages(),
    fetchMacroEvents(),
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
