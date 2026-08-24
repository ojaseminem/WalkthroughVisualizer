import * as THREE from 'three';

/**
 * The view-mode triad plus exploded, sharing one orbit rig.
 *
 * Each mode is a set of constraints on the same rig rather than a separate
 * camera implementation — that way a transition between any two modes is just a
 * blend between two poses, and there is only one place where orbit input is
 * interpreted.
 */

export const VIEW_MODES = {
  walk: {
    label: 'Walk', short: 'Walk', key: '1',
    hint: 'First person. Walk the building at eye height.',
  },
  dollhouse: {
    label: 'Dollhouse', short: 'Doll', key: '2',
    hint: 'Orbit the whole building from outside.',
  },
  plan: {
    label: 'Floor plan', short: 'Plan', key: '3',
    hint: 'Look straight down at the current level.',
  },
  exploded: {
    label: 'Exploded', short: 'Split', key: '4',
    hint: 'Levels pulled apart, so every floor plate reads at once.',
  },
};

const EASE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Per-mode camera constraints. `elevation` is the polar angle from the horizon:
// 0 is level with the target, PI/2 is straight down.
const LIMITS = {
  dollhouse: { minEl: 0.12, maxEl: 1.40, minDist: 14, maxDist: 90, fov: 46, pan: true },
  plan: { minEl: 1.38, maxEl: 1.5707, minDist: 18, maxDist: 95, fov: 26, pan: true },
  exploded: { minEl: 0.18, maxEl: 1.20, minDist: 30, maxDist: 150, fov: 40, pan: true },
};

function capture(el, id) {
  // setPointerCapture throws if the pointer is no longer active — which happens
  // on fast taps and on synthetic events. An exception here would abort the rest
  // of the pointerdown handler and leave the control half-initialised.
  try { el.setPointerCapture?.(id); } catch { /* not capturable, carry on */ }
}

export class OrbitRig {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.enabled = false;
    this.mode = 'dollhouse';

    this.target = new THREE.Vector3();
    this.desiredTarget = new THREE.Vector3();
    this.azimuth = -0.7;
    this.elevation = 0.55;
    this.distance = 45;

    this.desiredAzimuth = this.azimuth;
    this.desiredElevation = this.elevation;
    this.desiredDistance = this.distance;

    this._pointers = new Map();
    this._lastPinch = 0;
    this._dragMode = null;

    this._onDown = (e) => {
      if (!this.enabled) return;
      capture(this.dom, e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._dragMode = (e.button === 2 || e.shiftKey) ? 'pan' : 'orbit';
      if (this._pointers.size === 2) this._lastPinch = this._pinchDistance();
    };

    this._onMove = (e) => {
      if (!this.enabled) return;
      const prev = this._pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pointers.size >= 2) {
        // Two fingers: pinch to zoom, drag to pan. Matches every map app.
        const d = this._pinchDistance();
        if (this._lastPinch > 0) this.zoom(this._lastPinch / d);
        this._lastPinch = d;
        this.pan(dx / 2, dy / 2);
        return;
      }
      if (this._dragMode === 'pan') this.pan(dx, dy);
      else this.orbit(dx, dy);
    };

    this._onUp = (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._lastPinch = 0;
      if (this._pointers.size === 0) this._dragMode = null;
    };

