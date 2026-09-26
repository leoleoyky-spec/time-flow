// Renders the composition frame-by-frame to an MP4 (video only) and dumps the SFX cue list.
// usage: node render.js out.mp4 [fps] [start] [end]
const { open } = require('./lib.js');
const { spawn } = require('child_process');
const fs = require('fs');
const FFMPEG = require('child_process').execSync('python3 -c "import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())"').toString().trim();
(async () => {
  const out = process.argv[2] || 'out/video.mp4', fps = +(process.argv[3] || 30);
  const { browser, page } = await open('/video/index.html');
  await page.waitForFunction(() => window.framesReady && window.framesReady(), null, { timeout: 60000 });
  const dur = await page.evaluate(() => window.DURATION);
  const start = +(process.argv[4] || 0), end = +(process.argv[5] || dur);
  fs.writeFileSync('out/sfx.json', JSON.stringify(await page.evaluate(() => window.SFX), null, 1));
  const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round((end - start) * fps), t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const t = start + i / fps;
    await page.evaluate(t => window.seek(t), t);
    const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 150 === 0) console.log(`frame ${i}/${n}  t=${t.toFixed(1)}s  ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed`);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r));
  await browser.close();
})();
