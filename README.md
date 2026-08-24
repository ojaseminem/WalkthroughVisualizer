# Walkthrough Visualizer

A tag-driven WebGL walkthrough system. Correctly tagged 3D art produces a
finished interactive experience — navigation, room directory, info panels,
guided tours, level switching — with no per-project code.

Same engine for archviz, hospitals, malls, plants. Different tags.

Built by **Turtle Game Works**.

**Status: M2 — four view modes, touch controls, guided tour.** The demo scene is
a 2 BHK residential tower (Pune typology, Kolte Patil Western Avenue as the plan
reference): ground lobby, three typical floors, two mirrored flats per floor,
central core with lifts and a continuous stair to the terrace.

---

## Quick start

```bash
npm install
pip install pygltflib numpy        # only needed to regenerate the scene
npm run scene                      # procedurally build the tagged .glb
npm run dev                        # http://localhost:5173
```

**Desktop.** Click to take control. `W A S D` move, mouse looks, `Shift` walks
faster, `Space` hops a step, `Esc` releases. `1`–`4` switch view mode, `T` the
guided tour, `R` the room directory, `M` cycles time of day, `P` the performance
readout. During a tour: `Space` pauses, `[` and `]` step between stops.

**Phone and tablet.** Detected automatically. Drag the left thumb to walk — a
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
between two poses rather than a camera swap — the viewer never teleports and
never loses their bearings. Exploded view moves rendering only: the spread
always returns to 1 before walk mode resumes, which keeps the registry's cached
world boxes valid.

## Layout

```
packages/core/       @wv/core — the runtime. Knows the tag schema, nothing else.
  registry.js        glTF extras -> typed entity registry
  player.js          first-person walk: capsule, gravity, step-up
  collision.js       uniform-grid AABB resolution + ground probe
  pois.js            hotspot pins
  index.js           viewer: renderer, levels, time of day, guided tour

apps/viewer/         The M1 demo shell. Replaced by the JSON-driven UI in M3.
tools/modelgen/      Procedural building generator (Python -> tagged .glb)
  plan.py            the 2BHK plan and building massing, as data
  generate_tower.py  geometry emission and tagging
  glbwriter.py       minimal glTF writer that preserves `extras`
  viewmodes.js       orbit rig, level explode, pose blending
  tour.js            guided tour: timeline, scrubbing, per-stop look targets
  touch.js           floating stick, look drag, tap — phones and tablets
tools/verify/        Headless Chromium checks — registry, physics, modes, mobile
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
- **A tag never owns geometry.** Tag volumes are hidden with a render layer, not
  with `visible = false`, because visibility is inherited — a `ZONE` wrapping a
  whole flat must not black out the flat.

## Locked decisions

| Decision | Choice |
|---|---|
| Lighting | Baked lightmaps + 2–3 time-of-day sets. The real-time sun in M1 is a stand-in with the identical switching contract. |
| Device floor | Mid-range Android at 30 fps, desktop at 60. |
| Renderer | three.js, WebGL2 floor, WebGPU an opt-in ceiling. |
| Core | Plain three.js, framework-agnostic. React only in the UI layer, over an event bus. |
| Hosting | Fully static. `base: './'` so the same build runs from GitHub Pages, S3, or a client's iframe. |

## Performance

Budgets come from the device floor and are enforced in the HUD and in CI:

| Metric | Budget | M1 actual |
|---|---|---|
| Draw calls, interior | 150 | 106 |
| Draw calls, full exterior | 150 | ~213 — **M2 target** |
| Triangles on screen | 180 000 | 8 250 |
| Scene triangles, total | — | 5 900 |
| Scene size | — | 0.67 MB uncompressed |

The exterior view exceeds the draw-call budget because nothing is merged yet.
Every unit is a separate node with ~16 materials, so six flats cost ~96 calls on
their own. Material merging and atlasing in the M2 pipeline is what buys that
back; the HUD flags it in the meantime rather than hiding it.

The shadow map is rendered on demand rather than every frame — the sun only
moves when the time-of-day set changes. That alone is worth ~half the per-frame
draw calls.

## Verification

```bash
npm run check       # generate scene -> build -> verify
npm run verify      # just the checks, full-quality screenshots  (~2.5 min)
npm run verify:ci   # low-quality screenshots, what CI runs      (~1.5 min)
```

The harness serves `apps/viewer/dist` itself on an OS-assigned port, so there is
no background server, no fixed port, and no startup race. Point it at a running
dev server instead with `--url http://localhost:5173/`.

45 checks across the registry, movement, view modes, the tour, and the touch
build, then 23 screenshots into `tools/verify/out/`. The mobile checks run in a
second browser context that actually reports touch — `isTouchDevice()` is read
once at module load, so a narrow desktop window would not exercise the same code.
Both contexts rasterise in software on one CPU, so each pauses the other's render
loop while it works.

Three deliberate choices, each of which cost a CI run to learn:

- **Movement runs at a fixed timestep**, not wall-clock. Headless Chromium has no
  GPU and rasterises in software at around one frame per second, so a
  wall-clock walk test measures the rasteriser, not the movement code.
- **Checks are decided and printed before any screenshot is taken.** A screenshot
  timeout must never swallow the diagnostic output.
- **Screenshots are bounded and non-fatal.** They are a human artifact, not a
  build gate: a failed or skipped shot is reported by name, never thrown. CI uses
  `--shots low` (smaller viewport, shadows off) because a GPU-less runner cannot
  rasterise a full-size WebGL frame inside Playwright's screenshot timeout.

The physics checks assert against real geometry coordinates — the player must
stop at x = 13.82 because the wall's inner face is at 13.50 and the capsule
radius is 0.32. That specificity is deliberate: a vague check would not have
caught either of the two bugs it found on first run.

## Roadmap

- **M0** Approve references, freeze scope — done
- **M1** Vertical slice — done
- **M2** View modes, touch controls, guided tour, branding — done
- **M3** `wv-cli`: meshopt + KTX2, LODs, navmesh bake, portal graph,
  `project.json`, validator with hard failures, automated perf budget.
  **First job: material merging** — the full-exterior view runs ~213 draw calls
  against a 150 budget because six flats x ~16 materials are never merged.
- **M4** JSON-driven panels, minimap, measurement, finish variants, client theming
- **M5** Blender tagging add-on
- **M6** Archviz and hospital presets finished, with baked lighting
- **M7** WebGPU path, VR, analytics, embed SDK, docs site

## Deployment

Pushing to `main` builds, verifies, and publishes `apps/viewer/dist` to GitHub
Pages. Enable Pages with source **GitHub Actions** in repository settings.
Because `base` is `'./'`, the same artifact also works from any subpath or
inside an iframe with no rebuild.
