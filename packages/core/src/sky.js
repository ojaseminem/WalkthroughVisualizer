import * as THREE from 'three';

/**
 * The sky, and the environment light that comes from it.
 *
 * three.js ships RoomEnvironment, but it is a white box with rectangular area
 * lights in the ceiling. Everything lit by it picks up soft highlights from
 * four directions and reads like a product shot. A window wants a bright sky
 * with a hot spot at the sun and warm bounce off the ground, which is what this
 * shader draws.
 *
 * The environment map is generated from the same preset that drives the sun, so
 * switching to evening moves the sun, warms the direct light, dims and reddens
 * everything indirect and changes what you see through the glass in one go.
 * Before this the indirect light stayed put all day and the interiors barely
 * changed between presets. Both maps come off the same shader, so the visible
 * sky and the light in the room cannot drift apart.
 */

const VERT = `
  varying vec3 vDir;
  void main() {
    vDir = position;
    // The dome is drawn with the camera's rotation only. Stripping the
    // translation keeps it infinitely far away, so walking never approaches it.
    vec4 p = projectionMatrix * mat4(mat3(modelViewMatrix)) * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

const FRAG = `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform float uBounce;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uSunIntensity;
  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);

    // Sky above, ground below, and a band across the horizon that is neither.
    // The power curves keep the gradient tight near the horizon and slack
    // overhead, which is how the real thing falls off.
    float up = d.y;
    vec3 col;
    if (up >= 0.0) {
      col = mix(uHorizon, uZenith, pow(clamp(up, 0.0, 1.0), 0.42));
    } else {
      col = mix(uHorizon, uGround * uBounce, pow(clamp(-up, 0.0, 1.0), 0.30));
    }

    // The sun disc plus the glow around it. The glow is most of the light that
    // reaches into a room. Without it the environment lights everything evenly
    // from a flat dome.
    float cosA = dot(d, uSunDir);
    float disc = smoothstep(0.9985, 0.9995, cosA);
    float glow = pow(clamp(cosA, 0.0, 1.0), 26.0) * 0.55
               + pow(clamp(cosA, 0.0, 1.0), 5.0) * 0.13;
    float above = smoothstep(-0.06, 0.10, uSunDir.y);   // no sun once it has set
    col += uSunColor * (disc * 34.0 + glow) * uSunIntensity * above;

    gl_FragColor = vec4(col, 1.0);
  }
`;

function srgb(hex) {
  return new THREE.Color(hex).convertSRGBToLinear();
}

/** Sun direction from a preset's azimuth and elevation, matching index.js. */
export function sunDirection(sun) {
  const ce = Math.cos(sun.elevation);
  return new THREE.Vector3(
    Math.cos(sun.azimuth) * ce,
    Math.sin(sun.elevation),
    Math.sin(sun.azimuth) * ce,
  ).normalize();
}

export class SkyDome {
  constructor() {
    this.uniforms = {
      uZenith: { value: srgb(0x4d7fbf) },
      uHorizon: { value: srgb(0xcfdae4) },
      uGround: { value: srgb(0x8c8371) },
      uBounce: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: srgb(0xffffff) },
      uSunIntensity: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      toneMapped: true,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    this.mesh.frustumCulled = false;
    // Behind everything else. depthTest is off, so renderOrder is all that
    // holds it there.
    this.mesh.renderOrder = -1000;
  }

  /**
   * Point the dome at a time of day.
   *
   * Zenith and ground come off the preset's own sky and bounce colours so the
   * dome, the hemisphere light and the fog all agree. The horizon sits between
   * the two, which stops the join between sky and ground reading as a hard line
   * in the dollhouse view.
   */
  apply(preset) {
    const sky = srgb(preset.sky);
    const ground = srgb(preset.groundBounce);
    // Scaled well past 1. The preset colours are what a designer picks off a
    // swatch, so they describe a surface reflecting light, whereas a sky is the
    // light itself. Feed the swatch value in raw and midday tone maps to navy
    // with nothing coming through the windows. These multipliers put the dome
    // back in the range a sky occupies, and the dome is what gets baked into
    // the environment map, so the room brightens with it.
    const lum = preset.skyLuminance ?? 1;
    this.uniforms.uZenith.value.copy(sky).multiplyScalar(2.1 * lum);
    this.uniforms.uHorizon.value.copy(sky).lerp(ground, 0.40).multiplyScalar(3.0 * lum);
    this.uniforms.uGround.value.copy(ground).multiplyScalar(0.62 * lum);
    this.uniforms.uSunDir.value.copy(sunDirection(preset.sun));
    this.uniforms.uSunColor.value.copy(srgb(preset.sun.color));
    this.uniforms.uSunIntensity.value = preset.sun.intensity / 2.5;
  }

  /**
   * Bake the current sky into an environment map.
   *
   * Uses its own mesh. The PMREM pass renders from inside a unit cube, and the
   * visible dome has depth writing off and a hand-rolled projection that ignores
   * the camera translation, so it bakes to nothing useful.
   */
  toEnvironment(renderer, pmrem, bounce = 1) {
    const scene = new THREE.Scene();
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: false,
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), mat);
    scene.add(box);
    // The lower half is lifted for the bake only, then put back.
    //
    // Outdoors the ground is dark and the sky is bright, and a dome built that
    // way is right for the facade. Indoors it is wrong. The ceiling is the one
    // surface facing down, so it is lit entirely by the dark half and comes out
    // the colour of cardboard with white walls beside it. What lights a ceiling
    // is the floor of the room it is in, and an outdoor sky map has no way of
    // knowing that room exists. Real interior bounce arrives with the baked
    // lightmaps. This is the stand-in until then and it costs one uniform.
    const wasBounce = this.uniforms.uBounce.value;
    const wasGround = this.uniforms.uGround.value.clone();
    this.uniforms.uBounce.value = bounce;
    // Pull the ground colour toward the horizon as it is lifted. Indoor bounce
    // comes off pale tile and timber, not off earth, and leaving it at the
    // outdoor tint gave every ceiling a tan cast against cool grey walls. The
    // split between the two was the most obvious thing wrong with the interiors.
    this.uniforms.uGround.value.lerp(this.uniforms.uHorizon.value, 0.55);
    const target = pmrem.fromScene(scene, 0.04);
    this.uniforms.uBounce.value = wasBounce;
    this.uniforms.uGround.value.copy(wasGround);
    box.geometry.dispose();
    mat.dispose();
    // The whole target, not just its texture. Returning the texture alone left
    // the framebuffer behind on every time-of-day switch.
    return target;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
