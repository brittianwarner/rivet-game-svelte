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

export interface CarRig {
  root: THREE.Group;
  wheels: {
    frontLeft?: WheelRig;
    frontRight?: WheelRig;
    rearLeft?: WheelRig;
    rearRight?: WheelRig;
  };
  wheelSpinAxis: THREE.Vector3;
  anchors: CarRigAnchors;
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

  const wheelSpinAxis = new THREE.Vector3(1, 0, 0);
  if (wheels.frontLeft && wheels.frontRight) {
    wheelSpinAxis
      .copy(wheels.frontRight.pivot.position)
      .sub(wheels.frontLeft.pivot.position);

    if (wheelSpinAxis.lengthSq() > 1e-6) {
      wheelSpinAxis.normalize();
    } else {
      wheelSpinAxis.set(1, 0, 0);
    }
  }

  const finalBounds = new THREE.Box3().setFromObject(root);
  const finalSize = finalBounds.getSize(new THREE.Vector3());

  const anchors: CarRigAnchors = {
    frontLightX: Math.max(0.45, finalSize.x * 0.18),
    frontLightY: Math.max(0.35, finalSize.y * 0.3),
    frontLightZ: finalBounds.min.z + finalSize.z * 0.16,
    rearLightX: Math.max(0.35, finalSize.x * 0.15),
    rearLightY: Math.max(0.3, finalSize.y * 0.27),
    rearLightZ: finalBounds.max.z - finalSize.z * 0.12,
    nameY: finalBounds.max.y + 0.55,
    rearEffectZ: finalBounds.max.z - finalSize.z * 0.2,
  };

  return {
    root,
    wheels,
    wheelSpinAxis,
    anchors,
  };
}
