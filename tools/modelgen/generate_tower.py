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

from glbwriter import GlbWriter, Surface, MeshBuilder, Node
import plan as P


# --------------------------------------------------------------------------- #
# Surfaces and finishes
#
# A surface is a real material: one texture set, one glTF material. A finish is
# a named use of a surface plus a tint, and the tint goes to vertex colours. Do
# it the other way round and thirty finishes become thirty materials, which is
# thirty draw calls the merge pass cannot touch.
# --------------------------------------------------------------------------- #

def hexc(h: str, a: float = 1.0):
    h = h.lstrip("#")
    return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255, a)


SURFACES = {
    # name        texture set   metres per repeat
    "plaster":  Surface("plaster",  tex="plaster",  uv_scale=2.4, normal_scale=0.6),
    "tile":     Surface("tile",     tex="tile",     uv_scale=3.2, normal_scale=0.8),
    "timber":   Surface("timber",   tex="timber",   uv_scale=2.4, normal_scale=0.7),
    "granite":  Surface("granite",  tex="granite",  uv_scale=1.2, normal_scale=0.5),
    "concrete": Surface("concrete", tex="concrete", uv_scale=3.0, normal_scale=0.7),
    "fabric":   Surface("fabric",   tex="fabric",   uv_scale=0.8, normal_scale=0.5),
    "metal":    Surface("metal",    tex="metal",    uv_scale=0.6, metallic=1.0, normal_scale=0.4),
    "deck":     Surface("deck",     tex="deck",     uv_scale=2.4, normal_scale=0.8),
    "foliage":  Surface("foliage",  tex="foliage",  uv_scale=1.0, normal_scale=0.9,
                        double_sided=True),
    "turf":     Surface("turf",     tex="turf",     uv_scale=4.0, normal_scale=0.6),
    "asphalt":  Surface("asphalt",  tex="asphalt",  uv_scale=4.0, normal_scale=0.6),
    "glass":    Surface("glass",    tex=None, uv_scale=1.0, color=(1, 1, 1, 0.28),
                        roughness=0.06, double_sided=True),
    "hidden":   Surface("wv_hidden", tex=None, uv_scale=1.0, color=(1, 1, 1, 0.0),
                        double_sided=True),
}

# finish name -> (surface, tint hex, alpha)
FINISH = {
    "wall_int":      ("plaster",  "E9E4DA"),
    "wall_ext":      ("plaster",  "C8BFAF"),
    "wall_corridor": ("plaster",  "DCD7CC"),
    "ceiling":       ("plaster",  "F3F0EA"),
    "floor_tile":    ("tile",     "E6E1D7"),
    "floor_wood":    ("timber",   "CDC6BA"),
    "floor_bath":    ("tile",     "C6CED0"),
    "floor_deck":    ("deck",     "BCB5A8"),
    "glass":         ("glass",    "A8C8DA", 0.28),
    "railing":       ("metal",    "8A9296"),
    "door":          ("timber",   "BAB2A6"),
    "counter":       ("granite",  "FFFFFF"),
    "cabinet":       ("plaster",  "CFC8B9"),
    "wood_furn":     ("timber",   "DAD3C8"),
    "wood_dark":     ("timber",   "70675C"),
    "fabric":        ("fabric",   "7E9497"),
    "linen":         ("fabric",   "F2EEE6"),
    "linen_alt":     ("fabric",   "CBD3CE"),
    "steel":         ("metal",    "C6CCCF"),
    "screen":        ("metal",    "26292B"),
    "ceramic":       ("tile",     "FBFBF8"),
    "appliance":     ("metal",    "E6E8E6"),
    "planter":       ("concrete", "8A7A63"),
    "foliage":       ("foliage",  "FFFFFF"),
    "concrete":      ("concrete", "B6B3AB"),
    "ground":        ("turf",     "9AA184"),
    "grass":         ("turf",     "FFFFFF"),
    "road":          ("asphalt",  "FFFFFF"),
    "context":       ("concrete", "AAB0B4"),
    "lift":          ("metal",    "9CA3A7"),
    "signage":       ("plaster",  "C4341F"),
    "wv_hidden":     ("hidden",   "FF00FF", 0.0),
}


def build_finishes(writer: GlbWriter) -> dict:
    """Register every surface once, and resolve each finish to (index, tint, scale)."""
    idx = {name: writer.surface(s) for name, s in SURFACES.items()}
    out = {}
    for finish, spec in FINISH.items():
        surf_name, tint = spec[0], spec[1]
        alpha = spec[2] if len(spec) > 2 else 1.0
        surf = SURFACES[surf_name]
        out[finish] = (idx[surf_name], hexc(tint, alpha), surf.uv_scale)
    return out


# --------------------------------------------------------------------------- #
# Emitter: unit-local geometry with optional x-mirror
# --------------------------------------------------------------------------- #

