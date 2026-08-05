// Deterministic Haul generator.
//
// Turns the daily macro targets from `computeTargets()` into a weekly grocery
// list, using the curated baskets in lookups/haul-foods.json. Approach:
//   1. Take the food set for the user's diet, drop anything on their avoid list.
//   2. Re-weight base quantities by the goal (e.g. lose-fat → more protein/veg).
//   3. Scale the whole basket so its calories ≈ the user's weekly target.
//
// Pure function (no DOM, no globals) → unit-testable, and it emits the same
// output schema the future AI path will produce, so the result UI never changes.

import defaultData from "../../lookups/haul-foods.json";

const SECTION_ORDER = ["Produce", "Protein", "Dairy", "Pantry", "Frozen", "Other"];
const NEUTRAL_WEIGHTS = { protein: 1, carb: 1, fat: 1, veg: 1, fruit: 1 };

// Output schema (shared with the eventual AI generator):
// {
//   planDays,
//   targets:  { kcalPerDay, protein, carbs, fat },   // per day, from the user
//   provides: { kcalPerDay, protein, carbs, fat },   // what the basket delivers
//   sections: [ { section, items: [ { name, qty, unit, display } ] } ],
//   warnings: []
// }
export function generateHaul(targets, diet, data = defaultData) {
  const style = diet.style && data.diets[diet.style] ? diet.style : "omnivore";
  const avoid = Array.isArray(diet.avoid) ? diet.avoid : [];
  const planDays = diet.planDays || 7;
  const weights = data.goalWeights[targets.goal] || NEUTRAL_WEIGHTS;

  const basket = data.diets[style].filter(
    (f) => !f.contains.some((c) => avoid.includes(c))
  );

  // 1. Goal-weighted base quantities.
  const weighted = basket.map((f) => ({
    food: f,
    qtyG: f.baseQtyG * (weights[f.category] ?? 1),
  }));

  // 2. Scale so the basket's calories match the weekly target.
  const weightedWeeklyKcal = weighted.reduce(
    (sum, w) => sum + (w.qtyG * w.food.per100g.kcal) / 100,
    0
  );
  const targetWeeklyKcal = targets.target * planDays;
  const scale = weightedWeeklyKcal > 0 ? targetWeeklyKcal / weightedWeeklyKcal : 1;

  // 3. Round to shopper-friendly amounts; keep the rounded grams for the
  //    "what it provides" math so the footer is honest.
  const items = weighted.map((w) => {
    const disp = displayQty(w.qtyG * scale, w.food);
    return { food: w.food, ...disp };
  });

  const totals = items.reduce(
    (acc, it) => {
      const p = it.food.per100g;
      const g = it.grams / 100;
      acc.kcal += p.kcal * g;
      acc.protein += p.protein * g;
      acc.carbs += p.carbs * g;
      acc.fat += p.fat * g;
      return acc;
    },
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
  const provides = {
    kcalPerDay: Math.round(totals.kcal / planDays),
    protein: Math.round(totals.protein / planDays),
    carbs: Math.round(totals.carbs / planDays),
    fat: Math.round(totals.fat / planDays),
  };

  // Group by store section, in aisle order.
  const bySection = {};
  for (const it of items) {
    (bySection[it.food.section] ||= []).push({
      name: it.food.name,
      qty: it.qty,
      unit: it.unit,
      display: it.display,
    });
  }
  const sections = SECTION_ORDER.filter((s) => bySection[s]?.length).map((s) => ({
    section: s,
    items: bySection[s],
  }));

  const warnings = [];
  for (const cat of ["protein", "carb", "fat"]) {
    if (!basket.some((f) => f.category === cat)) {
      warnings.push(`No ${cat} sources left after your avoid list — the basket may fall short on ${cat}.`);
    }
  }

  return {
    planDays,
    targets: {
      kcalPerDay: targets.target,
      protein: targets.protein,
      carbs: targets.carbs,
      fat: targets.fat,
    },
    provides,
    sections,
    warnings,
  };
}

// Convert a raw gram amount into a shopper-friendly quantity + label.
// Returns { grams, qty, unit, display } — `grams` is the rounded amount used
// for the provides math; `display` is what the UI shows.
function displayQty(grams, food) {
  if (food.unit === "count") {
    const per = food.perUnitG || 50;
    const n = Math.max(1, Math.round(grams / per));
    return { grams: n * per, qty: n, unit: "count", display: `${n}` };
  }
  const unit = food.unit === "ml" ? "ml" : "g";
  const g = Math.max(50, Math.round(grams / 50) * 50);
  if (unit === "g" && g >= 1000) {
    const kg = Math.round(g / 100) / 10; // one decimal place
    return { grams: g, qty: g, unit: "g", display: `${kg} kg` };
  }
  return { grams: g, qty: g, unit, display: `${g} ${unit}` };
}
