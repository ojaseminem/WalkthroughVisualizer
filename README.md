# Walkthrough Visualizer

A tag-driven WebGL walkthrough system. Correctly tagged 3D art produces a
finished interactive experience with no per-project code: navigation, room
directory, info panels, guided tours, level switching.

The same engine covers archviz, hospitals, malls and plants. Only the tags
change.

Built by **Turtle Game Works**.

**Status: M3, asset pipeline and real materials.** The demo scene ships under
the project label "Template Project" and is a 2 BHK residential tower (Pune
typology, Kolte Patil Western Avenue as the plan reference): ground lobby, three
typical floors, two mirrored flats per floor, central core with lifts and a
continuous stair to the terrace.

---

## Quick start

```bash
npm install
pip install pygltflib numpy pillow   # only needed to regenerate content
npm run content                      # generate source art, then optimise it
npm run dev                          # http://localhost:5173
```

`content` is two steps. `scene` builds the tagged source art into
`content-src/`, and `pipeline` runs `wv build` over it into the viewer's public
folder. Source art and shipped bundle are kept separate on purpose, because the
pipeline has to be able to run over art it did not produce.

**Desktop.** Hold the right mouse button to look around, and `W A S D` to walk
while you hold it. `Shift` walks faster, `Space` hops a step. Release the right
button and the cursor is free for the interface. Left click opens a marker.
`1` to `4` switch view mode, `T` the guided tour, `R` the room directory, `M`
cycles time of day, `P` the performance readout, `Esc` closes an open panel.
During a tour: `Space` pauses, `[` and `]` step between stops.

**Phone and tablet.** Detected automatically. Drag the left thumb to walk. A
floating stick appears where the thumb lands, and how far you push it sets your
pace. Drag anywhere else to look. Tap a marker to open it. In the orbit views,
drag to orbit, pinch to zoom, two fingers to pan.

## View modes

| Mode | What it is for |
|---|---|
| **Walk** | First person at eye height, with collision and step-up. |
| **Dollhouse** | Orbit the whole building from outside. |
| **Floor plan** | Straight down at the current level, levels above hidden. |
| **Exploded** | Levels pulled apart so every floor plate reads at once. |

All four share one orbit rig with per-mode constraints, so switching is a blend
between two poses rather than a camera swap, and the viewer never teleports.
Exploded view moves rendering only: the spread always returns to 1 before walk
mode resumes, which keeps the registry's cached world boxes valid.

## Guided tour

Tour paths are routed rather than drawn as a spline straight through the stops
(`packages/core/src/route.js`). Consecutive stops in different rooms are joined
by walking the `PORTAL` graph and dropping a waypoint either side of each
doorway on the route; the resulting polyline is resampled and then relaxed off
the `NAV_BLOCK` volumes, moving sideways only, because a path allowed to move in
y solves a tight corner by flying up through the ceiling. The old spline spent
5.2% of its length inside solid geometry, so the camera passed through walls
between rooms. The routed path spends 0%.

## Layout

```
packages/core/       @wv/core: the runtime. Knows the tag schema, nothing else.
  registry.js        glTF extras -> typed entity registry
  player.js          first-person walk: capsule, gravity, step-up
  collision.js       uniform-grid AABB resolution + ground probe
  pois.js            hotspot pins
  viewmodes.js       orbit rig, level explode, pose blending
  tour.js            guided tour: timeline, scrubbing, per-stop look targets
  route.js           tour paths through portals, relaxed off obstructions
  sky.js             procedural sky: visible background and environment light
  touch.js           floating stick, look drag, tap, for phones and tablets
  index.js           viewer: renderer, levels, time of day, guided tour

apps/viewer/         The viewer shell. JSON-driven panels arrive in M6.
tools/modelgen/      Procedural building generator (Python -> tagged .glb)
  plan.py            the 2BHK plan and building massing, as data
  generate_tower.py  geometry emission and tagging
  textures.py        procedural tiling PBR sets (albedo / normal / ORM)
  glbwriter.py       glTF writer: extras, box-projected UVs, vertex colours
tools/wv-cli/        The asset pipeline
  wv.mjs             inspect | validate | build
  lib/tags.mjs       reads the tag schema (extras, then name convention)
  lib/merge.mjs      merge by material within tag boundaries; bake AABBs
  lib/coplanar.mjs   same-facing surfaces on one plane, which z-fight
  fixtures/          a deliberately awkward untagged "client export"
tools/verify/        Headless Chromium checks: registry, physics, modes, mobile
docs/                Tag schema and the approved plan
```

## The contract

Everything hangs on glTF `node.extras.wv`. Full spec in
[`docs/schema-v0.1.md`](docs/schema-v0.1.md).

```json
{ "wv": {
    "type": "POI",
    "id": "l01.a.kitchen",
    "label": "Modular Kitchen",
    "zone": "l01.a.kitchen",
    "panel": { "body": "L-shaped platform…", "fields": { "Counter": "4.7 m run" } }
} }
```

