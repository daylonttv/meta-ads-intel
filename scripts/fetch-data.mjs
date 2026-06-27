/**
 * fetch-data.mjs
 * Pulls data from all sources and writes data/data.json
 *
 * Sources:
 *  1. Triple Whale Summary API — daily revenue, spend, ROAS, CPA, CPM, orders
 *  2. Breezeway Bad Day Detector — platform health across ~45 DTC brands
 *  3. EIA API — weekly US gas prices
 *  4. StatusGator — Meta platform outage incidents
 *  5. Gemini API — macro events with feed-domination + mood-impact classification
 *  6. Google Trends (unofficial) — "wisconsin cheese" + "cheese gift" search interest
 *  7. Holiday Calendar — hardcoded retail + gifting calendar for the date range
 */

import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { scrapeBreezeway } from './scrape-breezeway.mjs';

const TW_API_KEY = process.env.TW_API_KEY;
const TW_SHOP_DOMAIN = process.env.TW_SHOP_DOMAIN || 'gardners-wisconsin-cheese.myshopify.com';
const EIA_API_KEY = process.env.EIA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const STATUSGATOR_API_KEY = process.env.STATUSGATOR_API_KEY;

// Rolling 30-day window ending yesterday (today's data isn't finalized when the job runs).
// Anchored to the store's business timezone (US Central / Wisconsin) so the window is
// stable regardless of the CI runner's timezone — avoids local-vs-UTC ±1-day drift.
const TZ = 'America/Chicago';
const MS_DAY = 86400000;
function dateStrInTZ(d) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const nowMs = Date.now();
const endDate = dateStrInTZ(new Date(nowMs - 1 * MS_DAY));    // yesterday (Central)
const startDate = dateStrInTZ(new Date(nowMs - 30 * MS_DAY)); // 30 days back (Central)
const monthLabel = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'long', year: 'numeric' }).format(new Date(nowMs));

console.log(`📊 Fetching data for ${startDate} to ${endDate}`);

// ============================================================
// HOLIDAY CALENDAR — no API needed, always fresh
// ============================================================
function computeHolidaysForYear(year) {
  function nthWeekday(y, month, n, dow) {
    const d = new Date(y, month, 1);
    let count = 0;
    while (d.getMonth() === month) {
      if (d.getDay() === dow) { count++; if (count === n) return new Date(d); }
      d.setDate(d.getDate() + 1);
    }
    return null;
  }
  function lastWeekday(y, month, dow) {
    const d = new Date(y, month + 1, 0);
    while (d.getDay() !== dow) d.setDate(d.getDate() - 1);
    return d;
  }
  function fmt(d) { return d.toISOString().split('T')[0]; }

  // Anonymous Gregorian algorithm for Easter
  function easter(y) {
    const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25);
    const g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4;
    const l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
    const month=Math.floor((h+l-7*m+114)/31)-1,day=((h+l-7*m+114)%31)+1;
    return new Date(y, month, day);
  }

  const thx = nthWeekday(year, 10, 4, 4);
  const blackFriday = new Date(thx); blackFriday.setDate(thx.getDate() + 1);
  const cyberMonday = new Date(blackFriday); cyberMonday.setDate(blackFriday.getDate() + 3);

  return [
    { date: `${year}-01-01`, name: "New Year's Day", icon: '🎆', mood_impact: 'neutral', boost: false },
    { date: `${year}-02-14`, name: "Valentine's Day", icon: '💝', mood_impact: 'boosts_spending', boost: true },
    { date: `${year}-03-17`, name: "St. Patrick's Day", icon: '🍀', mood_impact: 'neutral', boost: false },
    { date: fmt(easter(year)), name: 'Easter', icon: '🐣', mood_impact: 'boosts_spending', boost: true },
    { date: fmt(nthWeekday(year, 4, 2, 0)), name: "Mother's Day", icon: '💐', mood_impact: 'boosts_spending', boost: true },
    { date: fmt(lastWeekday(year, 4, 1)), name: 'Memorial Day', icon: '🏳️', mood_impact: 'neutral', boost: false },
    { date: fmt(nthWeekday(year, 5, 3, 0)), name: "Father's Day", icon: '👔', mood_impact: 'boosts_spending', boost: true },
    { date: `${year}-07-04`, name: 'Independence Day', icon: '🎆', mood_impact: 'neutral', boost: false },
    { date: fmt(nthWeekday(year, 8, 1, 1)), name: 'Labor Day', icon: '🏷️', mood_impact: 'neutral', boost: false },
    { date: `${year}-10-31`, name: 'Halloween', icon: '🎃', mood_impact: 'neutral', boost: false },
    { date: fmt(thx), name: 'Thanksgiving', icon: '🦃', mood_impact: 'boosts_spending', boost: true },
    { date: fmt(blackFriday), name: 'Black Friday', icon: '🛒', mood_impact: 'boosts_spending', boost: true },
    { date: fmt(cyberMonday), name: 'Cyber Monday', icon: '💻', mood_impact: 'boosts_spending', boost: true },
    { date: `${year}-12-25`, name: 'Christmas Day', icon: '🎄', mood_impact: 'boosts_spending', boost: true },
    { date: `${year}-12-31`, name: "New Year's Eve", icon: '🎉', mood_impact: 'neutral', boost: false },
  ];
}

