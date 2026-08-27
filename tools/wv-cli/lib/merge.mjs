import { getTag, isTagged, VOLUME_TYPES, walkScene } from './tags.mjs';

/**
 * Geometry transforms that respect the tag contract.
 *
 * gltf-transform's own join() is no use here. keepNamed:false flattened 643
 * tagged nodes down to 17, taking every zone, portal and POI in the building
 * with it. keepNamed:true joined nothing at all, because every node in a tagged
 * scene has a name. Merging has to know where the tags sit.
 */

// --------------------------------------------------------------------------- //
// Small matrix helpers, enough for rigid + scale node transforms
// --------------------------------------------------------------------------- //

function matMul(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

function matInvert(m) {
  // General 4x4 inverse. The node matrices are affine but can carry scale, so
  // the cheap rigid-inverse shortcut is out.
  const inv = new Array(16);
  const a = m;
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15]
    + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15]
    - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15]
    + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14]
    - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15]
    - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15]
    + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15]
    - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14]
    + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15]
    + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15]
    - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15]
    + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14]
    - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11]
    - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11]
    + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11]
    - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10]
    + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  det = 1.0 / det;
  return inv.map((v) => v * det);
}

function xformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function xformDir(m, v) {
  // Strictly this wants the inverse-transpose. Every transform in a building
  // scene is a translation plus near-uniform scale, so the rotation part is
  // close enough. Non-uniform scale on a mesh node would need fixing here.
  const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2];
  const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2];
  const z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2];
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// --------------------------------------------------------------------------- //
// Merge by material, within tag boundaries
// --------------------------------------------------------------------------- //

const ATTRS = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0'];

export function mergeByMaterial() {
  return (doc) => {
    const logger = doc.getLogger();
    let mergedNodes = 0;
    let producedPrims = 0;

    for (const scene of doc.getRoot().listScenes()) {
      // island key -> { boundary, nodes: [] }
      const islands = new Map();

      walkScene(scene, (node, boundary, tag) => {
        if (tag && tag.type) return;            // tagged nodes are never merged
        if (!node.getMesh()) return;
        const key = boundary || '@scene';
        if (!islands.has(key)) islands.set(key, { boundary, nodes: [] });
        islands.get(key).nodes.push(node);
      });

      for (const { boundary, nodes } of islands.values()) {
        if (nodes.length === 0) continue;

        const anchorInv = boundary
          ? matInvert(boundary.getWorldMatrix())
          : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

        // material -> accumulated attribute arrays
        const byMaterial = new Map();

        for (const node of nodes) {
          const rel = matMul(anchorInv, node.getWorldMatrix());
          for (const prim of node.getMesh().listPrimitives()) {
            const mat = prim.getMaterial();
            const key = mat ? mat.getName() + '#' + doc.getRoot().listMaterials().indexOf(mat) : '@null';
            if (!byMaterial.has(key)) {
              byMaterial.set(key, { material: mat, data: {}, count: 0, indices: [] });
            }
            const bucket = byMaterial.get(key);

            const pos = prim.getAttribute('POSITION');
            if (!pos) continue;
            const vcount = pos.getCount();
            const base = bucket.count;

            for (const name of ATTRS) {
              const acc = prim.getAttribute(name);
              if (!acc) continue;
              if (!bucket.data[name]) bucket.data[name] = { elems: [], size: acc.getElementSize() };
              const size = acc.getElementSize();
              const tmp = new Array(size);
              for (let i = 0; i < vcount; i++) {
                acc.getElement(i, tmp);
                let v = tmp.slice();
                if (name === 'POSITION') v = xformPoint(rel, v);
                else if (name === 'NORMAL') v = xformDir(rel, v);
                bucket.data[name].elems.push(...v);
              }
            }

            const idx = prim.getIndices();
            if (idx) {
              for (let i = 0; i < idx.getCount(); i++) bucket.indices.push(base + idx.getScalar(i));
            } else {
              for (let i = 0; i < vcount; i++) bucket.indices.push(base + i);
            }
            bucket.count += vcount;
          }
        }

        if (byMaterial.size === 0) continue;

        // Strip any WV_ off the anchor name before reusing it. Left on, the
        // name-convention parser reads "WV_LEVEL__L01__merged" back as a second
        // LEVEL tag on the next pass. Attributes only some primitives carry
        // would give a ragged buffer, so the accessor loop below drops any that
        // do not cover every vertex in the bucket.
        const anchorName = (boundary ? boundary.getName() : scene.getName() || 'scene')
          .replace(/^WV_/, '');
        const mesh = doc.createMesh(`merged_${anchorName}`);
        const buffer = doc.getRoot().listBuffers()[0];

        for (const bucket of byMaterial.values()) {
          const prim = doc.createPrimitive().setMaterial(bucket.material);
          for (const [name, store] of Object.entries(bucket.data)) {
            if (store.elems.length / store.size !== bucket.count) continue;
            const type = { 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' }[store.size] || 'SCALAR';
            const acc = doc.createAccessor(name)
              .setType(type)
              .setArray(new Float32Array(store.elems))
              .setBuffer(buffer);
            prim.setAttribute(name, acc);
          }
          const IndexArray = bucket.count > 65535 ? Uint32Array : Uint16Array;
          prim.setIndices(doc.createAccessor()
            .setType('SCALAR')
            .setArray(new IndexArray(bucket.indices))
            .setBuffer(buffer));
          mesh.addPrimitive(prim);
          producedPrims++;
        }

        const holder = doc.createNode(mesh.getName()).setMesh(mesh);
        if (boundary) boundary.addChild(holder);
        else scene.addChild(holder);

        for (const node of nodes) {
          mergedNodes++;
          node.setMesh(null);
          if (node.listChildren().length === 0) node.dispose();
        }
      }
    }

    logger.info(`merge: ${mergedNodes} geometry nodes -> ${producedPrims} primitives`);
  };
}

// --------------------------------------------------------------------------- //
// Bake tag volumes to AABBs
// --------------------------------------------------------------------------- //

/**
 * Swaps the placeholder box on ZONE / NAV_* / PORTAL nodes for a world-space
 * AABB in extras.
 *
 * Those meshes only ever existed so something could measure the volume. Once
 * the six numbers are in the file the box is dead weight, and the runtime stops
 * running a Box3.setFromObject per tag at load.
 */
export function bakeTagVolumes() {
  return (doc) => {
    let baked = 0;
    for (const scene of doc.getRoot().listScenes()) {
      walkScene(scene, (node, _b, tag) => {
        if (!tag || !VOLUME_TYPES.has(tag.type)) return;
        const mesh = node.getMesh();
        if (!mesh) return;

        const m = node.getWorldMatrix();
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        const tmp = [0, 0, 0];
        for (const prim of mesh.listPrimitives()) {
          const pos = prim.getAttribute('POSITION');
          if (!pos) continue;
          for (let i = 0; i < pos.getCount(); i++) {
            pos.getElement(i, tmp);
            const p = xformPoint(m, tmp);
            for (let k = 0; k < 3; k++) {
              if (p[k] < min[k]) min[k] = p[k];
              if (p[k] > max[k]) max[k] = p[k];
            }
          }
        }
        if (!Number.isFinite(min[0])) return;

        const extras = { ...(node.getExtras() || {}) };
        extras.wv = { ...(extras.wv || tag), aabb: [...min.map(round), ...max.map(round)] };
        node.setExtras(extras);
        node.setMesh(null);
        baked++;
      });
    }
    doc.getLogger().info(`bake: ${baked} tag volumes reduced to AABBs`);
  };
}

const round = (v) => Math.round(v * 1000) / 1000;
