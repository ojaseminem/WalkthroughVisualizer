import { WalkthroughViewer, TIME_OF_DAY, VIEW_MODES, isTouchDevice } from '@wv/core';

/**
 * Viewer shell.
 *
 * Every panel is driven off registry events, not off knowledge of this
 * particular building — swap the .glb and the same shell populates itself. The
 * JSON-declared panel system replaces this hand-wiring in M3; the event contract
 * it consumes is already the final one.
 */

const $ = (id) => document.getElementById(id);
const SCENE_URL = './content/kp-tower/scene.glb';
const TOUCH = isTouchDevice();

// Device-floor budget: mid-range Android at 30fps, from the locked decision.
// Draw calls are the binding constraint on that class of GPU long before
// triangles are; 150 is what an Adreno 6xx / Mali-G57 holds comfortably.
const BUDGET = { drawCalls: 150, triangles: 180000 };

const CATEGORY_COLOR = {
  living: '#E8563C', bedroom: '#6FB0AC', kitchen: '#E0B453', bath: '#8FA8C4',
  balcony: '#8CBF7A', circulation: '#A7ADA6', amenity: '#C39BD3', unit: '#F0EEE8',
};

const stage = $('stage');
const viewer = new WalkthroughViewer(stage, {
  startLevel: 'L01',
  timeOfDay: 'noon',
  stickEl: $('stick'),
  // A phone renders the same scene into far fewer pixels; capping the ratio is
  // the cheapest thing that keeps a mid-range Android at 30fps.
  maxPixelRatio: TOUCH ? 1.6 : 2,
});

let ready = false;
document.body.classList.toggle('touch', TOUCH);
document.body.classList.add('mode-walk');

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
  document.body.classList.remove('booting');

  if (d.project) {
    $('proj-name').textContent = d.project.label || 'Untitled project';
    $('load-title').textContent = (d.project.label || '').split('—')[0].trim() || 'Scene';
  }

  buildViews();
  buildLevels(d.levels);
  buildTimeOfDay();
  if (TOUCH) $('btn-tour').textContent = 'Tour';

  $('start-hint').innerHTML = TOUCH
    ? 'Drag the <b>left thumb</b> to walk, drag <b>anywhere else</b> to look, '
      + '<b>tap</b> a marker to open it.'
    : '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to move, mouse to look, '
      + '<kbd>Shift</kbd> to walk faster, <kbd>Esc</kbd> to release the cursor.';

  setProgress(1, 'Ready');
  $('loader').classList.add('hidden');
  $('start').classList.remove('hidden');

  if (d.warnings.length) console.warn('[wv] validator warnings\n' + d.warnings.join('\n'));
});

// --------------------------------------------------------------------------- //
// View modes
// --------------------------------------------------------------------------- //

function buildViews() {
  const nav = $('views');
  nav.innerHTML = '';
  for (const [id, v] of Object.entries(VIEW_MODES)) {
    const b = document.createElement('button');
    b.innerHTML = `${v.label}${TOUCH ? '' : `<span class="k">${v.key}</span>`}`;
    b.dataset.mode = id;
    b.title = v.hint;
    b.addEventListener('click', () => switchView(id));
    nav.appendChild(b);
  }
}

function switchView(mode) {
  if (mode === viewer.viewMode) return;
  viewer.setViewMode(mode);
  closeDrawer('poi');
  toast(mode === 'walk'
    ? (TOUCH ? 'Walk mode — drag the left thumb to move' : 'Walk mode — click to take control')
    : (TOUCH ? `${VIEW_MODES[mode].label} — drag to orbit, pinch to zoom`
      : `${VIEW_MODES[mode].label} — drag to orbit, scroll to zoom`));
}

