import { WalkthroughViewer, TIME_OF_DAY } from '@wv/core';

/**
 * M1 viewer shell. Every panel below is driven off registry events, not off any
 * knowledge of this particular building — swap the .glb and the same shell
 * populates itself. The JSON-declared panel system replaces this by hand-wiring
 * in M3; the event contract it consumes is already the final one.
 */

const $ = (id) => document.getElementById(id);
const SCENE_URL = './content/kp-tower/scene.glb';

// Device-floor budget: mid-range Android at 30fps, from the locked decision.
// Draw calls are the binding constraint on that class of GPU long before
// triangles are; 150 is what an Adreno 6xx / Mali-G57 holds comfortably. The
// M2 pipeline's material merging is what buys headroom below this.
const BUDGET = { drawCalls: 150, triangles: 180000, fps: 30 };

const CATEGORY_COLOR = {
  living: '#E8563C', bedroom: '#6FB0AC', kitchen: '#E0B453', bath: '#8FA8C4',
  balcony: '#8CBF7A', circulation: '#A7ADA6', amenity: '#C39BD3', unit: '#F0EEE8',
};

const stage = $('stage');
const viewer = new WalkthroughViewer(stage, { startLevel: 'L01', timeOfDay: 'noon' });

let ready = false;
let activePoi = null;

// --------------------------------------------------------------------------- //
// Loading
// --------------------------------------------------------------------------- //

function setProgress(f, msg) {
  $('bar-fill').style.width = `${Math.round(f * 100)}%`;
  if (msg) $('load-status').textContent = msg;
}

viewer.addEventListener('ready', (e) => {
  const d = e.detail;
  ready = true;

  if (d.project) {
    $('proj-name').textContent = d.project.label || 'Untitled project';
    $('load-title').textContent = (d.project.label || '').split('—')[0].trim() || 'Scene';
    $('proj-sub').textContent = `${d.project.preset || 'generic'} preset · schema ${d.project.schema || '?'}`;
  }

  buildLevels(d.levels);
  buildTimeOfDay();

  setProgress(1, 'Ready');
  $('loader').classList.add('hidden');
  $('start').classList.remove('hidden');

  console.info('[wv] registry', {
    zones: d.zones, pois: d.pois, portals: d.portals,
    navBlocks: d.navBlocks, tours: d.tours.length,
  });
  if (d.warnings.length) console.warn('[wv] validator warnings\n' + d.warnings.join('\n'));
});

// --------------------------------------------------------------------------- //
// Levels
// --------------------------------------------------------------------------- //

function buildLevels(levels) {
  const nav = $('levels');
  nav.innerHTML = '';
  [...levels].reverse().forEach((lv) => {
    const b = document.createElement('button');
    b.innerHTML = `<em>${lv.label}</em><span>${lv.id}</span>`;
    b.dataset.level = lv.id;
    b.addEventListener('click', () => {
      viewer.setLevel(lv.id);
      closeDrawer('poi');
      toast(`Moved to ${lv.label}`);
    });
    nav.appendChild(b);
  });
}

viewer.addEventListener('level', (e) => {
  for (const b of $('levels').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.level === e.detail.id);
  }
  if (!$('rooms').classList.contains('hidden')) buildRooms();
});

// --------------------------------------------------------------------------- //
// Time of day
// --------------------------------------------------------------------------- //

function buildTimeOfDay() {
  const box = $('tod');
  box.innerHTML = '';
  for (const [key, p] of Object.entries(TIME_OF_DAY)) {
    const b = document.createElement('button');
    b.innerHTML = `${p.label}<span>${p.hour}</span>`;
    b.dataset.tod = key;
    b.addEventListener('click', () => viewer.setTimeOfDay(key));
    box.appendChild(b);
  }
}

viewer.addEventListener('timeofday', (e) => {
  for (const b of $('tod').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.tod === e.detail.key);
  }
});

// --------------------------------------------------------------------------- //
// Zone readout
// --------------------------------------------------------------------------- //

viewer.addEventListener('zone', (e) => {
  const z = e.detail;
  $('locus-zone').textContent = z ? z.label : 'Outside';
  const bits = [];
  if (z?.unit) bits.push(z.unit.label);
  if (z?.area) bits.push(`${z.area} sq m`);
  $('locus-meta').textContent = bits.join('  ·  ');
});

