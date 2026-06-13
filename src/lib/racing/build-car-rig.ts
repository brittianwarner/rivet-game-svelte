import * as THREE from "three";
import type { RaceCarDefinition } from "./car-catalog.js";

export interface WheelRig {
  pivot: THREE.Group;
  spin: THREE.Group;
}

export interface CarRigAnchors {
  frontLightX: number;
  frontLightY: number;
  frontLightZ: number;
  rearLightX: number;
  rearLightY: number;
  rearLightZ: number;
  nameY: number;
  rearEffectZ: number;
}

/**
 * A per-rig body material whose base look is cached at build time so Kart.svelte
 * can drive transient status tints (hit flash, star rainbow, shrunk blue-grey)
 * and then restore the exact original color/emissive afterwards. Materials are
 * cloned per rig (the source GLTF shares materials across all 20 cars and every
 * kart instance), so writing to one kart's body never bleeds into another.
 */
export interface BodyMaterial {
  material: THREE.MeshStandardMaterial;
  /** Original base color (sRGB) */
  baseColor: THREE.Color;
  /** Original emissive color */
  baseEmissive: THREE.Color;
  /** Original emissiveIntensity */
  baseEmissiveIntensity: number;
}

export interface CarRig {
  root: THREE.Group;
  wheels: {
    frontLeft?: WheelRig;
    frontRight?: WheelRig;
    rearLeft?: WheelRig;
    rearRight?: WheelRig;
  };
  wheelSpinAxis: THREE.Vector3;
  steerAxis: THREE.Vector3;
  anchors: CarRigAnchors;
  /** Cloned, per-rig body materials with their base look cached for status VFX. */
  bodyMaterials: BodyMaterial[];
}

function makeWheelRig(
  root: THREE.Object3D,
  wheelObject: THREE.Object3D | undefined,
): WheelRig | undefined {
  if (!wheelObject || !wheelObject.parent) return undefined;

  root.updateMatrixWorld(true);

  const parent = wheelObject.parent;
  const wheelBounds = new THREE.Box3().setFromObject(wheelObject);
  const wheelCenterWorld = wheelBounds.getCenter(new THREE.Vector3());
  const wheelCenterLocal = parent.worldToLocal(wheelCenterWorld.clone());

  const pivot = new THREE.Group();
  pivot.name = `${wheelObject.name}__pivot`;
  pivot.position.copy(wheelCenterLocal);

  const spin = new THREE.Group();
  spin.name = `${wheelObject.name}__spin`;

  parent.add(pivot);
  pivot.add(spin);
  spin.attach(wheelObject);

  return { pivot, spin };
}

