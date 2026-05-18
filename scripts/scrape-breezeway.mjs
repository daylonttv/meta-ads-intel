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

export async function scrapeBreezeway(startDate, endDate) {
  const res = await fetch(BREEZEWAY_URL);
  if (!res.ok) throw new Error(`Breezeway S3 fetch failed: ${res.status}`);

  const allDays = await res.json();

  // Filter to date range
  const filtered = allDays.filter(d => {
    if (startDate && d.date < startDate) return false;
    if (endDate && d.date > endDate) return false;
    return true;
  });

  // Normalize status to our format
  return filtered.map(d => ({
    date: d.date,
    status: d.hyb_status === 'VERY BAD' ? 'very_bad'
          : d.hyb_status === 'BAD' ? 'bad'
          : 'normal',
    cpa_z: d.cpa_z,
    n_biz: d.n_biz,
    dow: d.dow,
    incident_source: d.incident_source || null,
    incident_description: d.incident_description || null,
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
