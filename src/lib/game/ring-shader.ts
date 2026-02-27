/**
 * ring-shader.ts — Fresnel rim glow shader for orbiting torus rings.
 *
 * View-dependent edge glow creates a neon tube effect. The ring appears
 * mostly transparent face-on and bright at grazing angles. A subtle
 * time-based pulse prevents static appearance at idle.
 *
 * Targets GLSL ES 1.00 (WebGL 1 compatible). Explicit precision qualifiers
 * ensure correct behavior on mobile GPUs (iOS Safari, Android Chrome).
 */

export const ringVertexShader = /* glsl */ `
  precision highp float;

  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPos.xyz);
    gl_Position = projectionMatrix * mvPos;
  }
`;

export const ringFragmentShader = /* glsl */ `
  precision mediump float;

  uniform vec3 uColor;
  uniform float uTime;
  uniform float uIntensity;

  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    float fresnel = pow(1.0 - abs(dot(vNormal, vViewDir)), 2.0);
    float pulse = 0.85 + 0.15 * sin(uTime * 3.0);
    float glow = fresnel * uIntensity * pulse;
    // gl_FragColor is intentional — targets GLSL ES 1.00 for WebGL 1 compat
    gl_FragColor = vec4(uColor * glow, glow * 0.9);
  }
`;