Node types the runtime understands: `PROJECT`, `LEVEL`, `ZONE`, `NAV_FLOOR`,
`NAV_BLOCK`, `PORTAL`, `POI`, `CAM_TOUR` / `CAM_KEY`, `DEST`, `VARIANT_SET`.

Two rules make the system safe to hand to an artist:

- **Untagged geometry still renders.** A scene with zero tags is a valid scene,
  so tagging can be incremental and a typo never produces a black screen.
- **A tag never owns geometry.** Tag volumes are hidden with a render layer
  rather than `visible = false`. Visibility is inherited, so a `ZONE` wrapping a
  whole flat would otherwise black out the flat.

## The pipeline

```bash
npm run wv -- inspect  content-src/kp-tower/scene.glb
npm run wv -- validate content-src/kp-tower/scene.glb    # non-zero exit on failure
npm run wv -- build    content-src/kp-tower/scene.glb -o out/
```

`build` runs: prune (keeping tag leaves) → dedup → **merge by material within tag
boundaries** → **bake tag volumes to AABBs** → prune → weld → resample →
texture compress (WebP) → quantize. It writes `scene.glb`, `project.json` and
`build-report.json`.

Two of those steps are ours rather than off-the-shelf, for the same reason:

- **gltf-transform's `join()` cannot be used on a tagged scene.** With
  `keepNamed:false` it flattened 643 tagged nodes to 17, taking every zone,
  portal and POI in the building with it. With `keepNamed:true` it joined
  nothing, because every node in a tagged scene has a name. Merging has to know
  where the tags are, so it merges only untagged geometry, and only within one
  tagged ancestor.
- **Tag volumes become numbers.** A ZONE's box mesh exists only so something can
  measure it. Baking the AABB into `extras.wv.aabb` and dropping the mesh removes
  550 mesh-bearing nodes and stops the runtime doing 550 `Box3.setFromObject`
  calls at load. The runtime reads the baked box when it is there and measures
  the mesh when it is not, so unprocessed source scenes still work.

`prune` also needs `keepLeaves: true`: POI and CAM_KEY nodes are empties whose
entire purpose is their extras, and a default prune deletes them as unused.

`validate` additionally warns on coplanar same-facing surfaces
(`tools/wv-cli/lib/coplanar.mjs`). Two surfaces a millimetre apart look right in
a modelling package and strobe in a real-time renderer, because past a few
metres the depth buffer cannot separate them. It never shows up in a screenshot,
so it has to be a build check. The check runs on world-space geometry after
instancing, so two copies of the same room standing in different places are not
reported against each other. The source scene had 5449 m² of conflicting surface
area when the check was written; it now has none.

### On foreign geometry

The pipeline never assumes the art came from our generator. `fixtures/` builds a
GLB with the artefacts a real 3ds Max or UE5 hand-off carries: four levels of
nesting, a Z-up root rotation, non-uniform node scales, ten materials that are
functionally three, and no tags at all. CI builds it every run:

| | before | after |
|---|---|---|
| Draw calls | 32 | 3 |
| Materials | 10 | 3 |
| Nodes | 37 | 6 |
| File | 54 KB | 17 KB |

An untagged scene optimises fine and produces a `project.json` with empty
collections, rather than failing.

## Materials

Eleven surface classes (plaster, tile, timber, granite, concrete, fabric,
metal, deck, foliage, turf, asphalt), each with a tiling albedo / normal / ORM set
generated by `textures.py`. UVs are world-space box projections divided by the
surface's metres-per-repeat, so texel density is identical on a skirting board
and a facade.

Sets are generated at 1024 rather than 512 and carry baked occlusion along
joints, which is what moved the shipped texture payload from 257 KB to 641 KB.

Two things had to be fixed before any of that showed up in the render. `fbm()`
upsampled each octave with PIL, which clamps at the lattice edge instead of
wrapping, so every map carried a hard seam at each texture repeat: the step
across the wrap measured 0.24 against a mean interior step of 0.0016. Padding
the lattice with `mode='wrap'` and cropping after the resize brings that to
within 1.3x of the interior. And the per-tile and per-board tone variation was
being scaled by its own standard deviation a second time, so a nominal spread
of 0.045 reached the image as 0.0019, under half an 8-bit level. Neither is
visible in a code review and both are obvious in a render.

**Tint lives in `COLOR_0`.** Thirty painted finishes that differ only in colour
would be thirty materials, and thirty materials is thirty draw calls that no
amount of geometry merging can combine. Moving the tint to vertex colours
collapses them to one material per surface class, which is what makes the merge
pay.

## Lighting