function getHolidaysInRange(start, end) {
  const y1 = new Date(start).getFullYear();
  const y2 = new Date(end).getFullYear();
  const years = y1 === y2 ? [y1] : [y1, y2];
  return years.flatMap(y => computeHolidaysForYear(y)).filter(h => h.date >= start && h.date <= end);
}

// ============================================================
// ANOMALY DETECTION — for Gemini context injection
// ============================================================
function getAnomalyContext(twDays) {
  if (!twDays || twDays.length < 5) return '';
  const validRoas = twDays.filter(d => d.metaRoas > 0.1);
  const validCpa = twDays.filter(d => d.metaCpa > 1);
  if (validRoas.length < 3) return '';

  const avgRoas = validRoas.reduce((s, d) => s + d.metaRoas, 0) / validRoas.length;
  const avgCpa = validCpa.length ? validCpa.reduce((s, d) => s + d.metaCpa, 0) / validCpa.length : 0;

  const anomalies = twDays.filter(d => {
    const rAnomaly = d.metaRoas > 0.1 && Math.abs(d.metaRoas - avgRoas) / avgRoas > 0.25;
    const cAnomaly = avgCpa > 0 && d.metaCpa > 1 && Math.abs(d.metaCpa - avgCpa) / avgCpa > 0.30;
    return rAnomaly || cAnomaly;
  }).map(d => {
    const parts = [];
    if (d.metaRoas > 0.1) {
      const pct = ((d.metaRoas - avgRoas) / avgRoas * 100).toFixed(0);
      parts.push(`ROAS ${d.metaRoas.toFixed(2)}× (avg ${avgRoas.toFixed(2)}×, ${+pct >= 0 ? '+' : ''}${pct}%)`);
    }
    if (d.metaCpa > 1 && avgCpa > 0) {
      const pct = ((d.metaCpa - avgCpa) / avgCpa * 100).toFixed(0);
      parts.push(`CPA $${d.metaCpa.toFixed(0)} (avg $${avgCpa.toFixed(0)}, ${+pct >= 0 ? '+' : ''}${pct}%)`);
    }
    return `  ${d.date}: ${parts.join(', ')}`;
  });

  if (!anomalies.length) return '';
  return `\n\nOUR ANOMALOUS PERFORMANCE DAYS — prioritize explaining these specific dates:\n${anomalies.join('\n')}`;
}

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

  const todayHour = Math.min(24, Math.max(1, new Date().getUTCHours() + 1)); // base-1, clamped 1–24

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

  // x = 1-indexed day-of-year; convert back to calendar date.
  // The rolling window can span a year boundary, so try the start year first then the
  // next year and keep whichever lands inside [startDate, endDate] (UTC, no TZ drift).
  const startYear = parseInt(startDate.slice(0, 4), 10);
  function dayOfYearToDate(doy) {
    for (const y of [startYear, startYear + 1]) {
      const d = new Date(Date.UTC(y, 0, 1));
      d.setUTCDate(d.getUTCDate() + doy - 1);
      const s = d.toISOString().split('T')[0];
      if (s >= startDate && s <= endDate) return s;
    }
    const d = new Date(Date.UTC(startYear, 0, 1));
    d.setUTCDate(d.getUTCDate() + doy - 1);
    return d.toISOString().split('T')[0];
  }

  const byId = {};
  for (const m of metrics) { byId[m.metricId || m.id] = m; }
  console.log(`  TW metric IDs: ${Object.keys(byId).join(', ')}`);

  const dayMap = {};
  function applyMetric(metricKey, field) {
    const m = byId[metricKey];
    if (!m) return;
    for (const pt of (m.charts?.current || [])) {
      const date = dayOfYearToDate(pt.x);
      if (date < startDate || date > endDate) continue;
      if (!dayMap[date]) dayMap[date] = { date };
      // Preserve missing metrics as null (not 0) so they're excluded from averages
      // rather than counted as a real zero.
      dayMap[date][field] = pt.y ?? null;
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
    if (!res.ok) { console.error(`EIA API error ${res.status}`); return null; }
    const data = await res.json();
    const prices = (data?.response?.data || []).map(d => ({ date: d.period, price: parseFloat(d.value) }));
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
      console.warn(`StatusGator API error ${res.status}`);
    } catch (err) {
      console.warn(`StatusGator fetch failed: ${err.message}`);
    }
  } else {
    console.warn('⚠️  STATUSGATOR_API_KEY not set, trying public sources...');
  }

  return await scrapeMetaStatus();
}

