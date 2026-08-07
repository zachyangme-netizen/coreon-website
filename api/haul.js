// AI-generated Haul basket.
//
// Design: the AI does NOT do the macro arithmetic. It only proposes a realistic,
// varied *basket* of foods (respecting diet + avoid). The client then runs the
// same deterministic engine (generateHaul) that scales each item to hit the
// targets — so macros stay exact and the result is editable like any other haul.
//
// This endpoint is the guardrail layer (audit #1): it is auth-gated (Supabase
// session required) and rate-limited per user per day via the bump_ai_usage RPC.
// On any failure it returns { ok: false, reason } and the client silently falls
// back to the deterministic basket.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const client = new Anthropic();

const MODEL = "claude-haiku-4-5-20251001"; // cheap + fast; Atwater check guards accuracy
const DAILY_LIMIT = 20; // AI hauls per user per day
const STYLES = ["omnivore", "vegetarian", "vegan"];
const SECTIONS = ["Produce", "Protein", "Dairy", "Pantry", "Frozen", "Other"];
const CATEGORIES = ["protein", "carb", "fat", "veg", "fruit"];

const SYSTEM_PROMPT = `You are a sports-nutrition grocery planner for Coreon, a training-tools app for runners.

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

function buildUserMessage({ targets, diet }) {
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
function itemIsValid(it) {
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

function sanitize(items, style) {
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "method_not_allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnon = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnon) {
    return res.status(503).json({ ok: false, reason: "auth_unconfigured" });
  }

  // 1. Require a valid Supabase session (blocks anonymous internet abuse).
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, reason: "signed_out" });

  const supa = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await supa.auth.getUser();
  if (userErr || !userData?.user) {
    return res.status(401).json({ ok: false, reason: "invalid_session" });
  }

  // 2. Rate limit: atomic per-user daily counter (cost control).
  const { data: usage, error: rpcErr } = await supa.rpc("bump_ai_usage", {
    p_limit: DAILY_LIMIT,
  });
  if (rpcErr) {
    if (rpcErr.code === "P0001" || /rate_limited/.test(rpcErr.message || "")) {
      return res
        .status(429)
        .json({ ok: false, reason: "rate_limited", limit: DAILY_LIMIT });
    }
    console.error("ai_usage rpc failed:", rpcErr.message);
    return res.status(500).json({ ok: false, reason: "usage_error" });
  }

  // 3. Validate the request body.
  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const targets = body.targets || {};
  const diet = body.diet || {};
  const style = STYLES.includes(diet.style) ? diet.style : "omnivore";
  diet.style = style;
  if (!Array.isArray(diet.avoid)) diet.avoid = [];
  if (!(targets.target > 0) || !(targets.protein > 0)) {
    return res.status(400).json({ ok: false, reason: "bad_targets" });
  }

  // 4. Ask the model for a basket, validate it, hand it back for the engine.
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1600,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: buildUserMessage({ targets, diet }) }],
    });

    const text = response.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = safeParse(match ? match[0] : text);
    const data = parsed ? sanitize(parsed.items, style) : null;

    if (!data) {
      return res.status(502).json({ ok: false, reason: "bad_generation" });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      data,
      source: "ai",
      usage: { count: usage, limit: DAILY_LIMIT },
    });
  } catch (err) {
    console.error("Haul generation failed:", err.message);
    return res.status(502).json({ ok: false, reason: "ai_error" });
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