The visible background and the image-based light come from the same procedural
sky dome (`packages/core/src/sky.js`), rebuilt whenever the time-of-day preset
changes. It replaced three.js's `RoomEnvironment`, which is a white box with
rectangular area lights in the ceiling: everything lit by it picked up soft
highlights from four directions, and the indirect light stayed put all day while
the direct sun moved. Generating both maps from the numbers that drive the sun
means what you see through the glass and what lands on the floor cannot drift
apart.

## Locked decisions

| Decision | Choice |
|---|---|
| Lighting | Baked lightmaps + 2 to 3 time-of-day sets. The real-time sun in M1 is a stand-in with the identical switching contract. |
| Device floor | Mid-range Android at 30 fps, desktop at 60. |
| Renderer | three.js, WebGL2 floor, WebGPU an opt-in ceiling. |
| Core | Plain three.js, framework-agnostic. React only in the UI layer, over an event bus. |
| Hosting | Fully static. `base: './'` so the same build runs from GitHub Pages, S3, or a client's iframe. |

## Performance

Budgets come from the device floor and are enforced in the HUD and in CI:

| Metric | Budget | Source art | After `wv build` |
|---|---|---|---|
| Draw calls, whole scene | 150 | 648 | **45** |
| Draw calls, interior view | 150 | n/a | 48 |
| Triangles drawn | 180 000 | n/a | 16 640 |
| Materials | n/a | 13 | 12 |
| Texture payload | n/a | 12.25 MB PNG | **641 KB WebP** |
| Shipped file | n/a | 1.08 MB + 33 files | **1.14 MB, one file** |

Merging trades memory for draw calls: baking three instances of a unit into
place triples its stored triangles, from 5 900 to 16 100. At a 180 000 budget
that is the right trade, and the report prints both numbers.

KTX2 would beat WebP for GPU memory, but needs `toktx` or `basisu` on the build
machine. WebP via sharp needs no extra tooling, and swapping to KTX2 later is a
change to one pipeline step.

The shadow map is rendered on demand rather than every frame, because the sun
only moves when the time-of-day set changes. That alone is worth roughly half
the per-frame draw calls.

## Verification

```bash
npm run check       # generate scene -> build -> verify
npm run verify      # just the checks, full-quality screenshots  (~2.5 min)
npm run verify:ci   # low-quality screenshots, what CI runs      (~1.5 min)
```

The harness serves `apps/viewer/dist` itself on an OS-assigned port, so it needs
no background server or fixed port and cannot lose a startup race. Point it at a
running dev server instead with `--url http://localhost:5173/`.

51 checks across the registry, movement, view modes, the tour, and the touch
build, then 23 screenshots into `tools/verify/out/`. The mobile checks run in a
second browser context that actually reports touch, because `isTouchDevice()` is
read once at module load and a narrow desktop window would not exercise the same
code. Both contexts rasterise in software on one CPU, so each pauses the other's
render loop while it works.

Three details of the harness were settled by failed CI runs:

- **Movement runs at a fixed timestep.** Headless Chromium has no GPU and
  rasterises in software at around one frame per second, so a wall-clock walk
  test measures the rasteriser rather than the movement code.
- **Checks are decided and printed before any screenshot is taken.** A screenshot
  timeout must never swallow the diagnostic output.
- **Screenshots are bounded and non-fatal.** A failed or skipped shot is reported
  by name and never thrown, so it cannot gate a build. CI uses `--shots low`
  (smaller viewport, shadows off) because a GPU-less runner cannot rasterise a
  full-size WebGL frame inside Playwright's screenshot timeout.

The physics checks assert against real geometry coordinates. The player must stop
at x = 13.82 because the wall's inner face is at 13.50 and the capsule radius is
0.32. A looser check would not have caught either of the two bugs it found on
first run.

## Roadmap

- **M0** Approve references, freeze scope. Done.
- **M1** Vertical slice. Done.
- **M2** View modes, touch controls, guided tour, branding. Done.
- **M3** Asset pipeline and real materials. Done.
- **M4** Baked lighting: Blender Cycles lightmaps, 2 to 3 time-of-day sets, the
  bake swapped in behind the switching contract the runtime already has
- **M5** Blender tagging add-on, so artists other than the generator can author
- **M6** JSON-driven panels, minimap, measurement, finish variants, theming
- **M7** Hospital preset: navmesh bake, A→B routing, department search
- **M8** WebGPU path, VR, analytics, embed SDK, docs site

## Deployment

Pushing to `main` builds, verifies, and publishes `apps/viewer/dist` to GitHub
Pages. Enable Pages with source **GitHub Actions** in repository settings.
Because `base` is `'./'`, the same artifact also works from any subpath or
inside an iframe with no rebuild.

Fonts are self-hosted through `@fontsource` and bundled with the build:
Montserrat for display, Source Sans 3 for UI, Roboto Mono for data, Sora for the
Turtle Game Works wordmark. Nothing is fetched from Google Fonts at runtime, so
the viewer renders identically offline and behind a client's firewall.
