import * as THREE from 'three';
import { CollisionGrid, GroundProbe } from './collision.js';

const EYE = 1.62;
const RADIUS = 0.32;
const STEP_UP = 0.36;
const GRAVITY = -18.0;
const WALK = 2.6;
const RUN = 4.6;
const ACCEL = 14.0;
const DAMP = 12.0;
const LOOK = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

/**
 * First-person walk mode. WALK is 2.6 m/s, slower than any game would run,
 * because an archviz walkthrough reads better at real walking pace and clients
 * complain when a room goes past too fast to take in.
 *
 * Looking around is a right-button drag. A click that swallows the cursor puts
 * the whole interface out of reach until the viewer works out that Escape gives
 * it back. Hold right to turn and walk, let go and the cursor is there for the
 * menus, same grammar as the viewport in the 3D tools these clients already use.
 *
 * The drag asks for pointer lock too, which is what lets you keep turning past
 * the edge of the screen. Lock is optional: browsers refuse the request for
 * about a second after a previous lock ends, so the drag captures the pointer as
 * well and works fine unlocked.
 */
export class Player {
  constructor(camera, domElement, registry) {
    this.camera = camera;
    this.dom = domElement;
    this.reg = registry;
    this.grid = new CollisionGrid(registry.navBlocks);
    this.probe = new GroundProbe(registry.walkables);

    this.position = new THREE.Vector3(10.7, 0, -1.0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = false;
    this.enabled = true;
    this.locked = false;
    this.dragging = false;
    this.keys = new Set();
    this.headBob = 0;

    // Written by the touch layer. Keyboard and touch feed the same movement
    // code, so there is no separate mobile path to keep in sync.
    this.analog = { x: 0, y: 0 };
    this.touchActive = false;

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space' && this.grounded && this.controlActive) {
        this.velocity.y = 4.2;
        this.grounded = false;
      }
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);

    this._onMove = (e) => {
      if (!this.dragging || !this.enabled) return;
      // movementX is reported the same way whether the pointer is locked or
      // merely captured, so one handler covers both.
      this.yaw -= (e.movementX || 0) * LOOK;
      this.pitch -= (e.movementY || 0) * LOOK;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    };

