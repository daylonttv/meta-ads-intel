/**
 * build-dashboard.mjs
 * Reads data/data.json + template/dashboard.html → outputs index.html
 *
 * Injects the data as a JS variable so the HTML is fully self-contained.
 * Anyone can open index.html in a browser with no server needed.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

// Escape a JSON string so it can be safely embedded inside an inline <script>.
// Prevents untrusted strings (Gemini/API/Breezeway text) from terminating the
// tag (</script>) or the JS string literal (U+2028 / U+2029 line separators,
// which are valid in JSON but illegal in JS string literals).
const LS = String.fromCharCode(0x2028); // U+2028 LINE SEPARATOR
const PS = String.fromCharCode(0x2029); // U+2029 PARAGRAPH SEPARATOR
function escapeForScript(jsonStr) {
  return jsonStr
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(new RegExp(LS, 'g'), '\\u2028')
    .replace(new RegExp(PS, 'g'), '\\u2029');
}

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

  // Inject data as a global JS variable. The template references window.__DASHBOARD_DATA__.
  const dataScript = `<script>window.__DASHBOARD_DATA__ = ${escapeForScript(JSON.stringify(data))};</script>`;

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
