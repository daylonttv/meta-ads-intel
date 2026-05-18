/**
 * build-dashboard.mjs
 * Reads data/data.json + template/dashboard.html → outputs index.html
 * 
 * Injects the data as a JS variable so the HTML is fully self-contained.
 * Anyone can open index.html in a browser with no server needed.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

async function build() {
  // Read data
  const dataPath = 'data/data.json';
  if (!existsSync(dataPath)) {
    console.error('❌ data/data.json not found. Run fetch-data.mjs first.');
    process.exit(1);
  }
  const data = JSON.parse(await readFile(dataPath, 'utf-8'));

  // Read HTML template
  const templatePath = 'template/dashboard.html';
  if (!existsSync(templatePath)) {
    console.error('❌ template/dashboard.html not found.');
    process.exit(1);
  }
  let html = await readFile(templatePath, 'utf-8');

  // Inject data as a global JS variable
  // The template references window.__DASHBOARD_DATA__
  const dataScript = `<script>window.__DASHBOARD_DATA__ = ${JSON.stringify(data)};</script>`;
  
  // Insert before closing </head> or before first <script>
  if (html.includes('<!-- DATA_INJECTION_POINT -->')) {
    html = html.replace('<!-- DATA_INJECTION_POINT -->', dataScript);
  } else if (html.includes('</head>')) {
    html = html.replace('</head>', dataScript + '\n</head>');
  } else {
    // Prepend to body
    html = html.replace('<body>', '<body>\n' + dataScript);
  }

  // Update the title with the date range
  const { monthLabel } = data.meta || {};
  if (monthLabel) {
    html = html.replace(
      /<title>.*?<\/title>/,
      `<title>Meta Ads Intel — ${monthLabel}</title>`
    );
  }

  // Write output
  await writeFile('index.html', html);
  console.log('✅ Dashboard built → index.html');
  console.log(`   Data from: ${data.meta?.dateRange?.start} to ${data.meta?.dateRange?.end}`);
  console.log(`   Last updated: ${data.meta?.updatedAt}`);
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
