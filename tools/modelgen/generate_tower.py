#!/usr/bin/env python3
"""Generate the WalkthroughVisualizer M1 demo scene: a 2BHK residential tower.

Ground floor lobby + three typical floors, two mirrored 2BHK units per floor,
central core with lifts and an alternating straight stair. Every node that the
runtime needs to understand carries `extras.wv` per docs/schema-v0.1.md.

    python3 generate_tower.py ../../content/kp-tower/scene.glb
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from glbwriter import GlbWriter, Material, MeshBuilder, Node
import plan as P


# --------------------------------------------------------------------------- #
# Palette
# --------------------------------------------------------------------------- #

def hexc(h: str, a: float = 1.0):
    h = h.lstrip("#")
    return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255, a)


PALETTE = {
    "wall_int":      Material("wall_int", hexc("E3DED4"), roughness=0.92),
    "wall_ext":      Material("wall_ext", hexc("BFB7A8"), roughness=0.94),
    "wall_corridor": Material("wall_corridor", hexc("D4CFC4"), roughness=0.92),
    "floor_tile":    Material("floor_tile", hexc("CCC6BB"), roughness=0.35),
    "floor_wood":    Material("floor_wood", hexc("9C6B41"), roughness=0.55),
    "floor_bath":    Material("floor_bath", hexc("AEB4B6"), roughness=0.40),
    "floor_deck":    Material("floor_deck", hexc("9C9488"), roughness=0.80),
    "ceiling":       Material("ceiling", hexc("EEEBE5"), roughness=0.95),
    "glass":         Material("glass", hexc("A8C8DA", 0.30), metallic=0.0, roughness=0.08,
                              double_sided=True),
    "railing":       Material("railing", hexc("6E7679"), metallic=0.80, roughness=0.35),
    "door":          Material("door", hexc("7A5433"), roughness=0.60),
    "counter":       Material("counter", hexc("33383B"), roughness=0.25),
    "cabinet":       Material("cabinet", hexc("BDB6A7"), roughness=0.55),
    "wood_furn":     Material("wood_furn", hexc("8A6242"), roughness=0.60),
    "wood_dark":     Material("wood_dark", hexc("5C4530"), roughness=0.55),
    "fabric":        Material("fabric", hexc("6B7F82"), roughness=0.95),
    "linen":         Material("linen", hexc("DAD6CD"), roughness=0.95),
    "linen_alt":     Material("linen_alt", hexc("C4CBC6"), roughness=0.95),
    "steel":         Material("steel", hexc("A9AFB2"), metallic=0.90, roughness=0.28),
    "screen":        Material("screen", hexc("1A1D1F"), roughness=0.20),
    "ceramic":       Material("ceramic", hexc("E8E8E4"), roughness=0.20),
    "appliance":     Material("appliance", hexc("DCDEDC"), roughness=0.40),
    "planter":       Material("planter", hexc("7A6A55"), roughness=0.90),
    "foliage":       Material("foliage", hexc("5E7A4A"), roughness=0.95),
    "concrete":      Material("concrete", hexc("A6A39B"), roughness=0.90),
    "ground":        Material("ground", hexc("8B9179"), roughness=1.0),
    "grass":         Material("grass", hexc("6E8055"), roughness=1.0),
    "road":          Material("road", hexc("55585A"), roughness=0.85),
    "context":       Material("context", hexc("9AA0A4"), roughness=0.90),
    "lift":          Material("lift", hexc("8E9599"), metallic=0.85, roughness=0.30),
    "signage":       Material("signage", hexc("C4341F"), roughness=0.50, emissive=(0.10, 0.02, 0.01)),
    "wv_hidden":     Material("wv_hidden", hexc("FF00FF", 0.0), roughness=1.0, double_sided=True),
}


# --------------------------------------------------------------------------- #
# Emitter — unit-local geometry with optional x-mirror
# --------------------------------------------------------------------------- #

class Emitter:
    def __init__(self, mb: MeshBuilder, mats: dict[str, int], mirror: bool = False):
        self.mb = mb
        self.mats = mats
        self.mirror = mirror

    def mx(self, x: float) -> float:
        return (P.UNIT_W - x) if self.mirror else x

    def box(self, x0, z0, x1, z1, y0, y1, mat: str, faces: str = "xXyYzZ"):
        ax, bx = self.mx(x0), self.mx(x1)
        self.mb.box((min(ax, bx), y0, z0), (max(ax, bx), y1, z1), self.mats[mat], faces)


def collision_rect(x0, z0, x1, z1, y0, y1, mirror: bool):
    """Return an axis-aligned box in unit-local space, mirrored if needed."""
    if mirror:
        x0, x1 = P.UNIT_W - x1, P.UNIT_W - x0
    return (min(x0, x1), y0, z0, max(x0, x1), y1, z1)


# --------------------------------------------------------------------------- #
# Wall emission
# --------------------------------------------------------------------------- #

OPENING_Y = {
    "door":   (0.0, P.DOOR_H),
    "window": (P.WIN_SILL, P.WIN_HEAD),
    "vent":   (P.HIGH_SILL, P.WIN_HEAD),
    "open":   (0.0, P.CEIL),
}


def emit_wall(em: Emitter, wall: dict, blocks: list) -> list[dict]:
    """Emit one wall's geometry and append the collision boxes it produces.

    Visual geometry and collision are generated separately on purpose. A window
    is a hole you can see through but not walk through, so its sill and lintel
    are drawn as pieces while collision stays a single unbroken span. Only doors
    and open balcony edges actually break the collision line.
    """
    axis, at, a, b, t = wall["axis"], wall["at"], wall["a"], wall["b"], wall["t"]
    mat = wall["mat"]
    half = t / 2.0
    lo, hi = at - half, at + half

    def draw(s, e, y0, y1, m):
        if e - s < 1e-6 or y1 - y0 < 1e-6:
            return
        if axis == "x":
            em.box(lo, s, hi, e, y0, y1, m)
        else:
            em.box(s, lo, e, hi, y0, y1, m)

    def collide(s, e, y0, y1):
        if e - s < 1e-6 or y1 - y0 < 1e-6:
            return
        if axis == "x":
            blocks.append(collision_rect(lo, s, hi, e, y0, y1, em.mirror))
        else:
            blocks.append(collision_rect(s, lo, e, hi, y0, y1, em.mirror))

    def pane(s, e, y0, y1, m, thin=0.03):
        if axis == "x":
            em.box(at - thin, s, at + thin, e, y0, y1, m)
        else:
            em.box(s, at - thin, e, at + thin, y0, y1, m)

    openings = sorted(wall.get("openings", []), key=lambda o: o[0])

    # ---- visual: solid spans between every opening ------------------------- #
    cursor = a
    for s, e, _kind in openings:
        draw(cursor, min(s, b), 0.0, P.CEIL, mat)
        cursor = max(cursor, e)
    draw(cursor, b, 0.0, P.CEIL, mat)

    # ---- collision: solid except where you can actually pass --------------- #
    passable = [o for o in openings if o[2] in ("door", "open")]
    cursor = a
    for s, e, _kind in passable:
        collide(cursor, min(s, b), 0.0, P.CEIL)
        cursor = max(cursor, e)
    collide(cursor, b, 0.0, P.CEIL)

    # ---- per-opening detail ------------------------------------------------ #
    interior_dir = 1 if (at < (P.UNIT_W if axis == "x" else P.UNIT_D) / 2) else -1

    for s, e, kind in openings:
        y0, y1 = OPENING_Y[kind]

        if kind == "open":
            # Recessed balcony edge: kerb, railing, and balusters.
            pane(s, e, 0.0, 0.06, "concrete")
            pane(s, e, P.RAIL_H - 0.06, P.RAIL_H, "railing")
            n = max(2, int((e - s) / 0.14))
            for i in range(1, n):
                q = s + (e - s) * i / n
                if axis == "x":
                    em.box(at - 0.015, q - 0.015, at + 0.015, q + 0.015,
                           0.06, P.RAIL_H - 0.06, "railing")
                else:
                    em.box(q - 0.015, at - 0.015, q + 0.015, at + 0.015,
                           0.06, P.RAIL_H - 0.06, "railing")
            if axis == "x":
                blocks.append(collision_rect(at - 0.08, s, at + 0.08, e, 0.0, P.RAIL_H, em.mirror))
            else:
                blocks.append(collision_rect(s, at - 0.08, e, at + 0.08, 0.0, P.RAIL_H, em.mirror))
            continue

        draw(s, e, y1, P.CEIL, mat)                      # lintel

        if y0 > 0.001:                                    # window or vent
            draw(s, e, 0.0, y0, mat)                      # sill wall
            pane(s, e, y0, y1, "glass")
            # Reveal returns so the opening reads as a punched hole, not a decal.
            draw(s, s + 0.02, y0, y1, mat)
            draw(e - 0.02, e, y0, y1, mat)
            continue

        # Door: frame, threshold, and a leaf swung open into the room.
        w = e - s
        if axis == "x":
            em.box(at - 0.06, s - 0.06, at + 0.06, s, 0.0, y1 + 0.07, "door")
            em.box(at - 0.06, e, at + 0.06, e + 0.06, 0.0, y1 + 0.07, "door")
            em.box(at - 0.06, s, at + 0.06, e, y1, y1 + 0.07, "door")
            lx0 = at if interior_dir > 0 else at - w * 0.92
            lx1 = at + w * 0.92 if interior_dir > 0 else at
            em.box(lx0, s + 0.02, lx1, s + 0.06, 0.03, y1 - 0.02, "door")
        else:
            em.box(s - 0.06, at - 0.06, s, at + 0.06, 0.0, y1 + 0.07, "door")
            em.box(e, at - 0.06, e + 0.06, at + 0.06, 0.0, y1 + 0.07, "door")
            em.box(s, at - 0.06, e, at + 0.06, y1, y1 + 0.07, "door")
            lz0 = at if interior_dir > 0 else at - w * 0.92
            lz1 = at + w * 0.92 if interior_dir > 0 else at
            em.box(s + 0.02, lz0, s + 0.06, lz1, 0.03, y1 - 0.02, "door")

    return blocks


# --------------------------------------------------------------------------- #
# Unit mesh
# --------------------------------------------------------------------------- #

def build_unit(writer: GlbWriter, mats: dict[str, int], mirror: bool):
    mb = MeshBuilder()
    em = Emitter(mb, mats, mirror)
    blocks: list = []

    # Floors and ceilings, per room.
    for room in P.ROOMS:
        for (x0, z0, x1, z1) in room["rects"]:
            em.box(x0, z0, x1, z1, -0.02, 0.0, room["floor"], faces="Y")
            if room["ceiling"]:
                em.box(x0, z0, x1, z1, P.CEIL, P.CEIL + 0.02, "ceiling", faces="y")

    for wall in P.WALLS:
        emit_wall(em, wall, blocks)

    # Furniture.
    for (x0, z0, x1, z1, y0, y1, mat, obstacle) in P.FURNITURE:
        em.box(x0, z0, x1, z1, y0, y1, mat)
        if obstacle:
            blocks.append(collision_rect(x0, z0, x1, z1, y0, max(y1, 0.9), mirror))

    # Planter foliage.
    em.box(7.65, 9.25, 8.15, 9.75, 0.55, 1.05, "foliage")

    name = "unit_2bhk_b" if mirror else "unit_2bhk_a"
    mesh = writer.mesh(name, mb)
    return mesh, blocks, mb.triangle_count()


def unit_tag_nodes(unit_key: str, level_id: str, mirror: bool, blocks: list,
                   hidden_box: int, hidden_quad: int) -> list[Node]:
    """Build the wv-tagged child nodes for one unit instance."""
    out: list[Node] = []
    scope = f"{level_id.lower()}.{unit_key.lower()}"

    def m_rect(x0, z0, x1, z1):
        if mirror:
            x0, x1 = P.UNIT_W - x1, P.UNIT_W - x0
        return min(x0, x1), z0, max(x0, x1), z1

    # ZONE volumes + NAV_FLOOR per rect.
    for room in P.ROOMS:
        xs = [r[0] for r in room["rects"]] + [r[2] for r in room["rects"]]
        zs = [r[1] for r in room["rects"]] + [r[3] for r in room["rects"]]
        zx0, zz0, zx1, zz1 = m_rect(min(xs), min(zs), max(xs), max(zs))
        area = round(sum((r[2] - r[0]) * (r[3] - r[1]) for r in room["rects"]), 2)

        zone_id = f"{scope}.{room['id']}"
        zone = Node(
            name=f"WV_ZONE__{zone_id}",
            mesh=hidden_box,
            translation=(zx0, 0.0, zz0),
            scale=(zx1 - zx0, P.CEIL, zz1 - zz0),
            extras={"wv": {
                "type": "ZONE", "id": zone_id, "label": room["label"],
                "category": room["category"], "area": area,
                "level": level_id, "parent": f"{scope}",
            }},
        )
        out.append(zone)

        for i, r in enumerate(room["rects"]):
            fx0, fz0, fx1, fz1 = m_rect(*r)
            inset = 0.06
            out.append(Node(
                name=f"WV_NAV_FLOOR__{zone_id}.{i}",
                mesh=hidden_quad,
                translation=(fx0 + inset, 0.005, fz0 + inset),
                scale=(max(0.01, fx1 - fx0 - 2 * inset), 1.0, max(0.01, fz1 - fz0 - 2 * inset)),
                extras={"wv": {"type": "NAV_FLOOR", "id": f"{zone_id}.nav{i}",
                               "surface": "exterior" if room["category"] == "balcony" else "interior",
                               "zone": zone_id, "level": level_id}},
            ))

    # PORTALs.
    for p in P.PORTALS:
        s, e = p["s"], p["e"]
        if p["axis"] == "x":
            at = P.UNIT_W - p["at"] if mirror else p["at"]
            tx, tz, sx, sz = at - 0.08, s, 0.16, e - s
        else:
            at = p["at"]
            ms, me = (P.UNIT_W - e, P.UNIT_W - s) if mirror else (s, e)
            tx, tz, sx, sz = ms, at - 0.08, me - ms, 0.16
        conn = [c if c == "corridor" else f"{scope}.{c}" for c in p["connects"]]
        if "corridor" in conn:
            conn = [f"{level_id.lower()}.corridor" if c == "corridor" else c for c in conn]
        out.append(Node(
            name=f"WV_PORTAL__{scope}.{p['id']}",
            mesh=hidden_box,
            translation=(tx, 0.0, tz),
            scale=(sx, P.DOOR_H, sz),
            extras={"wv": {"type": "PORTAL", "id": f"{scope}.{p['id']}",
                           "connects": conn, "door": "open", "level": level_id}},
        ))

    # Collision volumes.
    for i, (bx0, by0, bz0, bx1, by1, bz1) in enumerate(blocks):
        out.append(Node(
            name=f"WV_NAV_BLOCK__{scope}.{i}",
            mesh=hidden_box,
            translation=(bx0, by0, bz0),
            scale=(max(0.01, bx1 - bx0), max(0.01, by1 - by0), max(0.01, bz1 - bz0)),
            extras={"wv": {"type": "NAV_BLOCK", "id": f"{scope}.blk{i}", "level": level_id}},
        ))

    # POIs.
    for poi in P.POIS:
        px, py, pz = poi["pos"]
        if mirror:
            px = P.UNIT_W - px
        pid = f"{scope}.{poi['id']}"
        out.append(Node(
            name=f"WV_POI__{pid}",
            translation=(px, py, pz),
            extras={"wv": {
                "type": "POI", "id": pid, "label": poi["label"],
                "level": level_id, "zone": f"{scope}.{poi['zone']}",
                "panel": {"body": poi["body"], "fields": poi["fields"]},
                "anchor": {"offset": [0, 0, 0]},
            }},
        ))

    # Guided tour through the unit.
    tour_stops = [
        ("foyer",   (4.6, 1.60, 0.9),  "Entry foyer",        2.5),
        ("living",  (2.4, 1.60, 3.4),  "L-shaped living",    4.0),
        ("dining",  (1.9, 1.60, 1.2),  "Dining arm",         3.0),
        ("kitchen", (6.9, 1.60, 2.0),  "Modular kitchen",    3.5),
        ("bed2",    (6.9, 1.60, 6.2),  "Bedroom 2",          3.0),
        ("sundeck", (7.0, 1.60, 8.9),  "Sundeck",            3.5),
        ("mbed",    (1.9, 1.60, 8.3),  "Master bedroom",     4.0),
    ]
    tour = Node(
        name=f"WV_CAM_TOUR__{scope}.walkthrough",
        extras={"wv": {"type": "CAM_TOUR", "id": f"{scope}.walkthrough",
                       "label": "Unit walkthrough", "loop": False, "level": level_id}},
    )
    for order, (key, pos, label, dwell) in enumerate(tour_stops):
        px, py, pz = pos
        if mirror:
            px = P.UNIT_W - px
        tour.add(Node(
            name=f"WV_CAM_KEY__{scope}.{key}",
            translation=(px, py, pz),
            extras={"wv": {"type": "CAM_KEY", "id": f"{scope}.tour.{key}",
                           "order": order, "label": label, "dwell": dwell}},
        ))
    out.append(tour)

    return out


# --------------------------------------------------------------------------- #
# Common areas: corridor, core, lifts, stair
# --------------------------------------------------------------------------- #

VOID_X0, VOID_Z0 = P.CORE_X0 + 0.30, 2.50
VOID_X1, VOID_Z1 = P.CORE_X1, P.CORE_Z1


def slab_with_void(em: Emitter, x0, z0, x1, z1, y0, y1, mat, faces="xXyYzZ"):
    """Emit a slab as up to four pieces around the stairwell opening.

    Without this the flight climbs straight through the floor above it, and the
    ground probe snaps the player up a storey mid-stair.
    """
    vx0, vz0 = max(x0, VOID_X0), max(z0, VOID_Z0)
    vx1, vz1 = min(x1, VOID_X1), min(z1, VOID_Z1)
    if vx0 >= vx1 or vz0 >= vz1:
        em.box(x0, z0, x1, z1, y0, y1, mat, faces)
        return
    if z0 < vz0:
        em.box(x0, z0, x1, vz0, y0, y1, mat, faces)
    if vz1 < z1:
        em.box(x0, vz1, x1, z1, y0, y1, mat, faces)
    if x0 < vx0:
        em.box(x0, vz0, vx0, vz1, y0, y1, mat, faces)
    if vx1 < x1:
        em.box(vx1, vz0, x1, vz1, y0, y1, mat, faces)


def build_common(writer: GlbWriter, mats: dict[str, int], typical: bool):
    """Corridor + core for one floor. World space, origin at the building grid."""
    mb = MeshBuilder()
    em = Emitter(mb, mats, mirror=False)
    blocks: list = []

    def blk(x0, z0, x1, z1, y0, y1, mat, collide=True, faces="xXyYzZ"):
        em.box(x0, z0, x1, z1, y0, y1, mat, faces)
        if collide:
            blocks.append((x0, y0, z0, x1, y1, z1))

    cx0, cx1 = P.BLD_X0, P.BLD_X1
    cz0, cz1 = P.BLD_Z0, 0.0

    # Corridor slab and ceiling.
    em.box(cx0, cz0, cx1, cz1, -0.02, 0.0, "floor_tile", faces="Y")
    em.box(cx0, cz0, cx1, cz1, P.CEIL, P.CEIL + 0.02, "ceiling", faces="y")

    # Corridor outer wall (north side) with openings for daylight.
    blk(cx0, cz0 - 0.1, cx1, cz0, 0.0, 1.0, "wall_ext")
    blk(cx0, cz0 - 0.1, cx1, cz0, 2.2, P.CEIL, "wall_ext")
    for i in range(6):
        px = cx0 + 0.6 + i * 3.5
        blk(px, cz0 - 0.1, px + 0.18, cz0, 1.0, 2.2, "wall_ext")
    em.box(cx0, cz0 - 0.05, cx1, cz0 - 0.02, 1.0, 2.2, "glass", faces="xXyYzZ")

    # Corridor end walls.
    blk(cx0 - 0.2, cz0, cx0, cz1, 0.0, P.CEIL, "wall_ext")
    blk(cx1, cz0, cx1 + 0.2, cz1, 0.0, P.CEIL, "wall_ext")

    # Core walls (lift shaft + stair enclosure), open to the corridor.
    kx0, kx1, kz0, kz1 = P.CORE_X0, P.CORE_X1, P.CORE_Z0, P.CORE_Z1
    blk(kx0 - 0.1, kz0, kx0, kz1, 0.0, P.CEIL, "wall_int")
    blk(kx1, kz0, kx1 + 0.1, kz1, 0.0, P.CEIL, "wall_int")
    blk(kx0, kz1, kx1, kz1 + 0.1, 0.0, P.CEIL, "wall_int")
    slab_with_void(em, kx0, kz0, kx1, kz1, -0.02, 0.0, "floor_tile", faces="Y")
    slab_with_void(em, kx0, kz0, kx1, kz1, P.CEIL, P.CEIL + 0.02, "ceiling", faces="y")

    # Lift shaft wall and two lift doors facing the corridor.
    blk(kx0 + 0.3, 2.2, kx1 - 0.3, 2.3, 0.0, P.CEIL, "wall_int")
    for i, lx in enumerate((kx0 + 0.4, kx0 + 2.5)):
        em.box(lx, 2.18, lx + 1.8, 2.24, 0.0, 2.30, "lift")
        em.box(lx + 0.87, 2.16, lx + 0.93, 2.26, 0.0, 2.30, "wall_int")
        em.box(lx + 0.55, 2.10, lx + 0.75, 2.18, 1.05, 1.35, "signage")

    return writer.mesh("common_typical" if typical else "common_ground", mb), blocks, mb.triangle_count()


STAIR_X0 = P.CORE_X0 + 0.35
STAIR_X1 = P.CORE_X1 - 0.35
STAIR_Z0 = 2.55
STAIR_Z1 = P.CORE_Z1 - 0.15
STAIR_STEPS = 14


def build_stair(writer: GlbWriter, mats: dict[str, int]):
    """One flight, floor to floor. Instanced at every level including the ground,
    so the building is actually continuously walkable without teleporting."""
    mb = MeshBuilder()
    em = Emitter(mb, mats, mirror=False)
    blocks: list = []

    rise = P.FLOOR_H / STAIR_STEPS
    tread = (STAIR_X1 - STAIR_X0) / STAIR_STEPS
    for i in range(STAIR_STEPS):
        x = STAIR_X0 + i * tread
        em.box(x, STAIR_Z0, x + tread, STAIR_Z1, i * rise, (i + 1) * rise, "concrete")

    # Stringer wall on the corridor side, and a handrail, so you cannot walk off.
    em.box(STAIR_X0, STAIR_Z0 - 0.12, STAIR_X1, STAIR_Z0, 0.0, 1.0, "concrete")
    em.box(STAIR_X0, STAIR_Z0 - 0.14, STAIR_X1, STAIR_Z0 - 0.08, 0.95, 1.05, "railing")
    blocks.append((STAIR_X0, 0.0, STAIR_Z0 - 0.12, STAIR_X1, P.FLOOR_H, STAIR_Z0))

    # Arrival landing at the top of the flight.
    em.box(STAIR_X1, STAIR_Z0, STAIR_X1 + 0.5, STAIR_Z1, P.FLOOR_H - 0.02, P.FLOOR_H,
           "concrete", faces="Y")

    return writer.mesh("stair_flight", mb), blocks, mb.triangle_count()


def build_ground(writer: GlbWriter, mats: dict[str, int]):
    """Entrance lobby, stilt columns, plinth, and site context."""
    mb = MeshBuilder()
    em = Emitter(mb, mats, mirror=False)
    blocks: list = []

    def blk(x0, z0, x1, z1, y0, y1, mat, collide=True, faces="xXyYzZ"):
        em.box(x0, z0, x1, z1, y0, y1, mat, faces)
        if collide:
            blocks.append((x0, y0, z0, x1, y1, z1))

    # Site ground and approach.
    em.box(-60, -60, 80, 70, -0.30, -0.15, "ground", faces="Y")
    em.box(-14, -30, 36, P.BLD_Z1 + 14, -0.16, -0.14, "grass", faces="Y")
    em.box(-14, -22, 36, -14.0, -0.13, -0.12, "road", faces="Y")

    # Plinth.
    em.box(P.BLD_X0 - 1.4, P.BLD_Z0 - 1.4, P.BLD_X1 + 1.4, P.BLD_Z1 + 1.4,
           -0.15, 0.0, "concrete", faces="YxXzZ")

    # Lobby box.
    lx0, lx1 = 6.0, 15.4
    lz0, lz1 = P.BLD_Z0, 5.2
    em.box(lx0, lz0, lx1, lz1, -0.02, 0.0, "floor_tile", faces="Y")
    em.box(lx0, lz0, lx1, lz1, P.CEIL, P.CEIL + 0.02, "ceiling", faces="y")
    blk(lx0 - 0.2, lz0, lx0, lz1, 0.0, P.CEIL, "wall_ext")
    blk(lx1, lz0, lx1 + 0.2, lz1, 0.0, P.CEIL, "wall_ext")
    blk(lx0, lz1, lx1, lz1 + 0.2, 0.0, P.CEIL, "wall_int")

    # Entrance glazing with a doorway gap.
    blk(lx0, lz0 - 0.2, 9.6, lz0, 0.0, P.CEIL, "wall_ext")
    blk(12.0, lz0 - 0.2, lx1, lz0, 0.0, P.CEIL, "wall_ext")
    em.box(9.6, lz0 - 0.12, 12.0, lz0 - 0.06, 0.0, 2.4, "glass")
    em.box(9.6, lz0 - 0.2, 9.72, lz0, 0.0, 2.5, "railing")
    em.box(11.88, lz0 - 0.2, 12.0, lz0, 0.0, 2.5, "railing")
    em.box(9.6, lz0 - 0.2, 12.0, lz0, 2.4, P.CEIL, "wall_ext")

    # Reception desk and seating.
    blk(6.6, 1.4, 8.6, 2.3, 0.0, 1.05, "wood_dark")
    em.box(6.6, 1.4, 8.6, 2.3, 1.05, 1.12, "counter")
    blk(13.0, 0.6, 15.0, 1.4, 0.0, 0.42, "fabric")
    em.box(13.0, 0.6, 15.0, 1.4, 0.42, 0.85, "fabric", faces="xXyYzZ")
    blk(6.4, 3.4, 7.2, 4.2, 0.0, 0.9, "planter")
    em.box(6.35, 3.35, 7.25, 4.25, 0.9, 1.9, "foliage")

    # Signage.
    em.box(6.7, 1.36, 8.5, 1.40, 1.20, 1.55, "signage")

    # Stilt columns under the rest of the footprint.
    for gx in range(0, 6):
        for gz in range(0, 3):
            px = P.BLD_X0 + 0.6 + gx * 4.2
            pz = P.BLD_Z0 + 1.2 + gz * 4.4
            if lx0 - 0.6 < px < lx1 + 0.6 and lz0 - 0.6 < pz < lz1 + 0.6:
                continue
            blk(px, pz, px + 0.45, pz + 0.45, 0.0, P.FLOOR_H, "concrete")

    # Context massing so the sundeck has something to look at.
    for (cx, cz, w, d, h) in [(-46, -12, 16, 22, 21.0), (44, 2, 18, 20, 27.0),
                              (-30, 40, 22, 14, 15.0), (52, -34, 14, 16, 18.0)]:
        em.box(cx, cz, cx + w, cz + d, -0.15, h, "context")
        for f in range(1, int(h // 3.0)):
            em.box(cx - 0.03, cz + 0.4, cx + w + 0.03, cz + d - 0.4,
                   f * 3.0 + 0.9, f * 3.0 + 2.2, "glass", faces="xX")

    # Trees.
    for (tx, tz) in [(-6, 2), (-6, 9), (26, 1), (26, 8), (4, -8), (18, -8)]:
        em.box(tx - 0.12, tz - 0.12, tx + 0.12, tz + 0.12, -0.15, 2.2, "planter")
        em.box(tx - 1.3, tz - 1.3, tx + 1.3, tz + 1.3, 2.2, 4.6, "foliage")

    return writer.mesh("ground_lobby", mb), blocks, mb.triangle_count()


def build_facade(writer: GlbWriter, mats: dict[str, int]):
    """Per-floor slab band, emitted once and instanced at every level."""
    mb = MeshBuilder()
    em = Emitter(mb, mats, mirror=False)
    slab_with_void(em, P.BLD_X0 - 0.35, P.BLD_Z0 - 0.35, P.BLD_X1 + 0.35, P.BLD_Z1 + 0.35,
                   -P.SLAB, 0.0, "concrete")
    return writer.mesh("floor_band", mb), mb.triangle_count()


def build_roof(writer: GlbWriter, mats: dict[str, int]):
    mb = MeshBuilder()
    em = Emitter(mb, mats, mirror=False)
    blocks: list = []
    slab_with_void(em, P.BLD_X0 - 0.35, P.BLD_Z0 - 0.35, P.BLD_X1 + 0.35, P.BLD_Z1 + 0.35,
                   0.0, 0.12, "concrete")
    for (x0, z0, x1, z1) in [
        (P.BLD_X0 - 0.35, P.BLD_Z0 - 0.35, P.BLD_X1 + 0.35, P.BLD_Z0),
        (P.BLD_X0 - 0.35, P.BLD_Z1, P.BLD_X1 + 0.35, P.BLD_Z1 + 0.35),
        (P.BLD_X0 - 0.35, P.BLD_Z0, P.BLD_X0, P.BLD_Z1),
        (P.BLD_X1, P.BLD_Z0, P.BLD_X1 + 0.35, P.BLD_Z1),
    ]:
        em.box(x0, z0, x1, z1, 0.12, 1.05, "wall_ext")
    # Parapet around the stairwell opening, open on the arrival side.
    for (x0, z0, x1, z1) in [
        (VOID_X0 - 0.12, VOID_Z0 - 0.12, VOID_X1, VOID_Z0),
        (VOID_X0 - 0.12, VOID_Z1, VOID_X1, VOID_Z1 + 0.12),
        (VOID_X0 - 0.12, VOID_Z0, VOID_X0, VOID_Z1),
    ]:
        em.box(x0, z0, x1, z1, 0.12, 1.05, "wall_ext")
        blocks.append((x0, 0.12, z0, x1, 1.05, z1))

    # Lift machine room sits over the shaft only, clear of the stair head.
    em.box(P.CORE_X0, P.CORE_Z0, P.CORE_X1, 2.30, 0.12, 2.6, "concrete")
    blocks.append((P.CORE_X0, 0.12, P.CORE_Z0, P.CORE_X1, 2.6, 2.30))
    em.box(2.0, 4.0, 5.0, 7.0, 0.12, 1.8, "concrete")
    blocks.append((2.0, 0.12, 4.0, 5.0, 1.8, 7.0))
    return writer.mesh("roof", mb), blocks, mb.triangle_count()


# --------------------------------------------------------------------------- #
# Assembly
# --------------------------------------------------------------------------- #

def main(out_path: str):
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    w = GlbWriter()
    mats = {k: w.material(v) for k, v in PALETTE.items()}

    # Shared primitive meshes used by every invisible tag volume.
    ub = MeshBuilder()
    ub.box((0, 0, 0), (1, 1, 1), mats["wv_hidden"])
    hidden_box = w.mesh("__wv_unit_box", ub)

    uq = MeshBuilder()
    uq.quad((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1), mats["wv_hidden"])
    hidden_quad = w.mesh("__wv_unit_quad", uq)

    mesh_a, blocks_a, tris_a = build_unit(w, mats, mirror=False)
    mesh_b, blocks_b, tris_b = build_unit(w, mats, mirror=True)
    mesh_common, blocks_common, tris_common = build_common(w, mats, typical=True)
    mesh_stair, blocks_stair, tris_stair = build_stair(w, mats)
    mesh_ground, blocks_ground, tris_ground = build_ground(w, mats)
    mesh_band, tris_band = build_facade(w, mats)
    mesh_roof, blocks_roof, tris_roof = build_roof(w, mats)

    root = Node(name="WalkthroughVisualizer_Scene", extras={"wv": {
        "type": "PROJECT",
        "id": "kp-tower",
        "label": "Aster Residences — Tower B",
        "preset": "archviz",
        "schema": "0.1",
        "units": "metres",
        "up": "+Y",
    }})

    site = root.add(Node(name="Site"))
    site.add(Node(name="ground_lobby_geo", mesh=mesh_ground))

    unit_meta = {
        "A": {"mesh": mesh_a, "blocks": blocks_a, "mirror": False,
              "origin": (13.4, 0.0), "label": "Unit A"},
        "B": {"mesh": mesh_b, "blocks": blocks_b, "mirror": True,
              "origin": (0.0, 0.0), "label": "Unit B"},
    }

    stats_units = 0
    for li, lv in enumerate(P.LEVELS):
        level = root.add(Node(
            name=f"WV_LEVEL__{lv['id']}",
            translation=(0.0, lv["elev"], 0.0),
            extras={"wv": {"type": "LEVEL", "id": lv["id"], "label": lv["label"],
                           "elevation": lv["elev"]}},
        ))
        level.add(Node(name=f"{lv['id']}_band", mesh=mesh_band))
        level.add(Node(name=f"{lv['id']}_stair", mesh=mesh_stair))
        level.add(Node(
            name=f"WV_NAV_FLOOR__{lv['id'].lower()}.stair", mesh=hidden_quad,
            translation=(STAIR_X0, 0.02, STAIR_Z0),
            scale=(STAIR_X1 - STAIR_X0, 1.0, STAIR_Z1 - STAIR_Z0),
            extras={"wv": {"type": "NAV_FLOOR", "id": f"{lv['id'].lower()}.stair.nav",
                           "surface": "stair", "level": lv["id"]}},
        ))
        for i, (bx0, by0, bz0, bx1, by1, bz1) in enumerate(blocks_stair):
            level.add(Node(
                name=f"WV_NAV_BLOCK__{lv['id'].lower()}.s{i}", mesh=hidden_box,
                translation=(bx0, by0, bz0),
                scale=(max(0.01, bx1 - bx0), max(0.01, by1 - by0), max(0.01, bz1 - bz0)),
                extras={"wv": {"type": "NAV_BLOCK", "id": f"{lv['id'].lower()}.sblk{i}",
                               "level": lv["id"]}},
            ))

        if not lv["units"]:
            # Ground: lobby zones live here; the geometry sits under Site.
            for zid, zlabel, cat, rect in [
                ("lobby", "Entrance Lobby", "amenity", (6.2, -1.9, 15.2, 5.0)),
                ("liftlobby", "Lift Lobby", "circulation",
                 (P.CORE_X0, P.CORE_Z0, P.CORE_X1, P.CORE_Z1)),
            ]:
                x0, z0, x1, z1 = rect
                full = f"{lv['id'].lower()}.{zid}"
                level.add(Node(
                    name=f"WV_ZONE__{full}", mesh=hidden_box,
                    translation=(x0, 0.0, z0), scale=(x1 - x0, P.CEIL, z1 - z0),
                    extras={"wv": {"type": "ZONE", "id": full, "label": zlabel,
                                   "category": cat, "level": lv["id"],
                                   "area": round((x1 - x0) * (z1 - z0), 1)}},
                ))
                level.add(Node(
                    name=f"WV_NAV_FLOOR__{full}", mesh=hidden_quad,
                    translation=(x0 + 0.1, 0.005, z0 + 0.1),
                    scale=(x1 - x0 - 0.2, 1.0, z1 - z0 - 0.2),
                    extras={"wv": {"type": "NAV_FLOOR", "id": f"{full}.nav",
                                   "zone": full, "level": lv["id"], "surface": "interior"}},
                ))
            level.add(Node(
                name="WV_POI__l00.reception", translation=(7.6, 1.5, 2.9),
                extras={"wv": {"type": "POI", "id": "l00.reception", "label": "Reception",
                               "level": "L00", "zone": "l00.lobby",
                               "panel": {"body": "Staffed 24 hours. Visitor register, "
                                                 "intercom to every flat, and parcel lockers.",
                                         "fields": {"Hours": "24 x 7", "Lifts": "2 x 8 passenger"}}}},
            ))
            for i, (bx0, by0, bz0, bx1, by1, bz1) in enumerate(blocks_ground):
                level.add(Node(
                    name=f"WV_NAV_BLOCK__l00.{i}", mesh=hidden_box,
                    translation=(bx0, by0, bz0),
                    scale=(max(0.01, bx1 - bx0), max(0.01, by1 - by0), max(0.01, bz1 - bz0)),
                    extras={"wv": {"type": "NAV_BLOCK", "id": f"l00.blk{i}", "level": "L00"}},
                ))
            continue

        # Typical floor: corridor + core geometry, then the two units.
        level.add(Node(name=f"{lv['id']}_common", mesh=mesh_common))
        cor_id = f"{lv['id'].lower()}.corridor"
        level.add(Node(
            name=f"WV_ZONE__{cor_id}", mesh=hidden_box,
            translation=(P.BLD_X0, 0.0, P.BLD_Z0),
            scale=(P.BLD_X1 - P.BLD_X0, P.CEIL, P.CORRIDOR_D),
            extras={"wv": {"type": "ZONE", "id": cor_id, "label": "Corridor",
                           "category": "circulation", "level": lv["id"]}},
        ))
        level.add(Node(
            name=f"WV_NAV_FLOOR__{cor_id}", mesh=hidden_quad,
            translation=(P.BLD_X0 + 0.1, 0.005, P.BLD_Z0 + 0.1),
            scale=(P.BLD_X1 - P.BLD_X0 - 0.2, 1.0, P.CORRIDOR_D - 0.3),
            extras={"wv": {"type": "NAV_FLOOR", "id": f"{cor_id}.nav", "zone": cor_id,
                           "level": lv["id"], "surface": "interior"}},
        ))
        core_id = f"{lv['id'].lower()}.liftlobby"
        level.add(Node(
            name=f"WV_ZONE__{core_id}", mesh=hidden_box,
            translation=(P.CORE_X0, 0.0, P.CORE_Z0),
            scale=(P.CORE_X1 - P.CORE_X0, P.CEIL, P.CORE_Z1 - P.CORE_Z0),
            extras={"wv": {"type": "ZONE", "id": core_id, "label": "Lift Lobby",
                           "category": "circulation", "level": lv["id"]}},
        ))
        level.add(Node(
            name=f"WV_NAV_FLOOR__{core_id}", mesh=hidden_quad,
            translation=(P.CORE_X0 + 0.1, 0.005, P.CORE_Z0 + 0.1),
            scale=(P.CORE_X1 - P.CORE_X0 - 0.2, 1.0, 2.0),
            extras={"wv": {"type": "NAV_FLOOR", "id": f"{core_id}.nav", "zone": core_id,
                           "level": lv["id"], "surface": "interior"}},
        ))
        for i, (bx0, by0, bz0, bx1, by1, bz1) in enumerate(blocks_common):
            level.add(Node(
                name=f"WV_NAV_BLOCK__{lv['id'].lower()}.c{i}", mesh=hidden_box,
                translation=(bx0, by0, bz0),
                scale=(max(0.01, bx1 - bx0), max(0.01, by1 - by0), max(0.01, bz1 - bz0)),
                extras={"wv": {"type": "NAV_BLOCK", "id": f"{lv['id'].lower()}.cblk{i}",
                               "level": lv["id"]}},
            ))

        for key, meta in unit_meta.items():
            ox, oz = meta["origin"]
            flat_no = f"{li}0{1 if key == 'A' else 2}"
            unit_id = f"{lv['id'].lower()}.{key.lower()}"
            # The unit node is a plain group. Its ZONE volume is a sibling of the
            # geometry, never its parent — a tag must never own real geometry.
            unit = level.add(Node(name=f"UNIT_{lv['id']}_{key}", translation=(ox, 0.0, oz)))
            unit.add(Node(name=f"{unit_id}_geo", mesh=meta["mesh"]))
            unit.add(Node(
                name=f"WV_ZONE__{unit_id}", mesh=hidden_box,
                translation=(0.0, 0.0, 0.0), scale=(P.UNIT_W, P.CEIL, P.UNIT_D),
                extras={"wv": {
                    "type": "ZONE", "id": unit_id,
                    "label": f"Flat {flat_no} — 2 BHK",
                    "category": "unit", "level": lv["id"],
                    "area": 78.3, "tags": ["2bhk", "type-a" if key == "A" else "type-a-mirror"],
                }},
            ))
            for n in unit_tag_nodes(key, lv["id"], meta["mirror"], meta["blocks"],
                                    hidden_box, hidden_quad):
                unit.add(n)
            stats_units += 1

    roof = root.add(Node(name="WV_LEVEL__ROOF",
                         translation=(0.0, P.LEVELS[-1]["elev"] + P.FLOOR_H, 0.0),
                         extras={"wv": {"type": "LEVEL", "id": "ROOF", "label": "Terrace",
                                        "elevation": P.LEVELS[-1]["elev"] + P.FLOOR_H}}))
    roof.add(Node(name="roof_geo", mesh=mesh_roof))
    roof.add(Node(
        name="WV_ZONE__roof.terrace", mesh=hidden_box,
        translation=(P.BLD_X0, 0.12, P.BLD_Z0), scale=(P.BLD_X1 - P.BLD_X0, 2.4, P.BLD_Z1 - P.BLD_Z0),
        extras={"wv": {"type": "ZONE", "id": "roof.terrace", "label": "Terrace",
                       "category": "amenity", "level": "ROOF"}},
    ))
    roof.add(Node(
        name="WV_NAV_FLOOR__roof.terrace", mesh=hidden_quad,
        translation=(P.BLD_X0, 0.14, P.BLD_Z0), scale=(P.BLD_X1 - P.BLD_X0, 1.0, P.BLD_Z1 - P.BLD_Z0),
        extras={"wv": {"type": "NAV_FLOOR", "id": "roof.terrace.nav", "zone": "roof.terrace",
                       "level": "ROOF", "surface": "exterior"}},
    ))
    roof.add(Node(
        name="WV_POI__roof.view", translation=(6.0, 1.6, 6.0),
        extras={"wv": {"type": "POI", "id": "roof.view", "label": "Terrace",
                       "level": "ROOF", "zone": "roof.terrace",
                       "panel": {"body": "Common terrace at 12 m. Overhead tanks and the lift "
                                         "machine room sit over the shaft; the rest is open deck.",
                                 "fields": {"Level": "+12.00 m", "Access": "Stair only"}}}},
    ))
    for i, (bx0, by0, bz0, bx1, by1, bz1) in enumerate(blocks_roof):
        roof.add(Node(
            name=f"WV_NAV_BLOCK__roof.{i}", mesh=hidden_box,
            translation=(bx0, by0, bz0),
            scale=(max(0.01, bx1 - bx0), max(0.01, by1 - by0), max(0.01, bz1 - bz0)),
            extras={"wv": {"type": "NAV_BLOCK", "id": f"roof.blk{i}", "level": "ROOF"}},
        ))

    stats = w.write(str(out), root, asset_extras={"wv": {"generator": "modelgen 0.1"}})
    stats["flats"] = stats_units
    stats["unit_tris"] = tris_a
    print(json.dumps(stats, indent=2))
    print(f"\nwrote {out}  ({out.stat().st_size / 1024 / 1024:.2f} MB)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "../../content/kp-tower/scene.glb")