async function scrapeMetaStatus() {
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

  try {
    const graphRes = await fetch('https://www.metastatus.com/api/v2/summary.json');
    if (graphRes.ok) {
      const graphData = await graphRes.json();
      const status = graphData?.status?.indicator;
      if (status && status !== 'none') {
        console.log(`  ✅ Got Meta status: ${status}`);
        return [{ date: endDate, title: `Meta platform status: ${status}`, status: graphData?.status?.description || status, service: 'Meta' }];
      }
    }
  } catch (e) { /* silent */ }

  console.warn('  ⚠️  No outage data available from any public source');
  return [];
}

// ============================================================
// 5. GEMINI API — Macro events with feed-domination + mood classification
// ============================================================

// Parse Gemini's text into a clean, validated array of macro events.
// Tolerates markdown fences / leading prose, never throws, and drops any row
// that fails schema validation (missing ISO date or headline). Also bounds
// string lengths so a runaway model response can't bloat data.json.
export function parseAndValidateEvents(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;

  let arr;
  try {
    arr = JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    console.warn(`  Gemini JSON.parse failed: ${e.message}`);
    return null;
  }
  if (!Array.isArray(arr)) return null;

  const CATS = new Set(['wallet', 'feed', 'platform', 'seasonal']);
  const MOODS = new Set(['suppresses_spending', 'boosts_spending', 'neutral']);
  const DOMS = new Set(['high', 'medium', 'low']);
  const ICONS = { wallet: '💰', feed: '📱', platform: '🔴', seasonal: '🗓️' };

  // Accept events within the window, allowing ~3 weeks past the end for upcoming
  // "seasonal" items the prompt asks for. Reject impossible dates (e.g. 2026-99-99).
  const minEventDate = startDate;
  const maxEventDate = (() => { const d = new Date(endDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 21); return d.toISOString().split('T')[0]; })();

  const valid = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) continue;          // require ISO date shape
    if (Number.isNaN(Date.parse(e.date + 'T00:00:00Z'))) continue;    // reject impossible dates
    if (e.date < minEventDate || e.date > maxEventDate) continue;     // keep within window (+21d)
    if (!e.description || typeof e.description !== 'string') continue; // require headline
    const category = CATS.has(e.category) ? e.category : 'feed';
    valid.push({
      date: e.date,
      description: String(e.description).slice(0, 200),
      details: typeof e.details === 'string' ? e.details.slice(0, 1200) : '',
      intensity: [1, 2, 3].includes(e.intensity) ? e.intensity : 2,
      category,
      icon: (typeof e.icon === 'string' && e.icon) ? e.icon : ICONS[category],
      mood_impact: MOODS.has(e.mood_impact) ? e.mood_impact : 'neutral',
      feed_dominance: DOMS.has(e.feed_dominance) ? e.feed_dominance : 'low',
      source: typeof e.source === 'string' ? e.source.slice(0, 80) : '',
    });
  }
  return valid.length ? valid : null;
}

