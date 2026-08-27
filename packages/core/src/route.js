import * as THREE from 'three';

/**
 * Turns tour stops into a path that stays inside the building.
 *
 * A spline drawn straight through the stops cuts corners. On this plan about a
 * twentieth of its length ends up inside solid geometry, so the camera glides
 * through a bedroom wall on the way to the balcony.
 *
 * PORTAL volumes name the two zones each doorway joins, so rooms and doors form
 * a graph and a leg between two stops is a shortest path across it. NAV_BLOCK
 * volumes mark everything solid, so the finished curve can be measured.
 *
 * Pass one routes through doorways. For each pair of consecutive stops in
 * different rooms, walk the portal graph and drop a waypoint either side of
 * every door on the way. A single waypoint in the middle of a doorway lets the
 * curve arrive at an angle and clip the jamb; a run-in and run-out squares the
 * camera up to the opening.
 *
 * Pass two pulls the path taut. Resample every 30 cm, then relax: each free
 * point is drawn toward the midpoint of its neighbours and pushed straight back
 * out of anything solid. Stops and doorway centres are pinned. The spline is
 * fitted to whatever that settles into.
 *
 * Pass two only ever moves the path sideways. Let it move in y and it solves a
 * tight corner by flying the camera up through the ceiling.
 */

// A doorway here is 900 mm wide, so the most a path down its centre can claim
// is 450 mm either side. Ask for more and the relaxation can never satisfy a
// door, so it gives up on the points that matter most.
const CLEARANCE = 0.25;      // keep this far off anything solid
const MARGIN = 0.06;         // relax to a little more than that so the fitted
                             // spline still clears when it rounds a corner
const DOOR_STANDOFF = 0.75;  // how far either side of a doorway the run-in points sit
const RESAMPLE = 0.30;       // metres between points on the polyline being relaxed
const RELAX_PASSES = 90;
const SMOOTH = 0.30;         // how hard each pass pulls a point toward its neighbours
const CONTROL_SPACING = 0.9; // metres between the control points handed to the spline

/** The axis a portal is thin on. That is the direction you pass through it. */
function portalAxis(box) {
  const s = box.getSize(new THREE.Vector3());
  if (s.x <= s.y && s.x <= s.z) return 'x';
  if (s.z <= s.y && s.z <= s.x) return 'z';
  return 'y';
}

function zoneOf(reg, point) {
  let best = null;
  for (const z of reg.zones) {
    if (z.category === 'unit') continue;
    const b = z.box;
    if (point.x >= b.min.x && point.x <= b.max.x
      && point.z >= b.min.z && point.z <= b.max.z
      && point.y >= b.min.y - 0.6 && point.y <= b.max.y + 0.6) {
      // reg.zones is sorted smallest first, so the first hit is the tightest fit
      best = z;
      break;
    }
  }
  return best;
}

function buildGraph(reg) {
  const adj = new Map();
  const link = (from, edge) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(edge);
  };
  for (const p of reg.portals) {
    if (!p.connects || p.connects.length !== 2) continue;
    const [a, b] = p.connects;
    if (!reg.zoneById.has(a) || !reg.zoneById.has(b)) continue;
    const centre = p.box.getCenter(new THREE.Vector3());
    const ca = reg.zoneById.get(a).box.getCenter(new THREE.Vector3());
    const cb = reg.zoneById.get(b).box.getCenter(new THREE.Vector3());
    const cost = ca.distanceTo(centre) + cb.distanceTo(centre);
    link(a, { to: b, portal: p, centre, cost });
    link(b, { to: a, portal: p, centre, cost });
  }
  return adj;
}

/** Shortest sequence of portals from one zone to another. Empty if none exists. */
function portalPath(adj, fromZone, toZone) {
  if (fromZone === toZone) return [];
  const dist = new Map([[fromZone, 0]]);
  const prev = new Map();
  const seen = new Set();
  // The graph is a few dozen rooms, so a linear scan for the next node is
  // cheaper than the bookkeeping a heap would need.
  for (;;) {
    let node = null, bestCost = Infinity;
    for (const [id, d] of dist) {
      if (!seen.has(id) && d < bestCost) { bestCost = d; node = id; }
    }
    if (node === null) return null;
    if (node === toZone) break;
    seen.add(node);
    for (const e of adj.get(node) || []) {
      const d = bestCost + e.cost;
      if (d < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, d);
        prev.set(e.to, { from: node, edge: e });
      }
    }
  }
  const out = [];
  let cur = toZone;
  while (cur !== fromZone) {
    const step = prev.get(cur);
    if (!step) return null;
    out.unshift(step.edge);
    cur = step.from;
  }
  return out;
}

