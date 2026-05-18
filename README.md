# Meta Ads Intelligence Hub

Automated daily dashboard tracking Gardner's Wisconsin Cheese ad performance against platform health, macro events, fuel prices, and industry benchmarks.

**Live dashboard:** `https://<your-username>.github.io/meta-ads-intel/`

## What it does

Every morning at 7am CT, a GitHub Action:

1. **Pulls Triple Whale data** — revenue, ad spend, ROAS, CPA, CPM, orders (via Summary Page API)
2. **Scrapes Breezeway Bad Day Detector** — daily platform health rating (Normal/Bad/Very Bad)
3. **Fetches gas prices** — US national average from EIA API
4. **Checks platform status** — Meta outage data from StatusGator
5. **Auto-curates macro events** — Claude API with web search identifies consumer-spending-impacting news
6. **Generates a self-contained HTML dashboard** — bakes all data into a single file
7. **Deploys to GitHub Pages** — accessible to anyone with the link

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/<your-username>/meta-ads-intel.git
cd meta-ads-intel
```

### 2. Get your API keys

| Service | How to get it | Required? |
|---------|--------------|-----------|
| **Triple Whale** | Settings → API Keys → Generate. Select "Summary Page: Read" scope | ✅ Yes |
| **EIA** | https://www.eia.gov/opendata/register.php (free, instant) | ✅ Yes |
| **Anthropic (Claude)** | https://console.anthropic.com/settings/keys | ✅ Yes (for macro events) |
| **StatusGator** | https://statusgator.com/api (free tier) | ⬜ Optional |

### 3. Add secrets to GitHub

Go to your repo → Settings → Secrets and variables → Actions → New repository secret:

- `TW_API_KEY` — your Triple Whale API key
- `TW_SHOP_DOMAIN` — `gardners-wisconsin-cheese.myshopify.com`
- `EIA_API_KEY` — your EIA API key
- `ANTHROPIC_API_KEY` — your Claude API key
- `STATUSGATOR_API_KEY` — (optional) StatusGator API key

### 4. Enable GitHub Pages

Go to repo → Settings → Pages → Source: "GitHub Actions"

### 5. Done

The action runs daily at 7am CT (12:00 UTC). You can also trigger it manually from the Actions tab.

## Manual trigger

Go to Actions → "Update Dashboard" → "Run workflow"

## Architecture

```
scripts/
  fetch-data.mjs      — pulls all data sources, writes data.json
  build-dashboard.mjs  — reads data.json + template, outputs index.html
  scrape-breezeway.mjs — Puppeteer scraper for Breezeway status
template/
  dashboard.html       — the HTML/CSS/JS template (data injected at build)
data/
  data.json            — latest fetched data (auto-generated, committed)
index.html             — built dashboard (auto-generated, served by Pages)
```
