import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { buildRegistry, zoneAt, unitAt } from './registry.js';
import { Player } from './player.js';
import { PoiLayer } from './pois.js';

export { buildRegistry, zoneAt, unitAt };

/**
 * Time-of-day sets. These stand in for the baked lightmap sets that land in M5 —
 * the switching contract is identical, so nothing above this line changes when
 * the bakes arrive.
 */
export const TIME_OF_DAY = {
  morning: {
    label: 'Morning', hour: '08:00',
    sun: { azimuth: 1.95, elevation: 0.32, color: 0xffd7a8, intensity: 2.3 },
    sky: 0xbcd6ee, groundBounce: 0x8d8574, hemi: 0.34, env: 0.30,
    exposure: 0.86, fog: 0xd6dfe6, fogDensity: 0.0020,
  },
  noon: {
    label: 'Midday', hour: '13:00',
    sun: { azimuth: 0.55, elevation: 1.12, color: 0xfff3e0, intensity: 2.7 },
    sky: 0xa9c8e8, groundBounce: 0x8f8a7c, hemi: 0.40, env: 0.34,
    exposure: 0.80, fog: 0xcfdae4, fogDensity: 0.0016,
  },
  evening: {
    label: 'Evening', hour: '18:30',
    sun: { azimuth: -1.75, elevation: 0.16, color: 0xff9d5c, intensity: 2.0 },
    sky: 0x8fa8c4, groundBounce: 0x60564a, hemi: 0.28, env: 0.26,
    exposure: 0.94, fog: 0xd8c0a8, fogDensity: 0.0022,
  },
};

