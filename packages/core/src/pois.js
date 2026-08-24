import * as THREE from 'three';

function pinTexture(fill = '#C4341F') {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const r = s * 0.30;
  const cx = s / 2, cy = s / 2;

  g.beginPath();
  g.arc(cx, cy, r + 12, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fill();

  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(255,255,255,0.92)';
  g.stroke();

  g.beginPath();
  g.arc(cx, cy, r * 0.34, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fill();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Hotspot pins. One sprite per POI in the registry — the runtime never knows
 * what any of them mean, only that a tagged node asked for one.
 */
export class PoiLayer {
  constructor(scene, registry) {
    this.reg = registry;
    this.group = new THREE.Group();
    this.group.name = 'wv_poi_layer';
    scene.add(this.group);

    this.tex = pinTexture();
    this.sprites = [];
    this.hovered = null;
    this.activeLevel = null;

    for (const poi of registry.pois) {
      const mat = new THREE.SpriteMaterial({
        map: this.tex, transparent: true, depthTest: true, depthWrite: false,
        sizeAttenuation: true, opacity: 0.95,
      });
      const sp = new THREE.Sprite(mat);
      sp.position.copy(poi.position);
      sp.scale.setScalar(0.34);
      sp.renderOrder = 10;
      sp.userData.poi = poi;
      sp.userData.baseY = poi.position.y;
      this.group.add(sp);
      this.sprites.push(sp);
    }
  }

  /** Follow the levels when they are pulled apart in exploded view. */
  setExplode(spread, registry) {
    for (const sp of this.sprites) {
      const lv = registry.levelById.get(sp.userData.poi.level);
      const elev = lv ? lv.elevation : 0;
      sp.position.y = sp.userData.baseY + elev * (spread - 1);
    }
  }

  setLevel(levelId, { all = false } = {}) {
    if (all) {
      for (const sp of this.sprites) sp.visible = true;
      this.activeLevel = null;
      return;
    }
    this.activeLevel = levelId;
    for (const sp of this.sprites) {
      sp.visible = !levelId || sp.userData.poi.level === levelId;
    }
  }

  /** Returns the POI under the given normalised device coords, or null. */
  pick(raycaster) {
    const visible = this.sprites.filter((s) => s.visible);
    const hits = raycaster.intersectObjects(visible, false);
    return hits.length ? hits[0].object.userData.poi : null;
  }

  setHovered(poi) {
    if (this.hovered === poi) return;
    this.hovered = poi;
    // Scale and opacity are owned by update(), which also factors in distance;
    // setting them here too would fight it every frame.
  }

  /**
   * Pins shrink and fade as you approach them.
   *
   * A world-sized sprite grows without limit as the camera closes on it, so a
   * marker two metres away fills a phone screen and hides the thing it labels.
   */
  update(cameraPos) {
    const NEAR = 3.4;     // start fading here
    const GONE = 1.1;     // fully faded by here
    for (const sp of this.sprites) {
      if (!sp.visible) continue;
      const d = sp.position.distanceTo(cameraPos);
      const base = sp.userData.poi === this.hovered ? 0.44 : 0.34;
      sp.scale.setScalar(base * Math.min(1, Math.max(0.45, d / 4.5)));
      sp.material.opacity = d < NEAR
        ? Math.max(0, Math.min(1, (d - GONE) / (NEAR - GONE))) * 0.95
        : 0.95;
    }
  }
}
