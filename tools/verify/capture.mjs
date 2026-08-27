/**
 * Headless verification for the M1 vertical slice.
 *
 * Runs the built viewer in Chromium on SwiftShader and drives window.wv
 * directly, since headless gets no pointer lock. The checks cover console
 * errors, the registry contents, and movement: the player has to rest on a
 * slab, stop at a wall, fit through a door, climb a flight. Screenshots come
 * out at the end so the art can be eyeballed.
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

// --url points at a dev server that is already up. --serve hands a built
// directory to the in-process server. CI uses --serve, so nothing is left
// running once the harness exits.
const SERVE_DIR = args.serve ?? (args.url ? null : 'apps/viewer/dist');
let server = null;
if (SERVE_DIR) {
  if (!existsSync(resolve(SERVE_DIR))) {
    console.error(`\n  Nothing to serve at ${resolve(SERVE_DIR)}. Run \`npm run build\` first.\n`);
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
  // Free camera. Position and look target are both explicit, so these two do
  // not depend on where the player is standing.
  { name: '12-massing',  level: 'L00', free: [-24, 28, -34], look: [11, 7, 4], tod: 'evening' },
  { name: '13-approach', level: 'L00', free: [11, 2.2, -26], look: [11, 6, 0], tod: 'morning' },
  // Mode shots carry no position. The rig picks the framing, and that default
  // pose is what is under test.
  { name: '14-dollhouse', mode: 'dollhouse', level: 'L01', tod: 'noon' },
  { name: '15-plan-L01',  mode: 'plan',      level: 'L01', tod: 'noon' },
  { name: '16-exploded',  mode: 'exploded',  level: 'L01', tod: 'morning' },
  { name: '17-exploded-low', mode: 'exploded', level: 'L01', tod: 'evening', azimuth: 0.9, elevation: 0.22 },
];

const errors = [];
const warnings = [];

// The container's Chromium under PLAYWRIGHT_BROWSERS_PATH often carries a
// build number the npm package does not expect, and playwright then refuses to
// launch. Find the binary and pass the path in.
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
// 1024x640 for the checks. Every pixel costs real seconds on a software
// rasteriser, and nothing checked here depends on viewport size, because the
// physics runs at a fixed timestep. The screenshot pass resizes later.
const page = await browser.newPage({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1 });

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

  // SwiftShader manages about one frame a second, so stepping the player on
  // real frames would measure the rasteriser. Fixed 1/60 steps give the same
  // distances on any machine.
  const step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) wv.player.update(dt); };

  wv.setLevel('L01', { teleport: false });
  wv.player.enabled = true;
  // Walking only runs while a look drag is active, which on desktop means the
  // right mouse button is held. There is no real pointer here, so set the flag
  // beginDrag would set and skip the pointer capture and lock requests.
  wv.player.dragging = true;

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

  // 3. Walk from the living room through to the kitchen. A tagged portal you
  //    cannot walk through means the tagging went wrong upstream.
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
  wv.player.dragging = false;
  return out;
});

// Pump one frame by hand. The zone readout updates in frame(), and waiting for
// the render loop to get there costs a second or more per frame.
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
// View modes and tour
// --------------------------------------------------------------------------- //

const modes = await page.evaluate(async () => {
  const wv = window.wv;
  const out = {};
  const settle = (n = 200) => {
    for (let i = 0; i < n; i++) { wv.rig.update(1 / 60); wv.explode.update(1 / 60); }
  };


  // Dollhouse: rig should frame the whole site from outside it.
  wv.setViewMode('dollhouse', { animate: false });
  settle();
  out.dollhouseDist = wv.rig.distance;
  out.dollhouseMode = wv.viewMode;
  out.playerDisabledInOrbit = wv.player.enabled === false;

  // Plan: near-vertical, and levels above the current one hidden.
  wv.setLevel('L01', { teleport: false });
  wv.setViewMode('walk', { animate: false });
  wv.setViewMode('plan', { animate: false });
  settle();
  out.planElevation = wv.rig.elevation;
  out.hiddenAbove = wv.reg.levels.filter((l) => l.object.visible === false).map((l) => l.id);

  // Exploded: levels pulled apart, and put back when walk resumes.
  wv.setViewMode('walk', { animate: false });
  wv.setViewMode('exploded', { animate: false });
  settle(400);
  out.spread = wv.explode.spread;
  const l3 = wv.reg.levelById.get('L03');
  out.l3ExplodedY = l3.object.position.y;
  out.l3BaseY = l3.elevation;
  out.allLevelsVisible = wv.reg.levels.every((l) => l.object.visible);

  wv.setViewMode('walk', { animate: false });
  settle(400);
  out.spreadAfterWalk = wv.explode.spread;
  out.l3RestoredY = l3.object.position.y;

  // Tour: stops, seeking, and a look target that is not just the path tangent.
  wv.setLevel('L01', { teleport: false });
  wv.startTour();
  const t = wv.tourPlayer;
  out.tourStops = t ? t.keys.length : 0;
  out.tourDuration = t ? Math.round(t.duration) : 0;
  if (t) {
    t.seekToStop(3);
    t.update(wv.camera, 1 / 60);
    out.seekedStop = t.stopIndex;
    t.paused = true;
    const before = t.time;
    t.update(wv.camera, 1 / 60);
    out.pauseHolds = Math.abs(t.time - before) < 1e-6;
    t.paused = false;
    t.seekFraction(1);
    out.finishes = t.finished;
  }
  wv.stopTour();
  out.playerBackAfterTour = wv.player.enabled === true;
  return out;
});

check('orbit modes disable the player', modes.playerDisabledInOrbit === true);
check('dollhouse frames the site', modes.dollhouseDist > 20 && modes.dollhouseDist < 120,
  `distance ${modes.dollhouseDist.toFixed(1)} m`);
check('plan view looks down', modes.planElevation > 1.35,
  `elevation ${modes.planElevation.toFixed(2)} rad of 1.571`);
check('plan hides levels above', modes.hiddenAbove.join(',') === 'L02,L03,ROOF',
  modes.hiddenAbove.join(',') || 'none hidden');
check('exploded separates levels', modes.spread > 2.5 && modes.l3ExplodedY > modes.l3BaseY * 2,
  `L03 ${modes.l3BaseY} m -> ${modes.l3ExplodedY.toFixed(1)} m`);
check('exploded shows every level', modes.allLevelsVisible === true);
check('walk restores level positions', Math.abs(modes.l3RestoredY - modes.l3BaseY) < 0.01,
  `L03 back to ${modes.l3RestoredY.toFixed(2)} m`);
check('tour has stops and a duration', modes.tourStops >= 5 && modes.tourDuration > 20,
  `${modes.tourStops} stops · ${modes.tourDuration}s`);
check('tour seeks to a stop', modes.seekedStop === 3, `landed on ${modes.seekedStop}`);
check('tour pause holds time', modes.pauseHolds === true);
check('tour reports finished', modes.finishes === true);
check('player resumes after tour', modes.playerBackAfterTour === true);

// The tour used to fly through walls. Screenshots never caught it: the failure
// is about a second of camera inside a bedroom wall halfway along a leg, and
// the stops themselves look fine. Sample each curve at 400 points instead and
// test every point against the collision volumes the player already uses.
const tourPaths = await page.evaluate(() => {
  const wv = window.wv;
  const blocks = wv.reg.navBlocks;
  const hits = (p, pad) => blocks.some((b) =>
    p.x > b.min.x - pad && p.x < b.max.x + pad
    && p.y > b.min.y - pad && p.y < b.max.y + pad
    && p.z > b.min.z - pad && p.z < b.max.z + pad);
  const N = 400;
  const out = [];
  for (const tour of wv.reg.tours) {
    wv.startTour(tour.id);
    const t = wv.tourPlayer;
    let solid = 0;
    let worst = null;
    for (let i = 0; i <= N; i++) {
      const p = t.curve.getPointAt(i / N);
      if (hits(p, 0)) {
        solid++;
        if (!worst) worst = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
      }
    }
    wv.stopTour();
    out.push({ id: tour.id, pct: (100 * solid) / (N + 1), worst });
  }
  return out;
});
const throughWalls = tourPaths.filter((t) => t.pct > 0);
check('no tour passes through geometry', throughWalls.length === 0,
  throughWalls.length
    ? `${throughWalls[0].id} spends ${throughWalls[0].pct.toFixed(1)}% inside a block, first at (${throughWalls[0].worst})`
    : `${tourPaths.length} tours clear`);

// Exactly one mode button carries `.on`. A stale one lights two buttons at
// once, and then nothing on screen says which view you are in.
const switcher = await page.evaluate(() => {
  const wv = window.wv;
  const read = () => ({
    views: [...document.querySelectorAll('#views button')].filter((b) => b.classList.contains('on'))
      .map((b) => b.dataset.mode),
    levels: [...document.querySelectorAll('#levels button')].filter((b) => b.classList.contains('on'))
      .map((b) => b.dataset.level),
  });
  wv.setViewMode('walk', { animate: false });
  wv.setViewMode('dollhouse', { animate: false });
  const a = read();
  wv.setViewMode('plan', { animate: false });
  const b = read();
  wv.setViewMode('walk', { animate: false });
  const c = read();
  return { a, b, c };
});
check('one view mode marked active',
  switcher.a.views.join() === 'dollhouse'
  && switcher.b.views.join() === 'plan'
  && switcher.c.views.join() === 'walk',
  `${switcher.a.views}|${switcher.b.views}|${switcher.c.views}`);
check('one level marked active', switcher.c.levels.length === 1, switcher.c.levels.join());

// --------------------------------------------------------------------------- //
// Pipeline output
// --------------------------------------------------------------------------- //

const pipeline = await page.evaluate(async () => {
  const wv = window.wv;
  // wv-cli bakes tag volumes to AABBs and drops the meshes. A volume mesh
  // still in the scene means the build step was skipped.
  let volumeMeshes = 0;
  let taggedNodes = 0;
  wv.root.traverse((o) => {
    const t = o.userData?.wv;
    if (!t?.type) return;
    taggedNodes++;
    if (['ZONE', 'NAV_FLOOR', 'NAV_BLOCK', 'PORTAL'].includes(t.type) && o.isMesh) volumeMeshes++;
  });
  const res = await fetch('./content/kp-tower/project.json');
  const project = res.ok ? await res.json() : null;
  return {
    taggedNodes,
    volumeMeshes,
    zoneBoxesNonEmpty: wv.reg.zones.filter((z) => !z.box.isEmpty()).length,
    project,
  };
});

check('tag volumes baked to AABBs', pipeline.volumeMeshes === 0,
  `${pipeline.volumeMeshes} volumes still carry a mesh`);
check('zone boxes survived the bake', pipeline.zoneBoxesNonEmpty === reg.zones,
  `${pipeline.zoneBoxesNonEmpty} / ${reg.zones} non-empty`);
check('project.json ships and agrees with the scene',
  !!pipeline.project && pipeline.project.counts.zones === reg.zones
  && pipeline.project.counts.pois === reg.pois
  && pipeline.project.levels.length === reg.levels.length,
  pipeline.project
    ? `zones ${pipeline.project.counts.zones}, pois ${pipeline.project.counts.pois}, levels ${pipeline.project.levels.length}`
    : 'missing');
// Scene assets only. The UI logo PNGs live outside /content/, so they do not
// count against the single-file rule.
const sceneSideloads = [...okUrls].filter(
  (u) => u.includes('/content/') && !/\.(glb|json)$/i.test(u),
);
check('scene ships as one self-contained file', sceneSideloads.length === 0,
  sceneSideloads.slice(0, 2).join(' | ') || 'scene.glb + project.json only');

// --------------------------------------------------------------------------- //
// Perf sample
// --------------------------------------------------------------------------- //

const perf = await page.evaluate(async (frameCount) => {
  const wv = window.wv;
  wv.setLevel('L01', { teleport: false });
  wv.player.teleport(16.2, 3.4, 3.4, -2.3);
  const frames = [];
  await new Promise((res) => {
    let n = 0;
    const t = (last) => (ts) => {
      if (last) frames.push(ts - last);
      if (++n > frameCount) return res();
      requestAnimationFrame(t(ts));
    };
    requestAnimationFrame(t(0));
  });
  frames.sort((a, b) => a - b);
  return {
    medianMs: frames[Math.floor(frames.length / 2)] ?? 0,
    p95Ms: frames[Math.floor(frames.length * 0.95)] ?? 0,
    sampled: frames.length,
    drawCalls: wv.renderer.info.render.calls,
    triangles: wv.renderer.info.render.triangles,
    programs: wv.renderer.info.programs.length,
    textures: wv.renderer.info.memory.textures,
    geometries: wv.renderer.info.memory.geometries,
  };
}, Number(args['perf-frames'] ?? 8));
// Eight frames is enough. The draw-call and triangle counts settle on the first
// frame, and the timings are rasteriser noise. The old 90-frame sample spent
// minutes of CI measuring nothing.

// Only the counts are asserted. Timings off a software rasteriser say nothing
// about a phone. Draw calls and triangles carry across to real hardware.
check('draw calls within budget', perf.drawCalls <= 150, `${perf.drawCalls} / 150`);
check('triangles within budget', perf.triangles <= 180000, `${perf.triangles} / 180000`);

// --------------------------------------------------------------------------- //
// Mobile pass
//
// `isTouchDevice()` is read once at module load, so resizing the desktop page
// proves nothing about the phone build. This needs a second browser context
// that reports touch from the start.
// --------------------------------------------------------------------------- //

let mobile = { skipped: true };
const mctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const mpage = await mctx.newPage();
const mobileErrors = [];
mpage.on('pageerror', (e) => mobileErrors.push(e.message));
try {
  // Both pages rasterise in software on the same CPU. Leave the desktop render
  // loop running and the phone context never finishes its first frame.
  await page.evaluate(() => window.wv?.stop());
  await mpage.goto(URL_BASE, { waitUntil: 'networkidle' });
  await mpage.waitForFunction(() => window.wv && window.wv.reg, null, { timeout: 120000 });

  mobile = await mpage.evaluate(async () => {
    const wv = window.wv;
    const out = {};
    out.detectedTouch = wv.isTouch === true;
    out.hasTouchLayer = !!wv.touch;
    out.bodyTouchClass = document.body.classList.contains('touch');
    out.crosshairHidden = getComputedStyle(document.getElementById('crosshair')).display === 'none';

    // Press in the lower-left zone and drag upward, the way a thumb would.
    const canvas = document.querySelector('#stage canvas');
    const r = canvas.getBoundingClientRect();
    const ox = r.left + r.width * 0.18;
    const oy = r.top + r.height * 0.78;
    const ev = (type, x, y, id) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    ev('pointerdown', ox, oy, 1);
    ev('pointermove', ox, oy - 50, 1);
    out.stickVisible = document.getElementById('stick').classList.contains('on');
    out.analogForward = wv.player.analog.y;      // negative is forward
    out.analogSide = wv.player.analog.x;

    // Step the player too. Analog input arriving does not prove it moves anything.
    wv.player.enabled = true;
    const before = wv.player.position.clone();
    for (let i = 0; i < 90; i++) wv.player.update(1 / 60);
    out.walked = wv.player.position.distanceTo(before);

    ev('pointerup', ox, oy - 50, 1);
    out.analogReleased = wv.player.analog.y;
    out.stickHidden = !document.getElementById('stick').classList.contains('on');

    // Look-drag on the right side of the screen.
    const yaw0 = wv.player.yaw;
    ev('pointerdown', r.left + r.width * 0.8, r.top + r.height * 0.5, 2);
    ev('pointermove', r.left + r.width * 0.8 - 90, r.top + r.height * 0.5, 2);
    ev('pointerup', r.left + r.width * 0.8 - 90, r.top + r.height * 0.5, 2);
    out.yawChanged = Math.abs(wv.player.yaw - yaw0) > 0.1;
    return out;
  });

  check('mobile detects touch', mobile.detectedTouch && mobile.hasTouchLayer && mobile.bodyTouchClass);
  check('mobile hides the crosshair', mobile.crosshairHidden === true);
  check('virtual stick appears on touch', mobile.stickVisible === true);
  check('stick drives forward input', mobile.analogForward < -0.4,
    `analog.y = ${mobile.analogForward?.toFixed(2)}`);
  check('stick actually walks the player', mobile.walked > 1.0, `${mobile.walked?.toFixed(2)} m`);
  check('stick releases cleanly', mobile.analogReleased === 0 && mobile.stickHidden === true);
  check('look drag turns the camera', mobile.yawChanged === true);
  check('no mobile page errors', mobileErrors.length === 0, mobileErrors.slice(0, 2).join(' | '));
} catch (err) {
  check('mobile pass ran', false, err.message.split('\n')[0]);
} finally {
  await page.evaluate(() => window.wv?.start()).catch(() => {});
}

// --------------------------------------------------------------------------- //
// Print the checks before anything slow
//
// The screenshot pass can hit the job timeout on a GPU-less runner. Taken
// first, a timeout there kills the run with no diagnostics printed at all.
// Everything that can fail the build is decided and printed here.
// --------------------------------------------------------------------------- //

// Two kinds of noise get filtered out of the request log. Google Fonts is
// unreachable from a sandboxed runner, so a failure there is the environment.
// A URL that also came back 2xx is fine: Chromium logs ERR_ABORTED for
// speculative and duplicate requests it cancels itself, long after the asset
// arrived.
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

// The panel is populated from a POI's extras and there was nothing covering
// it, while the screenshot that claimed to show it was shooting an empty room.
// Driving the poiTap event is the same path a tap on a marker takes, and the
// ?poi= deep link at boot ends up in the same openPoi call, so this covers
// both without a reload. A reload is not worth it here: under SwiftShader the
// page never reaches network idle inside a sane timeout.
const poiPanel = await page.evaluate(async () => {
  const wv = window.wv;
  const poi = wv.reg.poiById.get('l01.a.poi.kitchen');
  if (!poi) return { open: false, title: '', body: 0, fields: 0, err: 'no such poi' };
  wv.emit('poiTap', { poi });
  await new Promise((r) => setTimeout(r, 60));
  return {
    open: !document.getElementById('poi').classList.contains('hidden'),
    title: document.getElementById('poi-title').textContent.trim(),
    body: document.getElementById('poi-body').textContent.trim().length,
    fields: document.getElementById('poi-fields').children.length,
  };
}).catch((err) => ({ open: false, title: '', body: 0, fields: 0, err: err.message.split('\n')[0] }));
check('poi panel opens and fills',
  poiPanel.open && poiPanel.title.length > 2 && poiPanel.body > 20 && poiPanel.fields >= 2,
  poiPanel.err || `${poiPanel.open ? 'open' : 'closed'}, "${poiPanel.title}", `
    + `${poiPanel.body} chars, ${poiPanel.fields} field nodes`);

const pad = (str, n) => String(str).padEnd(n);
console.log('\n  M1 verification\n  ' + '-'.repeat(64));
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${pad(c.name, 34)} ${c.detail}`);
}
console.log('  ' + '-'.repeat(64));
console.log(`  scene    ${reg.zones} zones · ${reg.pois} POIs · ${reg.portals} portals · ${reg.navBlocks} collision volumes`);
console.log(`  render   ${perf.drawCalls} draw calls · ${perf.triangles} triangles · ${perf.programs} programs`);
console.log(`  frames   median ${perf.medianMs.toFixed(1)}ms over ${perf.sampled} (software raster, indicative only)`);
if (reg.warnings.length) console.log(`  warnings ${reg.warnings.length} (see report.json)`);

const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);

// --------------------------------------------------------------------------- //
// Screenshots: for humans, bounded and non-fatal
//
// On a GPU-less runner a single 1440x900 WebGL frame can exceed Playwright's
// screenshot timeout. Low quality shrinks the viewport and drops shadows, and
// that is the difference between getting pictures and getting none. A shot that
// fails is reported and never thrown. A slow rasteriser is not a regression.
// --------------------------------------------------------------------------- //

const SHOT_QUALITY = args['shots'] ?? 'full';         // full | low | off
const SHOT_BUDGET_MS = Number(args['shot-budget'] ?? 480000);
const shotResults = { taken: [], failed: [], skipped: [] };

if (SHOT_QUALITY !== 'off') {
  page.setDefaultTimeout(60000);

  if (SHOT_QUALITY === 'low') {
    await page.setViewportSize({ width: 960, height: 600 });
    await page.evaluate(() => {
      window.wv.renderer.shadowMap.enabled = false;
      window.wv.sun.castShadow = false;
    });
  } else {
    await page.setViewportSize({ width: 1280, height: 800 });
  }

  // Dismiss the entry overlays so the shots show the scene behind them.
  await page.evaluate(() => {
    for (const id of ['loader', 'start']) document.getElementById(id).classList.add('hidden');
  });

  const started = Date.now();
  const settle = (frames = 2) => page.evaluate((n) => new Promise((res) => {
    let i = 0;
    const t = () => (++i >= n ? res() : requestAnimationFrame(t));
    requestAnimationFrame(t);
  }), frames);

  async function shoot(name, setup, frames = 2) {
    if (Date.now() - started > SHOT_BUDGET_MS) {
      shotResults.skipped.push(name);
      return;
    }
    try {
      if (setup) await setup();
      await settle(frames);
      // The DOM paints on its own schedule, so a class change that started a
      // CSS transition can still be mid-fade once the WebGL frames have landed.
      await page.waitForTimeout(220);
      await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 60000 });
      shotResults.taken.push(name);
    } catch (err) {
      shotResults.failed.push(`${name}: ${err.message.split('\n')[0]}`);
    }
  }

  for (const s of SHOTS) {
    await shoot(s.name, () => page.evaluate((shot) => {
      const wv = window.wv;
      wv.setTimeOfDay(shot.tod);

      if (shot.mode) {
        // A mode shot tests the framing the rig picks for itself.
        wv.setViewMode('walk', { animate: false });
        wv.setLevel(shot.level, { teleport: false });
        wv.setViewMode(shot.mode, { animate: false });
        if (typeof shot.azimuth === 'number') wv.rig.desiredAzimuth = shot.azimuth;
        if (typeof shot.elevation === 'number') wv.rig.desiredElevation = shot.elevation;
        // Settle rig and explode at a fixed timestep. Real frames are far too
        // slow here for either animation to converge.
        for (let i = 0; i < 400; i++) { wv.rig.update(1 / 60); wv.explode.update(1 / 60); }
        wv.blend.t = 1;
        wv.camera.position.copy(wv.rig.pose());
        wv.camera.up.set(0, 1, 0);
        wv.camera.lookAt(wv.rig.target);
        return;
      }

      wv.setViewMode('walk', { animate: false });
      wv.setLevel(shot.level, { teleport: false });
      wv.blend.t = 1;
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
    }, s));
  }

  await shoot('18-directory', () => page.evaluate(() => {
    window.wv.setViewMode('walk', { animate: false });
    window.wv.blend.t = 1;
    window.wv.player.enabled = true;
    window.wv.setLevel('L01');
    window.wv.setTimeOfDay('noon');
    document.getElementById('btn-rooms').click();
  }));

  // Through the ?poi= deep link, which is how a sales team actually shares one
  // of these: paste a link, land in front of the fitting with its panel open.
  // The old version of this shot moved the camera and set a hover but never
  // opened the drawer, so for months it was quietly shooting an empty room.
  await shoot('19-poi-panel', () => page.evaluate(() => {
    const wv = window.wv;
    wv.setViewMode('walk', { animate: false });
    wv.blend.t = 1;
    wv.setLevel('L01');
    wv.setTimeOfDay('noon');
    const poi = wv.reg.poiById.get('l01.a.poi.kitchen');
    wv.goToPoi('l01.a.poi.kitchen');
    wv.pois.setHovered(poi);
    wv.emit('poiTap', { poi });
  }), 3);

  // Phone shots, taken in the touch context that is already loaded.
  const mobileShots = [
    { name: '20-mobile-start', setup: null },
    { name: '21-mobile-walk', setup: () => mpage.evaluate(() => {
      document.getElementById('start').classList.add('hidden');
      const wv = window.wv;
      wv.setViewMode('walk', { animate: false });
      wv.setLevel('L01', { teleport: false });
      wv.player.enabled = true;
      wv.player.teleport(14.9, 3.2, 2.5, -2.36);
      wv.player.pitch = -0.08;
      wv.player.update(1 / 60);
      const c = document.querySelector('#stage canvas');
      const r = c.getBoundingClientRect();
      const ev = (t, x, y) => c.dispatchEvent(new PointerEvent(t, {
        pointerId: 9, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true,
      }));
      ev('pointerdown', r.left + r.width * 0.2, r.top + r.height * 0.76);
      ev('pointermove', r.left + r.width * 0.2 + 26, r.top + r.height * 0.76 - 40);
    }) },
    { name: '22-mobile-exploded', setup: () => mpage.evaluate(() => {
      const wv = window.wv;
      wv.setViewMode('walk', { animate: false });
      wv.setViewMode('exploded', { animate: false });
      for (let i = 0; i < 400; i++) { wv.rig.update(1 / 60); wv.explode.update(1 / 60); }
      wv.blend.t = 1;
      wv.camera.position.copy(wv.rig.pose());
      wv.camera.up.set(0, 1, 0);
      wv.camera.lookAt(wv.rig.target);
    }) },
    { name: '23-mobile-tour', setup: () => mpage.evaluate(() => {
      const wv = window.wv;
      wv.setViewMode('walk', { animate: false });
      wv.startTour();
      for (let i = 0; i < 260; i++) wv.tourPlayer.update(wv.camera, 1 / 60);
      wv.blend.t = 1;
    }) },
  ];

  // Hand the CPU back to the phone context for its shots.
  if (!mobile.skipped) await page.evaluate(() => window.wv?.stop()).catch(() => {});

  for (const m of mobileShots) {
    if (mobile.skipped) break;
    try {
      if (m.setup) await m.setup();
      await mpage.evaluate(() => new Promise((res) => {
        let i = 0;
        const t = () => (++i >= 2 ? res() : requestAnimationFrame(t));
        requestAnimationFrame(t);
      }));
      await mpage.waitForTimeout(220);
      await mpage.screenshot({ path: `${OUT}/${m.name}.png`, timeout: 60000 });
      shotResults.taken.push(m.name);
    } catch (err) {
      shotResults.failed.push(`${m.name}: ${err.message.split('\n')[0]}`);
    }
  }

  const line = [`${shotResults.taken.length} taken`];
  if (shotResults.failed.length) line.push(`${shotResults.failed.length} failed`);
  if (shotResults.skipped.length) line.push(`${shotResults.skipped.length} skipped (time budget)`);
  console.log(`  screenshots  ${line.join(' · ')}  [${SHOT_QUALITY} quality]`);
  for (const f of shotResults.failed) console.log(`    ! ${f}`);
  if (shotResults.skipped.length) console.log(`    - skipped: ${shotResults.skipped.join(', ')}`);
}
console.log('');

await mctx.close().catch(() => {});
await browser.close();
if (server) await server.close();

const report = {
  url: URL_BASE, registry: reg, physics, perf, checks,
  errors: realErrors, failedRequests: failedUrls, succeededRequests: [...okUrls],
  screenshots: shotResults, warnings: reg.warnings,
};
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

process.exit(failed.length ? 1 : 0);