// The event fires for internal switches too — starting a tour drops to walk
// mode, and toasting there would talk over the tour that just began. Only
// switchView(), the user-initiated path, announces itself.
viewer.addEventListener('viewmode', (e) => {
  const { mode } = e.detail;
  for (const b of $('views').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.mode === mode);
  }
  for (const m of Object.keys(VIEW_MODES)) document.body.classList.remove(`mode-${m}`);
  document.body.classList.add(`mode-${mode}`);
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
    b.title = lv.label;
    b.addEventListener('click', () => {
      viewer.setLevel(lv.id, { teleport: viewer.viewMode === 'walk' });
      // The plan view is per level, so changing level must reframe it.
      if (viewer.viewMode === 'plan') {
        viewer.setViewMode('walk', { animate: false });
        viewer.setViewMode('plan');
      }
      closeDrawer('poi');
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
  // Three side-by-side chips do not fit next to the action buttons on a 390px
  // screen, so touch gets one chip that cycles instead.
  if (TOUCH) {
    const b = document.createElement('button');
    b.id = 'tod-cycle';
    b.className = 'on';
    // The viewer sets the time of day during load(), before this panel exists,
    // so seed the label from current state rather than waiting for the event.
    b.textContent = TIME_OF_DAY[viewer.timeOfDay]?.label ?? 'Midday';
    b.addEventListener('click', cycleTimeOfDay);
    box.appendChild(b);
    return;
  }
  for (const [key, p] of Object.entries(TIME_OF_DAY)) {
    const b = document.createElement('button');
    b.innerHTML = `${p.label}<span>${p.hour}</span>`;
    b.dataset.tod = key;
    b.addEventListener('click', () => viewer.setTimeOfDay(key));
    box.appendChild(b);
  }
}

viewer.addEventListener('timeofday', (e) => {
  const cycle = $('tod-cycle');
  if (cycle) { cycle.textContent = e.detail.label; return; }
  for (const b of $('tod').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.tod === e.detail.key);
  }
});

// --------------------------------------------------------------------------- //
// Zone readout + stats
// --------------------------------------------------------------------------- //

viewer.addEventListener('zone', (e) => {
  const z = e.detail;
  $('locus-zone').textContent = z ? z.label : 'Outside';
  const bits = [];
  if (z?.unit) bits.push(z.unit.label);
  if (z?.area) bits.push(`${z.area} sq m`);
  $('locus-meta').textContent = bits.join('  ·  ');
});

viewer.addEventListener('stats', (e) => {
  if ($('stats').classList.contains('hidden')) return;
  const s = e.detail;
  $('s-fps').textContent = s.fps.toFixed(0);
  $('s-calls').textContent = s.drawCalls;
  $('s-tris').textContent = s.triangles > 9999 ? `${(s.triangles / 1000).toFixed(0)}k` : s.triangles;
  const over = s.drawCalls > BUDGET.drawCalls || s.triangles > BUDGET.triangles;
  const badge = $('s-budget');
  badge.textContent = over ? 'over' : 'ok';
  badge.className = `badge ${over ? 'warn' : 'ok'}`;
});

$('btn-stats').addEventListener('click', () => $('stats').classList.toggle('hidden'));

// --------------------------------------------------------------------------- //
// POIs
// --------------------------------------------------------------------------- //

function openPoi(poi) {
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
  $('btn-rooms').classList.remove('on');
  history.replaceState(null, '', `?poi=${encodeURIComponent(poi.id)}`);
}

function closeDrawer(id) {
  $(id).classList.add('hidden');
  if (id === 'poi') history.replaceState(null, '', location.pathname);
  if (id === 'rooms') $('btn-rooms').classList.remove('on');
}

for (const b of document.querySelectorAll('[data-close]')) {
  b.addEventListener('click', () => closeDrawer(b.dataset.close));
}

viewer.addEventListener('poiTap', (e) => openPoi(e.detail.poi));

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
        if (viewer.viewMode !== 'walk') viewer.setViewMode('walk');
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
// Guided tour
// --------------------------------------------------------------------------- //

let tourStops = [];

function renderChapters(state) {
  if (tourStops.join('|') !== state.stops.join('|')) {
    tourStops = state.stops;
    const box = $('tour-chapters');
    box.innerHTML = '';
    state.stops.forEach((label, i) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.stop = String(i);
      b.addEventListener('click', () => viewer.tourGoToStop(i));
      box.appendChild(b);
    });
    const ticks = $('tour-ticks');
    ticks.innerHTML = '';
    state.stops.forEach((_, i) => {
      const t = document.createElement('i');
      t.style.left = `${(i / Math.max(1, state.stops.length - 1)) * 100}%`;
      ticks.appendChild(t);
    });
  }

  const buttons = $('tour-chapters').querySelectorAll('button');
  buttons.forEach((b, i) => {
    const on = i === state.stopIndex;
    b.classList.toggle('on', on);
    if (on) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  });
  $('tour-ticks').querySelectorAll('i').forEach((t, i) => {
    t.classList.toggle('done', i <= state.stopIndex);
  });
}

