export const PLAYER_ACCENT_COLORS = [
  "#FF4444",
  "#44AAFF",
  "#44FF88",
  "#FFAA44",
] as const;

export type PlayerAccentColor = (typeof PLAYER_ACCENT_COLORS)[number];

/**
 * Per-car handling multipliers applied on top of the shared base physics
 * constants (KART_MAX_SPEED / KART_ACCELERATION / KART_TURN_RATE / drift
 * charge gain / collision mass). Every value is kept within ±~12% of 1.0 so
 * each archetype trades one strength for another and no car is strictly best
 * (lap-time spread stays inside ~3% on track1).
 */
export type CarStats = {
  /** Scales the top-speed cap */
  maxSpeedMult: number;
  /** Scales throttle acceleration */
  accelMult: number;
  /** Scales the base turn rate (cornering grip) */
  turnMult: number;
  /** Scales how fast drift charge builds toward each boost tier */
  driftChargeMult: number;
  /** Relative mass for kart-kart collisions (heavier shoves lighter further) */
  massMult: number;
};

/** Neutral stats — the fallback when a car id is unknown. */
export const NEUTRAL_CAR_STATS: CarStats = {
  maxSpeedMult: 1,
  accelMult: 1,
  turnMult: 1,
  driftChargeMult: 1,
  massMult: 1,
};

type RaceCarCatalogData = {
  id: string;
  name: string;
  tagline: string;
  rootNode: string;
  bodyNode: string;
  wheelsNode: string;
  wheels: {
    frontLeft: string;
    frontRight: string;
    rearLeft: string;
    rearRight: string;
  };
  scale: number;
  rotationY: number;
  /** Handling archetype — see CarStats */
  stats: CarStats;
};

const CURATED_RACE_CAR_DATA = [
  {
    id: "baguette-builder",
    name: "Baguette Builder",
    tagline: "Boxy rally bruiser",
    rootNode: "Baguette_Builder_25",
    bodyNode: "Body_11",
    wheelsNode: "Wheels_24",
    wheels: {
      frontLeft: "Front_Wheel_1_14",
      frontRight: "Front_Wheel_2_17",
      rearLeft: "Rear_Wheel_1_20",
      rearRight: "Rear_Wheel_2_23",
    },
    scale: 0.68,
    rotationY: 0,
    // Heavy rally bruiser: highest top speed + mass, sluggish off the line.
    stats: {
      maxSpeedMult: 1.04,
      accelMult: 0.92,
      turnMult: 0.94,
      driftChargeMult: 1.0,
      massMult: 1.25,
    },
  },
  {
    id: "lazergini-centari",
    name: "Lazergini Centari",
    tagline: "Low-slung hypercar",
    rootNode: "Lazergini_Centari_442",
    bodyNode: "Body.005_404",
    wheelsNode: "Wheels.004_441",
    wheels: {
      frontLeft: "Front_Wheel_1.005_413",
      frontRight: "Front_Wheel_2.005_422",
      rearLeft: "Rear_Wheel_1.005_431",
      rearRight: "Rear_Wheel_2.005_440",
    },
    scale: 0.68,
    rotationY: 0,
    // Grippy hypercar: best cornering + quick top speed, slightly light.
    stats: {
      maxSpeedMult: 1.03,
      accelMult: 0.97,
      turnMult: 1.08,
      driftChargeMult: 1.0,
      massMult: 0.95,
    },
  },
  {
    id: "macrain-jetttail",
    name: "Macrain Jetttail",
    tagline: "Retro futurist coupe",
    rootNode: "Macrain_Jetttail_869",
    bodyNode: "Body.009_777",
    wheelsNode: "Wheels.007_868",
    wheels: {
      frontLeft: "Front_Wheel_1.009_800",
      frontRight: "Front_Wheel_2.009_823",
      rearLeft: "Rear_Wheel_1.009_845",
      rearRight: "Rear_Wheel_2.009_867",
    },
    scale: 0.66,
    rotationY: 0,
    // Drift specialist: charges boosts fastest, nimble, modest top speed.
    stats: {
      maxSpeedMult: 0.99,
      accelMult: 1.02,
      turnMult: 1.04,
      driftChargeMult: 1.2,
      massMult: 1.0,
    },
  },
  {
    id: "raycan-nevada",
    name: "Raycan Nevada",
    tagline: "Modern electric GT",
    rootNode: "Raycan_Nevada_1363",
    bodyNode: "Body.015_1313",
    wheelsNode: "Wheels.013_1362",
    wheels: {
      frontLeft: "Front_Wheel_1.015_1325",
      frontRight: "Front_Wheel_2.014_1337",
      rearLeft: "Rear_Wheel_1.015_1349",
      rearRight: "Rear_Wheel_2.015_1361",
    },
    scale: 0.7,
    rotationY: 0,
    // Sprinter: explosive acceleration + light, gives up a little top speed.
    stats: {
      maxSpeedMult: 0.98,
      accelMult: 1.12,
      turnMult: 1.0,
      driftChargeMult: 1.0,
      massMult: 0.9,
    },
  },
] as const satisfies readonly RaceCarCatalogData[];

