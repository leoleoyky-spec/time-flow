// Captures still screenshots of the demo site used as mockup material in the video.
const { open } = require('./lib.js');
(async () => {
  const { browser, page } = await open('/montblanc-site/index.html', 1440, 900);
  const shot = (name, opts = {}) => page.screenshot({ path: `assets/${name}.png`, ...opts });
  for (const t of [0.6, 1.4, 2.4, 6]) { await page.evaluate(t => window.__mb.seek(t), t); await shot(`hero_${t}`); }
  await page.evaluate(() => window.__mb.seek(6));
  for (const [x, y, n] of [[300, 340, 'a'], [230, 250, 'b'], [300, 190, 'c'], [330, 470, 'd']]) {
    await page.evaluate(([x, y]) => window.__mb.lens(x, y, true), [x, y]); await shot(`lens_${n}`);
  }
  // "before" version of the lens for the refine step: smaller, plain white rim, no layer tag
  await page.addStyleTag({ content: '.lens{width:170px!important;height:170px!important;margin:-85px 0 0 -85px!important;box-shadow:0 0 0 2px #fff,0 10px 30px rgba(0,0,0,.4)!important}.lens::after{display:none}.lens-tag{display:none!important}' });
  await page.evaluate(() => { window.__mb.lens(300, 340, true); document.getElementById('inside').style.clipPath = 'circle(58px at 50% 53.1%)'; });
  await shot('lens_before');
  await page.reload({ waitUntil: 'networkidle' }); await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.__mb.seek(6));
  for (const [y, n] of [[900, 'concept'], [1560, 'menu'], [2300, 'reserve']]) { await page.evaluate(y => window.__mb.scroll(y), y); await shot(`sec_${n}`); }
  await page.evaluate(() => window.__mb.scroll(0));
  await page.addStyleTag({ content: '.halo,.hint,nav{display:none!important}' });
  const stage = await page.$('#stage');
  await page.evaluate(() => { document.body.style.background = 'transparent'; document.documentElement.style.background = 'transparent'; });
  await page.evaluate(() => { const i = document.getElementById('inside'); i.style.visibility = 'hidden'; });
  await stage.screenshot({ path: 'assets/stage_out.png', omitBackground: true });
  await page.evaluate(() => { const i = document.getElementById('inside'); i.style.visibility = 'visible'; i.style.clipPath = 'none'; i.style.transform = 'none'; document.getElementById('outside').style.visibility = 'hidden'; });
  await stage.screenshot({ path: 'assets/stage_in.png', omitBackground: true });
  await page.evaluate(() => { document.getElementById('outside').style.visibility = 'visible'; document.getElementById('inside').style.visibility = 'hidden'; });
  await browser.close();
})();