class Emitter:
    def __init__(self, mb: MeshBuilder, fin: dict, mirror: bool = False):
        self.mb = mb
        self.fin = fin
        self.mirror = mirror

    def mx(self, x: float) -> float:
        return (P.UNIT_W - x) if self.mirror else x

    def box(self, x0, z0, x1, z1, y0, y1, finish: str, faces: str = "xXyYzZ"):
        ax, bx = self.mx(x0), self.mx(x1)
        surf, tint, uvs = self.fin[finish]
        self.mb.box((min(ax, bx), y0, z0), (max(ax, bx), y1, z1),
                    surf, faces, uv_scale=uvs, color=tint)


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

    Visual and collision spans are built by separate passes. A window is a hole
    you can see through but not walk through, so the drawing breaks around its
    sill and lintel while collision stays one unbroken span. Doors and open
    balcony edges are the only openings that break the collision line.
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
            # Reveal returns. Without them the opening reads as a decal
            # painted on a flat wall.
            draw(s, s + 0.02, y0, y1, mat)
            draw(e - 0.02, e, y0, y1, mat)
            continue

        # Door: two jambs, a head, and a leaf swung open into the room.
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

def build_unit(writer: GlbWriter, fin: dict, mirror: bool):
    mb = MeshBuilder()
    em = Emitter(mb, fin, mirror)
    blocks: list = []

    # Floors and ceilings, per room.
    for room in P.ROOMS:
        for (x0, z0, x1, z1) in room["rects"]:
            # Sides as well as the top: the floor finish is a 20 mm layer over
            # the structural slab, and on a balcony you see its edge.
            em.box(x0, z0, x1, z1, -0.02, 0.0, room["floor"], faces="YxXzZ")
            if room["ceiling"]:
                em.box(x0, z0, x1, z1, P.CEIL - 0.035, P.CEIL - 0.015, "ceiling", faces="y")

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
        # Namespaced under .poi so a POI id cannot collide with the ZONE it
        # sits in. Ids are unique scene-wide, which is what the deep-link URLs
        # depend on.
        pid = f"{scope}.poi.{poi['id']}"
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


def build_common(writer: GlbWriter, fin: dict, typical: bool):
    """Corridor + core for one floor. World space, origin at the building grid."""
    mb = MeshBuilder()
    em = Emitter(mb, fin, mirror=False)
    blocks: list = []

    def blk(x0, z0, x1, z1, y0, y1, mat, collide=True, faces="xXyYzZ"):
        em.box(x0, z0, x1, z1, y0, y1, mat, faces)
        if collide:
            blocks.append((x0, y0, z0, x1, y1, z1))

    cx0, cx1 = P.BLD_X0, P.BLD_X1
    cz0, cz1 = P.BLD_Z0, 0.0

    # Corridor slab and ceiling.
    em.box(cx0, cz0, cx1, cz1, -0.02, 0.0, "floor_tile", faces="YxXzZ")
    em.box(cx0, cz0, cx1, cz1, P.CEIL - 0.035, P.CEIL - 0.015, "ceiling", faces="y")

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

    # Core walls (lift shaft plus stair enclosure), open to the corridor.
    #
    # On a typical floor the side walls sit inside the flats' party walls, which
    # occupy the same 100 mm and are the face you actually see from the living
    # room. Emitting the outer face here too puts two surfaces on one plane, so
    # the buried face is dropped and the box stays for collision. The ground
    # floor has no flats either side and the lobby looks straight at these
    # walls, so there they keep every face.
    kx0, kx1, kz0, kz1 = P.CORE_X0, P.CORE_X1, P.CORE_Z0, P.CORE_Z1
    west = "XyYzZ" if typical else "xXyYzZ"
    east = "xyYzZ" if typical else "xXyYzZ"
    blk(kx0 - 0.1, kz0, kx0, kz1, 0.0, P.CEIL, "wall_int", faces=west)
    blk(kx1, kz0, kx1 + 0.1, kz1, 0.0, P.CEIL, "wall_int", faces=east)
    blk(kx0, kz1, kx1, kz1 + 0.1, 0.0, P.CEIL, "wall_int")
    slab_with_void(em, kx0, kz0, kx1, kz1, -0.02, 0.0, "floor_tile", faces="Y")
    slab_with_void(em, kx0, kz0, kx1, kz1, P.CEIL - 0.035, P.CEIL - 0.015, "ceiling", faces="y")

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


def build_stair(writer: GlbWriter, fin: dict):
    """One flight, floor to floor. Instanced at every level, ground included,
    so the whole building is walkable without a teleport between storeys."""
    mb = MeshBuilder()
    em = Emitter(mb, fin, mirror=False)
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


