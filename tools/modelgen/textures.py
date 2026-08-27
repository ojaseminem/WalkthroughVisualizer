#!/usr/bin/env python3
"""Procedural PBR texture sets for the demo scene.

Every surface class gets albedo, normal and ORM (R = occlusion, G = roughness,
B = metallic, per the glTF spec). Maps are meant to tile so the runtime can
repeat one across a wall with no join showing. The mask and blur helpers do.
fbm does not yet, see its docstring.

These stand in for scanned maps. They exist so the pipeline downstream gets a
real textured scene with UVs, tiling and three map types instead of the
flat-colour greybox it used to be fed.

What keeps them from reading as noise: tiled surfaces vary cell to cell and
board to board, since a floor of identical tiles is the one thing that never
happens in a building and the eye catches it immediately. Joints also carry
baked occlusion, so a grout line goes dark from being recessed instead of from
being painted darker.

    python3 textures.py ../../apps/viewer/public/content/kp-tower/tex
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

SIZE = 1024
RNG = np.random.default_rng(20260824)


# --------------------------------------------------------------------------- #
# Noise helpers, all tileable
# --------------------------------------------------------------------------- #

def _white(size=SIZE):
    return RNG.random((size, size)).astype(np.float32)


def _tileable_blur(a, sigma):
    """Gaussian blur with wraparound, so the result still tiles."""
    if sigma <= 0:
        return a
    k = int(max(3, sigma * 4)) | 1
    x = np.arange(k) - k // 2
    g = np.exp(-(x ** 2) / (2 * sigma * sigma))
    g /= g.sum()
    out = a
    for axis in (0, 1):
        pad = k // 2
        wide = np.concatenate(
            [np.take(out, range(-pad, 0), axis=axis), out,
             np.take(out, range(0, pad), axis=axis)], axis=axis)
        out = np.apply_along_axis(lambda m: np.convolve(m, g, mode='valid'), axis, wide)
    return out.astype(np.float32)


def fbm(octaves=5, size=SIZE, persistence=0.5, base=4):
    """Fractal value noise from small random lattices upsampled to full size.

    The lattice is wrap-padded before the resize and the pad cropped off after.
    Without that, PIL clamps at the lattice edge and leaves a step across the
    wrap: at base=4, octaves=5 it measured 0.24 against a mean interior step of
    0.0016, which shows up as a hard line every time a texture repeats. Every
    surface here is built on fbm, so the seam was on all of them.
    """
    total = np.zeros((size, size), np.float32)
    amp, norm = 1.0, 0.0
    pad = 2
    for o in range(octaves):
        res = base * (2 ** o)
        if res > size:
            break
        lattice = RNG.random((res, res)).astype(np.float32)
        wrapped = np.pad(lattice, pad, mode='wrap')
        scale = size / res
        wide = int(round((res + 2 * pad) * scale))
        off = int(round(pad * scale))
        # Bicubic on the way up keeps it smooth enough to differentiate for a
        # normal map. Nearest or bilinear leave lattice edges you can see.
        img = Image.fromarray((wrapped * 255).astype(np.uint8)).resize(
            (wide, wide), Image.BICUBIC)
        oct_map = np.asarray(img, np.float32)[off:off + size, off:off + size] / 255.0
        if oct_map.shape != (size, size):
            oct_map = np.asarray(Image.fromarray((oct_map * 255).astype(np.uint8))
                                 .resize((size, size), Image.BILINEAR), np.float32) / 255.0
        total += oct_map * amp
        norm += amp
        amp *= persistence
    return total / max(norm, 1e-6)


def normal_from_height(h, strength=1.0):
    """Central differences on the height field, packed as a tangent-space
    normal map. np.roll for the neighbours, so it wraps and stays tileable."""
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * strength
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * strength
    nz = np.ones_like(h)
    ln = np.sqrt(dx * dx + dy * dy + nz * nz)
    n = np.stack([-dx / ln, -dy / ln, nz / ln], axis=-1)
    return ((n * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)


def to_rgb(a):
    if a.ndim == 2:
        a = np.stack([a] * 3, axis=-1)
    return (a.clip(0, 1) * 255).astype(np.uint8)


def grid_mask(cols, rows, line_px=2, size=SIZE):
    """1.0 inside a cell, 0.0 on the joint line."""
    m = np.ones((size, size), np.float32)
    for i in range(cols):
        x = int(round(i * size / cols))
        m[:, x:x + line_px] = 0.0
    for j in range(rows):
        y = int(round(j * size / rows))
        m[y:y + line_px, :] = 0.0
    return m


def cell_tones(cols, rows, spread=0.10, size=SIZE):
    """A flat tone per grid cell, so no two tiles come out exactly alike.

    np.repeat rather than a PIL resize. The old version encoded the tones to
    uint8 and back, then scaled by spread a second time on top of the standard
    deviation the draw already had, which left spread=0.045 measuring 0.0019.
    That is under half an 8-bit level, so the variation this exists to provide
    was not reaching the image at all.
    """
    tones = RNG.normal(0.0, spread, (rows, cols)).astype(np.float32)
    ry, rx = -(-size // rows), -(-size // cols)
    return np.repeat(np.repeat(tones, ry, axis=0), rx, axis=1)[:size, :size]


def plank_tones(rows, spread=0.09, size=SIZE):
    """One tone per board, constant along the board's length."""
    tones = RNG.normal(0.0, spread, (rows, 1)).astype(np.float32)
    ry = -(-size // rows)
    return np.repeat(np.repeat(tones, ry, axis=0), size, axis=1)[:size, :size]


def joint_occlusion(mask, sigma=3.0, depth=0.55):
    """Soft darkening that follows a joint mask, as a recess would."""
    return (1.0 - (1.0 - _tileable_blur(mask, sigma)) * depth).clip(0.0, 1.0)


def brick_mask(rows, cols, line_px=2, offset=0.5, size=SIZE):
    """Running-bond mask, for plank floors."""
    m = np.ones((size, size), np.float32)
    rh = size / rows
    for j in range(rows):
        y = int(round(j * rh))
        m[y:y + line_px, :] = 0.0
        shift = int(round((j * offset % 1.0) * size / cols))
        for i in range(cols):
            x = (int(round(i * size / cols)) + shift) % size
            m[y:y + int(rh), x:x + line_px] = 0.0
    return m


# --------------------------------------------------------------------------- #
# Surface classes
# --------------------------------------------------------------------------- #

def plaster():
    # Three noise bands. Roller nap on top, the trowel pass under that, and a
    # slow drift across the wall that only shows in raking light. A single band
    # reads as sandpaper.
    nap = fbm(7, persistence=0.52, base=48)
    trowel = fbm(5, persistence=0.58, base=7)
    drift = fbm(3, persistence=0.6, base=2)
    h = _tileable_blur(nap * 0.35 + trowel * 0.45 + drift * 0.20, 0.8)
    # 0.90 was close enough to white that the tone mapper clipped it and the
    # walls read as paper. 0.84 with a trace of warmth holds its shading.
    body = 0.84 + (h - 0.5) * 0.05 + (drift - 0.5) * 0.03
    albedo = np.stack([body * 1.000, body * 0.988, body * 0.968], axis=-1)
    rough = 0.88 + (nap - 0.5) * 0.09 + (drift - 0.5) * 0.04
    return to_rgb(albedo), normal_from_height(h, 1.5), rough, 0.0, None


def vitrified_tile():
    cells = grid_mask(4, 4, line_px=4)
    tone = cell_tones(4, 4, spread=0.045)
    veins = fbm(6, persistence=0.55, base=12) * 0.09
    body = 0.78 + veins - 0.045 + tone
    body = body * (0.76 + 0.24 * cells)              # grout reads darker
    albedo = np.stack([body * 1.000, body * 0.992, body * 0.975], axis=-1)
    h = cells * 0.5 + veins
    rough = 0.14 + (1 - cells) * 0.62 + veins * 0.5  # grout matte, tile polished
    return to_rgb(albedo), normal_from_height(h, 2.8), rough, 0.0, joint_occlusion(cells, 3.5, 0.5)


def timber():
    planks = brick_mask(6, 2, line_px=2, offset=0.5)
    # Grain runs along the plank: stretch the noise on one axis.
    fine = fbm(6, persistence=0.62, base=6)
    grain = np.asarray(Image.fromarray((fine * 255).astype(np.uint8))
                       .resize((SIZE, SIZE // 12), Image.BICUBIC)
                       .resize((SIZE, SIZE), Image.BICUBIC), np.float32) / 255.0
    # One tone per board. Engineered oak is sorted for consistency and still
    # runs light to dark across a floor. Identical boards read as wallpaper.
    board = plank_tones(6, spread=0.055)
    body = 0.34 + grain * 0.30 + board
    body = body * (0.70 + 0.30 * planks)
    albedo = np.stack([body * 1.00, body * 0.71, body * 0.47], axis=-1)
    h = planks * 0.6 + grain * 0.4
    rough = 0.40 + grain * 0.24 + (1 - planks) * 0.22
    return to_rgb(albedo), normal_from_height(h, 2.1), rough, 0.0, joint_occlusion(planks, 2.5, 0.45)


def granite():
    speck = _white()
    speck = _tileable_blur(speck, 0.7)
    blobs = fbm(6, persistence=0.5, base=10)
    body = 0.16 + blobs * 0.14 + (speck > 0.86) * 0.45
    albedo = to_rgb(body)
    rough = 0.20 + (speck > 0.86) * 0.18 + blobs * 0.08
    return albedo, normal_from_height(speck * 0.3, 1.0), rough, 0.0


def concrete():
    coarse = fbm(6, persistence=0.55, base=5)
    pits = (_tileable_blur(_white(), 1.2) > 0.86).astype(np.float32)
    body = 0.62 + (coarse - 0.5) * 0.16 - pits * 0.10
    albedo = to_rgb(body)
    h = coarse * 0.7 - pits * 0.4
    rough = 0.85 + (coarse - 0.5) * 0.12
    return albedo, normal_from_height(h, 2.2), rough, 0.0


def fabric():
    # Warp and weft as two sine bands at 64 repeats across the map.
    xs = np.linspace(0, np.pi * 2 * 64, SIZE, endpoint=False)
    warp = np.sin(xs)[None, :].repeat(SIZE, 0)
    weft = np.sin(xs)[:, None].repeat(SIZE, 1)
    weave = (warp * 0.5 + weft * 0.5) * 0.5 + 0.5
    lint = fbm(5, persistence=0.6, base=12)
    body = 0.55 + (weave - 0.5) * 0.12 + (lint - 0.5) * 0.08
    albedo = to_rgb(body)
    rough = 0.93 + (weave - 0.5) * 0.05
    return albedo, normal_from_height(weave * 0.6 + lint * 0.4, 3.0), rough, 0.0


def brushed_metal():
    xs = _white()
    streak = np.asarray(Image.fromarray((xs * 255).astype(np.uint8))
                        .resize((SIZE, 6), Image.BILINEAR)
                        .resize((SIZE, SIZE), Image.BILINEAR), np.float32) / 255.0
    body = 0.62 + (streak - 0.5) * 0.10
    albedo = to_rgb(body)
    rough = 0.26 + (streak - 0.5) * 0.14
    return albedo, normal_from_height(streak * 0.3, 1.6), rough, 0.92


def deck_tile():
    cells = grid_mask(6, 6, line_px=3)
    grit = fbm(6, persistence=0.6, base=14)
    tone = cell_tones(6, 6, spread=0.05)
    body = (0.58 + (grit - 0.5) * 0.16 + tone) * (0.76 + 0.24 * cells)
    albedo = to_rgb(body)
    rough = 0.70 + (grit - 0.5) * 0.16 + (1 - cells) * 0.18
    return albedo, normal_from_height(cells * 0.5 + grit * 0.5, 2.6), rough, 0.0, joint_occlusion(cells, 3.0, 0.5)


def foliage():
    leaf = fbm(6, persistence=0.62, base=9)
    body = np.stack([0.22 + leaf * 0.16, 0.34 + leaf * 0.26, 0.16 + leaf * 0.12], axis=-1)
    rough = 0.86 + (leaf - 0.5) * 0.12
    return to_rgb(body), normal_from_height(leaf, 2.4), rough, 0.0


def turf():
    blades = fbm(7, persistence=0.68, base=24)
    body = np.stack([0.26 + blades * 0.16, 0.36 + blades * 0.24, 0.20 + blades * 0.12], axis=-1)
    rough = 0.95
    return to_rgb(body), normal_from_height(blades, 2.0), np.full((SIZE, SIZE), rough, np.float32), 0.0


def asphalt():
    grit = fbm(7, persistence=0.66, base=20)
    body = 0.24 + (grit - 0.5) * 0.14
    return to_rgb(body), normal_from_height(grit, 2.4), 0.88 + (grit - 0.5) * 0.1, 0.0


SETS = {
    'plaster': plaster,
    'tile': vitrified_tile,
    'timber': timber,
    'granite': granite,
    'concrete': concrete,
    'fabric': fabric,
    'metal': brushed_metal,
    'deck': deck_tile,
    'foliage': foliage,
    'turf': turf,
    'asphalt': asphalt,
}


def build(out_dir: str):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for name, fn in SETS.items():
        # Surfaces with joints return an occlusion map as a fifth item. The
        # rest return four and get a flat white occlusion channel here.
        result = fn()
        albedo, normal, rough, metal = result[:4]
        occl = result[4] if len(result) > 4 and result[4] is not None else None
        if np.isscalar(rough):
            rough = np.full((SIZE, SIZE), float(rough), np.float32)
        if occl is None:
            occl = np.ones((SIZE, SIZE), np.float32)
        metal_ch = np.full((SIZE, SIZE), float(metal), np.float32) if np.isscalar(metal) else metal
        # glTF packs R = occlusion, G = roughness, B = metallic in one image.
        orm = np.stack([occl, rough.clip(0, 1), metal_ch], axis=-1)

        Image.fromarray(albedo).save(out / f'{name}_albedo.png', optimize=True)
        Image.fromarray(normal).save(out / f'{name}_normal.png', optimize=True)
        Image.fromarray((orm * 255).astype(np.uint8)).save(out / f'{name}_orm.png', optimize=True)
        written.append(name)

    total = sum(f.stat().st_size for f in out.glob('*.png'))
    print(f'{len(written)} sets, {len(list(out.glob("*.png")))} maps, '
          f'{total / 1024 / 1024:.2f} MB raw PNG -> {out}')
    return written


if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else '../../apps/viewer/public/content/kp-tower/tex')
