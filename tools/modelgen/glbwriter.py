"""Minimal glTF/GLB writer on top of pygltflib.

Takes surface-grouped triangles and a node tree, writes a .glb with extras
intact on every node. That is the whole job.

UVs are world-space box projections. Each face goes onto its own plane, divided
by the surface's metres-per-repeat, which keeps texel density the same on a
skirting board and a facade and leaves tiling with no seam to hide.

Tints go in COLOR_0 rather than in the material. Twenty painted finishes would
be twenty materials otherwise, which is twenty draw calls the merge pass can
never combine. With the tint in vertex colours there is one material per surface
class, so geometry joins across levels and units.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

import numpy as np
import pygltflib as pg


# --------------------------------------------------------------------------- #
# Surfaces
# --------------------------------------------------------------------------- #

@dataclass
class Surface:
    """A real material: one texture set, shared by everything of that class."""
    name: str
    tex: str | None = None            # texture set stem in the tex/ folder
    uv_scale: float = 2.0             # metres per texture repeat
    color: tuple = (1.0, 1.0, 1.0, 1.0)   # default tint, written to COLOR_0
    metallic: float = 0.0
    roughness: float = 1.0
    double_sided: bool = False
    normal_scale: float = 1.0


# --------------------------------------------------------------------------- #
# Geometry accumulation
# --------------------------------------------------------------------------- #

class MeshBuilder:
    """Accumulates flat-shaded triangles with UVs and vertex colours."""

    def __init__(self) -> None:
        # surface index -> dict of lists
        self._groups: dict[int, dict[str, list]] = {}

    def _group(self, surf: int):
        if surf not in self._groups:
            self._groups[surf] = {'p': [], 'n': [], 't': [], 'c': []}
        return self._groups[surf]

    def _emit_tri(self, a, b, c, uva, uvb, uvc, surf, color):
        g = self._group(surf)
        va, vb, vc = (np.asarray(v, np.float64) for v in (a, b, c))
        n = np.cross(vb - va, vc - va)
        ln = np.linalg.norm(n)
        if ln < 1e-12:
            return
        n = n / ln
        g['p'].extend([va, vb, vc])
        g['n'].extend([n, n, n])
        g['t'].extend([uva, uvb, uvc])
        g['c'].extend([color, color, color])

    def quad(self, a, b, c, d, surf: int, uvs=None, color=(1, 1, 1, 1)):
        """Vertices counter-clockwise seen from the front."""
        if uvs is None:
            uvs = _project_quad(a, b, c, d, 1.0)
        ua, ub, uc, ud = uvs
        self._emit_tri(a, b, c, ua, ub, uc, surf, color)
        self._emit_tri(a, c, d, ua, uc, ud, surf, color)

    def box(self, lo, hi, surf: int, faces: str = 'xXyYzZ',
            uv_scale: float = 2.0, color=(1, 1, 1, 1)) -> None:
        """Axis-aligned box with world-space box-projected UVs.

        `faces` picks which sides to emit: lowercase for the negative side of an
        axis, uppercase for the positive. Dropping faces nobody can see is the
        cheapest triangle saving available here, so pass a subset wherever the
        box is buried in a wall or backs onto another box.
        """
        x0, y0, z0 = (min(lo[i], hi[i]) for i in range(3))
        x1, y1, z1 = (max(lo[i], hi[i]) for i in range(3))
        if x1 - x0 < 1e-9 or y1 - y0 < 1e-9 or z1 - z0 < 1e-9:
            return
        s = 1.0 / max(uv_scale, 1e-6)

        def uv(*pairs):
            return [(p * s, q * s) for p, q in pairs]

        if 'z' in faces:
            self.quad((x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0), surf,
                      uv((x1, y0), (x0, y0), (x0, y1), (x1, y1)), color)
        if 'Z' in faces:
            self.quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1), surf,
                      uv((x0, y0), (x1, y0), (x1, y1), (x0, y1)), color)
        if 'x' in faces:
            self.quad((x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0), surf,
                      uv((z0, y0), (z1, y0), (z1, y1), (z0, y1)), color)
        if 'X' in faces:
            self.quad((x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1), surf,
                      uv((z1, y0), (z0, y0), (z0, y1), (z1, y1)), color)
        if 'y' in faces:
            self.quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), surf,
                      uv((x0, z0), (x1, z0), (x1, z1), (x0, z1)), color)
        if 'Y' in faces:
            self.quad((x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0), surf,
                      uv((x0, z1), (x1, z1), (x1, z0), (x0, z0)), color)

    def is_empty(self) -> bool:
        return not any(len(g['p']) for g in self._groups.values())

    def groups(self) -> Iterable[tuple[int, np.ndarray, np.ndarray, np.ndarray, np.ndarray]]:
        for surf in sorted(self._groups):
            g = self._groups[surf]
            if not g['p']:
                continue
            yield (surf,
                   np.asarray(g['p'], np.float32),
                   np.asarray(g['n'], np.float32),
                   np.asarray(g['t'], np.float32),
                   np.asarray(g['c'], np.float32))

    def triangle_count(self) -> int:
        return sum(len(g['p']) for g in self._groups.values()) // 3


def _project_quad(a, b, c, d, scale):
    """Fallback UVs when the caller passes none. Projects onto the two axes the
    face normal is smallest in, at 1 unit per metre."""
    va, vb, vc = (np.asarray(v, np.float64) for v in (a, b, c))
    n = np.cross(vb - va, vc - va)
    ax = int(np.argmax(np.abs(n)))
    pick = {0: (2, 1), 1: (0, 2), 2: (0, 1)}[ax]
    return [tuple(np.asarray(v, np.float64)[list(pick)] * scale) for v in (a, b, c, d)]


# --------------------------------------------------------------------------- #
# Scene description
# --------------------------------------------------------------------------- #

@dataclass
class Node:
    name: str
    mesh: int | None = None
    translation: tuple | None = None
    rotation: tuple | None = None
    scale: tuple | None = None
    extras: dict | None = None
    children: list["Node"] = field(default_factory=list)

    def add(self, child: "Node") -> "Node":
        self.children.append(child)
        return child


# --------------------------------------------------------------------------- #
# Writer
# --------------------------------------------------------------------------- #

class GlbWriter:
    def __init__(self, tex_dir: str = 'tex') -> None:
        self.tex_dir = tex_dir
        self.surfaces: list[Surface] = []
        self._surf_index: dict[str, int] = {}
        self.meshes: list[tuple[str, MeshBuilder]] = []

    def surface(self, s: Surface) -> int:
        if s.name in self._surf_index:
            return self._surf_index[s.name]
        idx = len(self.surfaces)
        self.surfaces.append(s)
        self._surf_index[s.name] = idx
        return idx

    def mesh(self, name: str, builder: MeshBuilder) -> int:
        self.meshes.append((name, builder))
        return len(self.meshes) - 1

    # -- materials ---------------------------------------------------------- #

    def _build_materials(self):
        """One glTF material per surface, plus its images/textures/samplers."""
        images: list[pg.Image] = []
        textures: list[pg.Texture] = []
        image_index: dict[str, int] = {}
        materials: list[pg.Material] = []

        sampler = pg.Sampler(magFilter=pg.LINEAR, minFilter=pg.LINEAR_MIPMAP_LINEAR,
                             wrapS=pg.REPEAT, wrapT=pg.REPEAT)

        def texture_for(stem: str, kind: str) -> int:
            uri = f'{self.tex_dir}/{stem}_{kind}.png'
            if uri not in image_index:
                images.append(pg.Image(uri=uri))
                textures.append(pg.Texture(source=len(images) - 1, sampler=0))
                image_index[uri] = len(textures) - 1
            return image_index[uri]

        for s in self.surfaces:
            # Alpha rides on COLOR_0 with the rest of the tint. Set it in the
            # factor as well and it multiplies twice: glass all but disappears.
            pbr = pg.PbrMetallicRoughness(
                baseColorFactor=[1.0, 1.0, 1.0, 1.0],
                metallicFactor=s.metallic,
                roughnessFactor=s.roughness,
            )
            mat = pg.Material(
                name=s.name,
                pbrMetallicRoughness=pbr,
                doubleSided=s.double_sided,
                alphaMode='BLEND' if s.color[3] < 1.0 else 'OPAQUE',
            )
            if s.tex:
                pbr.baseColorTexture = pg.TextureInfo(index=texture_for(s.tex, 'albedo'))
                # One ORM image feeds both slots. glTF reads G/B for roughness
                # and metallic, R for occlusion, so the same texture index goes
                # to metallicRoughnessTexture and occlusionTexture.
                orm = texture_for(s.tex, 'orm')
                pbr.metallicRoughnessTexture = pg.TextureInfo(index=orm)
                mat.occlusionTexture = pg.OcclusionTextureInfo(index=orm)
                mat.normalTexture = pg.NormalMaterialTexture(
                    index=texture_for(s.tex, 'normal'), scale=s.normal_scale)
            materials.append(mat)

        return materials, textures, images, [sampler] if textures else []

    # -- serialisation ------------------------------------------------------ #

    def write(self, path: str, root: Node, asset_extras: dict | None = None) -> dict:
        blob = bytearray()
        accessors: list[pg.Accessor] = []
        views: list[pg.BufferView] = []
        gmeshes: list[pg.Mesh] = []

        def pad4() -> None:
            while len(blob) % 4:
                blob.append(0)

        def add_view(data: bytes, target: int | None) -> int:
            pad4()
            offset = len(blob)
            blob.extend(data)
            views.append(pg.BufferView(buffer=0, byteOffset=offset,
                                       byteLength=len(data), target=target))
            return len(views) - 1

        def add_accessor(arr: np.ndarray, comp: int, kind: str, target, minmax=False) -> int:
            v = add_view(arr.tobytes(), target)
            acc = pg.Accessor(bufferView=v, componentType=comp, count=len(arr), type=kind)
            if minmax:
                acc.min = arr.min(axis=0).tolist() if arr.ndim > 1 else [float(arr.min())]
                acc.max = arr.max(axis=0).tolist() if arr.ndim > 1 else [float(arr.max())]
            accessors.append(acc)
            return len(accessors) - 1

        total_tris = 0
        for mesh_name, builder in self.meshes:
            prims: list[pg.Primitive] = []
            for surf, pos, nrm, uv, col in builder.groups():
                count = len(pos)
                total_tris += count // 3

                a_pos = add_accessor(pos, pg.FLOAT, pg.VEC3, pg.ARRAY_BUFFER, minmax=True)
                a_nrm = add_accessor(nrm, pg.FLOAT, pg.VEC3, pg.ARRAY_BUFFER)
                a_uv = add_accessor(uv, pg.FLOAT, pg.VEC2, pg.ARRAY_BUFFER)
                a_col = add_accessor(col, pg.FLOAT, pg.VEC4, pg.ARRAY_BUFFER)

                idx = np.arange(count, dtype=np.uint32)
                a_idx = add_accessor(idx, pg.UNSIGNED_INT, pg.SCALAR,
                                     pg.ELEMENT_ARRAY_BUFFER, minmax=True)

                prims.append(pg.Primitive(
                    attributes=pg.Attributes(POSITION=a_pos, NORMAL=a_nrm,
                                             TEXCOORD_0=a_uv, COLOR_0=a_col),
                    indices=a_idx, material=surf, mode=pg.TRIANGLES,
                ))
            gmeshes.append(pg.Mesh(name=mesh_name, primitives=prims))

        gnodes: list[pg.Node] = []

        def emit(n: Node) -> int:
            idx = len(gnodes)
            gnodes.append(pg.Node(name=n.name))    # reserve the slot before recursing
            child_ids = [emit(c) for c in n.children]
            gnodes[idx] = pg.Node(
                name=n.name,
                mesh=n.mesh,
                translation=list(n.translation) if n.translation else None,
                rotation=list(n.rotation) if n.rotation else None,
                scale=list(n.scale) if n.scale else None,
                children=child_ids or None,
                extras=n.extras,
            )
            return idx

        root_id = emit(root)
        pad4()

        materials, textures, images, samplers = self._build_materials()

        gltf = pg.GLTF2(
            asset=pg.Asset(version='2.0', generator='WalkthroughVisualizer modelgen 0.2',
                           extras=asset_extras),
            scene=0,
            scenes=[pg.Scene(nodes=[root_id])],
            nodes=gnodes,
            meshes=gmeshes,
            accessors=accessors,
            bufferViews=views,
            buffers=[pg.Buffer(byteLength=len(blob))],
            materials=materials,
            textures=textures,
            images=images,
            samplers=samplers,
        )
        gltf.set_binary_blob(bytes(blob))
        gltf.save_binary(path)

        return {
            'triangles': total_tris,
            'nodes': len(gnodes),
            'meshes': len(gmeshes),
            'materials': len(materials),
            'textures': len(textures),
            'bytes': len(blob),
        }
