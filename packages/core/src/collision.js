import * as THREE from 'three';

const CELL = 4.0;

/**
 * Uniform grid over the scene's NAV_BLOCK volumes. CELL is 4 m, which lands a
 * handful of blocks in each bucket on the flats we have tested.
 *
 * The player is a vertical cylinder. resolve() pushes it out of every
 * overlapping box along the axis of least penetration, which is cheap and
 * stable enough indoors. The M2 navmesh takes over pathfinding; free movement
 * stays here.
 */
export class CollisionGrid {
  constructor(blocks) {
    this.cells = new Map();
    this.blocks = blocks;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const x0 = Math.floor(b.min.x / CELL), x1 = Math.floor(b.max.x / CELL);
      const z0 = Math.floor(b.min.z / CELL), z1 = Math.floor(b.max.z / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const k = x + ',' + z;
          let arr = this.cells.get(k);
          if (!arr) { arr = []; this.cells.set(k, arr); }
          arr.push(i);
        }
      }
    }
  }

  near(x, z, radius, out) {
    out.length = 0;
    const x0 = Math.floor((x - radius) / CELL), x1 = Math.floor((x + radius) / CELL);
    const z0 = Math.floor((z - radius) / CELL), z1 = Math.floor((z + radius) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.cells.get(cx + ',' + cz);
        if (arr) for (const i of arr) if (!out.includes(i)) out.push(i);
      }
    }
    return out;
  }

  /**
   * @param pos      THREE.Vector3, mutated in place. y is the feet height.
   * @param radius   player radius, metres
   * @param height   player height, metres
   * @param stepUp   boxes whose top is within this of the feet get walked over
   */
  resolve(pos, radius, height, stepUp) {
    const idx = this._scratch || (this._scratch = []);
    this.near(pos.x, pos.z, radius + 0.5, idx);

    const feetLow = pos.y + stepUp;   // a box topping out below this gets stepped over
    const headHigh = pos.y + height;

    // Three passes. Pushing out of one box can push into its neighbour, and a
    // fourth pass has never changed the resting position by more than a mm.
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const i of idx) {
        const b = this.blocks[i];
        if (b.max.y <= feetLow) continue;      // low enough to step onto
        if (b.min.y >= headHigh) continue;     // passes overhead

        const cx = Math.max(b.min.x, Math.min(pos.x, b.max.x));
        const cz = Math.max(b.min.z, Math.min(pos.z, b.max.z));
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;

        if (d2 > radius * radius) continue;

        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = radius - d;
          pos.x += (dx / d) * push;
          pos.z += (dz / d) * push;
        } else {
          // Centre is inside the box, so there is no push direction to derive.
          // Leave by whichever face is nearest.
          const left = pos.x - b.min.x, right = b.max.x - pos.x;
          const back = pos.z - b.min.z, front = b.max.z - pos.z;
          const m = Math.min(left, right, back, front);
          if (m === left) pos.x = b.min.x - radius;
          else if (m === right) pos.x = b.max.x + radius;
          else if (m === back) pos.z = b.min.z - radius;
          else pos.z = b.max.z + radius;
        }
        moved = true;
      }
      if (!moved) break;
    }
  }
}

/** Downward raycast against visible geometry to find the floor under the player. */
export class GroundProbe {
  constructor(meshes) {
    this.meshes = meshes;
    this.ray = new THREE.Raycaster();
    this.ray.far = 6.0;   // one storey plus slack; misses become a null and a fall
    this.origin = new THREE.Vector3();
    this.down = new THREE.Vector3(0, -1, 0);
    this._n = new THREE.Vector3();
    this._m = new THREE.Matrix3();
  }

  /** Returns the floor Y beneath `pos`, or null. `lift` starts the ray above the feet. */
  heightAt(pos, lift = 1.2) {
    this.origin.set(pos.x, pos.y + lift, pos.z);
    this.ray.set(this.origin, this.down);
    const hits = this.ray.intersectObjects(this.meshes, false);
    for (const h of hits) {
      if (!h.face) return h.point.y;
      this._m.getNormalMatrix(h.object.matrixWorld);
      this._n.copy(h.face.normal).applyMatrix3(this._m).normalize();
      if (this._n.y > 0.5) return h.point.y;
    }
    return null;
  }
}
