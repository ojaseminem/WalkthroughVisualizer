import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { buildRegistry, zoneAt, unitAt } from './registry.js';
import { Player } from './player.js';
import { PoiLayer } from './pois.js';
import { OrbitRig, ExplodeController, PoseBlend, VIEW_MODES } from './viewmodes.js';
import { TourPlayer } from './tour.js';
import { TouchControls, isTouchDevice } from './touch.js';

export { buildRegistry, zoneAt, unitAt, VIEW_MODES, isTouchDevice };

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

// How far apart the levels sit in exploded view, as a multiple of their real
// elevation. Below about 2.2 the floor plates still occlude each other.
const EXPLODE_SPREAD = 2.6;

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
    this.viewMode = 'walk';
    this.touch = null;
    this.isTouch = isTouchDevice();
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

    this.walkFov = opts.fov ?? 62;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    // three.js fixes the *vertical* FOV, so a portrait phone sees a much
    // narrower slice of a room than a landscape monitor does. Widening it on
    // portrait is what stops a phone feeling like looking through a letterbox.
    this.walkFov = this.camera.aspect < 0.85 ? 74 : (this.opts.fov ?? 62);
    if (this.viewMode === 'walk') this.camera.fov = this.walkFov;
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

    this.rig = new OrbitRig(this.camera, this.renderer.domElement);
    this.explode = new ExplodeController(this.reg, this.pois);
    this.blend = new PoseBlend();

    // Framing is driven by the union of the tagged zones, not by the raw scene
    // bounds — the ground plane and the context blocks are a hundred metres
    // across, and fitting those puts the building in the middle distance.
    this.buildingBox = new THREE.Box3();
    for (const z of this.reg.zones) this.buildingBox.union(z.box);
    if (this.buildingBox.isEmpty()) {
      for (const m of this.reg.walkables) this.buildingBox.expandByObject(m);
    }
    this.siteBox = this.buildingBox;

    if (this.isTouch) {
      this.touch = new TouchControls(this.renderer.domElement, {
        stickEl: this.opts.stickEl || null,
        onStick: (x, y) => { this.player.analog.x = x; this.player.analog.y = y; },
        onLook: (dx, dy) => this.player.look(dx, dy),
        onTap: (x, y) => {
          const poi = this.pickAt(x, y);
          if (poi) this.emit('poiTap', { poi });
        },
      });
      this.player.touchActive = true;
      this.touch.setEnabled(true);
    }

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
      isTouch: this.isTouch,
      viewModes: Object.entries(VIEW_MODES).map(([id, v]) => ({ id, ...v })),
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

  // -- view modes ---------------------------------------------------------- //

  /**
   * walk | dollhouse | plan | exploded.
   *
   * Every mode change is a blend from the live camera pose to the new rig's
   * pose, so the viewer never teleports and never loses their bearings.
   */
  setViewMode(mode, { animate = true } = {}) {
    if (!VIEW_MODES[mode] || mode === this.viewMode) return;
    const previous = this.viewMode;
    this.viewMode = mode;
    if (this.tourPlayer) this.stopTour({ silent: true });

    if (animate) this.blend.start(this.camera, mode === 'walk' ? 0.75 : 0.95);

    if (mode === 'walk') {
      this.explode.set(1);
      this.rig.enabled = false;
      this.player.enabled = true;
      if (this.touch) this.touch.setEnabled(true);
      this.setLevelVisibility(null);
      this.pois.setLevel(this.currentLevel);
      this.camera.fov = this.walkFov ?? this.opts.fov ?? 62;
      this.camera.updateProjectionMatrix();
      // Coming back from an orbit mode, land somewhere sensible on this level
      // rather than wherever the orbit camera happened to be floating.
      if (previous !== 'walk') this.setLevel(this.currentLevel, { teleport: true });
    } else {
      this.player.enabled = false;
      this.player.releaseLock();
      if (this.touch) this.touch.setEnabled(false);
      this.rig.enabled = true;
      this.rig.setMode(mode);
      this.camera.fov = this.rig.limits.fov;
      this.camera.updateProjectionMatrix();

      if (mode === 'plan') {
        this.explode.set(1);
        this.setLevelVisibility(this.currentLevel);
        this.pois.setLevel(this.currentLevel);
        const lv = this.reg.levelById.get(this.currentLevel);
        const box = this.buildingBox.clone();
        box.min.y = (lv?.elevation ?? 0);
        box.max.y = (lv?.elevation ?? 0) + 3;
        // Azimuth 0 puts the building's long axis across the screen, so the plan
        // reads square instead of skewed across the corners.
        this.rig.frame(box, { azimuth: 0, elevation: 1.5707, margin: 1.06 });
      } else if (mode === 'exploded') {
        this.setLevelVisibility(null);
        this.pois.setLevel(null, { all: true });
        this.explode.set(EXPLODE_SPREAD);
        const box = this.buildingBox.clone();
        box.max.y = box.min.y + (box.max.y - box.min.y) * EXPLODE_SPREAD;
        this.rig.frame(box, { azimuth: -0.62, elevation: 0.38, margin: 1.15 });
      } else {
        this.explode.set(1);
        this.setLevelVisibility(null);
        this.pois.setLevel(null, { all: true });
        this.rig.frame(this.buildingBox, { azimuth: -0.7, elevation: 0.42, margin: 1.3 });
      }
    }

    this.emit('viewmode', { mode, label: VIEW_MODES[mode].label, previous });
  }

  /** Hide everything above `levelId`, or show all when null. */
  setLevelVisibility(levelId) {
    if (!levelId) {
      for (const lv of this.reg.levels) lv.object.visible = true;
      return;
    }
    const cut = this.reg.levelById.get(levelId)?.elevation ?? 0;
    for (const lv of this.reg.levels) lv.object.visible = lv.elevation <= cut + 0.01;
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
    const t = this.reg.tours.find((x) => x.id === tourId)
      || this.reg.tours.find((x) => x.level === this.currentLevel)
      || this.reg.tours[0];
    if (!t || t.keys.length < 2) return;

    if (this.viewMode !== 'walk') this.setViewMode('walk', { animate: false });
    if (t.level && t.level !== this.currentLevel) {
      this.setLevel(t.level, { teleport: false });
    }

    this.tourPlayer = new TourPlayer(t, this.reg);
    this.tour = this.tourPlayer;              // kept for the existing public shape
    this.player.enabled = false;
    this.player.releaseLock();
    if (this.touch) this.touch.setEnabled(false);
    this.blend.start(this.camera, 1.0);
    this.emit('tour', { state: 'start', ...this.tourPlayer.state() });
  }

  pauseTour(paused) {
    if (!this.tourPlayer) return;
    this.tourPlayer.paused = paused ?? !this.tourPlayer.paused;
    this.emit('tour', { state: 'update', ...this.tourPlayer.state() });
  }

  tourNext() { this.tourPlayer?.next(); }

  tourPrev() { this.tourPlayer?.prev(); }

  tourSeek(fraction) { this.tourPlayer?.seekFraction(fraction); }

  tourGoToStop(i) { this.tourPlayer?.seekToStop(i); }

  stopTour({ silent = false } = {}) {
    if (!this.tourPlayer) return;
    const cam = this.camera.position.clone();
    const lv = this.reg.levelById.get(this.currentLevel);
    this.tourPlayer = null;
    this.tour = null;
    if (this.viewMode === 'walk') {
      this.player.enabled = true;
      if (this.touch) this.touch.setEnabled(true);
      // Hand control back exactly where the camera is, not at a reset spawn.
      this.player.teleport(cam.x, (lv?.elevation ?? 0) + 0.2, cam.z);
      this.player.yaw = Math.atan2(-this._camForward().x, -this._camForward().z);
    }
    if (!silent) this.emit('tour', { state: 'stop' });
  }

  _camForward() {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).setY(0).normalize();
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
    let tourStop = -1;

    this.explode?.update(dt);

    if (this.tourPlayer) {
      tourStop = this.tourPlayer.update(this.camera, dt);
      if (tourStop !== this._lastTourStop || this._tourTick > 0.2) {
        this._lastTourStop = tourStop;
        this._tourTick = 0;
        this.emit('tour', { state: 'update', ...this.tourPlayer.state() });
      }
      this._tourTick = (this._tourTick || 0) + dt;
      if (this.tourPlayer.finished && !this.tourPlayer.tour.loop) {
        this.emit('tour', { state: 'end', ...this.tourPlayer.state() });
        this.stopTour();
      }
    } else if (this.viewMode === 'walk') {
      this.player.update(dt);
      const hovered = this.player.controlActive ? this.pickAtCentre() : this.pois.hovered;
      this.pois.setHovered(hovered);
    } else {
      this.rig.update(dt);
      this.camera.position.copy(this.rig.pose());
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.rig.target);
    }

    // The blend runs last: it reads the pose the active rig just wrote and eases
    // the camera toward it, so a mode switch is one code path for all four modes.
    this.blend?.apply(this.camera, dt);

    this.pois.update(this.camera.position);

    // Zone readout, walk mode only. In an orbit mode the camera is not a person
    // standing somewhere, so "you are in" would be a lie.
    if (this.reg && this.viewMode === 'walk') {
      const feet = this.tourPlayer
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
    } else if (this.currentZone !== null && this.viewMode !== 'walk') {
      this.currentZone = null;
      this.emit('zone', null);
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
    this.rig?.dispose();
    this.touch?.dispose();
    this.renderer.dispose();
  }
}
