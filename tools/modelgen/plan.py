"""The 2BHK unit plan and building massing, as data.

Everything here is metres. Unit-local space is x 0->8.4 (width), z 0->10.0
(depth from the corridor), y 0 at finished floor level.

Layout follows Pune developer typology (Kolte Patil Western Avenue 2BHK as the
reference): L-shaped living with a separate dining arm, master bedroom with
attached bath and cupboard niche, kitchen with an adjoining dry balcony, and a
sundeck off the second bedroom.
"""

# --------------------------------------------------------------------------- #
# Dimensions
# --------------------------------------------------------------------------- #

UNIT_W = 8.4          # x extent of one unit
UNIT_D = 10.0         # z extent of one unit
CEIL = 2.75           # finished floor to ceiling
SLAB = 0.25           # structural slab
FLOOR_H = CEIL + SLAB  # 3.0 floor-to-floor
W_EXT = 0.20
W_INT = 0.10

DOOR_H = 2.10
WIN_SILL = 0.90
WIN_HEAD = 2.30
HIGH_SILL = 1.50      # bathroom / ventilator
RAIL_H = 1.05

# Building grid
CORRIDOR_D = 2.0                    # z -2.0 -> 0.0
CORE_X0, CORE_X1 = 8.4, 13.4
CORE_Z0, CORE_Z1 = 0.0, 4.4
BLD_X0, BLD_X1 = 0.0, 21.8
BLD_Z0, BLD_Z1 = -CORRIDOR_D, UNIT_D

LEVELS = [
    {"id": "L00", "label": "Ground Floor",   "elev": 0.0, "units": False},
    {"id": "L01", "label": "First Floor",    "elev": 3.0, "units": True},
    {"id": "L02", "label": "Second Floor",   "elev": 6.0, "units": True},
    {"id": "L03", "label": "Third Floor",    "elev": 9.0, "units": True},
]

# --------------------------------------------------------------------------- #
# Rooms. Rects are (x0, z0, x1, z1) in unit-local space.
# --------------------------------------------------------------------------- #

ROOMS = [
    {
        "id": "living", "label": "Living & Dining", "category": "living",
        "rects": [(0.0, 1.6, 5.6, 7.0), (0.0, 0.0, 3.6, 1.6)],
        "floor": "floor_tile", "ceiling": True,
    },
    {
        "id": "foyer", "label": "Foyer", "category": "circulation",
        "rects": [(3.6, 0.0, 5.6, 1.6)],
        "floor": "floor_tile", "ceiling": True,
    },
    {
        "id": "kitchen", "label": "Kitchen", "category": "kitchen",
        "rects": [(5.6, 0.0, 8.4, 3.2)],
        "floor": "floor_tile", "ceiling": True,
    },
    {
        "id": "drybalcony", "label": "Dry Balcony", "category": "balcony",
        "rects": [(5.6, 3.2, 8.4, 4.4)],
        "floor": "floor_deck", "ceiling": True,
    },
    {
        "id": "bed2", "label": "Bedroom 2", "category": "bedroom",
        "rects": [(5.6, 4.4, 8.4, 7.6)],
        "floor": "floor_wood", "ceiling": True,
    },
    {
        "id": "bath2", "label": "Common Bathroom", "category": "bath",
        "rects": [(3.6, 7.0, 5.6, 8.8)],
        "floor": "floor_bath", "ceiling": True,
    },
    {
        "id": "mbed", "label": "Master Bedroom", "category": "bedroom",
        "rects": [(0.0, 7.0, 3.6, 10.0)],
        "floor": "floor_wood", "ceiling": True,
    },
    {
        "id": "mbath", "label": "Master Bathroom", "category": "bath",
        "rects": [(3.6, 8.8, 5.6, 10.0)],
        "floor": "floor_bath", "ceiling": True,
    },
    {
        "id": "sundeck", "label": "Sundeck", "category": "balcony",
        "rects": [(5.6, 7.6, 8.4, 10.0)],
        "floor": "floor_deck", "ceiling": True,
    },
]

# --------------------------------------------------------------------------- #
# Walls
#   axis 'x' -> plane at x=at, running along z from a to b
#   axis 'z' -> plane at z=at, running along x from a to b
#   openings: (start, end, kind)  kind in door|window|vent|open
# --------------------------------------------------------------------------- #