async function fetchMacroEvents(existingTW) {
  console.log('🌍 Generating macro events via Gemini API...');
  if (!GEMINI_API_KEY) {
    console.warn('⚠️  GEMINI_API_KEY not set, skipping macro events');
    return null;
  }

  const anomalyContext = getAnomalyContext(existingTW);
  const holidaysInWindow = getHolidaysInRange(startDate, endDate);
  const holidayContext = holidaysInWindow.length
    ? `\n\nKNOWN HOLIDAYS IN THIS WINDOW: ${holidaysInWindow.map(h => `${h.date} ${h.name}`).join(', ')}`
    : '';

  const prompt = `You are analyzing events that affected Meta ad performance and consumer behavior for Gardner's Wisconsin Cheese — a premium DTC specialty food brand (artisan cheese shipped nationally, avg order ~$45, gifting-heavy, repeat gifters, primarily US audience).

DATE RANGE: ${startDate} to ${endDate}${anomalyContext}${holidayContext}

Use Google Search to find what REALLY happened in this exact date window, then identify 8–14 significant events across these four categories. Focus on US events. Base every event and number on real, citable sources — do NOT fabricate events or data points. If you can't verify enough, return fewer.

CATEGORY DEFINITIONS:

1. WALLET IMPACT (💰) — consumer financial signals:
Gas prices, CPI/inflation releases, consumer confidence surveys (U of Michigan Sentiment Index — below 70 = pessimism, below 60 = alarm), Conference Board Consumer Confidence, tariff/trade announcements, retail spending reports, major employment/layoff news. ALWAYS include the actual reading (e.g. "U of M Sentiment fell to 52.2 in May from 57.0 in April"). Specialty food is discretionary — financial anxiety correlates with reduced gifting spend.

2. FEED DOMINATION (📱) — events that took over social media feeds for 24+ hours:
Major news events, tragedies, political moments (big votes, rulings, crises), viral cultural moments, major sporting events, celebrity deaths, national emergencies, major viral controversies. These matter because doomscrolling/news-following displaces product discovery — ad impressions still serve but conversion intent drops sharply.

3. PLATFORM ISSUE (🔴) — Meta/Facebook/Instagram ad delivery problems:
Algorithm updates, ad auction changes, iOS/Android privacy changes, ad policy changes, delivery bugs, CPM anomalies widely reported by DTC advertisers.

4. SEASONAL MOMENT (🗓️) — upcoming retail/gift occasions:
Gift-giving holidays, shopping moments, or seasonal purchase shifts relevant to specialty food gifting in the next 2 weeks from the end of the date range.

For each event, provide ALL of these fields:
- date: exact date or best estimate (YYYY-MM-DD), closest to when the event peaked or was announced
- description: one punchy headline (max 15 words), include actual data point if available
- details: 3–4 sentences. (1) What is this event/metric and its historical baseline — explain it as if the reader has never heard of it. (2) What specifically happened this instance and why it's notable. (3) Expected impact on Meta ROAS and CPA for a DTC food gifting brand. (4) Optional: actionable implication.
- intensity: 1 (minor), 2 (notable), 3 (major)
- category: wallet | feed | platform | seasonal
- icon: 💰 | 📱 | 🔴 | 🗓️
- mood_impact: "suppresses_spending" (tragedies, crises, economic anxiety, outrage cycles) | "boosts_spending" (celebrations, gift occasions, positive economic data, viral feel-good moments) | "neutral"
- feed_dominance: "high" (topic saturated feeds 2+ days), "medium" (dominated for ~24h), "low" (hours or minor reach)
- source: publication or agency (e.g. "Reuters", "U of Michigan", "Meta Business Blog", "Axios")

${anomalyContext ? 'IMPORTANT: Try to explain the anomalous performance days listed above. Look for events on or just before those dates.' : ''}

Respond ONLY with a valid JSON array. No markdown fences, no preamble, no trailing text.
[{"date":"YYYY-MM-DD","description":"...","details":"...","intensity":2,"category":"feed","icon":"📱","mood_impact":"suppresses_spending","feed_dominance":"high","source":"AP News"}]`;

  const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1) {
          const wait = attempt * 20000;
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
              // Google Search grounding is REQUIRED: the dashboard window is "now", which is
              // past the model's training cutoff — without live search it would hallucinate
              // events. The window-aware cache keeps this to ~1 grounded call/day (free tier).
              tools: [{ google_search: {} }],
              generationConfig: { temperature: 0.3, maxOutputTokens: 4000 },
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
          break;
        }

        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        const events = parseAndValidateEvents(text);
        if (events && events.length) {
          console.log(`  ✅ Got ${events.length} valid macro events (${model})`);
          return events;
        }
        console.warn('  ⚠️  Could not parse/validate macro events from Gemini response');
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
// 6. GOOGLE TRENDS (unofficial 2-step API, no npm required)
// ============================================================

