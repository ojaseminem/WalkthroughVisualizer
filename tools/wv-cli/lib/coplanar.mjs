/**
 * Finds pairs of axis-aligned faces sitting on nearly the same plane and
 * covering the same patch of it.
 *
 * Two surfaces a millimetre apart look right in a modelling package and strobe
 * in a real-time renderer: past a few metres the depth buffer cannot separate
 * them. Nothing shows up in a screenshot, so it has to be a build check.
 *
 * Runs on world-space geometry after instancing, so two copies of the same room
 * standing in different places are not reported against each other.
 */

import { getTag, VOLUME_TYPES } from './tags.mjs';

const AXES = ['x', 'y', 'z'];

function mat4Multiply(a, b) {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
                     + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function applyMat4(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

/** The same matrix with translation stripped, for taking normals to world. */
function rotationOnly(m) {
  const out = new Float64Array(m);
  out[12] = out[13] = out[14] = 0;
  return out;
}

function localMatrix(node) {
  const [tx, ty, tz] = node.getTranslation();
  const [qx, qy, qz, qw] = node.getRotation();
  const [sx, sy, sz] = node.getScale();
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return new Float64Array([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

/** Every triangle in the scene, in world space, with its normal where it has one. */
function worldTriangles(scene) {
  const tris = [];
  const walk = (node, parent) => {
    // Skip tag volumes. They are measuring boxes on a hidden render layer, and
    // in a source scene they sit flush against the geometry they describe, so
    // including them buries the real hits under a few hundred invisible ones.
    const tag = getTag(node);
    if (tag && VOLUME_TYPES.has(tag.type)) return;
    const world = mat4Multiply(parent, localMatrix(node));
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const nrm = prim.getAttribute('NORMAL');
        if (!pos) continue;
        const idx = prim.getIndices();
        const count = idx ? idx.getCount() : pos.getCount();
        const el = [0, 0, 0];
        const nl = [0, 0, 0];
        for (let i = 0; i + 2 < count; i += 3) {
          const t = [];
          for (let k = 0; k < 3; k++) {
            const vi = idx ? idx.getScalar(i + k) : i + k;
            pos.getElement(vi, el);
            t.push(applyMat4(world, el[0], el[1], el[2]));
          }
          if (nrm) {
            const vi = idx ? idx.getScalar(i) : i;
            nrm.getElement(vi, nl);
            t.normal = applyMat4(rotationOnly(world), nl[0], nl[1], nl[2]);
          }
          tris.push(t);
        }
      }
    }
    for (const child of node.listChildren()) walk(child, world);
  };
  const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const node of scene.listChildren()) walk(node, identity);
  return tris;
}

/**
 * Reduce triangles to axis-aligned face rectangles. A triangle qualifies only
 * if all three vertices share one coordinate. Angled geometry is skipped: the
 * plane bucketing below has no way to reason about it.
 */
function faceRects(tris, eps = 1e-4) {
  const rects = [];
  for (const t of tris) {
    for (let a = 0; a < 3; a++) {
      const v = t[0][a];
      if (Math.abs(t[1][a] - v) > eps || Math.abs(t[2][a] - v) > eps) continue;
      const b = (a + 1) % 3, c = (a + 2) % 3;
      // Which way the face points. Only same-facing surfaces fight. A wall's
      // underside against a floor's top face is back to back, and culling
      // throws one of them out before the depth test sees both.
      const facing = t.normal ? Math.sign(t.normal[a]) : 0;
      rects.push({
        axis: a,
        facing,
        plane: v,
        lo: [Math.min(t[0][b], t[1][b], t[2][b]), Math.min(t[0][c], t[1][c], t[2][c])],
        hi: [Math.max(t[0][b], t[1][b], t[2][b]), Math.max(t[0][c], t[1][c], t[2][c])],
      });
      break;
    }
  }
  return rects;
}

/**
 * @param {number} tolerance  metres. Planes closer than this count as fighting.
 * @param {number} minArea    m2. Under this it is usually two abutting walls
 *                            clipping by a sliver, which nobody ever sees.
 */
export function findCoplanar(scene, { tolerance = 0.012, minArea = 0.5 } = {}) {
  const rects = faceRects(worldTriangles(scene));

  // Both triangles of a quad have the quad's bounding rectangle, so without
  // this every quad reports itself. Collapsing identical rectangles also folds
  // away exact duplicate faces, which share a depth and so never flicker.
  const unique = new Map();
  for (const r of rects) {
    const key = `${r.axis}|${r.facing}|${r.plane.toFixed(4)}|${r.lo[0].toFixed(3)}`
              + `|${r.lo[1].toFixed(3)}|${r.hi[0].toFixed(3)}|${r.hi[1].toFixed(3)}`;
    if (!unique.has(key)) unique.set(key, r);
  }

  // Split by direction as well as axis so opposed faces are never paired.
  const byAxis = new Map();
  for (const r of unique.values()) {
    const k = `${r.axis}|${r.facing}`;
    if (!byAxis.has(k)) byAxis.set(k, []);
    byAxis.get(k).push(r);
  }

  const found = [];
  for (const [key, group] of byAxis) {
    const axis = Number(key.split('|')[0]);
    const list = group.sort((p, q) => p.plane - q.plane);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const gap = list[j].plane - list[i].plane;
        if (gap > tolerance) break;
        const w = Math.min(list[i].hi[0], list[j].hi[0]) - Math.max(list[i].lo[0], list[j].lo[0]);
        const h = Math.min(list[i].hi[1], list[j].hi[1]) - Math.max(list[i].lo[1], list[j].lo[1]);
        if (w <= 0.02 || h <= 0.02) continue;
        const area = w * h;
        if (area < minArea) continue;
        found.push({ axis: AXES[axis], plane: list[i].plane, gap, area });
      }
    }
  }
  found.sort((p, q) => q.area - p.area);
  return found;
}

/** Hit count, total conflicting area in m2, and the eight worst pairs. */
export function coplanarSummary(scene, opts) {
  const hits = findCoplanar(scene, opts);
  let area = 0;
  for (const h of hits) area += h.area;
  return { count: hits.length, area, worst: hits.slice(0, 8) };
}
