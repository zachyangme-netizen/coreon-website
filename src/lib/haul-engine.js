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
// Edits overlay (M3):
//   edits = { removedThisWeek: [names], locked: {name: grams}, flexed: {name: grams} }
//   - generateHaul() renders the list literally: each item's amount is
//     locked ?? flexed ?? Coreon's base pick, with removed items dropped.
//     Editing alone never re-solves — the meter shows the drift (phase 1).
//   - solveFlex() (phase 2) is the on-demand "Rebalance to my target" action:
//     it re-solves the FREE (un-locked, non-removed) items to hit the target,
//     capped so no item balloons past ~2× its base, and reports any gap the
//     flex couldn't close plus removed foods worth re-adding.
//
// Pure functions (no DOM, no globals) → unit-testable; same output schema the
// future AI path will produce, so the result UI never changes.

import defaultData from "../../lookups/haul-foods.json";

const SECTION_ORDER = ["Produce", "Protein", "Dairy", "Pantry", "Frozen", "Other"];
const MACRO_CATS = ["protein", "carb", "fat"];
const MACRO_PROP = { protein: "protein", carb: "carbs", fat: "fat" };
const PASSES = 4;
const MIN_ITEM_G = 25; // drop near-zero items instead of showing a token 50 g
const FLEX_CAP = 2; // a free item can grow to at most 2× its base amount
const GAP_TOLERANCE = 0.08; // matches the meter's ±8% "on target" band, so the
                            // prompt and the meter never disagree

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
  const flexed = edits.flexed || {};

  const basket = data.diets[style].filter(
    (f) => !f.contains.some((c) => avoid.includes(c))
  );
  const cats = groupByCat(basket);
  const dayScale = planDays / 7;
  const target = weeklyTarget(targets, planDays);
  const factor = computeFactors(cats, target, dayScale);

  // Amount priority: an explicit user lock wins, then a rebalanced amount, then
  // Coreon's base pick. Removed items drop out.
  const items = basket
    .map((f) => {
      let grams;
      if (locked[f.name] != null) grams = roundGrams(locked[f.name], f);
      else if (flexed[f.name] != null) grams = roundGrams(flexed[f.name], f);
      else grams = roundGrams(f.baseQtyG * (factor[f.category] ?? 0), f);
      return { food: f, grams };
    })
    .filter((x) => x.grams >= MIN_ITEM_G)
    .filter((x) => !removed.has(x.food.name))
    .map((x) => toItem(x.food, x.grams));

  const provides = perDayMacros(items, planDays);

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