// Google prepends an anti-XSSI guard (e.g. )]}'\n) to JSON responses. Strip
// anything before the first { or [ rather than matching one exact prefix, so a
// minor format change doesn't break parsing.
function stripXssiPrefix(text) {
  const i = text.search(/[\[{]/);
  return i === -1 ? text : text.slice(i);
}

async function fetchGoogleTrends() {
  console.log('📈 Fetching Google Trends...');
  const keywords = ['wisconsin cheese', 'cheese gift'];
  // Google Trends `tz` is minutes offset; derive it for Central on the run date so it's
  // correct under both CST (360) and CDT (300) instead of being hardcoded.
  const tzMin = (() => {
    const d = new Date();
    const loc = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
    const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
    return Math.round((utc - loc) / 60000);
  })();

  const req = JSON.stringify({
    comparisonItem: keywords.map(kw => ({ keyword: kw, geo: 'US', time: `${startDate} ${endDate}` })),
    category: 0,
    property: '',
  });

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://trends.google.com/',
  };

  // Step 1: get widget tokens
  const exploreUrl = `https://trends.google.com/trends/api/explore?hl=en-US&tz=${tzMin}&req=${encodeURIComponent(req)}`;
  const exploreRes = await fetch(exploreUrl, { headers });
  if (!exploreRes.ok) throw new Error(`Google Trends explore ${exploreRes.status}`);

  const exploreText = await exploreRes.text();
  const exploreJson = JSON.parse(stripXssiPrefix(exploreText));
  const timelineWidget = exploreJson.widgets?.find(w => w.id === 'TIMESERIES');
  if (!timelineWidget?.token) throw new Error('No TIMESERIES widget token');

  // Step 2: get actual time-series data
  const dataReq = JSON.stringify(timelineWidget.request);
  const dataUrl = `https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=${tzMin}&req=${encodeURIComponent(dataReq)}&token=${encodeURIComponent(timelineWidget.token)}`;
  const dataRes = await fetch(dataUrl, { headers });
  if (!dataRes.ok) throw new Error(`Google Trends widgetdata ${dataRes.status}`);

  const dataText = await dataRes.text();
  const dataJson = JSON.parse(stripXssiPrefix(dataText));
  const timelineData = dataJson?.default?.timelineData || [];

  const result = timelineData.map(pt => ({
    date: new Date(parseInt(pt.time) * 1000).toISOString().split('T')[0],
    'wisconsin cheese': pt.value[0] ?? 0,
    'cheese gift': pt.value[1] ?? 0,
  }));

  console.log(`  ✅ Got ${result.length} days of Google Trends data`);
  return result;
}

// ============================================================
// MAIN — Fetch all, merge, write data.json
// ============================================================
async function main() {
  let existing = {};
  const dataPath = 'data/data.json';
  if (existsSync(dataPath)) {
    try { existing = JSON.parse(await readFile(dataPath, 'utf-8')); } catch (e) { /* fresh start */ }
  }

  // Cache for Gemini + Google Trends: skip the fetch only when cached data is < 25h old
  // AND was built for the SAME window end-date. Same-day re-runs reuse the cache (saving
  // Gemini's free-tier quota); when the day rolls over, the window end changes and both
  // refetch. Fixes stale wrong-range data without burning quota on repeated same-day runs.
  const existingEnd = existing.meta?.dateRange?.end;
  const existingAgeH = existing.meta?.updatedAt
    ? (Date.now() - new Date(existing.meta.updatedAt).getTime()) / 3600000
    : 999;
  const sameWindow = existingEnd === endDate;
  // Judge cache freshness by EACH source's OWN last-success timestamp, not the whole-file
  // updatedAt (which other sources refresh daily). Otherwise a source that's been failing
  // for days gets re-marked "fresh" just because the file was rewritten today, and we never
  // re-attempt it. Per-source age forces a retry once that source's own data goes stale.
  const sourceAgeH = (name) => {
    const ts = existing.meta?.sources?.[name]?.updatedAt;
    return ts ? (Date.now() - new Date(ts).getTime()) / 3600000 : 999;
  };
  const macroIsFresh = sourceAgeH('macroEvents') < 25 && sameWindow && (existing.macroEvents?.length || 0) > 0;
  const trendsIsFresh = sourceAgeH('googleTrends') < 25 && sameWindow && (existing.googleTrends?.length || 0) > 0;
  if (macroIsFresh) console.log(`🌍 Skipping Gemini — cached macro events ${existingAgeH.toFixed(1)}h old (same window)`);
  if (trendsIsFresh) console.log(`📈 Skipping Google Trends — cached data ${existingAgeH.toFixed(1)}h old (same window)`);

  // Fetch all sources in parallel
  const [tripleWhale, breezeway, gasPrices, outages, macroEvents, googleTrends] = await Promise.allSettled([
    fetchTripleWhale(),
    fetchBreezeway(),
    fetchGasPrices(),
    fetchOutages(),
    macroIsFresh ? Promise.resolve(null) : fetchMacroEvents(existing.tripleWhale || []),
    trendsIsFresh ? Promise.resolve(null) : fetchGoogleTrends().catch(err => { console.warn(`  ⚠️  Google Trends failed: ${err.message} — skipping`); return null; }),
  ]);

  // Holidays are always recomputed from code — no API, no cache needed
  const holidays = getHolidaysInRange(startDate, endDate);
  console.log(`🗓️  ${holidays.length} holidays in range: ${holidays.map(h => h.name).join(', ')}`);

  // Per-source freshness so the dashboard can honestly flag stale data instead of showing
  // it as freshly updated. A source that failed this run carries forward its last-good
  // timestamp and is marked stale; cached (intentionally skipped) macro/trends stay "ok".
  const nowIso = new Date().toISOString();
  const prevSources = existing.meta?.sources || {};
  function srcStatus(settled, existingArr, name) {
    const ok = settled.status === 'fulfilled' && settled.value != null;
    return {
      ok,
      updatedAt: ok ? nowIso : (prevSources[name]?.updatedAt || null),
      stale: !ok && (existingArr?.length || 0) > 0,
    };
  }
  const sources = {
    tripleWhale: srcStatus(tripleWhale, existing.tripleWhale, 'tripleWhale'),
    breezeway: srcStatus(breezeway, existing.breezeway, 'breezeway'),
    gasPrices: srcStatus(gasPrices, existing.gasPrices, 'gasPrices'),
    outages: srcStatus(outages, existing.outages, 'outages'),
    macroEvents: macroIsFresh
      ? { ok: true, updatedAt: prevSources.macroEvents?.updatedAt || existing.meta?.updatedAt || null, stale: false, cached: true }
      : srcStatus(macroEvents, existing.macroEvents, 'macroEvents'),
    googleTrends: trendsIsFresh
      ? { ok: true, updatedAt: prevSources.googleTrends?.updatedAt || existing.meta?.updatedAt || null, stale: false, cached: true }
      : srcStatus(googleTrends, existing.googleTrends, 'googleTrends'),
  };
  const staleList = Object.entries(sources).filter(([, s]) => s.stale).map(([k]) => k);
  if (staleList.length) console.warn(`  ⚠️  Stale (kept previous) sources: ${staleList.join(', ')}`);

  const data = {
    meta: {
      updatedAt: nowIso,
      dateRange: { start: startDate, end: endDate },
      monthLabel,
      timezone: TZ,
      sources,
    },
    tripleWhale: tripleWhale.value || existing.tripleWhale || [],
    breezeway: breezeway.value || existing.breezeway || [],
    gasPrices: gasPrices.value || existing.gasPrices || [],
    outages: outages.value || existing.outages || [],
    macroEvents: macroEvents.value || existing.macroEvents || [],
    holidays,
    googleTrends: googleTrends.value || existing.googleTrends || [],
  };

  await mkdir('data', { recursive: true });
  await writeFile(dataPath, JSON.stringify(data, null, 2));
  console.log(`\n✅ Data written to ${dataPath}`);
  console.log(`   TW days: ${data.tripleWhale?.length || 0}`);
  console.log(`   Breezeway days: ${data.breezeway?.length || 0}`);
  console.log(`   Gas prices: ${data.gasPrices?.length || 0}`);
  console.log(`   Outages: ${data.outages?.length || 0}`);
  console.log(`   Macro events: ${data.macroEvents?.length || 0}`);
  console.log(`   Holidays: ${data.holidays?.length || 0}`);
  console.log(`   Google Trends days: ${data.googleTrends?.length || 0}`);
}

// Only auto-run when invoked directly (so this file can be imported by tools/tests).
if (process.argv[1] && process.argv[1].endsWith('fetch-data.mjs')) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
