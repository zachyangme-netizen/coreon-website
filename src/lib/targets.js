// Coreon calorie + macro target math — pure, no DOM, no globals.
//
// Extracted from haul.js so it is unit-testable AND reusable by the AI haul
// generator (which needs the exact same targets the wizard shows). `state` is
// the Haul wizard blob: { goal, stats:{sex,weightKg,heightCm,age}, training }.

export const GOAL_LABELS = {
  "lose-fat": "Lose fat",
  "gain-muscle": "Gain muscle",
  "fuel-performance": "Fuel performance",
};

const ACTIVITY_FACTOR = 1.036; // kcal per kg per km of running
const NEAT_FACTOR = 0.35; // non-exercise activity ≈ 35% of BMR
const FAT_PCT = 0.25; // 25% of calories from fat
const MAX_DEFICIT = 500; // safety cap for fat-loss target

const GOAL_INFO = {
  "lose-fat": { factor: 0.85, capDeficit: true, proteinPerKg: 1.8 },
  "gain-muscle": { factor: 1.1, capDeficit: false, proteinPerKg: 1.8 },
  "fuel-performance": { factor: 1.0, capDeficit: false, proteinPerKg: 1.6 },
};

// For non-runner mode: standard Mifflin activity multipliers (slightly rounded).
const ACTIVITY_MULTIPLIERS = {
  light: 1.4, // 1–3 days/week light-to-moderate exercise
  moderate: 1.6, // 4–5 days/week
  high: 1.8, // 6+ days/week or hard daily training
};

export function computeBMR({ sex, weightKg, heightCm, age }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === "male" ? base + 5 : base - 161;
}

export function computeTargets(state) {
  const goal = state.goal;
  const { sex, weightKg, heightCm, age } = state.stats;
  const training = state.training;
  // Mode is derived: if the user picked an activity level, treat them as a
  // non-runner (mileage skipped). Otherwise it's the runner path.
  const mode = training.activityLevel ? "non-runner" : "runner";

  const bmr = computeBMR({ sex, weightKg, heightCm, age });

  let tdee,
    runningPerDay = 0,
    neat = 0,
    activityMultiplier = null;

  if (mode === "non-runner") {
    activityMultiplier = ACTIVITY_MULTIPLIERS[training.activityLevel] || 1.4;
    tdee = bmr * activityMultiplier;
  } else {
    runningPerDay = (weightKg * ACTIVITY_FACTOR * training.weeklyKm) / 7;
    neat = bmr * NEAT_FACTOR;
    tdee = bmr + neat + runningPerDay;
  }

  const info = GOAL_INFO[goal];
  let target = tdee * info.factor;

  // Cap deficit to protect performance (fat-loss only)
  if (info.capDeficit && tdee - target > MAX_DEFICIT) {
    target = tdee - MAX_DEFICIT;
  }

  const proteinG = Math.round(weightKg * info.proteinPerKg);
  const proteinKcal = proteinG * 4;
  const fatKcal = target * FAT_PCT;
  const fatG = Math.round(fatKcal / 9);
  const carbsKcal = target - proteinKcal - fatKcal;
  const carbsG = Math.round(carbsKcal / 4);

  return {
    goal,
    goalLabel: GOAL_LABELS[goal] || goal,
    mode,
    bmr: Math.round(bmr),
    runningPerDay: Math.round(runningPerDay),
    neat: Math.round(neat),
    activityMultiplier,
    activityLevel: training.activityLevel || null,
    tdee: Math.round(tdee),
    target: Math.round(target),
    adjKcal: Math.round(target - tdee),
    protein: proteinG,
    carbs: carbsG,
    fat: fatG,
    proteinPerKg: info.proteinPerKg,
  };
}
