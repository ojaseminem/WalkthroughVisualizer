import * as THREE from 'three';

/**
 * Reads a loaded glTF scene into the typed entity registry the rest of the
 * runtime works against. Only file that knows the tag schema, so a schema change
 * stops here.
 *
 * No project knowledge in this file. Any correctly tagged scene gives back the
 * same shape of registry.
 */

const VOLUME_TYPES = new Set(['ZONE', 'NAV_FLOOR', 'NAV_BLOCK', 'PORTAL']);
const EMPTY_TYPES = new Set(['POI', 'CAM_TOUR', 'CAM_KEY']);

// Tag volumes are hidden with a render layer, never `visible = false`.
// Visibility is inherited, and a tagged node often wraps real geometry (a ZONE
// around a whole flat). Layers are per-object, so the placeholder goes and its
// children carry on rendering.
const HIDDEN_LAYER = 2;

function hideVolume(obj) {
  obj.layers.set(HIDDEN_LAYER);
}

function isRenderable(obj) {
  return (obj.layers.mask & 1) !== 0;
}

/**
 * A tag volume's world box.
 *
 * wv-cli bakes each volume down to `wv.aabb` and drops the placeholder mesh,
 * taking hundreds of geometry-carrying nodes out of the shipped scene. Raw
 * source scenes still carry the boxes, so both paths have to work. Use the
 * baked numbers when present, otherwise measure the mesh.
 */
function volumeBox(obj, wv) {
  if (Array.isArray(wv.aabb) && wv.aabb.length === 6) {
    const [a, b, c, d, e, f] = wv.aabb;
    return new THREE.Box3(new THREE.Vector3(a, b, c), new THREE.Vector3(d, e, f));
  }
  obj.updateWorldMatrix(true, false);
  return new THREE.Box3().setFromObject(obj);
}

/** Parse `WV_<TYPE>__<id>__<label>` node names for DCCs that cannot write extras. */
function fromName(name) {
  if (!name || !name.startsWith('WV_')) return null;
  const parts = name.slice(3).split('__');
  if (parts.length < 2) return null;
  const wv = { type: parts[0], id: parts[1] };
  if (parts[2]) wv.label = parts[2].replace(/_/g, ' ');
  return wv;
}

function tagOf(obj) {
  const explicit = obj.userData && obj.userData.wv;
  if (explicit && explicit.type) return explicit;
  return fromName(obj.name);
}

