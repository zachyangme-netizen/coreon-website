// Deterministic Haul generator.
//
// Turns the daily macro targets from `computeTargets()` into a weekly grocery
// list, using the curated food set in lookups/haul-foods.json. Approach:
//   1. Take the food set for the user's diet, drop anything on their avoid list.
//   2. Scale each macro category (protein / carb / fat) to hit that macro's
//      weekly target, accounting for the macro the OTHER categories contribute.
//      A few fixed-point passes converge, so `provides` tracks `targets`.
//   3. Produce (veg + fruit) is a fixed baseline scaled by plan length.
//
// M3 phase 1 adds a literal edit overlay: after building Coreon's base picks,
// apply the user's removals + quantity locks and recompute `provides`. No
// re-solving yet — the meter shows the impact and the user adjusts (auto-flex
// is phase 2). `edits = { removedThisWeek: [names], locked: {name: grams} }`.
//
// Pure function (no DOM, no globals) → unit-testable; same output schema the
// future AI path will produce, so the result UI never changes.

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
//   provides: { kcalPerDay, protein, carbs, fat },   // what the (edited) basket delivers
//   sections: [ { section, items: [ Item ] } ],
//   warnings: []
// }
// Item = { name, section, category, grams, unit, perUnitG?, per100g }
export function generateHaul(targets, diet, data = defaultData, edits = {}) {
  const style = diet.style && data.diets[diet.style] ? diet.style : "omnivore";
  const avoid = Array.isArray(diet.avoid) ? diet.avoid : [];
  const planDays = diet.planDays || 7;
  const removed = new Set(edits.removedThisWeek || []);
  const locked = edits.locked || {};

  const basket = data.diets[style].filter(
    (f) => !f.contains.some((c) => avoid.includes(c))
  );

  const cats = { protein: [], carb: [], fat: [], veg: [], fruit: [] };
  basket.forEach((f) => (cats[f.category] || (cats[f.category] = [])).push(f));

  const target = {
    protein: targets.protein * planDays,
    carb: targets.carbs * planDays,
    fat: targets.fat * planDays,
  };

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

  // Coreon's base picks, then the literal edit overlay.
  const items = basket
    .map((f) => ({ food: f, grams: roundGrams(f.baseQtyG * (factor[f.category] ?? 0), f) }))
    .filter((x) => x.grams >= MIN_ITEM_G)
    .filter((x) => !removed.has(x.food.name))
    .map((x) =>
      locked[x.food.name] != null
        ? { food: x.food, grams: roundGrams(locked[x.food.name], x.food) }
        : x
    )
    .map((x) => toItem(x.food, x.grams));

  const totals = items.reduce(
    (acc, it) => {
      const g = it.grams / 100;
      acc.kcal += it.per100g.kcal * g;
      acc.protein += it.per100g.protein * g;
      acc.carbs += it.per100g.carbs * g;
      acc.fat += it.per100g.fat * g;
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
  for (const it of items) (bySection[it.section] ||= []).push(it);
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

// Round a raw gram amount to a shopper-friendly quantity in canonical grams.
// (Count items store grams = count × perUnitG so the macro math stays uniform.)
function roundGrams(raw, food) {
  if (food.unit === "count") {
    const per = food.perUnitG || 50;
    return Math.max(1, Math.round(raw / per)) * per;
  }
  return Math.max(50, Math.round(raw / 50) * 50);
}

function toItem(food, grams) {
  return {
    name: food.name,
    section: food.section,
    category: food.category,
    grams,
    unit: food.unit || "g",
    perUnitG: food.perUnitG,
    per100g: food.per100g,
  };
}