export class WalkthroughViewer extends EventTarget {
  constructor(container, opts = {}) {
    super();
    this.container = container;
    this.opts = opts;
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(0, 0);
    this.reg = null;
    this.tour = null;
    this.currentLevel = null;
    this.currentZone = null;
    this._frames = 0;
    this._acc = 0;
    this._fps = 0;
    this._running = false;

    const renderer = new THREE.WebGLRenderer({
      antialias: true, powerPreference: 'high-performance', alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.maxPixelRatio ?? 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The sun only moves when the time-of-day set changes, so the shadow map is
    // re-rendered on demand instead of every frame. On this scene that is the
    // difference between ~170 and ~85 draw calls per frame.
    renderer.shadowMap.autoUpdate = false;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      opts.fov ?? 62, container.clientWidth / container.clientHeight, 0.08, 400,
    );

    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.055;
    const sc = this.sun.shadow.camera;
    sc.left = -26; sc.right = 34; sc.top = 30; sc.bottom = -20;
    sc.near = 0.5; sc.far = 90;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbcd6ee, 0x9b917c, 0.6);
    this.scene.add(this.hemi);

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.06).texture;
    this.scene.environmentIntensity = 0.32;
    pmrem.dispose();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  async load(url, onProgress) {
    const loader = new GLTFLoader();
    if (this.opts.dracoPath) {
      const draco = new DRACOLoader();
      draco.setDecoderPath(this.opts.dracoPath);
      loader.setDRACOLoader(draco);
    }

    const gltf = await new Promise((resolve, reject) => {
      loader.load(url, resolve, (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      }, reject);
    });

    this.root = gltf.scene;
    this.scene.add(this.root);
    this.reg = buildRegistry(this.root);

    for (const m of this.reg.walkables) {
      m.castShadow = true;
      m.receiveShadow = true;
      if (m.material) m.material.shadowSide = THREE.FrontSide;
    }

    this.player = new Player(this.camera, this.renderer.domElement, this.reg);
    this.player.onLockChange = (locked) => this.emit('lock', { locked });
    this.pois = new PoiLayer(this.scene, this.reg);

    this.setTimeOfDay(this.opts.timeOfDay ?? 'noon');
    const first = this.reg.levels.find((l) => l.id === (this.opts.startLevel ?? 'L01'))
      || this.reg.levels[0];
    this.setLevel(first.id);

    this.renderer.shadowMap.needsUpdate = true;
    this.emit('ready', {
      project: this.reg.project,
      levels: this.reg.levels.map((l) => ({ id: l.id, label: l.label, elevation: l.elevation })),
      zones: this.reg.zones.length,
      pois: this.reg.pois.length,
      portals: this.reg.portals.length,
      navBlocks: this.reg.navBlocks.length,
      tours: this.reg.tours.map((t) => ({ id: t.id, label: t.label, level: t.level, stops: t.keys.length })),
      warnings: this.reg.warnings,
      triangles: this.renderer.info.render.triangles,
    });
    return this.reg;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // -- lighting ----------------------------------------------------------- //

  setTimeOfDay(key) {
    const p = TIME_OF_DAY[key];
    if (!p) return;
    this.timeOfDay = key;
    const r = 60;
    const { azimuth: a, elevation: e } = p.sun;
    this.sun.position.set(
      Math.cos(a) * Math.cos(e) * r,
      Math.sin(e) * r,
      Math.sin(a) * Math.cos(e) * r,
    );
    this.sun.target.position.set(11, 4, 4);
    this.sun.color.setHex(p.sun.color);
    this.sun.intensity = p.sun.intensity;
    this.hemi.color.setHex(p.sky);
    this.hemi.groundColor.setHex(p.groundBounce);
    this.hemi.intensity = p.hemi;
    // The image-based environment has no occlusion, so a high value floods
    // interiors with light that should never reach them. Keep it low; the baked
    // lightmaps in M5 are what actually carry interior bounce.
    this.scene.environmentIntensity = p.env ?? 0.3;
    this.renderer.toneMappingExposure = p.exposure;
    this.scene.background = new THREE.Color(p.fog);
    this.scene.fog = new THREE.FogExp2(p.fog, p.fogDensity);
    this.renderer.shadowMap.needsUpdate = true;
    this.emit('timeofday', { key, label: p.label, hour: p.hour });
  }

  // -- levels ------------------------------------------------------------- //

  setLevel(levelId, { teleport = true } = {}) {
    const lv = this.reg.levelById.get(levelId);
    if (!lv) return;
    this.currentLevel = levelId;
    this.pois.setLevel(levelId);

    if (teleport && this.player) {
      const spot = this.reg.zoneById.get(`${levelId.toLowerCase()}.liftlobby`)
        || this.reg.zoneById.get(`${levelId.toLowerCase()}.lobby`)
        || this.reg.zoneById.get(`${levelId.toLowerCase()}.corridor`);
      if (spot) {
        const c = spot.box.getCenter(new THREE.Vector3());
        this.player.teleport(c.x, lv.elevation + 0.2, Math.max(c.z, spot.box.min.z + 0.8), -Math.PI / 2);
      } else {
        this.player.teleport(10.7, lv.elevation + 0.2, -1.0, 0);
      }
    }
    this.emit('level', { id: lv.id, label: lv.label, elevation: lv.elevation });
  }

  goToPoi(poiId) {
    const poi = this.reg.poiById.get(poiId);
    if (!poi) return;
    if (poi.level !== this.currentLevel) this.setLevel(poi.level, { teleport: false });
    const lv = this.reg.levelById.get(poi.level);
    const back = new THREE.Vector3(0, 0, 1).multiplyScalar(1.8);
    this.player.teleport(poi.position.x + back.x, (lv?.elevation ?? 0) + 0.2, poi.position.z + back.z, 0);
    this.pois.setLevel(poi.level);
  }

  // -- guided tour --------------------------------------------------------- //

  startTour(tourId) {
    const t = this.reg.tours.find((x) => x.id === tourId);
    if (!t || t.keys.length < 2) return;
    const pts = t.keys.map((k) => k.position.clone());
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.35);
    const lengths = curve.getLengths(200);
    const total = lengths[lengths.length - 1];

    // Map each key to its arc-length position so dwell lands on the real stop.
    const us = [0];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      acc += pts[i].distanceTo(pts[i - 1]);
      us.push(acc);
    }
    const flat = us[us.length - 1] || 1;
    const keyU = us.map((v) => v / flat);