function titleCase(id) {
  const leaf = String(id).split('.').pop() || '';
  return leaf.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function buildRegistry(root) {
  const reg = {
    project: null,
    levels: [],
    levelById: new Map(),
    zones: [],
    zoneById: new Map(),
    navFloors: [],
    navBlocks: [],
    portals: [],
    pois: [],
    poiById: new Map(),
    tours: [],
    walkables: [],
    warnings: [],
    untaggedMeshes: 0,
  };

  const box = new THREE.Box3();
  const stack = [{ obj: root, level: null }];

  // First pass: walk the hierarchy, classify, inherit level downward.
  while (stack.length) {
    const { obj, level } = stack.pop();
    const wv = tagOf(obj);
    let childLevel = level;

    if (wv) {
      const type = wv.type;
      const resolvedLevel = wv.level || level;

      if (type === 'PROJECT') {
        reg.project = { ...wv };
      } else if (type === 'LEVEL') {
        const lv = {
          id: wv.id,
          label: wv.label || titleCase(wv.id),
          elevation: typeof wv.elevation === 'number' ? wv.elevation : obj.position.y,
          object: obj,
        };
        reg.levels.push(lv);
        reg.levelById.set(lv.id, lv);
        childLevel = lv.id;
      } else if (type === 'ZONE') {
        const b = volumeBox(obj, wv);
        const zone = {
          id: wv.id,
          label: wv.label || titleCase(wv.id),
          category: wv.category || null,
          area: wv.area ?? null,
          parent: wv.parent || null,
          tags: wv.tags || [],
          level: resolvedLevel,
          box: b,
          volume: b.getSize(new THREE.Vector3()).x * b.getSize(new THREE.Vector3()).z,
          object: obj,
        };
        reg.zones.push(zone);
        reg.zoneById.set(zone.id, zone);
        if (!zone.category) reg.warnings.push(`ZONE ${zone.id} has no category`);
      } else if (type === 'NAV_FLOOR') {
        reg.navFloors.push({
          id: wv.id, zone: wv.zone || null, level: resolvedLevel,
          surface: wv.surface || 'interior',
          box: volumeBox(obj, wv), object: obj,
        });
      } else if (type === 'NAV_BLOCK') {
        const b = volumeBox(obj, wv);
        reg.navBlocks.push({
          min: b.min.clone(), max: b.max.clone(), level: resolvedLevel,
        });
      } else if (type === 'PORTAL') {
        reg.portals.push({
          id: wv.id, connects: wv.connects || [], door: wv.door || 'open',
          level: resolvedLevel, box: volumeBox(obj, wv),
        });
      } else if (type === 'POI') {
        obj.updateWorldMatrix(true, false);
        const pos = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
        const off = wv.anchor && wv.anchor.offset;
        if (off) pos.add(new THREE.Vector3(off[0], off[1], off[2]));
        const poi = {
          id: wv.id, label: wv.label || titleCase(wv.id), level: resolvedLevel,
          zone: wv.zone || null, panel: wv.panel || null, icon: wv.icon || null,
          position: pos,
        };
        reg.pois.push(poi);
        reg.poiById.set(poi.id, poi);
        if (!poi.panel) reg.warnings.push(`POI ${poi.id} has no panel content`);
      } else if (type === 'CAM_TOUR') {
        const keys = [];
        obj.traverse((c) => {
          const k = tagOf(c);
          if (k && k.type === 'CAM_KEY') {
            c.updateWorldMatrix(true, false);
            keys.push({
              id: k.id, label: k.label || titleCase(k.id),
              order: k.order ?? keys.length, dwell: k.dwell ?? 3,
              position: new THREE.Vector3().setFromMatrixPosition(c.matrixWorld),
              look: k.look || null,
            });
          }
        });
        keys.sort((a, b2) => a.order - b2.order);
        if (keys.length < 2) reg.warnings.push(`CAM_TOUR ${wv.id} has fewer than two keys`);
        reg.tours.push({
          id: wv.id, label: wv.label || titleCase(wv.id),
          loop: !!wv.loop, level: resolvedLevel, keys,
        });
      } else if (type !== 'VARIANT_SET' && type !== 'VARIANT' && type !== 'CAM_KEY') {
        reg.warnings.push(`Unknown wv.type "${type}" on ${obj.name}`);
      }

      if (VOLUME_TYPES.has(type) || EMPTY_TYPES.has(type)) {
        hideVolume(obj);
      }
    } else if (obj.isMesh) {
      reg.untaggedMeshes += 1;
    }

    for (const c of obj.children) stack.push({ obj: c, level: childLevel });
  }

  // Visible geometry the player walks on and looks at.
  root.traverse((o) => {
    if (!o.isMesh || !isRenderable(o)) return;
    let p = o;
    while (p) { if (p.visible === false) return; p = p.parent; }
    reg.walkables.push(o);
  });

  reg.levels.sort((a, b) => a.elevation - b.elevation);
  // Smallest zone wins containment, so a foyer beats the living room whose AABB
  // overlaps it. Sorting once here keeps the per-frame lookup a linear scan.
  reg.zones.sort((a, b) => a.volume - b.volume);

  // Same portal wiring check wv-cli does, but non-fatal at runtime.
  for (const p of reg.portals) {
    for (const c of p.connects) {
      if (!reg.zoneById.has(c)) reg.warnings.push(`PORTAL ${p.id} references missing zone "${c}"`);
    }
  }

  return reg;
}

export function zoneAt(reg, point, levelId) {
  for (const z of reg.zones) {
    if (levelId && z.level !== levelId) continue;
    if (z.category === 'unit') continue;
    if (point.x >= z.box.min.x && point.x <= z.box.max.x
      && point.z >= z.box.min.z && point.z <= z.box.max.z
      && point.y >= z.box.min.y - 0.5 && point.y <= z.box.max.y + 0.5) {
      return z;
    }
  }
  return null;
}

export function unitAt(reg, point) {
  for (const z of reg.zones) {
    if (z.category !== 'unit') continue;
    if (point.x >= z.box.min.x && point.x <= z.box.max.x
      && point.z >= z.box.min.z && point.z <= z.box.max.z
      && point.y >= z.box.min.y - 0.5 && point.y <= z.box.max.y + 0.5) return z;
  }
  return null;
}
