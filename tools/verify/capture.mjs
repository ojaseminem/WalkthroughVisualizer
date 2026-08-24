/**
 * Headless verification for the M1 vertical slice.
 *
 * Loads the built viewer in Chromium with SwiftShader, drives the runtime API
 * directly (no pointer lock in headless), and asserts the things that must never
 * silently regress: no console errors, the registry actually populated, the
 * player stands on a floor rather than falling, and walking forward does not
 * pass through a wall. Screenshots are a by-product for eyeballing the art.
 *
 *   node tools/verify/capture.mjs [--url http://localhost:4173/]
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from './serve.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : []).filter(Boolean),
);

// Either point at a running dev server, or hand over a built directory and let
// the harness serve it. The second form is what CI uses — no background process,
// no fixed port, no startup race.
const SERVE_DIR = args.serve ?? (args.url ? null : 'apps/viewer/dist');
let server = null;
if (SERVE_DIR) {
  if (!existsSync(resolve(SERVE_DIR))) {
    console.error(`\n  Nothing to serve at ${resolve(SERVE_DIR)} — run \`npm run build\` first.\n`);
    process.exit(2);
  }
  server = await serve(SERVE_DIR);
}
const URL_BASE = server ? server.url : args.url;

const OUT = resolve('tools/verify/out');
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  // Unit A occupies world x 13.4-21.8, z 0-10 (add 13.4 to a unit-local x).
  // Every position below sits on clear floor, away from furniture collision.
  { name: '01-lobby',    level: 'L00',  pos: [11.2, 0.2, 3.6],  yaw: 1.12,       pitch: -0.04, tod: 'morning' },
  { name: '02-corridor', level: 'L01',  pos: [17.5, 3.2, -1.0], yaw: Math.PI / 2, pitch: -0.02, tod: 'noon' },
  { name: '03-living',   level: 'L01',  pos: [14.9, 3.2, 2.5],  yaw: -2.36,      pitch: -0.08, tod: 'noon' },
  { name: '04-dining',   level: 'L01',  pos: [15.4, 3.2, 2.6],  yaw: 0.0,        pitch: -0.10, tod: 'morning' },
  { name: '05-kitchen',  level: 'L02',  pos: [18.3, 6.2, 2.55], yaw: -Math.PI / 2, pitch: -0.08, tod: 'noon' },
  { name: '06-mbed',     level: 'L02',  pos: [16.6, 6.2, 7.3],  yaw: 2.32,       pitch: -0.06, tod: 'evening' },
  { name: '07-bed2',     level: 'L02',  pos: [20.4, 6.2, 7.1],  yaw: 0.0,        pitch: -0.08, tod: 'noon' },
  { name: '08-sundeck',  level: 'L03',  pos: [20.4, 9.2, 8.6],  yaw: -2.36,      pitch: 0.02,  tod: 'evening' },
  { name: '09-unitB',    level: 'L03',  pos: [6.9, 9.2, 2.5],   yaw: 2.36,       pitch: -0.08, tod: 'morning' },
  { name: '10-stair',    level: 'L01',  pos: [9.4, 3.2, 3.5],   yaw: -Math.PI / 2, pitch: 0.12, tod: 'noon' },
  { name: '11-terrace',  level: 'ROOF', pos: [6.0, 12.2, 5.0],  yaw: -1.9,       pitch: -0.06, tod: 'evening' },
  // Free camera: position plus an explicit look target, so a shot can never end
  // up buried inside a context block.
  { name: '12-massing',  level: 'L00', free: [-24, 28, -34], look: [11, 7, 4], tod: 'evening' },
  { name: '13-approach', level: 'L00', free: [11, 2.2, -26], look: [11, 6, 0], tod: 'morning' },
];

const errors = [];
const warnings = [];

// The container ships a Chromium under PLAYWRIGHT_BROWSERS_PATH that may not match
// the npm package's expected build number, so point at it explicitly.
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

process.on('uncaughtException', async (err) => {
  console.error(err);
  if (server) await server.close();
  process.exit(1);
});

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push(t);
  if (m.type() === 'warning') warnings.push(t);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const failedUrls = [];
const okUrls = new Set();
page.on('requestfailed', (r) => failedUrls.push(`${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.status() >= 400) failedUrls.push(`${r.url()} :: HTTP ${r.status()}`);
  else okUrls.add(r.url());
});

await page.goto(URL_BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.wv && window.wv.reg, null, { timeout: 60000 });
await page.waitForTimeout(1200);

// --------------------------------------------------------------------------- //
// Registry assertions
// --------------------------------------------------------------------------- //

const reg = await page.evaluate(() => {
  const r = window.wv.reg;
  return {
    project: r.project,
    levels: r.levels.map((l) => ({ id: l.id, elevation: l.elevation })),
    zones: r.zones.length,
    unitZones: r.zones.filter((z) => z.category === 'unit').length,
    navFloors: r.navFloors.length,
    navBlocks: r.navBlocks.length,
    portals: r.portals.length,
    pois: r.pois.length,
    tours: r.tours.map((t) => ({ id: t.id, keys: t.keys.length })),
    warnings: r.warnings,
    untaggedMeshes: r.untaggedMeshes,
    walkables: r.walkables.length,
  };
});

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

check('project tag present', !!reg.project && reg.project.id === 'kp-tower', JSON.stringify(reg.project?.id));
check('five levels found', reg.levels.length === 5, `${reg.levels.length}`);
check('six unit zones', reg.unitZones === 6, `${reg.unitZones}`);
check('zones populated', reg.zones > 60, `${reg.zones}`);
check('nav floors populated', reg.navFloors > 40, `${reg.navFloors}`);
check('collision volumes populated', reg.navBlocks > 300, `${reg.navBlocks}`);
check('portals wired', reg.portals === 54, `${reg.portals}`);
check('pois found', reg.pois === 38, `${reg.pois}`);
check('tours have >=2 stops', reg.tours.every((t) => t.keys >= 2), JSON.stringify(reg.tours.length));
check('no unresolved portal targets',
  !reg.warnings.some((w) => w.includes('missing zone')),
  reg.warnings.filter((w) => w.includes('missing zone')).slice(0, 3).join(' | '));

// --------------------------------------------------------------------------- //
// Physics assertions
// --------------------------------------------------------------------------- //

const physics = await page.evaluate(async () => {
  const wv = window.wv;
  const out = {};

  // SwiftShader renders at roughly one frame per second, so wall-clock stepping
  // would test the rasteriser rather than the movement code. Drive the player
  // at a fixed timestep instead — deterministic, and independent of the GPU.
  const step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) wv.player.update(dt); };

  wv.setLevel('L01', { teleport: false });
  wv.player.enabled = true;
  wv.player.locked = true;

  // 1. Stand in Unit A's living room and settle.
  wv.player.teleport(16.2, 3.4, 3.4, 0);
  step(30);
  out.restY = wv.player.position.y;
  out.grounded = wv.player.grounded;

  // 2. Walk hard into the west exterior wall of Unit A. Lane z=2.2 is clear of
  //    furniture, so this tests the wall and not the sofa.
  wv.player.teleport(16.4, 3.4, 2.2, 0);
  step(15);
  const startX = wv.player.position.x;
  wv.player.yaw = Math.PI / 2;               // face -X
  wv.player.keys.add('KeyW');
  step(180);
  wv.player.keys.delete('KeyW');
  step(10);
  out.wallStartX = startX;
  out.wallEndX = wv.player.position.x;
  out.wallEndY = wv.player.position.y;
  out.wallTravelled = startX - wv.player.position.x;

  // 3. Walk through the living-room door into the kitchen — a portal must be
  //    passable, or the whole tagging contract is worthless.
  wv.player.teleport(16.4, 3.4, 2.55, 0);
  step(10);
  wv.player.yaw = -Math.PI / 2;              // face +X toward the kitchen door
  wv.player.keys.add('KeyW');
  step(150);
  wv.player.keys.delete('KeyW');
  step(5);
  out.doorEndX = wv.player.position.x;

  // 4. Climb the L01 -> L02 flight.
  wv.player.teleport(8.6, 3.3, 3.4, 0);
  step(20);
  out.stairBaseY = wv.player.position.y;
  wv.player.yaw = -Math.PI / 2;              // face +X, up the flight
  wv.player.keys.add('KeyW');
  step(300);
  wv.player.keys.delete('KeyW');
  step(10);
  out.stairTopY = wv.player.position.y;
  out.stairTopX = wv.player.position.x;

  // 5. Park back in the living room for the zone check below.
  wv.player.teleport(16.2, 3.4, 3.4, 0);
  step(10);
  wv.player.locked = false;
  return out;
});

// One explicit frame drives the zone readout, so this does not race the
// (very slow) software rasteriser's own animation loop.
const zoneProbe = await page.evaluate(() => {
  window.wv.frame();
  return window.wv.currentZone ? window.wv.currentZone.label : null;
});

check('player rests on the slab', Math.abs(physics.restY - 3.0) < 0.08, `y=${physics.restY.toFixed(3)}`);
check('player is grounded', physics.grounded === true);
check('zone readout resolves', zoneProbe === 'Living & Dining', `${zoneProbe}`);
check('player actually moved', physics.wallTravelled > 1.4, `${physics.wallTravelled.toFixed(2)} m`);
check('wall stops the player', physics.wallEndX > 13.5 && physics.wallEndX < 14.3,
  `stopped at x=${physics.wallEndX.toFixed(2)} (wall inner face 13.50)`);
check('player did not fall', physics.wallEndY > 2.5, `y=${physics.wallEndY.toFixed(2)}`);
check('door opening is passable', physics.doorEndX > 19.4,
  `reached x=${physics.doorEndX.toFixed(2)} (kitchen starts at world 19.0)`);
check('stairs are climbable', physics.stairTopY - physics.stairBaseY > 2.4,
  `${physics.stairBaseY.toFixed(2)} -> ${physics.stairTopY.toFixed(2)} (one storey = 3.0)`);
check('stair does not punch the slab', physics.stairTopY < 6.4,
  `arrived at y=${physics.stairTopY.toFixed(2)}`);

// --------------------------------------------------------------------------- //
// Perf sample
// --------------------------------------------------------------------------- //

const perf = await page.evaluate(async () => {
  const wv = window.wv;
  wv.setLevel('L01', { teleport: false });
  wv.player.teleport(16.2, 3.4, 3.4, -2.3);
  const frames = [];
  await new Promise((res) => {
    let n = 0;
    const t = (last) => (ts) => {
      if (last) frames.push(ts - last);
      if (++n > 90) return res();
      requestAnimationFrame(t(ts));
    };
    requestAnimationFrame(t(0));
  });
  frames.sort((a, b) => a - b);
  return {
    medianMs: frames[Math.floor(frames.length / 2)],
    p95Ms: frames[Math.floor(frames.length * 0.95)],
    drawCalls: wv.renderer.info.render.calls,
    triangles: wv.renderer.info.render.triangles,
    programs: wv.renderer.info.programs.length,
    textures: wv.renderer.info.memory.textures,
    geometries: wv.renderer.info.memory.geometries,
  };
});

// SwiftShader is a software rasteriser — absolute timings mean nothing here.
// Draw calls and triangle counts are the numbers that carry to real hardware.
check('draw calls within budget', perf.drawCalls <= 150, `${perf.drawCalls} / 150`);
check('triangles within budget', perf.triangles <= 180000, `${perf.triangles} / 180000`);

// --------------------------------------------------------------------------- //
// Screenshots
// --------------------------------------------------------------------------- //

// Dismiss the entry overlays so the shots show the scene, not the splash.
await page.evaluate(() => {
  for (const id of ['loader', 'start']) document.getElementById(id).classList.add('hidden');
});

for (const s of SHOTS) {
  await page.evaluate(async (shot) => {
    const wv = window.wv;
    wv.setTimeOfDay(shot.tod);
    wv.setLevel(shot.level, { teleport: false });
    wv.player.enabled = true;
    if (shot.free) {
      wv.player.enabled = false;
      wv.camera.position.set(...shot.free);
      wv.camera.up.set(0, 1, 0);
      wv.camera.lookAt(...shot.look);
    } else {
      wv.player.enabled = true;
      wv.player.teleport(shot.pos[0], shot.pos[1], shot.pos[2], shot.yaw);
      wv.player.pitch = shot.pitch;
      wv.player.update(1 / 60);
    }
  }, s);
  // Software rasterisation runs near 1 fps, so wait for real frames to land
  // rather than a nominal settle time.
  await page.evaluate(() => new Promise((res) => {
    let n = 0;
    const t = () => (++n >= 3 ? res() : requestAnimationFrame(t));
    requestAnimationFrame(t);
  }));
  await page.screenshot({ path: `${OUT}/${s.name}.png` });
}

// UI states worth capturing.
await page.evaluate(() => {
  window.wv.player.enabled = true;
  window.wv.setLevel('L01');
  window.wv.setTimeOfDay('noon');
  document.getElementById('btn-rooms').click();
});
await page.evaluate(() => new Promise((res) => {
  let n = 0; const t = () => (++n >= 3 ? res() : requestAnimationFrame(t)); requestAnimationFrame(t);
}));
await page.screenshot({ path: `${OUT}/09-directory.png` });

await page.evaluate(() => {
  document.getElementById('btn-rooms').click();
  const poi = window.wv.reg.poiById.get('l01.a.living');
  window.wv.goToPoi('l01.a.living');
  window.dispatchEvent(new Event('resize'));
  return poi;
});
await page.evaluate(() => {
  const ev = new MouseEvent('mousedown', { clientX: 0, clientY: 0 });
  const wv = window.wv;
  // Open the panel through the public path the UI uses.
  const poi = wv.reg.poiById.get('l01.a.kitchen');
  wv.goToPoi('l01.a.kitchen');
  wv.pois.setHovered(poi);
});
await page.evaluate(() => new Promise((res) => {
  let n = 0; const t = () => (++n >= 4 ? res() : requestAnimationFrame(t)); requestAnimationFrame(t);
}));
await page.screenshot({ path: `${OUT}/10-poi-approach.png` });

// --------------------------------------------------------------------------- //
// Report
// --------------------------------------------------------------------------- //

await browser.close();

// Google Fonts is unreachable from a sandboxed runner; that is the environment,
// not the app. A URL that also came back 2xx is not a failure either — Chromium
// reports ERR_ABORTED for duplicate and speculative requests that it cancels
// itself, and the asset still arrived.
const EXTERNAL = /fonts\.(googleapis|gstatic)\.com/;
const appFailures = failedUrls.filter((entry) => {
  const url = entry.split(' :: ')[0];
  return !EXTERNAL.test(url) && !okUrls.has(url);
});
const realErrors = errors.filter(
  (e) => !/WebGL|SwiftShader|GPU stall|net::ERR_FAILED|net::ERR_TUNNEL_CONNECTION_FAILED/i.test(e)
    && !(/Failed to load resource/i.test(e) && appFailures.length === 0),
);
check('no failed app requests', appFailures.length === 0, appFailures.slice(0, 3).join(' | '));
check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

const report = { url: URL_BASE, registry: reg, physics, perf, checks, errors: realErrors, failedRequests: failedUrls, succeededRequests: [...okUrls], warnings: reg.warnings };
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

const pad = (s, n) => String(s).padEnd(n);
console.log('\n  M1 verification\n  ' + '-'.repeat(64));
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${pad(c.name, 34)} ${c.detail}`);
}
console.log('  ' + '-'.repeat(64));
console.log(`  scene    ${reg.zones} zones · ${reg.pois} POIs · ${reg.portals} portals · ${reg.navBlocks} collision volumes`);
console.log(`  render   ${perf.drawCalls} draw calls · ${perf.triangles} triangles · ${perf.programs} programs`);
console.log(`  frames   median ${perf.medianMs.toFixed(1)}ms · p95 ${perf.p95Ms.toFixed(1)}ms  (software raster — indicative only)`);
if (reg.warnings.length) console.log(`  warnings ${reg.warnings.length} (see report.json)`);

const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
