/**
 * scrape-breezeway.mjs
 * Fetches Breezeway Bad Day Detector data from their public S3 endpoint.
 * 
 * The endpoint serves daily platform health data for Meta ads across ~45 DTC brands.
 * No auth required — it's the same JSON the headwinds.breezeway.co frontend fetches.
 * 
 * Source: https://headwinds.s3.us-east-1.amazonaws.com/cpa_z_data.json
 * Fields: date, dow, cpa_z, hyb_cpa_bad, hyb_cpa_vbad, hyb_status, n_biz,
 *         incident_source, incident_description
 * 
 * Returns: [{ date, status, cpa_z, n_biz, dow, incident_source, incident_description }]
 */

const BREEZEWAY_URL = 'https://headwinds.s3.us-east-1.amazonaws.com/cpa_z_data.json';

// Map Breezeway's hyb_status to our internal status. Unknown/new values are
// preserved as 'unknown' (not silently treated as 'normal') so schema changes
// or new warning states surface instead of being hidden.
function normalizeStatus(raw) {
  const v = (raw || '').toUpperCase().trim();
  if (v === 'VERY BAD') return 'very_bad';
  if (v === 'BAD') return 'bad';
  if (v === 'NORMAL' || v === 'OK' || v === 'GOOD' || v === '') return 'normal';
  console.warn(`  ⚠️  Breezeway unknown hyb_status "${raw}" — preserving as 'unknown'`);
  return 'unknown';
}

export async function scrapeBreezeway(startDate, endDate) {
  const res = await fetch(BREEZEWAY_URL);
  if (!res.ok) throw new Error(`Breezeway S3 fetch failed: ${res.status}`);

  const allDays = await res.json();
  if (!Array.isArray(allDays)) {
    throw new Error(`Breezeway returned non-array (${typeof allDays}) — schema may have changed`);
  }

  // Filter to date range (drop rows with malformed/missing dates)
  const filtered = allDays.filter(d => {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) return false;
    if (startDate && d.date < startDate) return false;
    if (endDate && d.date > endDate) return false;
    return true;
  });

  // Normalize: coerce numeric fields to finite numbers or null; bound incident strings.
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  return filtered.map(d => ({
    date: d.date,
    status: normalizeStatus(d.hyb_status),
    cpa_z: num(d.cpa_z),
    n_biz: num(d.n_biz),
    dow: d.dow,
    incident_source: typeof d.incident_source === 'string' ? d.incident_source.slice(0, 200) : null,
    incident_description: typeof d.incident_description === 'string' ? d.incident_description.slice(0, 1000) : null,
  }));
}

// Allow running standalone: node scrape-breezeway.mjs [startDate] [endDate]
if (process.argv[1]?.endsWith('scrape-breezeway.mjs')) {
  const start = process.argv[2] || null;
  const end = process.argv[3] || null;
  scrapeBreezeway(start, end)
    .then(data => {
      console.log(`Got ${data.length} days`);
      console.log(JSON.stringify(data, null, 2));
    })
    .catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
}
