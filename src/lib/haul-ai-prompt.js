// Pure prompt + validation for the AI Haul generator — no SDK, no network, no
// DOM. Shared by the serverless endpoint (api/haul.js) and the local test
// harness (scripts/try-haul-ai.mjs), so both exercise the exact same prompt and
// the exact same server-side validation. Keeping it pure also makes it testable.

export const MODEL = "claude-haiku-4-5-20251001"; // cheap + fast; Atwater check guards accuracy
// A full 16–22 item basket (each with per100g) runs ~1.8–2.2k output tokens.
// 1600 truncated the JSON mid-object → unparseable → bad_generation. 4000 gives
// comfortable headroom; still well under the streaming threshold.
export const MAX_TOKENS = 4000;
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
      "unit": "count",     // OPTIONAL — ONLY for whole countable items (see rule)
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
- Use "unit":"count" (+ "perUnitG") ONLY for foods bought as discrete whole pieces: eggs, whole fruit (banana, apple), whole vegetables (pepper, sweet potato), bread slices, chicken breasts/fillets. For anything measured by weight or volume — rice, oats, flour, pasta, lentils, quinoa, oil, yogurt, milk, nut butter, nuts, seeds, cheese — OMIT "unit" and "perUnitG" entirely; it'll be shown by weight.
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

// Foods sold by weight or volume — never sensible as a "count" no matter what
// the model says ("4 olive oils", "5 brown rices"). The prompt asks it to omit
// count for these; this is the safety net that strips it if it doesn't.
const BULK_BY_WEIGHT =
  /\b(oil|rice|oats?|flour|quinoa|couscous|pasta|noodles?|lentils?|beans?|chickpeas?|hummus|yogh?urt|milk|cream|butter|honey|syrup|jam|sugar|salt|sauce|paste|granola|muesli|cereal|powder|cheese|nuts?|almonds?|walnuts?|cashews?|peanuts?|pistachios?|seeds?)\b/i;

// Whether an item may keep a "count" unit — false for bulk weight/volume staples.
export function countAllowed(name) {
  return !BULK_BY_WEIGHT.test(name || "");
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
    if (raw.unit === "count" && raw.perUnitG > 0 && countAllowed(item.name)) {
      item.unit = "count";
      item.perUnitG = Math.round(raw.perUnitG);
    }
    // else: leave it as a weight-based item (no unit) — the UI shows grams/lb.
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