// --------------------------------------------------------------------------- //
// Stats + budget
// --------------------------------------------------------------------------- //

viewer.addEventListener('stats', (e) => {
  const s = e.detail;
  $('s-fps').textContent = s.fps.toFixed(0);
  $('s-calls').textContent = s.drawCalls;
  $('s-tris').textContent = s.triangles > 9999
    ? `${(s.triangles / 1000).toFixed(0)}k` : s.triangles;

  const over = s.drawCalls > BUDGET.drawCalls || s.triangles > BUDGET.triangles;
  const badge = $('s-budget');
  badge.textContent = over ? 'over budget' : 'within budget';
  badge.className = `badge ${over ? 'warn' : 'ok'}`;
});

// --------------------------------------------------------------------------- //
// POIs
// --------------------------------------------------------------------------- //

function openPoi(poi) {
  activePoi = poi;
  $('poi-title').textContent = poi.label;
  $('poi-body').textContent = poi.panel?.body || '';
  const dl = $('poi-fields');
  dl.innerHTML = '';
  for (const [k, v] of Object.entries(poi.panel?.fields || {})) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  const zone = viewer.reg.zoneById.get(poi.zone);
  $('poi-zone').textContent = `${poi.id}  ·  ${zone ? zone.label : poi.level}`;
  $('poi').classList.remove('hidden');
  $('rooms').classList.add('hidden');
  history.replaceState(null, '', `?poi=${encodeURIComponent(poi.id)}`);
}

function closeDrawer(id) {
  $(id).classList.add('hidden');
  if (id === 'poi') {
    activePoi = null;
    history.replaceState(null, '', location.pathname);
  }
  if (id === 'rooms') $('btn-rooms').classList.remove('on');
}

for (const b of document.querySelectorAll('[data-close]')) {
  b.addEventListener('click', () => closeDrawer(b.dataset.close));
}

// --------------------------------------------------------------------------- //
// Room directory
// --------------------------------------------------------------------------- //

function buildRooms() {
  const list = $('rooms-list');
  list.innerHTML = '';
  const level = viewer.currentLevel;

  const units = viewer.reg.zones.filter((z) => z.category === 'unit' && z.level === level);
  const commons = viewer.reg.zones.filter(
    (z) => z.level === level && z.category !== 'unit' && !z.parent,
  );

  const section = (title, zones) => {
    if (!zones.length) return;
    const h = document.createElement('div');
    h.className = 'room-group';
    h.innerHTML = `<span>${title}</span>`;
    list.appendChild(h);
    for (const z of zones) {
      const b = document.createElement('button');
      const dot = CATEGORY_COLOR[z.category] || '#A7ADA6';
      b.innerHTML = `<span><em style="background:${dot}"></em>${z.label}</span>`
        + `<i>${z.area ? z.area + ' sq m' : (z.category || '')}</i>`;
      b.addEventListener('click', () => {
        const c = z.box.getCenter(new (viewer.camera.position.constructor)());
        const lv = viewer.reg.levelById.get(z.level);
        viewer.player.teleport(c.x, (lv?.elevation ?? 0) + 0.2, c.z);
        closeDrawer('rooms');
        toast(`Jumped to ${z.label}`);
      });
      list.appendChild(b);
    }
  };

  section('Common areas', commons);
  for (const u of units) {
    const rooms = viewer.reg.zones
      .filter((z) => z.parent === u.id)
      .sort((a, b) => (b.area || 0) - (a.area || 0));
    section(u.label, rooms);
  }
}

$('btn-rooms').addEventListener('click', () => {
  const el = $('rooms');
  const opening = el.classList.contains('hidden');
  if (opening) { buildRooms(); el.classList.remove('hidden'); $('poi').classList.add('hidden'); }
  else el.classList.add('hidden');
  $('btn-rooms').classList.toggle('on', opening);
});

// --------------------------------------------------------------------------- //
// Tour
// --------------------------------------------------------------------------- //

function firstTourOnLevel() {
  return viewer.reg.tours.find((t) => t.level === viewer.currentLevel) || viewer.reg.tours[0];
}

$('btn-tour').addEventListener('click', () => {
  if (viewer.tour) { viewer.stopTour(); return; }
  const t = firstTourOnLevel();
  if (t) viewer.startTour(t.id);
  else toast('No guided tour on this level');
});

