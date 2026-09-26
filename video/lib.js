const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://localhost:8080';
async function open(url, w = 1920, h = 1080) {
  const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text'] });
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route =>
    route.fulfill({ status: 200, contentType: 'text/css', headers: { 'access-control-allow-origin': '*' }, body: `@import url("${BASE}/video/fonts.css");` }));
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await page.goto(BASE + url, { waitUntil: 'load', timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  return { browser, page };
}
module.exports = { open, BASE };