    this._onDown = (e) => {
      if (e.button !== 2 || !this.enabled) return;
      e.preventDefault();
      this.beginDrag(e.pointerId);
    };
    this._onUp = (e) => {
      if (e.button !== 2 && e.type === 'pointerup') return;
      this.endDrag();
    };
    // Alt-tab mid-drag never delivers the keyup, so without this the player
    // keeps walking into a wall with nothing able to stop them.
    this._onBlur = () => this.endDrag();
    this._onContext = (e) => e.preventDefault();

    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.dom;
      this.onLockChange?.(this.locked);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('mousemove', this._onMove);
    document.addEventListener('pointerlockchange', this._onLockChange);
    this.dom.addEventListener('pointerdown', this._onDown);
    this.dom.addEventListener('contextmenu', this._onContext);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
  }

  /** Start a look drag. Pointer lock is attempted but not depended on. */
  beginDrag(pointerId) {
    if (this.dragging) return;
    this.dragging = true;
    if (pointerId !== undefined) {
      try { this.dom.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
      this._pointerId = pointerId;
    }
    this.dom.requestPointerLock?.();
    this.onDragChange?.(true);
  }

  endDrag() {
    if (!this.dragging) return;
    this.dragging = false;
    if (this._pointerId !== undefined) {
      try { this.dom.releasePointerCapture(this._pointerId); } catch { /* already released */ }
      this._pointerId = undefined;
    }
    if (this.locked) document.exitPointerLock?.();
    this.keys.clear();
    this.onDragChange?.(false);
  }

  /** True while a right-drag or a touch stick is actually driving the player. */
  get controlActive() {
    return this.dragging || this.touchActive;
  }

  /** Look delta in radians. Called by the touch layer. */
  look(dYaw, dPitch) {
    this.yaw -= dYaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - dPitch));
  }

  requestLock() {
    this.dom.requestPointerLock?.();
  }

  releaseLock() {
    this.endDrag();
    if (this.locked) document.exitPointerLock?.();
  }

  teleport(x, y, z, yaw) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    if (typeof yaw === 'number') this.yaw = yaw;
    const h = this.probe.heightAt(this.position, 1.6);
    if (h !== null) this.position.y = h;
    this.grounded = true;
  }

  dispose() {
    this.endDrag();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    document.removeEventListener('mousemove', this._onMove);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.dom.removeEventListener('pointerdown', this._onDown);
    this.dom.removeEventListener('contextmenu', this._onContext);
  }

  update(dt) {
    if (!this.enabled) return;
    dt = Math.min(dt, 0.05);

    // -- desired horizontal velocity ------------------------------------- //
    let fx = 0, fz = 0;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) fz -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fz += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;

    // Stick wins wherever it is pushed, so touch gets fine speed control
    // rather than the on/off a key gives.
    let analogDrive = false;
    if (Math.hypot(this.analog.x, this.analog.y) > 0.05) {
      fx = this.analog.x;
      fz = this.analog.y;
      analogDrive = true;
    }

    const raw = Math.hypot(fx, fz);
    const len = raw > 0 ? 1 : 0;
    // Keys are on/off so they always run at full throttle. Only the stick
    // scales speed by how far it is pushed. Without this split, holding W+A
    // reads as a magnitude of 1.41 and diagonal walking becomes a sprint.
    const throttle = analogDrive ? Math.min(raw, 1) : 1;
    const sprinting = k.has('ShiftLeft') || k.has('ShiftRight') || (analogDrive && raw > 0.92);
    const speed = (sprinting ? RUN : WALK) * throttle;

    let wishX = 0, wishZ = 0;
    if (len > 0 && this.controlActive) {
      fx /= raw; fz /= raw;
      // Camera forward after rotateY(yaw) is (-sin, 0, -cos) and right is
      // (cos, 0, -sin). The basis is derived from those two so WASD tracks
      // wherever the head is pointing.
      const s2 = Math.sin(this.yaw), c2 = Math.cos(this.yaw);
      wishX = (fx * c2 + fz * s2) * speed;
      wishZ = (-fx * s2 + fz * c2) * speed;
    }

    const blend = 1 - Math.exp(-(len > 0 ? ACCEL : DAMP) * dt);
    this.velocity.x += (wishX - this.velocity.x) * blend;
    this.velocity.z += (wishZ - this.velocity.z) * blend;
    this.velocity.y += GRAVITY * dt;

    // -- integrate and resolve -------------------------------------------- //
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.grid.resolve(this.position, RADIUS, EYE, STEP_UP);

    this.position.y += this.velocity.y * dt;
    const floor = this.probe.heightAt(this.position, Math.max(1.2, STEP_UP + 0.1));
    if (floor !== null) {
      if (this.position.y <= floor + 0.02) {
        this.position.y = floor;
        this.velocity.y = 0;
        this.grounded = true;
      } else if (this.grounded && this.position.y - floor < STEP_UP && this.velocity.y <= 0) {
        this.position.y = floor;   // walking down a step
        this.velocity.y = 0;
      } else {
        this.grounded = false;
      }
    } else {
      this.grounded = false;
      if (this.position.y < -20) this.teleport(10.7, 0, -1.0);
    }

    // -- camera ------------------------------------------------------------ //
    const moving = Math.hypot(this.velocity.x, this.velocity.z);
    this.headBob += moving * dt * 2.2;
    const bob = this.grounded ? Math.sin(this.headBob) * Math.min(moving, RUN) * 0.008 : 0;

    this.camera.position.set(this.position.x, this.position.y + EYE + bob, this.position.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
  }
}