/**
 * Waypoints for one doorway: run-in, centre, run-out.
 *
 * "Through" comes from the centres of the two rooms the portal joins. It used
 * to come from the two stops the leg runs between, which broke on a leg that
 * doubles back. Kitchen to living room to bedroom with both stops against the
 * same wall gives a stop-to-stop vector of almost nothing, so the run-in came
 * out on the far side of the door and the path crossed the wall, came back
 * through the opening and crossed it again.
 */
function doorwayPoints(reg, edge, fromZoneId, y) {
  const centre = edge.centre.clone();
  centre.y = y;
  const axis = portalAxis(edge.portal.box);
  if (axis === 'y') return [centre];

  const leaving = reg.zoneById.get(fromZoneId);
  const entering = reg.zoneById.get(edge.to);
  const a = leaving ? leaving.box.getCenter(new THREE.Vector3())[axis] : centre[axis] - 1;
  const b = entering ? entering.box.getCenter(new THREE.Vector3())[axis] : centre[axis] + 1;

  const dir = new THREE.Vector3();
  dir[axis] = Math.sign(b - a) || 1;
  const back = centre.clone().addScaledVector(dir, -DOOR_STANDOFF);
  const fwd = centre.clone().addScaledVector(dir, DOOR_STANDOFF);
  return [back, centre, fwd];
}

/** Smallest sideways move that takes a point out of a block, or null if clear. */
function escape(point, block, pad) {
  const minX = block.min.x - pad, maxX = block.max.x + pad;
  const minY = block.min.y - pad, maxY = block.max.y + pad;
  const minZ = block.min.z - pad, maxZ = block.max.z + pad;
  if (point.x <= minX || point.x >= maxX) return null;
  if (point.y <= minY || point.y >= maxY) return null;
  if (point.z <= minZ || point.z >= maxZ) return null;

  const outLeft = point.x - minX, outRight = maxX - point.x;
  const outBack = point.z - minZ, outFwd = maxZ - point.z;
  const best = Math.min(outLeft, outRight, outBack, outFwd);
  const fix = point.clone();
  if (best === outLeft) fix.x = minX;
  else if (best === outRight) fix.x = maxX;
  else if (best === outBack) fix.z = minZ;
  else fix.z = maxZ;
  return fix;
}

/**
 * Moves a point clear of everything solid.
 *
 * In a tight spot, pushing out of one block pushes into another and the two
 * bounce the point back and forth forever. Capped at 12 attempts, keeping
 * whichever position was least buried. Half a fix in a narrow gap still beats
 * leaving the point in the middle of a wall.
 */
function pushClear(point, blocks, pad) {
  const p = point.clone();
  let best = p.clone();
  let bestDepth = Infinity;
  for (let attempt = 0; attempt < 12; attempt++) {
    let moved = false;
    let depth = 0;
    for (const b of blocks) {
      const fix = escape(p, b, pad);
      if (!fix) continue;
      depth += fix.distanceTo(p);
      p.copy(fix);
      moved = true;
    }
    if (!moved) return p;
    if (depth < bestDepth) { bestDepth = depth; best.copy(p); }
  }
  return best;
}

function isBlocked(point, blocks, pad) {
  for (const b of blocks) {
    if (point.x > b.min.x - pad && point.x < b.max.x + pad
      && point.y > b.min.y - pad && point.y < b.max.y + pad
      && point.z > b.min.z - pad && point.z < b.max.z + pad) return true;
  }
  return false;
}

/**
 * Resample a polyline at fixed spacing, remembering which points may not move.
 * The originals are kept and marked pinned. The fill-in points between them are
 * what the relaxation is free to push around.
 */
function densify(points, pinned, spacing) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    out.push({ point: points[i].clone(), pinned: pinned.has(i) });
    if (i === points.length - 1) break;
    const a = points[i], b = points[i + 1];
    const steps = Math.floor(a.distanceTo(b) / spacing);
    for (let k = 1; k < steps; k++) {
      out.push({ point: a.clone().lerp(b, k / steps), pinned: false });
    }
  }
  return out;
}

