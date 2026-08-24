/**
 * Touch controls for phones and tablets.
 *
 * Walk mode splits the screen: the left third is a floating stick that appears
 * where the thumb lands, and anywhere else is look-drag. The stick is floating
 * rather than fixed because thumbs land in different places on different hands
 * and phone sizes, and a fixed stick forces a regrip.
 *
 * In the orbit modes the rig owns the gestures, so this layer stands down
 * entirely rather than competing for the same pointers.
 */

const STICK_RADIUS = 58;      // px, travel from centre to full deflection
const DEAD_ZONE = 0.12;
const LOOK_SPEED = 0.0032;    // radians per px
const TAP_MS = 260;
const TAP_SLOP = 12;          // px of movement still counted as a tap

export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches
    || navigator.maxTouchPoints > 0
    || 'ontouchstart' in window;
}

function capture(el, id) {
  // setPointerCapture throws if the pointer is no longer active — which happens
  // on fast taps and on synthetic events. An exception here would abort the rest
  // of the pointerdown handler and leave the control half-initialised.
  try { el.setPointerCapture?.(id); } catch { /* not capturable, carry on */ }
}

export class TouchControls {
  /**
   * @param {HTMLElement} dom   the canvas
   * @param {object} opts       { onLook, onStick, onTap, stickEl }
   */
  constructor(dom, opts = {}) {
    this.dom = dom;
    this.opts = opts;
    this.enabled = false;
    this.stickId = null;
    this.lookId = null;
    this.stickOrigin = { x: 0, y: 0 };
    this.value = { x: 0, y: 0 };
    this._downAt = 0;
    this._downPos = { x: 0, y: 0 };
    this._moved = 0;

    this.el = opts.stickEl || null;

    this._onDown = (e) => {
      if (!this.enabled || e.pointerType === 'mouse') return;
      const rect = this.dom.getBoundingClientRect();
      const leftZone = e.clientX - rect.left < rect.width * 0.38
        && e.clientY - rect.top > rect.height * 0.35;

      if (leftZone && this.stickId === null) {
        this.stickId = e.pointerId;
        this.stickOrigin = { x: e.clientX, y: e.clientY };
        this._showStick(e.clientX, e.clientY, 0, 0);
      } else if (this.lookId === null) {
        this.lookId = e.pointerId;
        this._downAt = performance.now();
        this._downPos = { x: e.clientX, y: e.clientY };
        this._moved = 0;
        this._last = { x: e.clientX, y: e.clientY };
      }
      capture(this.dom, e.pointerId);
    };

    this._onMove = (e) => {
      if (!this.enabled) return;

      if (e.pointerId === this.stickId) {
        const dx = e.clientX - this.stickOrigin.x;
        const dy = e.clientY - this.stickOrigin.y;
        const d = Math.hypot(dx, dy);
        const clamped = Math.min(d, STICK_RADIUS);
        const nx = d > 0 ? (dx / d) * (clamped / STICK_RADIUS) : 0;
        const ny = d > 0 ? (dy / d) * (clamped / STICK_RADIUS) : 0;
        const mag = Math.hypot(nx, ny);
        if (mag < DEAD_ZONE) {
          this.value.x = 0; this.value.y = 0;
        } else {
          // Rescale past the dead zone so the first responsive pixel is a slow
          // walk, not a lurch.
          const t = (mag - DEAD_ZONE) / (1 - DEAD_ZONE);
          this.value.x = (nx / mag) * t;
          this.value.y = (ny / mag) * t;
        }
        this._showStick(this.stickOrigin.x, this.stickOrigin.y, dx, dy);
        this.opts.onStick?.(this.value.x, this.value.y);
        e.preventDefault();
        return;
      }

      if (e.pointerId === this.lookId) {
        const dx = e.clientX - this._last.x;
        const dy = e.clientY - this._last.y;
        this._last = { x: e.clientX, y: e.clientY };
        this._moved += Math.hypot(dx, dy);
        this.opts.onLook?.(dx * LOOK_SPEED, dy * LOOK_SPEED);
        e.preventDefault();
      }
    };

    this._onUp = (e) => {
      if (e.pointerId === this.stickId) {
        this.stickId = null;
        this.value.x = 0; this.value.y = 0;
        this.opts.onStick?.(0, 0);
        this._hideStick();
      } else if (e.pointerId === this.lookId) {
        const quick = performance.now() - this._downAt < TAP_MS;
        if (quick && this._moved < TAP_SLOP) {
          this.opts.onTap?.(this._downPos.x, this._downPos.y);
        }
        this.lookId = null;
      }
    };

    dom.addEventListener('pointerdown', this._onDown);
    dom.addEventListener('pointermove', this._onMove, { passive: false });
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
  }

  _showStick(ox, oy, dx, dy) {
    if (!this.el) return;
    const d = Math.hypot(dx, dy);
    const c = Math.min(d, STICK_RADIUS);
    const kx = d > 0 ? (dx / d) * c : 0;
    const ky = d > 0 ? (dy / d) * c : 0;
    this.el.style.setProperty('--x', `${ox}px`);
    this.el.style.setProperty('--y', `${oy}px`);
    this.el.style.setProperty('--kx', `${kx}px`);
    this.el.style.setProperty('--ky', `${ky}px`);
    this.el.classList.add('on');
  }

  _hideStick() {
    this.el?.classList.remove('on');
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.stickId = null;
      this.lookId = null;
      this.value.x = 0; this.value.y = 0;
      this.opts.onStick?.(0, 0);
      this._hideStick();
    }
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this._onDown);
    this.dom.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
  }
}