WALLS = [
    # -- exterior ----------------------------------------------------------- #
    dict(axis="z", at=0.0,  a=0.0, b=UNIT_W, t=W_EXT, ext=True, mat="wall_corridor",
         openings=[(4.2, 5.1, "door")]),
    dict(axis="x", at=0.0,  a=0.0, b=UNIT_D, t=W_EXT, ext=True, mat="wall_ext",
         openings=[(3.0, 5.0, "window"), (7.8, 9.2, "window")]),
    dict(axis="z", at=UNIT_D, a=0.0, b=UNIT_W, t=W_EXT, ext=True, mat="wall_ext",
         openings=[(1.0, 2.6, "window"), (4.2, 5.0, "vent"), (5.6, 8.4, "open")]),
    dict(axis="x", at=UNIT_W, a=0.0, b=UNIT_D, t=W_EXT, ext=True, mat="wall_ext",
         openings=[(1.0, 2.4, "window"), (3.2, 4.4, "open"),
                   (5.2, 6.8, "window"), (7.6, 10.0, "open")]),

    # -- interior ----------------------------------------------------------- #
    dict(axis="x", at=5.6, a=0.0, b=7.0,  t=W_INT, ext=False, mat="wall_int",
         openings=[(2.1, 3.0, "door"), (5.3, 6.2, "door")]),
    dict(axis="x", at=5.6, a=7.0, b=10.0, t=W_INT, ext=False, mat="wall_int", openings=[]),
    dict(axis="z", at=3.2, a=5.6, b=8.4,  t=W_INT, ext=False, mat="wall_int",
         openings=[(6.6, 7.5, "door")]),
    dict(axis="z", at=4.4, a=5.6, b=8.4,  t=W_INT, ext=False, mat="wall_int", openings=[]),
    dict(axis="z", at=7.0, a=0.0, b=5.6,  t=W_INT, ext=False, mat="wall_int",
         openings=[(1.4, 2.3, "door"), (4.2, 5.1, "door")]),
    dict(axis="x", at=3.6, a=0.0, b=1.6,  t=W_INT, ext=False, mat="wall_int", openings=[]),
    dict(axis="x", at=3.6, a=7.0, b=10.0, t=W_INT, ext=False, mat="wall_int",
         openings=[(9.0, 9.9, "door")]),
    dict(axis="z", at=8.8, a=3.6, b=5.6,  t=W_INT, ext=False, mat="wall_int", openings=[]),
    dict(axis="z", at=7.6, a=5.6, b=8.4,  t=W_INT, ext=False, mat="wall_int",
         openings=[(6.6, 7.5, "door")]),
]

# --------------------------------------------------------------------------- #
# Portals. One per door opening, wired to the zone on either side.
# --------------------------------------------------------------------------- #

PORTALS = [
    dict(id="entry",       axis="z", at=0.0,  s=4.2, e=5.1, connects=["corridor", "foyer"]),
    dict(id="foyer_liv",   axis="z", at=1.6,  s=3.6, e=5.6, connects=["foyer", "living"]),
    dict(id="liv_kit",     axis="x", at=5.6,  s=2.1, e=3.0, connects=["living", "kitchen"]),
    dict(id="kit_dry",     axis="z", at=3.2,  s=6.6, e=7.5, connects=["kitchen", "drybalcony"]),
    dict(id="liv_bed2",    axis="x", at=5.6,  s=5.3, e=6.2, connects=["living", "bed2"]),
    dict(id="liv_mbed",    axis="z", at=7.0,  s=1.4, e=2.3, connects=["living", "mbed"]),
    dict(id="liv_bath2",   axis="z", at=7.0,  s=4.2, e=5.1, connects=["living", "bath2"]),
    dict(id="mbed_mbath",  axis="x", at=3.6,  s=9.0, e=9.9, connects=["mbed", "mbath"]),
    dict(id="bed2_sun",    axis="z", at=7.6,  s=6.6, e=7.5, connects=["bed2", "sundeck"]),
]

# --------------------------------------------------------------------------- #
# Furniture: (x0, z0, x1, z1, y0, y1, material, is_obstacle)
# --------------------------------------------------------------------------- #

