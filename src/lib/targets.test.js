import { describe, it, expect } from "vitest";
import { computeTargets, computeBMR } from "./targets.js";

// A runner: 70 kg, 178 cm, 30 yo male, 50 km/week, no activity level set.
const runner = (goal) => ({
  goal,
  stats: { sex: "male", weightKg: 70, heightCm: 178, age: 30 },
  training: { weeklyKm: 50 },
});

// A non-runner: same body, but picked an activity level → mileage path skipped.
const nonRunner = (goal, activityLevel) => ({
  goal,
  stats: { sex: "male", weightKg: 70, heightCm: 178, age: 30 },
  training: { activityLevel },
});

describe("computeBMR", () => {
  it("applies the Mifflin sex offset", () => {
    const male = computeBMR({ sex: "male", weightKg: 70, heightCm: 178, age: 30 });
    const female = computeBMR({ sex: "female", weightKg: 70, heightCm: 178, age: 30 });
    expect(male - female).toBe(166); // +5 vs −161
  });
});

describe("computeTargets", () => {
  it("runner mode: adds NEAT + running to BMR (no activity multiplier)", () => {
    const t = computeTargets(runner("fuel-performance"));
    expect(t.mode).toBe("runner");
    expect(t.activityMultiplier).toBeNull();
    expect(t.runningPerDay).toBeGreaterThan(0);
    // fuel-performance = maintenance (factor 1.0) → target ≈ tdee.
    expect(t.target).toBe(t.tdee);
    expect(t.adjKcal).toBe(0);
  });

  it("non-runner mode: uses the activity multiplier and skips mileage", () => {
    const t = computeTargets(nonRunner("fuel-performance", "moderate"));
    expect(t.mode).toBe("non-runner");
    expect(t.activityMultiplier).toBe(1.6);
    expect(t.runningPerDay).toBe(0);
    // tdee rounds bmr·1.6; comparing against the rounded bmr allows ±1 kcal.
    expect(Math.abs(t.tdee - t.bmr * 1.6)).toBeLessThanOrEqual(1);
  });

  it("macros reconcile with the calorie target (P·4 + C·4 + F·9 ≈ target)", () => {
    const t = computeTargets(runner("fuel-performance"));
    const kcalFromMacros = t.protein * 4 + t.carbs * 4 + t.fat * 9;
    // Rounding to whole grams introduces a few kcal of drift.
    expect(Math.abs(kcalFromMacros - t.target)).toBeLessThan(15);
  });

  it("fat-loss leans protein (1.8 g/kg) and caps the deficit at 500 kcal", () => {
    const t = computeTargets(runner("lose-fat"));
    expect(t.protein).toBe(Math.round(70 * 1.8)); // 126 g
    expect(t.adjKcal).toBeLessThan(0); // it's a deficit
    expect(t.tdee - t.target).toBeLessThanOrEqual(500); // never deeper than the cap
  });

  it("muscle-gain runs a surplus (factor 1.1) at 1.8 g/kg protein", () => {
    const t = computeTargets(runner("gain-muscle"));
    expect(t.protein).toBe(Math.round(70 * 1.8));
    expect(t.target).toBeGreaterThan(t.tdee); // surplus
  });

  it("carries the goal label through", () => {
    expect(computeTargets(runner("lose-fat")).goalLabel).toBe("Lose fat");
  });
});