def build_ground(writer: GlbWriter, fin: dict):
    """Entrance lobby, stilt columns, plinth, and site context."""
    mb = MeshBuilder()
    em = Emitter(mb, fin, mirror=False)
    blocks: list = []

    def blk(x0, z0, x1, z1, y0, y1, mat, collide=True, faces="xXyYzZ"):
        em.box(x0, z0, x1, z1, y0, y1, mat, faces)
        if collide:
            blocks.append((x0, y0, z0, x1, y1, z1))

    # Site ground and approach. Three planes over the same footprint, spaced
    # 100 mm apart instead of the few millimetres a CAD section would use. At
    # 60 m out the depth buffer cannot separate planes a few millimetres apart
    # and they strobe. 100 mm is invisible from eye height and survives
    # position quantisation in the wv build.
    em.box(-60, -60, 80, 70, -0.40, -0.30, "ground", faces="Y")
    em.box(-14, -30, 36, P.BLD_Z1 + 14, -0.30, -0.20, "grass", faces="Y")
    em.box(-14, -22, 36, -14.0, -0.20, -0.10, "road", faces="Y")

    # Plinth. Its top stops 60 mm below finish floor level: the structural slab
    # sits at -20 mm and the floor finish on top of that, so the three surfaces
    # that cover this footprint each get their own plane.
    em.box(P.BLD_X0 - 1.4, P.BLD_Z0 - 1.4, P.BLD_X1 + 1.4, P.BLD_Z1 + 1.4,
           -0.30, -0.06, "concrete", faces="YxXzZ")

    # Lobby box. The floor and ceiling start at z = 0 because build_common
    # already lays both across the full corridor strip behind the entrance;
    # running the lobby slab back to the entrance line would put two coplanar
    # 19 m2 planes on top of each other.
    lx0, lx1 = 6.0, 15.4
    lz0, lz1 = P.BLD_Z0, 5.2
    em.box(lx0, 0.0, lx1, lz1, -0.02, 0.0, "floor_tile", faces="YxXzZ")
    em.box(lx0, 0.0, lx1, lz1, P.CEIL - 0.035, P.CEIL - 0.015, "ceiling", faces="y")
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


def build_facade(writer: GlbWriter, fin: dict):
    """Per-floor slab band, emitted once and instanced at every level.

    Slab top is at -20 mm. Every room lays its floor finish over the same
    footprint with the top at 0, and two planes at one height do not resolve:
    the whole floor plate shimmers as you walk it. 20 mm is the real screed
    thickness, so nothing is given up by leaving the gap in.
    """
    mb = MeshBuilder()
    em = Emitter(mb, fin, mirror=False)
    slab_with_void(em, P.BLD_X0 - 0.35, P.BLD_Z0 - 0.35, P.BLD_X1 + 0.35, P.BLD_Z1 + 0.35,
                   -P.SLAB, -0.02, "concrete")
    return writer.mesh("floor_band", mb), mb.triangle_count()


def build_roof(writer: GlbWriter, fin: dict):
    mb = MeshBuilder()
    em = Emitter(mb, fin, mirror=False)
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

    w = GlbWriter(tex_dir="tex")
    fin = build_finishes(w)
    hidden_surf, hidden_tint, _ = fin["wv_hidden"]

    # Shared primitive meshes used by every invisible tag volume.
    ub = MeshBuilder()
    ub.box((0, 0, 0), (1, 1, 1), hidden_surf, color=hidden_tint)
    hidden_box = w.mesh("__wv_unit_box", ub)

    uq = MeshBuilder()
    uq.quad((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1), hidden_surf, color=hidden_tint)
    hidden_quad = w.mesh("__wv_unit_quad", uq)

    mesh_a, blocks_a, tris_a = build_unit(w, fin, mirror=False)
    mesh_b, blocks_b, tris_b = build_unit(w, fin, mirror=True)
    mesh_common, blocks_common, tris_common = build_common(w, fin, typical=True)
    mesh_stair, blocks_stair, tris_stair = build_stair(w, fin)
    mesh_ground, blocks_ground, tris_ground = build_ground(w, fin)
    mesh_band, tris_band = build_facade(w, fin)
    mesh_roof, blocks_roof, tris_roof = build_roof(w, fin)

    root = Node(name="WalkthroughVisualizer_Scene", extras={"wv": {
        "type": "PROJECT",
        "id": "kp-tower",
        "label": "Template Project",
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
            # The unit node is a plain group and its ZONE volume goes in as a
            # sibling of the geometry. Hang real geometry off a tagged node and
            # bakeTagVolumes in the wv build clears its mesh along with the
            # placeholder box.
            unit = level.add(Node(name=f"UNIT_{lv['id']}_{key}", translation=(ox, 0.0, oz)))
            unit.add(Node(name=f"{unit_id}_geo", mesh=meta["mesh"]))
            unit.add(Node(
                name=f"WV_ZONE__{unit_id}", mesh=hidden_box,
                translation=(0.0, 0.0, 0.0), scale=(P.UNIT_W, P.CEIL, P.UNIT_D),
                extras={"wv": {
                    "type": "ZONE", "id": unit_id,
                    "label": f"Flat {flat_no} (2 BHK)",
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
