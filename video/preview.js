// Renders still frames at given times for checking: node preview.js 3 8.5 14 ...
const { open } = require('./lib.js');
(async () => {
  const { browser, page } = await open('/video/index.html');
  await page.waitForFunction(() => window.framesReady && window.framesReady(), null, { timeout: 30000 });
  for (const t of process.argv.slice(2).map(Number)) {
    await page.evaluate(t => window.seek(t), t);
    await page.screenshot({ path: `shots/f_${t}.jpg`, quality: 70 });
  }
  await browser.close();
})();