export type RaceCarId = (typeof CURATED_RACE_CAR_DATA)[number]["id"];

export type RaceCarDefinition = (typeof CURATED_RACE_CAR_DATA)[number];

export const CURATED_RACE_CARS: readonly RaceCarDefinition[] = CURATED_RACE_CAR_DATA;

export const DEFAULT_RACE_CAR_ID: RaceCarId = CURATED_RACE_CARS[0].id;

const LEGACY_VARIANT_TO_CAR_ID: readonly RaceCarId[] = CURATED_RACE_CARS.map(
  (car) => car.id,
);

const RACE_CAR_IDS = new Set<RaceCarId>(LEGACY_VARIANT_TO_CAR_ID);

const RACE_CAR_MAP: Record<RaceCarId, RaceCarDefinition> = Object.fromEntries(
  CURATED_RACE_CARS.map((car) => [car.id, car]),
) as Record<RaceCarId, RaceCarDefinition>;

export function getRaceCar(carId: RaceCarId): RaceCarDefinition {
  return RACE_CAR_MAP[carId] ?? RACE_CAR_MAP[DEFAULT_RACE_CAR_ID];
}

/**
 * Handling stats for a car id. Accepts unknown / legacy values and falls back
 * to neutral 1.0 multipliers so the physics step is safe for any kart.carId
 * (including the reconnect-grace path where carId may be loosely typed).
 */
export function getCarStats(carId: unknown): CarStats {
  if (isRaceCarId(carId)) {
    return RACE_CAR_MAP[carId].stats;
  }
  return NEUTRAL_CAR_STATS;
}

export function isRaceCarId(value: unknown): value is RaceCarId {
  return typeof value === "string" && RACE_CAR_IDS.has(value as RaceCarId);
}

export function raceCarIdFromLegacyVariant(value: number): RaceCarId {
  if (!Number.isFinite(value)) return DEFAULT_RACE_CAR_ID;
  const clamped = Math.max(
    0,
    Math.min(LEGACY_VARIANT_TO_CAR_ID.length - 1, Math.floor(value)),
  );
  return LEGACY_VARIANT_TO_CAR_ID[clamped] ?? DEFAULT_RACE_CAR_ID;
}

export function coerceRaceCarId(value: unknown): RaceCarId {
  if (isRaceCarId(value)) return value;

  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  if (Number.isFinite(numericValue)) {
    return raceCarIdFromLegacyVariant(numericValue);
  }

  return DEFAULT_RACE_CAR_ID;
}

export function resolveRaceCarIdFromSearchParams(
  searchParams: URLSearchParams,
): RaceCarId {
  const explicitCarId = searchParams.get("carId");
  if (explicitCarId) {
    return coerceRaceCarId(explicitCarId);
  }

  const legacyCar = searchParams.get("car");
  if (legacyCar !== null) {
    return coerceRaceCarId(legacyCar);
  }

  return DEFAULT_RACE_CAR_ID;
}

export function getPlayerAccentColor(
  accentIndex: number | null | undefined,
): PlayerAccentColor {
  if (typeof accentIndex !== "number" || Number.isNaN(accentIndex)) {
    return PLAYER_ACCENT_COLORS[0];
  }

  const normalizedIndex =
    ((Math.floor(accentIndex) % PLAYER_ACCENT_COLORS.length) +
      PLAYER_ACCENT_COLORS.length) %
    PLAYER_ACCENT_COLORS.length;

  return PLAYER_ACCENT_COLORS[normalizedIndex] ?? PLAYER_ACCENT_COLORS[0];
}