// "Rebalance to my target": re-solve the free items (category-local) to hit the
// target given the user's locks + removals, capped at FLEX_CAP× base. Returns
// the new amounts to apply, any gap the flex couldn't close, and removed foods
// worth re-adding to fill it.
//   → { flexed: {name: grams}, gaps: [{macro, shortPerDay}], suggestions: [{name, macro}] }
export function solveFlex(targets, diet, data = defaultData, edits = {}) {
  const style = diet.style && data.diets[diet.style] ? diet.style : "omnivore";
  const avoid = Array.isArray(diet.avoid) ? diet.avoid : [];
  const planDays = diet.planDays || 7;
  const removed = new Set(edits.removedThisWeek || []);
  const locked = edits.locked || {};
  const dayScale = planDays / 7;
  const target = weeklyTarget(targets, planDays);

  const fullBasket = data.diets[style].filter(
    (f) => !f.contains.some((c) => avoid.includes(c))
  );
  // Unconstrained reference factors — the cap is relative to Coreon's original pick.
  const baseFactors = computeFactors(groupByCat(fullBasket), target, dayScale);

  const basket = fullBasket.filter((f) => !removed.has(f.name));

  const amountOf = (f, factor) => {
    if (locked[f.name] != null) return locked[f.name];
    if (f.category === "veg" || f.category === "fruit") return f.baseQtyG * dayScale;
    return f.baseQtyG * (factor[f.category] ?? 0);
  };

  // Solve only the free macro items; locked + produce are fixed contributions.
  const factor = { protein: 1, carb: 1, fat: 1 };
  for (let pass = 0; pass < PASSES; pass++) {
    for (const cat of MACRO_CATS) {
      const prop = MACRO_PROP[cat];
      let fromOthers = 0;
      for (const f of basket) {
        const freeInCat = f.category === cat && locked[f.name] == null;
        if (!freeInCat) fromOthers += (amountOf(f, factor) * (f.per100g[prop] || 0)) / 100;
      }
      const need = Math.max(target[cat] - fromOthers, 0);
      const freeBase = basket
        .filter((f) => f.category === cat && locked[f.name] == null)
        .reduce((s, f) => s + (f.baseQtyG * (f.per100g[prop] || 0)) / 100, 0);
      const wanted = freeBase > 0 ? need / freeBase : 0;
      const cap = FLEX_CAP * (baseFactors[cat] || wanted);
      factor[cat] = Math.min(wanted, cap);
    }
  }

  const flexed = {};
  for (const f of basket) {
    if (locked[f.name] != null || !MACRO_CATS.includes(f.category)) continue;
    const g = roundGrams(f.baseQtyG * factor[f.category], f);
    if (g >= MIN_ITEM_G) flexed[f.name] = g;
  }

  // What the capped solve actually delivers → any remaining gap.
  const gaps = [];
  for (const cat of MACRO_CATS) {
    const prop = MACRO_PROP[cat];
    let achieved = 0;
    for (const f of basket) achieved += (amountOf(f, factor) * (f.per100g[prop] || 0)) / 100;
    const shortWeekly = target[cat] - achieved;
    if (shortWeekly > target[cat] * GAP_TOLERANCE) {
      gaps.push({ macro: cat, shortPerDay: Math.round(shortWeekly / planDays) });
    }
  }

  // Removed foods that could fill a gap, ranked by that macro's density.
  const suggestions = [];
  const removedFoods = fullBasket.filter((f) => removed.has(f.name));
  for (const gap of gaps) {
    const prop = MACRO_PROP[gap.macro];
    removedFoods
      .filter((f) => f.category === gap.macro)
      .sort((a, b) => (b.per100g[prop] || 0) - (a.per100g[prop] || 0))
      .forEach((f) => {
        if (!suggestions.some((s) => s.name === f.name)) {
          suggestions.push({ name: f.name, macro: gap.macro });
        }
      });
  }

  return { flexed, gaps, suggestions: suggestions.slice(0, 3) };
}

// ── helpers ──────────────────────────────────────────────────────────────

function weeklyTarget(targets, planDays) {
  return {
    protein: targets.protein * planDays,
    carb: targets.carbs * planDays,
    fat: targets.fat * planDays,
  };
}

function groupByCat(basket) {
  const cats = { protein: [], carb: [], fat: [], veg: [], fruit: [] };
  basket.forEach((f) => (cats[f.category] || (cats[f.category] = [])).push(f));
  return cats;
}

// Unconstrained macro-anchored solve: one scale factor per category, sized so
// each macro hits its target given the others' contributions.
function computeFactors(cats, target, dayScale) {
  const factor = { veg: dayScale, fruit: dayScale, protein: 1, carb: 1, fat: 1 };
  const macroAt = (cat, prop) =>
    cats[cat].reduce((s, f) => s + (f.baseQtyG * factor[cat] * (f.per100g[prop] || 0)) / 100, 0);
  const baseMacro = (cat, prop) =>
    cats[cat].reduce((s, f) => s + (f.baseQtyG * (f.per100g[prop] || 0)) / 100, 0);

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
  return factor;
}

function perDayMacros(items, planDays) {
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
  return {
    kcalPerDay: Math.round(totals.kcal / planDays),
    protein: Math.round(totals.protein / planDays),
    carbs: Math.round(totals.carbs / planDays),
    fat: Math.round(totals.fat / planDays),
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