viewer.addEventListener('tour', (e) => {
  const d = e.detail;
  if (d.state === 'stop') {
    $('tour').classList.add('hidden');
    $('btn-tour').classList.remove('on');
    document.body.classList.remove('touring');
    return;
  }
  if (d.state === 'end') {
    toast('Tour complete');
    return;
  }
  $('tour').classList.remove('hidden');
  $('btn-tour').classList.add('on');
  document.body.classList.add('touring');
  $('tour-stop').textContent = d.stopLabel;
  $('tour-count').textContent = `${d.stopIndex + 1} / ${d.stops.length}`;
  $('tour-fill').style.width = `${(d.progress * 100).toFixed(1)}%`;
  $('tour-track').setAttribute('aria-valuenow', Math.round(d.progress * 100));
  $('tour-play').classList.toggle('playing', !d.paused);
  $('tour-play').title = d.paused ? 'Play' : 'Pause';
  renderChapters(d);
});

$('btn-tour').addEventListener('click', () => {
  if (viewer.tourPlayer) viewer.stopTour();
  else viewer.startTour();
});
$('tour-start-btn').addEventListener('click', () => {
  $('start').classList.add('hidden');
  viewer.startTour();
});
$('tour-exit').addEventListener('click', () => viewer.stopTour());
$('tour-prev').addEventListener('click', () => viewer.tourPrev());
$('tour-next').addEventListener('click', () => viewer.tourNext());
$('tour-play').addEventListener('click', () => viewer.pauseTour());

// Scrubbing: pointer events on the track, so it works with mouse and finger.
const track = $('tour-track');
let scrubbing = false;
const scrubTo = (clientX) => {
  const r = track.getBoundingClientRect();
  viewer.tourSeek((clientX - r.left) / r.width);
};
track.addEventListener('pointerdown', (e) => {
  if (!viewer.tourPlayer) return;
  scrubbing = true;
  track.setPointerCapture(e.pointerId);
  scrubTo(e.clientX);
});
track.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e.clientX); });
track.addEventListener('pointerup', () => { scrubbing = false; });
track.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') viewer.tourNext();
  if (e.key === 'ArrowLeft') viewer.tourPrev();
});

// --------------------------------------------------------------------------- //
// Pointer lock, hover, clicks (desktop)
// --------------------------------------------------------------------------- //

$('start-btn').addEventListener('click', () => {
  $('start').classList.add('hidden');
  if (!TOUCH) viewer.player.requestLock();
});
$('start').addEventListener('click', (e) => {
  if (e.target === $('start')) {
    $('start').classList.add('hidden');
    if (!TOUCH) viewer.player.requestLock();
  }
});

viewer.addEventListener('lock', (e) => {
  if (!e.detail.locked && ready && !viewer.tourPlayer) {
    document.body.classList.remove('aiming');
    $('hover-label').classList.add('hidden');
  }
});

