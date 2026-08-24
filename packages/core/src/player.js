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
 * First-person walk mode. Movement is intentionally slower than a game — an
 * archviz walkthrough reads better at real walking pace, and clients notice.
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
    this.keys = new Set();
    this.headBob = 0;

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space' && this.grounded && this.locked) {
        this.velocity.y = 4.2;
        this.grounded = false;
      }
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onMove = (e) => {
      if (!this.locked || !this.enabled) return;
      this.yaw -= e.movementX * LOOK;
      this.pitch -= e.movementY * LOOK;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.dom;
      this.onLockChange?.(this.locked);
      if (!this.locked) this.keys.clear();
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('mousemove', this._onMove);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  requestLock() {
    this.dom.requestPointerLock?.();
  }

  releaseLock() {
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
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMove);
    document.removeEventListener('pointerlockchange', this._onLockChange);
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

    const len = Math.hypot(fx, fz);
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight')) ? RUN : WALK;
    let wishX = 0, wishZ = 0;
    if (len > 0 && this.locked) {
      fx /= len; fz /= len;
      // Camera forward after rotateY(yaw) is (-sin, 0, -cos) and right is
      // (cos, 0, -sin). Deriving the basis from that keeps WASD locked to where
      // the player is actually looking.
      const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
      wishX = (fx * c + fz * s) * speed;
      wishZ = (-fx * s + fz * c) * speed;
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
