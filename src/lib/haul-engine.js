// Deterministic Haul generator.
//
// Turns the daily macro targets from `computeTargets()` into a weekly grocery
// list, using the curated food set in lookups/haul-foods.json. Approach:
//   1. Take the food set for the user's diet, drop anything on their avoid list.
//   2. Scale each macro category (protein / carb / fat) to hit that macro's
//      weekly target, accounting for the macro the OTHER categories contribute
//      (carb foods carry protein, protein foods carry fat, etc.). A few
//      fixed-point passes converge, so `provides` tracks `targets` closely.
//   3. Produce (veg + fruit) is a fixed baseline scaled by plan length.
//
// The goal is already baked into the macro targets by computeTargets (protein
// per kg, deficit/surplus, carb remainder), so it needs no separate weighting.
//
// Pure function (no DOM, no globals) → unit-testable, and it emits the same
// output schema the future AI path will produce, so the result UI never changes.

import defaultData from "../../lookups/haul-foods.json";

const SECTION_ORDER = ["Produce", "Protein", "Dairy", "Pantry", "Frozen", "Other"];
const MACRO_CATS = ["protein", "carb", "fat"];
const MACRO_PROP = { protein: "protein", carb: "carbs", fat: "fat" };
const PASSES = 4;
const MIN_ITEM_G = 25; // drop near-zero items instead of showing a token 50 g

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

  const basket = data.diets[style].filter(
    (f) => !f.contains.some((c) => avoid.includes(c))
  );

  const cats = { protein: [], carb: [], fat: [], veg: [], fruit: [] };
  basket.forEach((f) => (cats[f.category] || (cats[f.category] = [])).push(f));

  // Weekly macro targets (grams).
  const target = {
    protein: targets.protein * planDays,
    carb: targets.carbs * planDays,
    fat: targets.fat * planDays,
  };

  // Produce is a fixed baseline (always buy your greens/fruit); everything else
  // starts at 1× and gets solved below.
  const dayScale = planDays / 7;
  const factor = { veg: dayScale, fruit: dayScale, protein: 1, carb: 1, fat: 1 };

  const macroAt = (cat, prop) =>
    cats[cat].reduce(
      (s, f) => s + (f.baseQtyG * factor[cat] * (f.per100g[prop] || 0)) / 100,
      0
    );
  const baseMacro = (cat, prop) =>
    cats[cat].reduce((s, f) => s + (f.baseQtyG * (f.per100g[prop] || 0)) / 100, 0);

  // Fixed-point solve: size each macro category to its target minus what the
  // other categories already supply of that macro.
  for (let pass = 0; pass < PASSES; pass++) {
    for (const cat of MACRO_CATS) {
      const prop = MACRO_PROP[cat];
      let fromOthers = 0;
      for (const other of ["protein", "carb", "fat", "veg", "fruit"]) {
        if (other !== cat) fromOthers += macroAt(other, prop);
      }
      const need = Math.max(target[cat] - fromOthers, 0);
      const base = baseMacro(cat, prop);
      factor[cat] = base > 0 ? need / base : 0;
    }
  }

  const items = basket
    .map((f) => ({ food: f, rawG: f.baseQtyG * (factor[f.category] ?? 0) }))
    .filter((x) => x.rawG >= MIN_ITEM_G)
    .map((x) => ({ food: x.food, ...displayQty(x.rawG, x.food) }));

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
  for (const cat of MACRO_CATS) {
    if (!cats[cat].length) {
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
// for the provides math; `display` is the metric label (the UI re-labels for
// the kg/lb toggle).
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
