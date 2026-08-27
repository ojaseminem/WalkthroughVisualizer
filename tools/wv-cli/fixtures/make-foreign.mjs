/**
 * An awkward fixture standing in for a client export: no wv tags, deep nesting,
 * materials duplicated under different names, non-uniform node scales, a Z-up
 * rotation on the root. Roughly what turns up from 3ds Max or UE5. The pipeline
 * has to survive it with no tags to lean on.
 */
import { NodeIO, Document } from '@gltf-transform/core';

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('Master Scene');

function boxPrim(mat, sx = 1, sy = 1, sz = 1) {
  const p = [], n = [], uv = [];
  const faces = [
    [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,-1]],
    [[0,0,sz],[0,sy,sz],[sx,sy,sz],[sx,0,sz],[0,0,1]],
    [[0,0,0],[0,sy,0],[0,sy,sz],[0,0,sz],[-1,0,0]],
    [[sx,0,0],[sx,0,sz],[sx,sy,sz],[sx,sy,0],[1,0,0]],
    [[0,0,0],[0,0,sz],[sx,0,sz],[sx,0,0],[0,-1,0]],
    [[0,sy,0],[sx,sy,0],[sx,sy,sz],[0,sy,sz],[0,1,0]],
  ];
  for (const [a,b,c,d,nv] of faces) {
    for (const v of [a,b,c, a,c,d]) { p.push(...v); n.push(...nv); uv.push(v[0], v[1]); }
  }
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(n)).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buffer));
  return prim;
}

// Ten materials that are really three. Standard export artefact.
const mats = [];
for (let i = 0; i < 10; i++) {
  mats.push(doc.createMaterial(`Material__${i}`)
    .setBaseColorFactor([0.5 + (i % 3) * 0.2, 0.5, 0.5, 1])
    .setRoughnessFactor(0.8));
}

let deep = doc.createNode('Root_Group').setRotation([-0.7071, 0, 0, 0.7071]); // Z-up import
scene.addChild(deep);
for (let level = 0; level < 4; level++) {
  const g = doc.createNode(`Group_${level}`).setTranslation([0, 0, level * 3]);
  deep.addChild(g);
  deep = g;
  for (let i = 0; i < 8; i++) {
    const mesh = doc.createMesh(`Mesh_${level}_${i}`);
    mesh.addPrimitive(boxPrim(mats[(level * 8 + i) % mats.length], 1 + i * 0.1, 1, 1));
    g.addChild(doc.createNode(`Obj_${level}_${i}`)
      .setMesh(mesh)
      .setTranslation([i * 1.5, 0, 0])
      .setScale([1, 1 + i * 0.05, 1]));
  }
}

await new NodeIO().write(process.argv[2] || 'tools/wv-cli/fixtures/foreign.glb', doc);
console.log('wrote foreign fixture');