    const phases = [];
    for (let i = 0; i < t.keys.length; i++) {
      phases.push({ kind: 'dwell', u: keyU[i], dur: t.keys[i].dwell, key: t.keys[i] });
      if (i < t.keys.length - 1) {
        const dist = pts[i].distanceTo(pts[i + 1]);
        phases.push({
          kind: 'move', u0: keyU[i], u1: keyU[i + 1],
          dur: Math.max(1.6, dist / 1.35), key: t.keys[i + 1],
        });
      }
    }

    this.tour = { t, curve, phases, index: 0, elapsed: 0, total };
    if (this.player) { this.player.enabled = false; this.player.releaseLock(); }
    if (t.level && t.level !== this.currentLevel) this.setLevel(t.level, { teleport: false });
    this.emit('tour', { state: 'start', id: t.id, label: t.label, stops: t.keys.length });
  }

  stopTour() {
    if (!this.tour) return;
    const cam = this.camera.position;
    const lv = this.reg.levelById.get(this.currentLevel);
    this.tour = null;
    if (this.player) {
      this.player.enabled = true;
      this.player.teleport(cam.x, (lv?.elevation ?? 0) + 0.2, cam.z);
    }
    this.emit('tour', { state: 'stop' });
  }

  _updateTour(dt) {
    const T = this.tour;
    T.elapsed += dt;
    let ph = T.phases[T.index];
    while (ph && T.elapsed > ph.dur) {
      T.elapsed -= ph.dur;
      T.index += 1;
      ph = T.phases[T.index];
      if (ph) this.emit('tour', { state: 'stop-reached', label: ph.key?.label, index: T.index });
    }
    if (!ph) { this.stopTour(); return; }

    const k = ph.dur > 0 ? THREE.MathUtils.clamp(T.elapsed / ph.dur, 0, 1) : 1;
    const smooth = k * k * (3 - 2 * k);
    const u = ph.kind === 'dwell' ? ph.u : THREE.MathUtils.lerp(ph.u0, ph.u1, smooth);

    const pos = T.curve.getPointAt(THREE.MathUtils.clamp(u, 0, 1));
    const ahead = T.curve.getPointAt(THREE.MathUtils.clamp(u + 0.02, 0, 1));
    this.camera.position.lerp(pos, 1 - Math.exp(-9 * dt));
    const look = ahead.clone();
    if (ph.kind === 'dwell') look.copy(T.curve.getPointAt(THREE.MathUtils.clamp(u + 0.05, 0, 1)));
    this._lookTarget = this._lookTarget || look.clone();
    this._lookTarget.lerp(look, 1 - Math.exp(-5 * dt));
    this.camera.lookAt(this._lookTarget);
  }

  // -- interaction --------------------------------------------------------- //

  pickAtCentre() {
    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera);
    return this.pois.pick(this.raycaster);
  }

  pickAt(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.pois.pick(this.raycaster);
  }

  // -- loop ---------------------------------------------------------------- //

  start() {
    if (this._running) return;
    this._running = true;
    const tick = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(tick);
      this.frame();
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);

    if (this.tour) {
      this._updateTour(dt);
    } else if (this.player) {
      this.player.update(dt);
      const hovered = this.player.locked ? this.pickAtCentre() : this.pois.hovered;
      this.pois.setHovered(hovered);
    }

    this.pois.update(this.camera.position);

    // Zone readout — cheap enough to run every frame at this scene size.
    if (this.reg) {
      const feet = this.tour
        ? this.camera.position.clone().setY(this.camera.position.y - 1.6)
        : this.player.position;
      const z = zoneAt(this.reg, feet, this.currentLevel);
      const u = unitAt(this.reg, feet);
      if (z !== this.currentZone) {
        this.currentZone = z;
        this.emit('zone', z ? {
          id: z.id, label: z.label, category: z.category, area: z.area,
          unit: u ? { id: u.id, label: u.label } : null,
        } : null);
      }
    }

    this.renderer.render(this.scene, this.camera);

    this._frames += 1;
    this._acc += dt;
    if (this._acc >= 0.5) {
      this._fps = this._frames / this._acc;
      this._frames = 0;
      this._acc = 0;
      const info = this.renderer.info;
      this.emit('stats', {
        fps: this._fps,
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs ? info.programs.length : 0,
        textures: info.memory.textures,
      });
    }
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.player?.dispose();
    this.renderer.dispose();
  }
}
