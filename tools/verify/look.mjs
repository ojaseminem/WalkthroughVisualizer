/**
 * Pictures only, no checks.
 *
 * capture.mjs runs the whole check list and 23 shots. That is the right thing
 * before a commit and far too slow for judging a lighting tweak. This renders
 * the framings below into tools/verify/out/look and stops. Name frames on the
 * command line to render fewer.
 *
 *   node tools/verify/look.mjs [name ...]
 */
import { chromium } from 'playwright';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from './serve.mjs';

function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root)) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      const p = `${root}/${d}/${rel}`;
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const FRAMES = {
  living:    { level: 'L01', pos: [14.9, 3.2, 2.5], yaw: -2.36, pitch: -0.08, tod: 'noon' },
  kitchen:   { level: 'L02', pos: [18.3, 6.2, 2.55], yaw: -Math.PI / 2, pitch: -0.08, tod: 'noon' },
  mbed:      { level: 'L02', pos: [16.6, 6.2, 7.3], yaw: 2.32, pitch: -0.06, tod: 'evening' },
  lobby:     { level: 'L00', pos: [11.2, 0.2, 3.6], yaw: 1.12, pitch: -0.04, tod: 'morning' },
  dollhouse: { level: 'L01', mode: 'dollhouse', tod: 'noon' },
  approach:  { level: 'L00', free: [11, 2.2, -26], look: [11, 6, 0], tod: 'morning' },
};

const want = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const names = want.length ? want : Object.keys(FRAMES);

const server = await serve('apps/viewer/dist');
const out = resolve('tools/verify/out/look');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
await page.goto(server.url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.wv?.reg, null, { timeout: 90000 });
await page.evaluate(() => {
  document.getElementById('start')?.classList.add('hidden');
  document.getElementById('loader')?.classList.add('hidden');
});

for (const name of names) {
  const f = FRAMES[name];
  if (!f) { console.log(`  no frame called ${name}`); continue; }
  await page.evaluate((f) => {
    const wv = window.wv;
    wv.setTimeOfDay(f.tod);
    wv.setViewMode('walk', { animate: false });
    wv.setLevel(f.level, { teleport: false });
    wv.blend.t = 1;
    if (f.mode && f.mode !== 'walk') {
      wv.setViewMode(f.mode, { animate: false });
      // A frame costs about a second under SwiftShader, so the rig easing
      // never converges on real frames. Step it at a fixed 1/60 and place the
      // camera by hand, the same way capture.mjs does.
      for (let i = 0; i < 400; i++) { wv.rig.update(1 / 60); wv.explode.update(1 / 60); }
      wv.blend.t = 1;
      wv.camera.position.copy(wv.rig.pose());
      wv.camera.up.set(0, 1, 0);
      wv.camera.lookAt(wv.rig.target);
    } else if (f.free) {
      wv.player.enabled = false;
      wv.camera.position.set(...f.free);
      wv.camera.up.set(0, 1, 0);
      wv.camera.lookAt(...f.look);
    } else {
      wv.player.enabled = true;
      wv.player.teleport(f.pos[0], f.pos[1], f.pos[2], f.yaw);
      wv.player.pitch = f.pitch;
      wv.player.update(1 / 60);
    }
    wv.renderer.shadowMap.needsUpdate = true;
  }, f);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 60000 });
  console.log(`  ${name}`);
}
await browser.close();
server.close();
