#!/usr/bin/env node
/**
 * wv: the Walkthrough Visualizer asset pipeline.
 *
 *   wv inspect  <in.glb>                what is in this file, tagged or not
 *   wv validate <in.glb>                schema rules, exits non-zero on failure
 *   wv build    <in.glb> -o <outdir>    optimise into a shippable bundle
 *
 * Input can be the generator in this repo, a Blender export, or whatever comes
 * out of a client's 3ds Max or UE5 project. Tags are optional everywhere. An
 * untagged scene still optimises, it just gets an empty project.json.
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, quantize, textureCompress, resample,
} from '@gltf-transform/functions';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, join as pjoin, resolve } from 'node:path';
import sharp from 'sharp';

import { getTag, collectTags, VOLUME_TYPES, TAG_TYPES } from './lib/tags.mjs';
import { coplanarSummary } from './lib/coplanar.mjs';
import { mergeByMaterial, bakeTagVolumes } from './lib/merge.mjs';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// --------------------------------------------------------------------------- //
// Reporting
// --------------------------------------------------------------------------- //

function stats(doc) {
  const root = doc.getRoot();
  let prims = 0;
  let tris = 0;
  let verts = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      prims++;
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      verts += pos ? pos.getCount() : 0;
      tris += (idx ? idx.getCount() : (pos ? pos.getCount() : 0)) / 3;
    }
  }

  // What actually reaches the GPU. A mesh referenced by three nodes costs three
  // draws, so a primitive count understates an instanced scene badly, and the
  // build report ends up claiming a win nobody got.
  let drawCalls = 0;
  let renderedTris = 0;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      drawCalls++;
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      renderedTris += (idx ? idx.getCount() : (pos ? pos.getCount() : 0)) / 3;
    }
  }
  const tags = collectTags(doc);
  const byType = {};
  for (const { tag } of tags) byType[tag.type] = (byType[tag.type] || 0) + 1;

  return {
    nodes: root.listNodes().length,
    meshes: root.listMeshes().length,
    primitives: prims,
    triangles: Math.round(tris),
    vertices: verts,
    drawCalls,
    renderedTriangles: Math.round(renderedTris),
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    textureBytes: root.listTextures().reduce((a, t) => a + (t.getImage()?.byteLength || 0), 0),
    tags: byType,
    taggedNodes: tags.length,
  };
}

function fmtBytes(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

function printStats(label, s, fileBytes) {
  console.log(`\n  ${label}`);
  console.log('  ' + '-'.repeat(58));
  console.log(`  nodes      ${s.nodes}   meshes ${s.meshes}   primitives ${s.primitives}`);
  console.log(`  draw calls ${s.drawCalls}   (primitives x instances, whole scene)`);
  console.log(`  triangles  ${s.triangles.toLocaleString()} stored, `
    + `${s.renderedTriangles.toLocaleString()} drawn   vertices ${s.vertices.toLocaleString()}`);
  console.log(`  materials  ${s.materials}   textures ${s.textures} (${fmtBytes(s.textureBytes)})`);
  if (fileBytes) console.log(`  file       ${fmtBytes(fileBytes)}`);
  const tags = Object.entries(s.tags).sort();
  console.log(`  tags       ${tags.length ? tags.map(([k, v]) => `${k} ${v}`).join(' · ') : '(none)'}`);
}

// --------------------------------------------------------------------------- //
// Validate
// --------------------------------------------------------------------------- //

function validate(doc) {
  const errors = [];
  const warnings = [];
  const tags = collectTags(doc);
  const byId = new Map();
  const zones = new Set();
  const levels = [];

  for (const { node, tag } of tags) {
    if (!TAG_TYPES.has(tag.type)) {
      warnings.push(`unknown wv.type "${tag.type}" on ${node.getName()}`);
      continue;
    }
    if (tag.id) {
      if (byId.has(tag.id)) errors.push(`duplicate id "${tag.id}"`);
      byId.set(tag.id, tag);
    }
    if (tag.type === 'ZONE') zones.add(tag.id);
    if (tag.type === 'LEVEL') levels.push(tag);
  }

  for (const { node, tag } of tags) {
    switch (tag.type) {
      case 'PORTAL':
        if (!Array.isArray(tag.connects) || tag.connects.length !== 2) {
          errors.push(`PORTAL ${tag.id} must connect exactly two zones`);
        } else {
          for (const z of tag.connects) {
            if (!zones.has(z)) errors.push(`PORTAL ${tag.id} references missing zone "${z}"`);
          }
        }
        break;
      case 'ZONE':
        if (!tag.label) warnings.push(`ZONE ${tag.id} has no label`);
        if (!tag.category) warnings.push(`ZONE ${tag.id} has no category`);
        break;
      case 'POI':
        if (!tag.panel) warnings.push(`POI ${tag.id} has no panel content`);
        break;
      case 'LEVEL':
        if (typeof tag.elevation !== 'number') {
          errors.push(`LEVEL ${tag.id} has no numeric elevation`);
        }
        break;
      case 'CAM_TOUR': {
        const keys = node.listChildren().filter((c) => getTag(c)?.type === 'CAM_KEY');
        if (keys.length < 2) errors.push(`CAM_TOUR ${tag.id} has fewer than two stops`);
        break;
      }
      default:
        break;
    }
  }

  if (levels.length === 0) warnings.push('scene declares no LEVEL nodes');
  const hasNav = tags.some(({ tag }) => tag.type === 'NAV_FLOOR');
  if (levels.length && !hasNav) warnings.push('scene declares levels but no NAV_FLOOR');

  // Surfaces stacked within a few millimetres look fine in a still and shimmer
  // the moment the camera moves. Much cheaper to catch here than in a review.
  for (const scene of doc.getRoot().listScenes()) {
    const z = coplanarSummary(scene, { tolerance: 0.012, minArea: 0.5 });
    if (z.count) {
      const w = z.worst[0];
      warnings.push(`${z.count} overlapping same-facing surface pair(s), `
        + `${z.area.toFixed(1)} m2 total; worst is ${w.area.toFixed(1)} m2 at `
        + `${w.axis} = ${w.plane.toFixed(3)} with a ${(w.gap * 1000).toFixed(1)} mm gap. `
        + 'These will z-fight when the camera moves.');
    }
  }

  return { errors, warnings };
}

// --------------------------------------------------------------------------- //
// project.json
// --------------------------------------------------------------------------- //

function buildProject(doc, extra = {}) {
  const tags = collectTags(doc);
  const project = tags.find(({ tag }) => tag.type === 'PROJECT')?.tag || {};
  const levels = tags.filter(({ tag }) => tag.type === 'LEVEL')
    .map(({ tag }) => ({ id: tag.id, label: tag.label, elevation: tag.elevation }))
    .sort((a, b) => a.elevation - b.elevation);
  const zones = tags.filter(({ tag }) => tag.type === 'ZONE')
    .map(({ tag }) => ({
      id: tag.id, label: tag.label, category: tag.category ?? null,
      level: tag.level ?? null, area: tag.area ?? null, parent: tag.parent ?? null,
    }));
  const pois = tags.filter(({ tag }) => tag.type === 'POI')
    .map(({ tag }) => ({ id: tag.id, label: tag.label, level: tag.level ?? null, zone: tag.zone ?? null }));
  const tours = tags.filter(({ tag }) => tag.type === 'CAM_TOUR')
    .map(({ node, tag }) => ({
      id: tag.id,
      label: tag.label,
      level: tag.level ?? null,
      stops: node.listChildren().filter((c) => getTag(c)?.type === 'CAM_KEY').length,
    }));

  return {
    schema: '0.1',
    generated: extra.generated ?? null,
    project: {
      id: project.id ?? null,
      label: project.label ?? null,
      preset: project.preset ?? 'generic',
      units: project.units ?? 'metres',
    },
    scene: extra.scene ?? 'scene.glb',
    levels,
    counts: {
      zones: zones.length,
      pois: pois.length,
      portals: tags.filter(({ tag }) => tag.type === 'PORTAL').length,
      navFloors: tags.filter(({ tag }) => tag.type === 'NAV_FLOOR').length,
      navBlocks: tags.filter(({ tag }) => tag.type === 'NAV_BLOCK').length,
    },
    zones,
    pois,
    tours,
    budget: extra.budget ?? null,
  };
}

// --------------------------------------------------------------------------- //
// Commands
// --------------------------------------------------------------------------- //

async function cmdInspect(input) {
  const doc = await io.read(input);
  printStats(`inspect  ${basename(input)}`, stats(doc), statSync(input).size);
  const { errors, warnings } = validate(doc);
  if (errors.length) console.log(`\n  ${errors.length} error(s):\n` + errors.map((e) => `    ! ${e}`).join('\n'));
  if (warnings.length) console.log(`  ${warnings.length} warning(s)` + (warnings.length > 6 ? ' (first 6)' : '')
    + '\n' + warnings.slice(0, 6).map((w) => `    - ${w}`).join('\n'));
  console.log('');
}

async function cmdValidate(input) {
  const doc = await io.read(input);
  const { errors, warnings } = validate(doc);
  console.log(`\n  validate  ${basename(input)}`);
  console.log('  ' + '-'.repeat(58));
  for (const w of warnings) console.log(`  WARN  ${w}`);
  for (const e of errors) console.log(`  FAIL  ${e}`);
  console.log(`\n  ${errors.length} error(s), ${warnings.length} warning(s)\n`);
  return errors.length === 0;
}

async function cmdBuild(input, outDir, opts) {
  const doc = await io.read(input);
  const before = stats(doc);
  const beforeBytes = statSync(input).size;

  const { errors, warnings } = validate(doc);
  if (errors.length && !opts.force) {
    console.log('\n  Build refused, validation failed:');
    for (const e of errors) console.log(`    ! ${e}`);
    console.log('  Pass --force to build anyway.\n');
    return false;
  }

  const steps = [
    // keepLeaves is load-bearing. POI and CAM_KEY nodes are empties carrying
    // nothing but extras, and a default prune throws them out as unused.
    prune({ keepLeaves: true, keepAttributes: false }),
    dedup(),
    mergeByMaterial(),
    bakeTagVolumes(),
    // Second prune clears the placeholder box meshes that merging and baking
    // orphaned. keepLeaves still protects the tag nodes.
    prune({ keepLeaves: true }),
    weld(),
    resample(),
  ];

  if (!opts.noTextures) {
    steps.push(textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [opts.textureSize, opts.textureSize],
      quality: 82,
    }));
  }
  if (!opts.noQuantize) {
    // Positions keep all 16 bits. Dropping to 14 saves no bytes here, since the
    // attribute is int16 either way and there is no meshopt pass after this. It
    // does cost precision. The site mesh spans 140 m of context geometry, where
    // 14 bits is an 8.5 mm step, coarse enough to collapse deliberately offset
    // surfaces onto each other and start them z-fighting. 16 bits gives 2 mm.
    steps.push(quantize({
      pattern: /^(POSITION|NORMAL|TEXCOORD_0|COLOR_0)$/,
      quantizePosition: 16,
      quantizeNormal: 10,
      quantizeTexcoord: 12,
      quantizeColor: 8,
    }));
  }

  await doc.transform(...steps);

  mkdirSync(outDir, { recursive: true });
  const outGlb = pjoin(outDir, 'scene.glb');
  await io.write(outGlb, doc);

  const after = stats(doc);
  const afterBytes = statSync(outGlb).size;

  const budget = {
    drawCalls: after.drawCalls,
    primitives: after.primitives,
    triangles: after.renderedTriangles,
    textureBytes: after.textureBytes,
    fileBytes: afterBytes,
  };

  const project = buildProject(doc, {
    generated: opts.now,
    scene: 'scene.glb',
    budget,
  });
  writeFileSync(pjoin(outDir, 'project.json'), JSON.stringify(project, null, 2));

  const report = {
    input: resolve(input), output: resolve(outGlb),
    before: { ...before, fileBytes: beforeBytes },
    after: { ...after, fileBytes: afterBytes },
    warnings,
  };
  writeFileSync(pjoin(outDir, 'build-report.json'), JSON.stringify(report, null, 2));

  printStats('before', before, beforeBytes);
  printStats('after', after, afterBytes);

  const pct = (a, b) => (a === 0 ? 'n/a' : `${(((a - b) / a) * 100).toFixed(0)}% smaller`);
  console.log('\n  change');
  console.log('  ' + '-'.repeat(58));
  console.log(`  draw calls   ${before.drawCalls} -> ${after.drawCalls}`
    + `   (${pct(before.drawCalls, after.drawCalls)})`);
  console.log(`  primitives   ${before.primitives} -> ${after.primitives}`);
  console.log(`  nodes        ${before.nodes} -> ${after.nodes}`);
  console.log(`  materials    ${before.materials} -> ${after.materials}`);
  console.log(`  textures     ${fmtBytes(before.textureBytes)} -> ${fmtBytes(after.textureBytes)}`
    + `   (${pct(before.textureBytes, after.textureBytes)})`);
  console.log(`  file         ${fmtBytes(beforeBytes)} -> ${fmtBytes(afterBytes)}`
    + `   (${pct(beforeBytes, afterBytes)})`);
  if (warnings.length) console.log(`\n  ${warnings.length} validator warning(s), see build-report.json`);
  console.log(`\n  wrote ${outDir}/scene.glb, project.json, build-report.json\n`);
  return true;
}

// --------------------------------------------------------------------------- //
// Entry
// --------------------------------------------------------------------------- //

const argv = process.argv.slice(2);
const cmd = argv[0];
const input = argv[1];
const flag = (name, fallback) => {
  // Both -o and --out work. Everyone types -o.
  for (const form of [`--${name}`, `-${name}`]) {
    const i = argv.indexOf(form);
    if (i >= 0) return argv[i + 1] ?? true;
  }
  return fallback;
};
const has = (name) => argv.includes(`--${name}`);

function usage() {
  console.log(`
  wv: Walkthrough Visualizer asset pipeline

    wv inspect  <in.glb>
    wv validate <in.glb>
    wv build    <in.glb> -o <outdir> [--texture-size 1024] [--no-textures]
                                     [--no-quantize] [--force]
`);
}

if (!cmd || !input || has('help')) {
  usage();
  process.exit(cmd ? 1 : 0);
}
if (!existsSync(input)) {
  console.error(`\n  No such file: ${input}\n`);
  process.exit(2);
}

try {
  if (cmd === 'inspect') {
    await cmdInspect(input);
  } else if (cmd === 'validate') {
    process.exit((await cmdValidate(input)) ? 0 : 1);
  } else if (cmd === 'build') {
    const out = flag('o', null) || flag('out', null);
    if (!out) { console.error('\n  build needs -o <outdir>\n'); process.exit(2); }
    const ok = await cmdBuild(input, out, {
      textureSize: Number(flag('texture-size', 1024)),
      noTextures: has('no-textures'),
      noQuantize: has('no-quantize'),
      force: has('force'),
      now: new Date().toISOString(),
    });
    process.exit(ok ? 0 : 1);
  } else {
    usage();
    process.exit(2);
  }
} catch (err) {
  console.error(`\n  ${cmd} failed: ${err.message}\n`);
  if (process.env.WV_DEBUG) console.error(err);
  process.exit(1);
}
