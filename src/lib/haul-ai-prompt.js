// Pure prompt + validation for the AI Haul generator — no SDK, no network, no
// DOM. Shared by the serverless endpoint (api/haul.js) and the local test
// harness (scripts/try-haul-ai.mjs), so both exercise the exact same prompt and
// the exact same server-side validation. Keeping it pure also makes it testable.

export const MODEL = "claude-haiku-4-5-20251001"; // cheap + fast; Atwater check guards accuracy
export const DAILY_LIMIT = 20; // AI hauls per user per day
export const STYLES = ["omnivore", "vegetarian", "vegan"];
export const SECTIONS = ["Produce", "Protein", "Dairy", "Pantry", "Frozen", "Other"];
export const CATEGORIES = ["protein", "carb", "fat", "veg", "fruit"];

export const SYSTEM_PROMPT = `You are a sports-nutrition grocery planner for Coreon, a training-tools app for runners.

Given a runner's daily calorie + macro targets and their diet constraints, propose a SHOPPING BASKET of whole foods and staples. A downstream deterministic solver rescales every item to hit the macro targets exactly — so you do NOT need to hit the numbers. Your job is to pick a realistic, varied, appealing set of foods a runner would actually buy this week.

Return ONLY a valid JSON object (no markdown, no code fences, no prose):
{
  "items": [
    {
      "name": "Chicken breast",
      "section": "Protein",
      "category": "protein",
      "baseQtyG": 1000,
      "per100g": { "kcal": 165, "protein": 31, "carbs": 0, "fat": 3.6 },
      "contains": [],
      "unit": "count",     // OPTIONAL — only for countable items (eggs, fruit)
      "perUnitG": 50        // OPTIONAL — grams per unit, required if unit is "count"
    }
  ]
}

Rules:
- 16–22 items total.
- "section" ∈ ["Produce","Protein","Dairy","Pantry","Frozen","Other"].
- "category" ∈ ["protein","carb","fat","veg","fruit"] — the food's PRIMARY macro role.
- Include at least 3 protein, 3 carb, 2 fat, 3 veg, 2 fruit foods.
- "per100g" must be realistic per-100g nutrition. kcal MUST ≈ 4·protein + 4·carbs + 9·fat.
- "baseQtyG" is a rough weekly seed amount in grams (the solver rescales it).
- "contains" lists any of ["dairy","gluten","nuts","eggs","soy","shellfish","fish","meat","pork"] the food contains — used to honor the avoid list. Use [] if none apply.
- Respect the diet style: "vegan" → no animal products at all; "vegetarian" → no meat/fish/shellfish (dairy + eggs OK).
- Never include a food that contains anything on the user's avoid list.
- Favor variety and seasonality over the same staples every time.`;

export function buildUserMessage({ targets, diet }) {
  const lines = [
    `Daily targets: ${targets.target} kcal, ${targets.protein} g protein, ${targets.carbs} g carbs, ${targets.fat} g fat.`,
    `Goal: ${targets.goalLabel || targets.goal || "maintain"}.`,
    `Diet style: ${diet.style}.`,
    `Avoid: ${diet.avoid && diet.avoid.length ? diet.avoid.join(", ") : "nothing"}.`,
    `Plan length: ${diet.planDays || 7} days.`,
    `Return the basket JSON now.`,
  ];
  return lines.join("\n");
}

// Atwater sanity: catch hallucinated nutrition. kcal must roughly equal the
// energy from its macros, and be physically plausible.
export function itemIsValid(it) {
  if (!it || typeof it.name !== "string" || !it.name.trim()) return false;
  if (!SECTIONS.includes(it.section)) return false;
  if (!CATEGORIES.includes(it.category)) return false;
  const p = it.per100g || {};
  const nums = [p.kcal, p.protein, p.carbs, p.fat];
  if (nums.some((n) => typeof n !== "number" || n < 0 || Number.isNaN(n))) return false;
  if (p.kcal > 950) return false; // nothing is denser than pure fat (~900)
  if (!(it.baseQtyG > 0) || it.baseQtyG > 20000) return false;
  const atwater = 4 * p.protein + 4 * p.carbs + 9 * p.fat;
  if (Math.abs(p.kcal - atwater) > Math.max(20, 0.2 * p.kcal)) return false;
  return true;
}

// Validate + normalize the model's item list into an engine-ready dataset, or
// null when too little survives. Returns { diets: { [style]: [items] } }.
export function sanitize(items, style) {
  const clean = [];
  for (const raw of Array.isArray(items) ? items : []) {
    if (!itemIsValid(raw)) continue;
    const item = {
      name: String(raw.name).trim().slice(0, 60),
      section: raw.section,
      category: raw.category,
      baseQtyG: Math.round(raw.baseQtyG),
      per100g: {
        kcal: raw.per100g.kcal,
        protein: raw.per100g.protein,
        carbs: raw.per100g.carbs,
        fat: raw.per100g.fat,
      },
      contains: Array.isArray(raw.contains)
        ? raw.contains.filter((c) => typeof c === "string").slice(0, 8)
        : [],
    };
    if (raw.unit === "count" && raw.perUnitG > 0) {
      item.unit = "count";
      item.perUnitG = Math.round(raw.perUnitG);
    }
    clean.push(item);
  }
  // De-dupe by name and require the three macro roles to survive.
  const seen = new Set();
  const deduped = clean.filter((i) => {
    const k = i.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const hasAllMacros = ["protein", "carb", "fat"].every((c) =>
    deduped.some((i) => i.category === c)
  );
  if (!hasAllMacros || deduped.length < 8) return null;
  return { diets: { [style]: deduped } };
}

// Extract the first JSON object from a model response and parse it.
export function parseBasket(text) {
  const match = (text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
