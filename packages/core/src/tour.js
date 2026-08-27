import * as THREE from 'three';
import { buildTourPath } from './route.js';

/**
 * Guided tour player.
 *
 * The first version flew the spline and looked down the tangent. The camera
 * stared at a doorway on the way through it and swung past whatever the stop was
 * about. Position and aim are separate now: the path is still a smoothed spline,
 * the look target is picked per stop, held while dwelling and eased toward the
 * next one while travelling.
 *
 * Where the path runs is route.js's problem. The whole tour is one timeline of
 * phases, so prev, next and the scrubber are all a time to seek to.
 */

const EASE_IO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const TRAVEL_SPEED = 1.25;   // m/s along the path, a shade slower than walking
const MIN_TRAVEL = 1.8;      // seconds, so adjacent stops still get a real move

export class TourPlayer {
  constructor(tour, registry) {
    this.tour = tour;
    this.reg = registry;
    this.keys = tour.keys;

    const pts = this.keys.map((k) => k.position.clone());

    // The route pass inserts doorway waypoints and pushes the curve off the
    // walls, so the finished path is longer than the straight line through the
    // stops and the stops no longer sit at even intervals along it. stopU says
    // where each one landed.
    const routed = buildTourPath(this.reg, pts);
    this.curve = routed.curve;
    this.path = routed.points;
    this.keyU = routed.stopU;

    // Travel time comes off the routed length. Use the straight-line distance
    // and a leg that now goes the long way round through a door still gets the
    // few seconds it had when it cut through the wall, so the camera sprints.
    this.legLength = [];
    for (let i = 1; i < pts.length; i++) {
      this.legLength.push(this.curve.getLength() * Math.abs(this.keyU[i] - this.keyU[i - 1]));
    }

    // Each stop looks at its subject: the POI or zone it names, else a point a
    // little further along the path.
    this.lookAt = this.keys.map((k, i) => this._subjectFor(k, i, pts));

    this.phases = [];
    for (let i = 0; i < this.keys.length; i++) {
      this.phases.push({ kind: 'dwell', index: i, dur: Math.max(1.2, this.keys[i].dwell ?? 3) });
      if (i < this.keys.length - 1) {
        const dist = this.legLength[i] || pts[i].distanceTo(pts[i + 1]);
        this.phases.push({
          kind: 'move', index: i, to: i + 1,
          dur: Math.max(MIN_TRAVEL, dist / TRAVEL_SPEED),
        });
      }
    }
    this.duration = this.phases.reduce((a, p) => a + p.dur, 0);

    this.time = 0;
    this.paused = false;
    this.stopIndex = 0;
    this._look = null;
  }

  _subjectFor(key, i, pts) {
    // A stop can name what it is about; otherwise aim at the next point along,
    // which at least keeps the camera facing into the room it is entering.
    const poi = this.reg.poiById.get(key.look || key.id?.replace('.tour.', '.'));
    if (poi) return poi.position.clone();
    const zoneId = key.look || null;
    const zone = zoneId && this.reg.zoneById.get(zoneId);
    if (zone) return zone.box.getCenter(new THREE.Vector3());
    const ahead = pts[Math.min(i + 1, pts.length - 1)].clone();
    if (ahead.distanceTo(pts[i]) < 0.4 && i > 0) ahead.copy(pts[i]).add(
      pts[i].clone().sub(pts[i - 1]).setY(0).normalize().multiplyScalar(3),
    );
    return ahead.setY(pts[i].y);
  }

  /** Absolute time at which a stop's dwell begins. */
  timeOfStop(i) {
    let t = 0;
    for (const p of this.phases) {
      if (p.kind === 'dwell' && p.index === i) return t;
      t += p.dur;
    }
    return t;
  }

  seekToStop(i) {
    this.time = this.timeOfStop(THREE.MathUtils.clamp(i, 0, this.keys.length - 1));
  }

  next() { this.seekToStop(this.stopIndex + 1); }

  prev() {
    // Re-entering the current stop feels like a mis-press, so only step back
    // once the current one has been running for a moment.
    const start = this.timeOfStop(this.stopIndex);
    this.seekToStop(this.time - start > 1.2 ? this.stopIndex : this.stopIndex - 1);
  }

  seekFraction(f) {
    this.time = THREE.MathUtils.clamp(f, 0, 1) * this.duration;
  }

  get progress() {
    return this.duration > 0 ? this.time / this.duration : 0;
  }

  get finished() {
    return this.time >= this.duration;
  }

  _phaseAt(t) {
    let acc = 0;
    for (const p of this.phases) {
      if (t < acc + p.dur) return { phase: p, local: (t - acc) / p.dur };
      acc += p.dur;
    }
    const last = this.phases[this.phases.length - 1];
    return { phase: last, local: 1 };
  }

  /** Advances the tour and writes the camera. Returns the stop index in view. */
  update(camera, dt) {
    if (!this.paused) this.time += dt;
    if (this.time > this.duration) {
      if (this.tour.loop) this.time = 0;
      else this.time = this.duration;
    }

    const { phase, local } = this._phaseAt(this.time);
    const e = EASE_IO(local);

    let u;
    let look;
    if (phase.kind === 'dwell') {
      u = this.keyU[phase.index];
      look = this.lookAt[phase.index];
      this.stopIndex = phase.index;
    } else {
      u = THREE.MathUtils.lerp(this.keyU[phase.index], this.keyU[phase.to], e);
      look = this.lookAt[phase.index].clone().lerp(this.lookAt[phase.to], e);
      // Report the stop being approached once past halfway, so the UI label
      // changes when the viewer can see where they are going.
      this.stopIndex = e > 0.5 ? phase.to : phase.index;
    }

    const pos = this.curve.getPointAt(THREE.MathUtils.clamp(u, 0, 1));
    camera.position.lerp(pos, 1 - Math.exp(-11 * dt));

    if (!this._look) this._look = look.clone();
    this._look.lerp(look, 1 - Math.exp(-4.5 * dt));
    camera.lookAt(this._look);

    return this.stopIndex;
  }

  /** Serialisable state for the UI. */
  state() {
    return {
      id: this.tour.id,
      label: this.tour.label,
      stopIndex: this.stopIndex,
      stopLabel: this.keys[this.stopIndex]?.label ?? '',
      stops: this.keys.map((k) => k.label),
      progress: this.progress,
      paused: this.paused,
      duration: this.duration,
    };
  }
}