export function buildCarRig(
  scene: THREE.Object3D,
  car: RaceCarDefinition,
): CarRig | null {
  const sourceRoot = scene.getObjectByName(car.rootNode);
  if (!sourceRoot) {
    console.warn(`[Kart] Missing curated car root: ${car.rootNode}`);
    return null;
  }

  const clonedRoot = sourceRoot.clone(true) as THREE.Group;

  // THREE's Object3D.clone() SHARES materials with the source — and the source
  // is itself shared across every car in the pack and every kart instance. To
  // tint a single kart's body for status VFX without bleeding the tint onto
  // every other kart, clone each material once per rig (dedup by source so
  // multi-material meshes that reuse a material keep sharing within this rig)
  // and cache the base look for exact restoration.
  const bodyMaterials: BodyMaterial[] = [];
  const clonedBySource = new Map<THREE.Material, THREE.Material>();
  const cloneMaterial = (src: THREE.Material): THREE.Material => {
    const existing = clonedBySource.get(src);
    if (existing) return existing;
    const cloned = src.clone();
    clonedBySource.set(src, cloned);
    if ((cloned as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      const std = cloned as THREE.MeshStandardMaterial;
      bodyMaterials.push({
        material: std,
        baseColor: std.color.clone(),
        baseEmissive: std.emissive.clone(),
        baseEmissiveIntensity: std.emissiveIntensity,
      });
    }
    return cloned;
  };

  clonedRoot.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => cloneMaterial(m));
    } else if (mesh.material) {
      mesh.material = cloneMaterial(mesh.material);
    }
  });

  const root = new THREE.Group();
  root.name = `${car.id}__root`;

  const model = new THREE.Group();
  model.name = `${car.id}__model`;
  model.rotation.y = car.rotationY;
  root.add(model);
  model.add(clonedRoot);

  const bodyRoot = clonedRoot.getObjectByName(car.bodyNode);
  const wheelsRoot = clonedRoot.getObjectByName(car.wheelsNode);
  if (!bodyRoot || !wheelsRoot) {
    console.warn(
      `[Kart] Incomplete curated car mapping for ${car.id}:`,
      car.bodyNode,
      car.wheelsNode,
    );
  }

  const wheels = {
    frontLeft: makeWheelRig(
      root,
      clonedRoot.getObjectByName(car.wheels.frontLeft) ?? undefined,
    ),
    frontRight: makeWheelRig(
      root,
      clonedRoot.getObjectByName(car.wheels.frontRight) ?? undefined,
    ),
    rearLeft: makeWheelRig(
      root,
      clonedRoot.getObjectByName(car.wheels.rearLeft) ?? undefined,
    ),
    rearRight: makeWheelRig(
      root,
      clonedRoot.getObjectByName(car.wheels.rearRight) ?? undefined,
    ),
  };

  root.updateMatrixWorld(true);

  const unscaledBounds = new THREE.Box3().setFromObject(root);
  const unscaledCenter = unscaledBounds.getCenter(new THREE.Vector3());
  model.position.x -= unscaledCenter.x;
  model.position.z -= unscaledCenter.z;

  let wheelMinY = Number.POSITIVE_INFINITY;
  for (const wheel of Object.values(wheels)) {
    if (!wheel) continue;
    const wheelBounds = new THREE.Box3().setFromObject(wheel.pivot);
    wheelMinY = Math.min(wheelMinY, wheelBounds.min.y);
  }

  if (!Number.isFinite(wheelMinY)) {
    wheelMinY = unscaledBounds.min.y;
  }

  model.position.y -= wheelMinY;

  root.scale.setScalar(car.scale);
  root.updateMatrixWorld(true);

  // The GLTF car nodes carry a baked +90° X rotation (wheel-parent local Y maps
  // to rig +Z nose, local Z maps to rig −Y), so wheel-pivot-local axes do not
  // match rig-space axes. Derive both wheel axes by mapping the rig-space axes
  // into the pivot parent's local frame: rig +X (the left-pointing axle, which
  // rolls wheels FORWARD when spun positively) and rig +Y (up, the axis front
  // wheels must yaw around when steering instead of camber-leaning).
  const wheelSpinAxis = new THREE.Vector3(1, 0, 0);
  const steerAxis = new THREE.Vector3(0, 1, 0);
  const referencePivot =
    wheels.frontLeft?.pivot ??
    wheels.frontRight?.pivot ??
    wheels.rearLeft?.pivot ??
    wheels.rearRight?.pivot;
  if (referencePivot?.parent) {
    const parentWorldInverse = new THREE.Matrix4()
      .copy(referencePivot.parent.matrixWorld)
      .invert();
    wheelSpinAxis.set(1, 0, 0).transformDirection(parentWorldInverse);
    steerAxis.set(0, 1, 0).transformDirection(parentWorldInverse);
  }

  const finalBounds = new THREE.Box3().setFromObject(root);
  const finalSize = finalBounds.getSize(new THREE.Vector3());

  // Rig space: the nose points +Z (max.z) and the tail −Z (min.z), matching
  // the kart group where rotation.y = heading maps local +Z to world forward.
  const anchors: CarRigAnchors = {
    frontLightX: Math.max(0.45, finalSize.x * 0.18),
    frontLightY: Math.max(0.35, finalSize.y * 0.3),
    frontLightZ: finalBounds.max.z - finalSize.z * 0.16,
    rearLightX: Math.max(0.35, finalSize.x * 0.15),
    rearLightY: Math.max(0.3, finalSize.y * 0.27),
    rearLightZ: finalBounds.min.z + finalSize.z * 0.12,
    nameY: finalBounds.max.y + 0.55,
    rearEffectZ: finalBounds.min.z + finalSize.z * 0.2,
  };

  return {
    root,
    wheels,
    wheelSpinAxis,
    steerAxis,
    anchors,
    bodyMaterials,
  };
}