function makeCurve(points) {
  // Centripetal parameterisation. Uniform Catmull-Rom overshoots when the gap
  // between control points is uneven, and tour stops are always uneven: a long
  // run down a corridor, then three stops within a couple of metres of each
  // other. The overshoot is what puts the camera in the wall.
  return new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
}

/**
 * @param {object} reg    the entity registry
 * @param {THREE.Vector3[]} stops  the tour's stop positions, in order
 * @returns {{ curve: THREE.CatmullRomCurve3, points: THREE.Vector3[], stopU: number[] }}
 *   stopU is each original stop's position along the finished curve. The tour
 *   timeline dwells on those.
 */
export function buildTourPath(reg, stops) {
  const adj = buildGraph(reg);
  const blocks = reg.navBlocks;

  // -- pass one: route each leg through the doorways it needs ------------- //
  const points = [stops[0].clone()];
  // Stops and doorway centres are fixed. The relaxation may move everything
  // else. A run-in point only exists to square the camera up to an opening, so
  // if the taut path already arrives straight there is no reason to hold it.
  const pinned = new Set([0]);

  for (let i = 1; i < stops.length; i++) {
    const from = stops[i - 1];
    const to = stops[i];
    const zFrom = zoneOf(reg, from);
    const zTo = zoneOf(reg, to);

    if (zFrom && zTo && zFrom.id !== zTo.id) {
      const legs = portalPath(adj, zFrom.id, zTo.id);
      if (legs) {
        let standingIn = zFrom.id;
        for (const edge of legs) {
          const y = THREE.MathUtils.lerp(from.y, to.y, 0.5);
          const centre = edge.centre;
          for (const wp of doorwayPoints(reg, edge, standingIn, y)) {
            // A doorway the tour is already standing in needs no waypoint.
            if (wp.distanceTo(points[points.length - 1]) <= 0.35
              || wp.distanceTo(to) <= 0.35) continue;
            points.push(wp);
            if (Math.abs(wp.x - centre.x) < 1e-6 && Math.abs(wp.z - centre.z) < 1e-6) {
              pinned.add(points.length - 1);
            }
          }
          standingIn = edge.to;
        }
      }
    }
    points.push(to.clone());
    pinned.add(points.length - 1);
  }

  // -- pass two: pull it taut ---------------------------------------------- //
  const poly = densify(points, pinned, RESAMPLE);
  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    let moved = 0;
    for (let i = 1; i < poly.length - 1; i++) {
      if (poly[i].pinned) continue;
      const p = poly[i].point;
      const bx = p.x, bz = p.z;
      // Horizontal only. See the note at the top of the file about y drift.
      p.x += (0.5 * (poly[i - 1].point.x + poly[i + 1].point.x) - p.x) * SMOOTH;
      p.z += (0.5 * (poly[i - 1].point.z + poly[i + 1].point.z) - p.z) * SMOOTH;
      const clear = pushClear(p, blocks, CLEARANCE + MARGIN);
      if (clear) p.copy(clear);
      // Per axis. Summing them let a move of +d in x and -d in z read as no
      // move at all and stop the relaxation a few passes early.
      if (Math.abs(p.x - bx) > 1e-4 || Math.abs(p.z - bz) > 1e-4) moved++;
    }
    if (!moved) break;
  }

  // -- fit the spline to the relaxed path ---------------------------------- //
  points.length = 0;
  let since = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const last = points[points.length - 1];
    since = last ? since + poly[i].point.distanceTo(poly[i - 1].point) : Infinity;
    const isEnd = i === 0 || i === poly.length - 1;
    if (!isEnd && !poly[i].pinned && since < CONTROL_SPACING) continue;
    if (last && poly[i].point.distanceTo(last) < 0.05) continue;
    points.push(poly[i].point.clone());
    since = 0;
  }
  const curve = makeCurve(points);

  // -- where the stops ended up along the finished curve ------------------ //
  const acc = [0];
  for (let i = 1; i < points.length; i++) {
    acc.push(acc[i - 1] + points[i].distanceTo(points[i - 1]));
  }
  const total = acc[acc.length - 1] || 1;
  // The stop indices shift as corrections are spliced in, so find each stop by
  // position rather than trusting the index it had before pass two.
  const stopU = stops.map((s) => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = points[i].distanceToSquared(s);
      if (d < bestD) { bestD = d; best = i; }
    }
    return acc[best] / total;
  });

  return { curve, points, stopU };
}