$('tour-exit').addEventListener('click', () => viewer.stopTour());

viewer.addEventListener('tour', (e) => {
  const d = e.detail;
  if (d.state === 'start') {
    $('tour-bar').classList.remove('hidden');
    $('btn-tour').classList.add('on');
    $('tour-stop').textContent = d.label;
    document.body.classList.remove('aiming');
  } else if (d.state === 'stop') {
    $('tour-bar').classList.add('hidden');
    $('btn-tour').classList.remove('on');
  } else if (d.state === 'stop-reached' && d.label) {
    $('tour-stop').textContent = d.label;
  }
});

// --------------------------------------------------------------------------- //
// Pointer lock, hover, clicks
// --------------------------------------------------------------------------- //

$('start-btn').addEventListener('click', () => {
  $('start').classList.add('hidden');
  viewer.player.requestLock();
});

$('start').addEventListener('click', (e) => {
  if (e.target === $('start')) { $('start').classList.add('hidden'); viewer.player.requestLock(); }
});

viewer.addEventListener('lock', (e) => {
  if (!e.detail.locked && ready && !viewer.tour) {
    document.body.classList.remove('aiming');
    $('hover-label').classList.add('hidden');
  }
});

stage.addEventListener('click', () => {
  if (!ready) return;
  if (viewer.tour) return;
  if (!viewer.player.locked) { viewer.player.requestLock(); return; }
  const poi = viewer.pois.hovered;
  if (poi) {
    viewer.player.releaseLock();
    openPoi(poi);
  }
});

// Hover feedback outside pointer lock, so the demo also works with a trackpad.
stage.addEventListener('mousemove', (ev) => {
  if (!ready || viewer.player.locked || viewer.tour) return;
  const poi = viewer.pickAt(ev.clientX, ev.clientY);
  viewer.pois.setHovered(poi);
  stage.style.cursor = poi ? 'pointer' : 'default';
  updateHover(poi);
});

stage.addEventListener('mousedown', (ev) => {
  if (!ready || viewer.player.locked || viewer.tour) return;
  const poi = viewer.pickAt(ev.clientX, ev.clientY);
  if (poi) openPoi(poi);
});

function updateHover(poi) {
  const el = $('hover-label');
  document.body.classList.toggle('aiming', !!poi);
  if (poi) { el.textContent = poi.label; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}

let lastHover = null;
setInterval(() => {
  if (!ready || viewer.tour) return;
  if (viewer.player.locked && viewer.pois.hovered !== lastHover) {
    lastHover = viewer.pois.hovered;
    updateHover(lastHover);
  }
}, 90);

// --------------------------------------------------------------------------- //
// Keyboard shortcuts
// --------------------------------------------------------------------------- //

window.addEventListener('keydown', (e) => {
  if (!ready) return;
  if (e.code === 'KeyT') { $('btn-tour').click(); }
  if (e.code === 'KeyR') { $('btn-rooms').click(); }
  if (e.code === 'Escape') { closeDrawer('poi'); closeDrawer('rooms'); }
  if (e.code === 'Digit1') viewer.setTimeOfDay('morning');
  if (e.code === 'Digit2') viewer.setTimeOfDay('noon');
  if (e.code === 'Digit3') viewer.setTimeOfDay('evening');
});

$('btn-help').addEventListener('click', () => {
  $('start').classList.remove('hidden');
  viewer.player.releaseLock();
});

// --------------------------------------------------------------------------- //
// Toast
// --------------------------------------------------------------------------- //

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1800);
}

// --------------------------------------------------------------------------- //
// Boot
// --------------------------------------------------------------------------- //

setProgress(0.05, 'Fetching scene…');
viewer.load(SCENE_URL, (f) => setProgress(0.05 + f * 0.9, `Loading geometry… ${Math.round(f * 100)}%`))
  .then(() => {
    viewer.start();
    const wanted = new URLSearchParams(location.search).get('poi');
    if (wanted && viewer.reg.poiById.has(wanted)) {
      const poi = viewer.reg.poiById.get(wanted);
      viewer.goToPoi(wanted);
      openPoi(poi);
      $('start').classList.add('hidden');
    }
  })
  .catch((err) => {
    console.error(err);
    $('load-status').textContent = `Could not load the scene — ${err.message || err}`;
    $('load-status').style.color = '#E8563C';
  });

window.wv = viewer;