if (!TOUCH) {
  stage.addEventListener('click', () => {
    if (!ready || viewer.tourPlayer || viewer.viewMode !== 'walk') return;
    if (!viewer.player.locked) { viewer.player.requestLock(); return; }
    const poi = viewer.pois.hovered;
    if (poi) { viewer.player.releaseLock(); openPoi(poi); }
  });

  stage.addEventListener('mousemove', (ev) => {
    if (!ready || viewer.tourPlayer) return;
    if (viewer.viewMode === 'walk' && viewer.player.locked) return;
    const poi = viewer.pickAt(ev.clientX, ev.clientY);
    viewer.pois.setHovered(poi);
    stage.style.cursor = poi ? 'pointer' : (viewer.viewMode === 'walk' ? 'default' : 'grab');
    updateHover(poi);
  });

  stage.addEventListener('mousedown', (ev) => {
    if (!ready || viewer.tourPlayer) return;
    if (viewer.viewMode === 'walk' && viewer.player.locked) return;
    const poi = viewer.pickAt(ev.clientX, ev.clientY);
    if (poi) openPoi(poi);
  });
}

function updateHover(poi) {
  const el = $('hover-label');
  document.body.classList.toggle('aiming', !!poi);
  if (poi) { el.textContent = poi.label; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}

let lastHover = null;
setInterval(() => {
  if (!ready || viewer.tourPlayer || viewer.viewMode !== 'walk') return;
  if (viewer.player.controlActive && viewer.pois.hovered !== lastHover) {
    lastHover = viewer.pois.hovered;
    updateHover(lastHover);
  }
}, 90);

// --------------------------------------------------------------------------- //
// Keyboard
// --------------------------------------------------------------------------- //

const VIEW_KEYS = Object.fromEntries(Object.entries(VIEW_MODES).map(([id, v]) => [v.key, id]));

window.addEventListener('keydown', (e) => {
  if (!ready) return;
  if (VIEW_KEYS[e.key]) { switchView(VIEW_KEYS[e.key]); return; }
  switch (e.code) {
    case 'KeyT': $('btn-tour').click(); break;
    case 'KeyR': $('btn-rooms').click(); break;
    case 'KeyP': $('btn-stats').click(); break;
    case 'KeyM': cycleTimeOfDay(); break;
    case 'Escape': closeDrawer('poi'); closeDrawer('rooms'); break;
    case 'Space': if (viewer.tourPlayer) { e.preventDefault(); viewer.pauseTour(); } break;
    case 'BracketRight': if (viewer.tourPlayer) viewer.tourNext(); break;
    case 'BracketLeft': if (viewer.tourPlayer) viewer.tourPrev(); break;
    default: break;
  }
});

function cycleTimeOfDay() {
  const keys = Object.keys(TIME_OF_DAY);
  const i = keys.indexOf(viewer.timeOfDay);
  viewer.setTimeOfDay(keys[(i + 1) % keys.length]);
}

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
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2000);
}

// --------------------------------------------------------------------------- //
// Boot
// --------------------------------------------------------------------------- //

setProgress(0.05, 'Fetching scene…');
viewer.load(SCENE_URL, (f) => setProgress(0.05 + f * 0.9, `Loading geometry… ${Math.round(f * 100)}%`))
  .then(() => {
    viewer.start();
    for (const b of $('views').querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.mode === viewer.viewMode);
    }
    const wanted = new URLSearchParams(location.search).get('poi');
    if (wanted && viewer.reg.poiById.has(wanted)) {
      viewer.goToPoi(wanted);
      openPoi(viewer.reg.poiById.get(wanted));
      $('start').classList.add('hidden');
    }
  })
  .catch((err) => {
    console.error(err);
    $('load-status').textContent = `Could not load the scene — ${err.message || err}`;
    $('load-status').style.color = '#E8563C';
  });

window.wv = viewer;
