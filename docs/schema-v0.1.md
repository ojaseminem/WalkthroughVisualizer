# WalkthroughVisualizer — Tag Schema v0.1

Status: **frozen for M1**. Breaking changes require a version bump and a `wv-cli` migration.

Tags live in glTF `node.extras.wv`. Any node without `extras.wv` renders as plain geometry — a scene
with zero tags is a valid scene. This is deliberate: artists tag incrementally and a missing tag
never breaks a build.

## 1. Common fields

Every tagged node may carry these. Only `type` is required.

| Field   | Type       | Required | Notes |
|---------|------------|----------|-------|
| `type`  | string     | yes      | One of the node types in §2. Unknown types are ignored with a validator warning. |
| `id`    | string     | see §2   | Dot-scoped, stable, unique per scene. `l01.a.living`. Used for deep links. |
| `label` | string     | no       | Human-facing name. Falls back to a title-cased `id` leaf. |
| `level` | string     | no       | Level key, e.g. `L00`. Inherited from the nearest ancestor `LEVEL` node if absent. |
| `zone`  | string     | no       | `id` of the owning `ZONE`. Inherited from spatial containment if absent. |
| `tags`  | string[]   | no       | Free-form filter keys — `public`, `staffed`, `accessible`, `type-a`. |

### Inheritance

Resolution order for `level` and `zone`, first hit wins:

1. Explicit value on the node.
2. Nearest tagged ancestor in the glTF node hierarchy.
3. Spatial containment — the `ZONE` volume whose AABB contains the node origin.
4. Unset.

## 2. Node types

### `LEVEL`
A floor of the building. Groups everything on it.

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | `L00`, `L01`. Sort order is lexical. |
| `label` | yes | "Ground Floor", "Typical Floor 1". |
| `elevation` | yes | Metres, floor slab top. Used by the level manager and the plan view camera. |

Children of a `LEVEL` node inherit its `id` as their `level`.

### `NAV_FLOOR`
Walkable surface. Invisible at runtime.

| Field | Required | Notes |
|-------|----------|-------|
| `id` | no | |
| `surface` | no | `interior` (default), `exterior`, `stair`, `ramp`. Affects footstep audio and accessible routing. |

The mesh should be a flat, non-overlapping horizontal polygon. The M2 baker fuses all `NAV_FLOOR`
meshes per level into one navmesh. In M1 the runtime uses them directly as a raycast ground plane.

### `NAV_BLOCK`
Obstruction volume. Invisible at runtime. Carves holes in the navmesh and blocks the walk capsule.
Use for furniture the player must not walk through, and for railings.

| Field | Required | Notes |
|-------|----------|-------|
| `height` | no | Metres. Defaults to the mesh AABB height. Overriding lets a low box block movement full-height. |

### `PORTAL`
A doorway or opening between two zones. Author as a single quad filling the opening, facing either way.

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | |
| `connects` | yes | `[zoneIdA, zoneIdB]`. |
| `door` | no | `open` (default), `closed`, `locked`. `locked` removes the edge from the routing graph. |

Drives room-to-room visibility culling and is an edge in the wayfinding graph.

### `ZONE`
A named region — a room, a corridor, a lobby. Author as a box volume, invisible at runtime.

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | |
| `label` | yes | |
| `category` | no | `living`, `bedroom`, `kitchen`, `bath`, `balcony`, `circulation`, `amenity`, `department`. Drives the legend and plan-view colouring. |
| `area` | no | Square metres. If absent, `wv-cli` computes it from the footprint. |
| `parent` | no | `id` of an enclosing `ZONE` — a unit containing its rooms. |

`ZONE` produces: a room-directory entry, a minimap region, the "you are in" readout, and a plan-view
label.

### `POI`
A point of interest. Author as an empty, or as a mesh whose centroid anchors the pin.

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | |
| `label` | yes | |
| `panel` | no | `{ body, media[], fields{} }` — the info card contents. |
| `anchor` | no | `{ offset: [x,y,z] }` in metres, local space. Lifts the pin off the geometry. |
| `icon` | no | Key into the preset's icon set. |

Produces a hotspot pin, an info panel, a deep link (`?poi=<id>`), and a `poi.view` analytics event.

### `VARIANT_SET`
A switchable set of finishes or furniture layouts. Author as a parent node whose direct children are
the options.

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | |
| `label` | yes | "Flooring", "Kitchen finish". |
| `default` | no | `id` of the child to show first. Defaults to the first child. |
| `scope` | no | `global` (default) or a `ZONE` id — limits the switcher to that room's UI. |

Children carry `type: "VARIANT"` with `id`, `label`, and optional `swatch` (a hex colour or image path).

### `CAM_TOUR`
An ordered guided tour. Author as a parent node whose children are camera empties.

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | |
| `label` | yes | |
| `loop` | no | Boolean, default `false`. |

Children carry `type: "CAM_KEY"` with `order` (int), `label`, `dwell` (seconds at this stop), and
optional `look` (`id` of a node to face).

### `DEST`
A wayfinding destination — hospital preset. Author as an empty at the arrival point.

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | |
| `label` | yes | |
| `keywords` | no | string[] — search synonyms. "Radiology", "X-ray", "Imaging". |
| `dept` | no | Department key for grouping and colour. |
| `accessible` | no | Boolean. Whether a step-free route exists. |

## 3. Naming-convention fallback

For DCC tools that cannot write `extras`, `wv-cli` parses node names:

```
WV_<TYPE>__<id>__<label>
WV_ZONE__l01.a.living__Living & Dining
WV_NAV_FLOOR__l01.corridor
```

Double underscore separates fields, single underscores inside a field become spaces in the label.
Explicit `extras` always wins over a parsed name.

## 4. Validator rules

`wv-cli validate` fails the build on:

- A `PORTAL` whose `connects` names a `ZONE` id that does not exist.
- A duplicate `id` within a scene.
- A `ZONE` with no `NAV_FLOOR` intersecting it and no `category: amenity` exemption.
- A `CAM_TOUR` with fewer than two `CAM_KEY` children.
- A `VARIANT_SET` whose `default` names a missing child.
- Any level with no `NAV_FLOOR` at all.

Warns on: unknown `type`, a `POI` with no `panel`, a `ZONE` with no `category`, geometry outside all
level bounds.

## 5. Worked example

```json
{
  "extras": {
    "wv": {
      "type": "POI",
      "id": "l01.a.kitchen.drybalcony",
      "label": "Dry balcony",
      "level": "L01",
      "zone": "l01.a.kitchen",
      "tags": ["utility"],
      "panel": {
        "body": "Dedicated utility space with washing-machine point and service access.",
        "fields": { "Area": "1.4 sq m" }
      },
      "anchor": { "offset": [0, 1.4, 0] }
    }
  }
}
```
