/**
 * Reads the wv tag schema off a glTF Document.
 *
 * Same two-source rule as the runtime: extras.wv first, then the
 * WV_<TYPE>__<id>__<label> name convention for DCC tools that cannot write
 * extras. Keep both paths. A 3ds Max export carries its tags in node names
 * only, and dropping that path loses every tag in the scene with no error.
 */

export const TAG_TYPES = new Set([
  'PROJECT', 'LEVEL', 'ZONE', 'NAV_FLOOR', 'NAV_BLOCK', 'PORTAL',
  'POI', 'CAM_TOUR', 'CAM_KEY', 'VARIANT_SET', 'VARIANT', 'DEST',
]);

/** Types whose geometry is a measuring box the build pass bakes away. */
export const VOLUME_TYPES = new Set(['ZONE', 'NAV_FLOOR', 'NAV_BLOCK', 'PORTAL']);

export function tagFromName(name) {
  if (!name || !name.startsWith('WV_')) return null;
  const parts = name.slice(3).split('__');
  if (parts.length < 2) return null;
  const wv = { type: parts[0], id: parts[1] };
  if (parts[2]) wv.label = parts[2].replace(/_/g, ' ');
  return wv;
}

export function getTag(node) {
  const extras = node.getExtras?.() || {};
  if (extras.wv && extras.wv.type) return extras.wv;
  return tagFromName(node.getName?.() || '');
}

export function isTagged(node) {
  const t = getTag(node);
  return !!(t && t.type);
}

/** Depth-first walk. Each visit gets the node's nearest tagged ancestor. */
export function walkScene(scene, visit) {
  const stack = scene.listChildren().map((n) => ({ node: n, boundary: null }));
  while (stack.length) {
    const { node, boundary } = stack.pop();
    const tag = getTag(node);
    visit(node, boundary, tag);
    const next = tag && tag.type ? node : boundary;
    for (const c of node.listChildren()) stack.push({ node: c, boundary: next });
  }
}

/** Every tag in the document, with the node it came from. */
export function collectTags(doc) {
  const out = [];
  for (const scene of doc.getRoot().listScenes()) {
    walkScene(scene, (node, _boundary, tag) => {
      if (tag && tag.type) out.push({ node, tag });
    });
  }
  return out;
}
