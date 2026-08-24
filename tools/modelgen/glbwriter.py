"""Minimal glTF/GLB writer built on pygltflib.

Owns exactly one concern: turning material-grouped triangle soup plus a node tree
into a valid .glb with `extras` preserved on every node. Nothing in here knows
what a building is.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Iterable

import numpy as np
import pygltflib as pg


# --------------------------------------------------------------------------- #
# Geometry accumulation
# --------------------------------------------------------------------------- #

class MeshBuilder:
    """Accumulates flat-shaded triangles, grouped by material index."""

    def __init__(self) -> None:
        # material index -> (positions list, normals list)
        self._groups: dict[int, tuple[list, list]] = {}

    def _group(self, mat: int) -> tuple[list, list]:
        if mat not in self._groups:
            self._groups[mat] = ([], [])
        return self._groups[mat]

    def tri(self, a, b, c, mat: int) -> None:
        pos, nrm = self._group(mat)
        va, vb, vc = np.asarray(a, np.float64), np.asarray(b, np.float64), np.asarray(c, np.float64)
        n = np.cross(vb - va, vc - va)
        ln = np.linalg.norm(n)
        if ln < 1e-12:
            return  # degenerate, drop it
        n = n / ln
        pos.extend([va, vb, vc])
        nrm.extend([n, n, n])

    def quad(self, a, b, c, d, mat: int) -> None:
        """Vertices in counter-clockwise order when viewed from the front."""
        self.tri(a, b, c, mat)
        self.tri(a, c, d, mat)

    def box(self, lo, hi, mat: int, faces: str = "xXyYzZ") -> None:
        """Axis-aligned box from lo=(x0,y0,z0) to hi=(x1,y1,z1).

        `faces` selects which faces to emit — lowercase is the negative side,
        uppercase the positive. Dropping unseen faces is the cheapest win in the
        whole pipeline, so callers are encouraged to use it.
        """
        x0, y0, z0 = (min(lo[i], hi[i]) for i in range(3))
        x1, y1, z1 = (max(lo[i], hi[i]) for i in range(3))
        if x1 - x0 < 1e-9 or y1 - y0 < 1e-9 or z1 - z0 < 1e-9:
            return

        if "z" in faces:  # -Z
            self.quad((x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0), mat)
        if "Z" in faces:  # +Z
            self.quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1), mat)
        if "x" in faces:  # -X
            self.quad((x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0), mat)
        if "X" in faces:  # +X
            self.quad((x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1), mat)
        if "y" in faces:  # -Y
            self.quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), mat)
        if "Y" in faces:  # +Y
            self.quad((x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0), mat)

    def is_empty(self) -> bool:
        return not any(len(p) for p, _ in self._groups.values())

    def groups(self) -> Iterable[tuple[int, np.ndarray, np.ndarray]]:
        for mat in sorted(self._groups):
            pos, nrm = self._groups[mat]
            if not pos:
                continue
            yield mat, np.asarray(pos, np.float32), np.asarray(nrm, np.float32)

    def triangle_count(self) -> int:
        return sum(len(p) for p, _ in self._groups.values()) // 3


# --------------------------------------------------------------------------- #
# Scene description
# --------------------------------------------------------------------------- #

@dataclass
class Material:
    name: str
    color: tuple[float, float, float, float]
    metallic: float = 0.0
    roughness: float = 0.85
    emissive: tuple[float, float, float] = (0.0, 0.0, 0.0)
    double_sided: bool = False


@dataclass
class Node:
    name: str
    mesh: int | None = None
    translation: tuple[float, float, float] | None = None
    rotation: tuple[float, float, float, float] | None = None
    scale: tuple[float, float, float] | None = None
    extras: dict | None = None
    children: list["Node"] = field(default_factory=list)

    def add(self, child: "Node") -> "Node":
        self.children.append(child)
        return child


# --------------------------------------------------------------------------- #
# Writer
# --------------------------------------------------------------------------- #

class GlbWriter:
    def __init__(self) -> None:
        self.materials: list[Material] = []
        self._mat_index: dict[str, int] = {}
        self.meshes: list[tuple[str, MeshBuilder]] = []

    def material(self, m: Material) -> int:
        if m.name in self._mat_index:
            return self._mat_index[m.name]
        idx = len(self.materials)
        self.materials.append(m)
        self._mat_index[m.name] = idx
        return idx

    def mesh(self, name: str, builder: MeshBuilder) -> int:
        self.meshes.append((name, builder))
        return len(self.meshes) - 1

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
            views.append(pg.BufferView(buffer=0, byteOffset=offset, byteLength=len(data), target=target))
            return len(views) - 1

        total_tris = 0
        for mesh_name, builder in self.meshes:
            prims: list[pg.Primitive] = []
            for mat, pos, nrm in builder.groups():
                count = len(pos)
                total_tris += count // 3

                v_pos = add_view(pos.tobytes(), pg.ARRAY_BUFFER)
                accessors.append(pg.Accessor(
                    bufferView=v_pos, componentType=pg.FLOAT, count=count, type=pg.VEC3,
                    min=pos.min(axis=0).tolist(), max=pos.max(axis=0).tolist(),
                ))
                a_pos = len(accessors) - 1

                v_nrm = add_view(nrm.tobytes(), pg.ARRAY_BUFFER)
                accessors.append(pg.Accessor(
                    bufferView=v_nrm, componentType=pg.FLOAT, count=count, type=pg.VEC3,
                ))
                a_nrm = len(accessors) - 1

                idx = np.arange(count, dtype=np.uint32)
                v_idx = add_view(idx.tobytes(), pg.ELEMENT_ARRAY_BUFFER)
                accessors.append(pg.Accessor(
                    bufferView=v_idx, componentType=pg.UNSIGNED_INT, count=count, type=pg.SCALAR,
                    min=[0], max=[int(count - 1)],
                ))
                a_idx = len(accessors) - 1

                prims.append(pg.Primitive(
                    attributes=pg.Attributes(POSITION=a_pos, NORMAL=a_nrm),
                    indices=a_idx, material=mat, mode=pg.TRIANGLES,
                ))
            gmeshes.append(pg.Mesh(name=mesh_name, primitives=prims))

        gnodes: list[pg.Node] = []

        def emit(n: Node) -> int:
            idx = len(gnodes)
            gnodes.append(pg.Node(name=n.name))  # placeholder, keeps index stable
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

        gltf = pg.GLTF2(
            asset=pg.Asset(version="2.0", generator="WalkthroughVisualizer modelgen 0.1",
                           extras=asset_extras),
            scene=0,
            scenes=[pg.Scene(nodes=[root_id])],
            nodes=gnodes,
            meshes=gmeshes,
            accessors=accessors,
            bufferViews=views,
            buffers=[pg.Buffer(byteLength=len(blob))],
            materials=[
                pg.Material(
                    name=m.name,
                    pbrMetallicRoughness=pg.PbrMetallicRoughness(
                        baseColorFactor=list(m.color),
                        metallicFactor=m.metallic,
                        roughnessFactor=m.roughness,
                    ),
                    emissiveFactor=list(m.emissive),
                    doubleSided=m.double_sided,
                    alphaMode="BLEND" if m.color[3] < 1.0 else "OPAQUE",
                )
                for m in self.materials
            ],
        )
        gltf.set_binary_blob(bytes(blob))
        gltf.save_binary(path)

        return {
            "triangles": total_tris,
            "nodes": len(gnodes),
            "meshes": len(gmeshes),
            "materials": len(self.materials),
            "bytes": len(blob),
        }