FURNITURE = [
    # living
    (4.55, 3.00, 5.45, 5.30, 0.00, 0.42, "fabric", True),    # sofa seat
    (5.20, 3.00, 5.48, 5.30, 0.42, 0.85, "fabric", False),   # sofa back
    (2.60, 3.40, 3.50, 4.90, 0.00, 0.42, "wood_furn", True),  # coffee table
    (0.22, 3.20, 0.80, 5.10, 0.00, 0.50, "wood_dark", True),  # tv console
    (0.30, 3.90, 0.36, 4.40, 0.50, 1.20, "screen", False),   # tv
    (1.00, 0.30, 2.90, 1.30, 0.70, 0.76, "wood_furn", True),  # dining top
    (1.10, 0.40, 1.25, 1.20, 0.00, 0.70, "steel", False),    # dining leg
    (2.65, 0.40, 2.80, 1.20, 0.00, 0.70, "steel", False),    # dining leg
    (0.55, 0.45, 0.95, 0.85, 0.00, 0.45, "fabric", True),    # chair
    (0.55, 0.75, 0.95, 1.15, 0.00, 0.45, "fabric", True),    # chair
    (2.95, 0.45, 3.35, 0.85, 0.00, 0.45, "fabric", True),    # chair
    (2.95, 0.75, 3.35, 1.15, 0.00, 0.45, "fabric", True),    # chair

    # kitchen, L counter along the east and north walls
    (7.70, 0.25, 8.28, 3.10, 0.00, 0.90, "cabinet", True),
    (7.70, 0.25, 8.28, 3.10, 0.90, 0.94, "counter", False),
    (5.75, 0.25, 7.70, 0.83, 0.00, 0.90, "cabinet", True),
    (5.75, 0.25, 7.70, 0.83, 0.90, 0.94, "counter", False),
    (7.80, 0.30, 8.28, 2.20, 1.45, 2.15, "cabinet", False),  # overhead
    (6.30, 0.35, 6.90, 0.75, 0.94, 1.00, "steel", False),    # hob

    # dry balcony
    (5.80, 3.40, 6.50, 4.05, 0.00, 0.85, "appliance", True),  # washing machine

    # bedroom 2
    (6.20, 4.60, 7.70, 6.50, 0.00, 0.50, "wood_furn", True),  # bed base
    (6.20, 4.60, 7.70, 6.50, 0.50, 0.62, "linen", False),     # mattress
    (6.25, 4.62, 7.65, 4.95, 0.62, 0.80, "linen_alt", False),  # pillows
    # Runs from z 6.50 rather than from the wall start at 4.60. The bed2 door
    # sits at z 5.30 to 6.20 in this same wall and the full run stood across it.
    (5.75, 6.50, 6.15, 7.40, 0.00, 2.30, "wood_dark", True),  # wardrobe

    # master bedroom
    (0.90, 7.20, 2.70, 9.30, 0.00, 0.50, "wood_furn", True),
    (0.90, 7.20, 2.70, 9.30, 0.50, 0.62, "linen", False),
    (0.95, 9.00, 2.65, 9.28, 0.62, 0.82, "linen_alt", False),
    (0.25, 7.15, 0.85, 9.85, 0.00, 2.30, "wood_dark", True),  # cupboard niche
    (2.85, 9.35, 3.50, 9.90, 0.00, 0.55, "wood_furn", True),  # side table

    # master bath
    (3.80, 9.55, 4.30, 9.92, 0.00, 0.42, "ceramic", True),   # wc
    (3.78, 9.55, 4.32, 9.94, 0.42, 0.78, "ceramic", False),
    (4.70, 9.60, 5.45, 9.92, 0.78, 0.88, "counter", False),  # vanity top
    (4.80, 9.65, 5.35, 9.90, 0.00, 0.78, "cabinet", True),

    # common bath
    (3.75, 7.20, 4.25, 7.60, 0.00, 0.42, "ceramic", True),
    (3.73, 7.18, 4.27, 7.62, 0.42, 0.78, "ceramic", False),
    (4.70, 7.10, 5.45, 7.42, 0.78, 0.88, "counter", False),
    (4.80, 7.15, 5.35, 7.40, 0.00, 0.78, "cabinet", True),

    # sundeck
    (7.60, 9.20, 8.20, 9.80, 0.00, 0.55, "planter", True),
    (5.90, 8.00, 6.70, 8.80, 0.00, 0.42, "wood_dark", True),  # deck stool
]

# --------------------------------------------------------------------------- #
# Points of interest
# --------------------------------------------------------------------------- #

POIS = [
    dict(id="living", zone="living", label="L-shaped Living & Dining",
         pos=(2.8, 1.55, 3.6),
         body="28.0 sq m of living and dining in one L, with the dining arm tucked "
              "beside the entry so the main span stays clear.",
         fields={"Carpet area": "28.0 sq m", "Flooring": "800x800 vitrified",
                 "Daylight": "West, full-height window"}),
    dict(id="kitchen", zone="kitchen", label="Modular Kitchen",
         pos=(7.0, 1.55, 1.7),
         body="L-shaped platform with a granite counter, undercounter and overhead "
              "cabinets, and a niche running the full east wall.",
         fields={"Counter": "L-shape, 4.7 m run", "Service": "Direct dry-balcony access"}),
    dict(id="drybalcony", zone="drybalcony", label="Dry Balcony",
         pos=(7.0, 1.40, 3.8),
         body="Utility space off the kitchen with a washing-machine point, kept out "
              "of sight from the living room.",
         fields={"Area": "3.4 sq m", "Point": "Washing machine + service outlet"}),
    dict(id="mbed", zone="mbed", label="Master Bedroom",
         pos=(1.8, 1.55, 8.4),
         body="10.8 sq m with an attached bathroom and a dedicated cupboard niche "
              "along the west wall.",
         fields={"Carpet area": "10.8 sq m", "Wardrobe": "0.6 m niche, full height",
                 "Bath": "Attached"}),
    dict(id="bed2", zone="bed2", label="Bedroom 2",
         pos=(7.0, 1.55, 6.0),
         body="9.0 sq m opening directly onto the sundeck, with a wardrobe against "
              "the party wall.",
         fields={"Carpet area": "9.0 sq m", "Access": "Sundeck"}),
    dict(id="sundeck", zone="sundeck", label="Sundeck",
         pos=(7.0, 1.40, 8.8),
         body="6.7 sq m of recessed outdoor space with an open corner. The only "
              "part of the plan with light on two sides.",
         fields={"Area": "6.7 sq m", "Aspect": "South and east"}),
]