    this._onWheel = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.zoom(Math.exp(e.deltaY * 0.0012));
    };

    this._onContext = (e) => { if (this.enabled) e.preventDefault(); };

    dom.addEventListener('pointerdown', this._onDown);
    dom.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
    dom.addEventListener('wheel', this._onWheel, { passive: false });
    dom.addEventListener('contextmenu', this._onContext);
  }

  _pinchDistance() {
    const [a, b] = [...this._pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  get limits() {
    return LIMITS[this.mode] || LIMITS.dollhouse;
  }

  orbit(dx, dy) {
    const L = this.limits;
    this.desiredAzimuth -= dx * 0.005;
    this.desiredElevation = THREE.MathUtils.clamp(
      this.desiredElevation + dy * 0.005, L.minEl, L.maxEl,
    );
  }

  zoom(factor) {
    const L = this.limits;
    this.desiredDistance = THREE.MathUtils.clamp(this.desiredDistance * factor, L.minDist, L.maxDist);
  }

  pan(dx, dy) {
    if (!this.limits.pan) return;
    // Pan in the camera's screen plane, scaled by distance so the ground keeps
    // pace with the finger regardless of zoom.
    const scale = this.distance * 0.0016;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    // Flatten so panning never drifts the target below the site.
    right.y = 0; right.normalize();
    up.y = 0;
    if (up.lengthSq() < 1e-6) up.setFromMatrixColumn(this.camera.matrix, 2).setY(0);
    up.normalize().negate();
    this.desiredTarget.addScaledVector(right, -dx * scale);
    this.desiredTarget.addScaledVector(up, -dy * scale);
  }

  /** Frame a bounding box, choosing a distance that fits it in view. */
  frame(box, { azimuth, elevation, margin = 1.35 } = {}) {
    const size = box.getSize(new THREE.Vector3());
    box.getCenter(this.desiredTarget);
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    const fov = THREE.MathUtils.degToRad(this.limits.fov);
    const dist = (radius * margin) / Math.tan(fov * 0.5);
    this.desiredDistance = THREE.MathUtils.clamp(dist, this.limits.minDist, this.limits.maxDist);
    if (typeof azimuth === 'number') this.desiredAzimuth = azimuth;
    if (typeof elevation === 'number') {
      this.desiredElevation = THREE.MathUtils.clamp(elevation, this.limits.minEl, this.limits.maxEl);
    }
  }

  setMode(mode) {
    this.mode = mode;
    const L = this.limits;
    this.desiredElevation = THREE.MathUtils.clamp(this.desiredElevation, L.minEl, L.maxEl);
    this.desiredDistance = THREE.MathUtils.clamp(this.desiredDistance, L.minDist, L.maxDist);
  }

  /** Where the camera wants to be, given the current orbit state. */
  pose(out = new THREE.Vector3()) {
    const el = this.elevation;
    const az = this.azimuth;
    const r = this.distance;
    out.set(
      this.target.x + r * Math.cos(el) * Math.sin(az),
      this.target.y + r * Math.sin(el),
      this.target.z + r * Math.cos(el) * Math.cos(az),
    );
    return out;
  }

  update(dt) {
    const k = 1 - Math.exp(-9 * dt);
    this.azimuth += (this.desiredAzimuth - this.azimuth) * k;
    this.elevation += (this.desiredElevation - this.elevation) * k;
    this.distance += (this.desiredDistance - this.distance) * k;
    this.target.lerp(this.desiredTarget, k);
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this._onDown);
    this.dom.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    this.dom.removeEventListener('wheel', this._onWheel);
    this.dom.removeEventListener('contextmenu', this._onContext);
  }
}

/**
 * Pulls the levels apart vertically.
 *
 * Only rendering moves — the registry's cached world boxes stay valid because
 * the spread is always returned to 1 before walk mode resumes.
 */
export class ExplodeController {
  constructor(registry, poiLayer) {
    this.reg = registry;
    this.pois = poiLayer;
    this.spread = 1;
    this.desired = 1;
    this.base = new Map();
    for (const lv of registry.levels) this.base.set(lv.id, lv.object.position.y);
  }

  set(target) {
    this.desired = target;
  }

  get active() {
    return Math.abs(this.spread - 1) > 0.001;
  }

  update(dt) {
    if (Math.abs(this.desired - this.spread) < 0.0005) {
      if (this.spread !== this.desired) this.spread = this.desired;
      else return;
    } else {
      this.spread += (this.desired - this.spread) * (1 - Math.exp(-6 * dt));
    }
    this.apply();
  }

  apply() {
    for (const lv of this.reg.levels) {
      const base = this.base.get(lv.id) ?? lv.elevation;
      lv.object.position.y = base * this.spread;
    }
    this.pois?.setExplode(this.spread, this.reg);
  }
}

/** Blends the camera from wherever it is to wherever a rig wants it. */
export class PoseBlend {
  constructor() {
    this.t = 1;
    this.duration = 0.9;
    this.fromPos = new THREE.Vector3();
    this.fromQuat = new THREE.Quaternion();
    this.fromFov = 50;
  }

  start(camera, duration = 0.9) {
    this.fromPos.copy(camera.position);
    this.fromQuat.copy(camera.quaternion);
    this.fromFov = camera.fov;
    this.duration = duration;
    this.t = 0;
  }

  get running() {
    return this.t < 1;
  }

  /** Applies the blend on top of a pose the caller has already written. */
  apply(camera, dt) {
    if (this.t >= 1) return false;
    this.t = Math.min(1, this.t + dt / this.duration);
    const e = EASE(this.t);
    const targetPos = camera.position.clone();
    const targetQuat = camera.quaternion.clone();
    const targetFov = camera.fov;
    camera.position.copy(this.fromPos).lerp(targetPos, e);
    camera.quaternion.copy(this.fromQuat).slerp(targetQuat, e);
    camera.fov = THREE.MathUtils.lerp(this.fromFov, targetFov, e);
    camera.updateProjectionMatrix();
    return true;
  }
}
