// AI Haul evaluation suite.
//
// Runs the REAL production prompt (src/lib/haul-ai-prompt.js) across a matrix of
// goal × diet × avoid scenarios and scores each generation, so a prompt change
// can be regression-tested before it ships. Grades what the model actually
// controls: valid output, macro-role coverage (feasibility for the deterministic
// engine to hit targets), diet + avoid-list compliance, count-unit sanity,
// truncation, and cost. Prints a per-scenario table + an aggregate PASS/FAIL and
// exits non-zero on any failure.
//
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/eval-haul-ai.mjs
//   node scripts/eval-haul-ai.mjs --runs 3        (repeat each scenario N times)
//
// Costs a few cents per full pass on Haiku. Not run in CI (needs a real key).

import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  MODEL, MAX_TOKENS, SYSTEM_PROMPT, buildUserMessage, parseBasket, sanitize, countAllowed,
} from "../src/lib/haul-ai-prompt.js";
import { computeTargets } from "../src/lib/targets.js";

const PRICE = { in: 1.0, out: 5.0 }; // Haiku 4.5 $/MTok

const args = Object.fromEntries(
  Array.from(process.argv.slice(2).join(" ").matchAll(/--(\w+)\s+([^\s]+)/g), (m) => [m[1], m[2]])
);
const RUNS = Math.max(1, parseInt(args.runs || "1", 10));
const MODEL_ID = args.model || MODEL;

if (!process.env.ANTHROPIC_API_KEY && fs.existsSync(".env")) {
  const m = fs.readFileSync(".env", "utf8").match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/m);
  if (m) process.env.ANTHROPIC_API_KEY = m[1].replace(/^["']|["']$/g, "");
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("\n✖ ANTHROPIC_API_KEY is not set. Run: ANTHROPIC_API_KEY=sk-ant-... node scripts/eval-haul-ai.mjs\n");
  process.exit(1);
}

// Two body profiles so targets vary across scenarios.
const RUNNER = { sex: "male", weightKg: 74, heightCm: 179, age: 31, units: "metric" };
const LIGHTER = { sex: "female", weightKg: 61, heightCm: 166, age: 28, units: "metric" };

const SCENARIOS = [
  { goal: "fuel-performance", style: "omnivore",   avoid: [],                       stats: RUNNER,  training: { weeklyKm: 55 } },
  { goal: "lose-fat",         style: "omnivore",   avoid: ["pork"],                 stats: RUNNER,  training: { weeklyKm: 30 } },
  { goal: "gain-muscle",      style: "omnivore",   avoid: ["nuts", "dairy"],        stats: RUNNER,  training: { weeklyKm: 20 } },
  { goal: "fuel-performance", style: "vegetarian", avoid: [],                       stats: LIGHTER, training: { weeklyKm: 45 } },
  { goal: "lose-fat",         style: "vegetarian", avoid: ["gluten"],               stats: LIGHTER, training: { activityLevel: "moderate" } },
  { goal: "gain-muscle",      style: "vegan",      avoid: [],                       stats: RUNNER,  training: { weeklyKm: 25 } },
  { goal: "fuel-performance", style: "vegan",      avoid: ["nuts"],                 stats: LIGHTER, training: { weeklyKm: 40 } },
  { goal: "lose-fat",         style: "omnivore",   avoid: ["gluten", "dairy", "nuts"], stats: LIGHTER, training: { activityLevel: "high" } },
];

// Foods a given diet style must not contain (matched against `contains[]` tags,
// with a name fallback for common animal proteins the model might mis-tag).
const DISALLOWED = { vegan: ["dairy", "eggs", "fish", "meat", "pork", "shellfish"], vegetarian: ["meat", "fish", "pork", "shellfish"], omnivore: [] };
const ANIMAL_NAME = /\b(chicken|beef|pork|turkey|salmon|tuna|cod|fish|shrimp|prawn|bacon|ham|steak|lamb|sausage|anchov)/i;

function score(kept, sc) {
  const has = (c) => kept.some((i) => i.category === c);
  const macrosCovered = ["protein", "carb", "fat"].every(has);
  const produceCovered = has("veg") && has("fruit");
  const badTags = DISALLOWED[sc.style] || [];
  const dietViolations = kept.filter((i) =>
    (i.contains || []).some((c) => badTags.includes(c)) || (sc.style !== "omnivore" && ANIMAL_NAME.test(i.name))
  ).map((i) => i.name);
  const avoidViolations = kept.filter((i) => (i.contains || []).some((c) => sc.avoid.includes(c))).map((i) => i.name);
  const countUnitViolations = kept.filter((i) => i.unit === "count" && !countAllowed(i.name)).map((i) => i.name);
  return { macrosCovered, produceCovered, dietViolations, avoidViolations, countUnitViolations };
}

const client = new Anthropic();
const usd = (n) => "$" + n.toFixed(4);
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

async function evalOne(sc, i) {
  const t = computeTargets({ goal: sc.goal, stats: sc.stats, training: sc.training });
  const targets = { target: t.target, protein: t.protein, carbs: t.carbs, fat: t.fat, goal: t.goal, goalLabel: t.goalLabel };
  const diet = { style: sc.style, avoid: sc.avoid, planDays: 7 };

  const res = await client.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage({ targets, diet }) }],
  });

  const u = res.usage;
  const cost = ((u.input_tokens || 0) * PRICE.in + (u.output_tokens || 0) * PRICE.out) / 1e6;
  const truncated = res.stop_reason === "max_tokens";
  const parsed = parseBasket(res.content?.[0]?.text || "");
  const data = parsed ? sanitize(parsed.items, sc.style) : null;
  const kept = data ? data.diets[sc.style] : [];
  const s = score(kept, sc);

  const pass = !!data && s.macrosCovered && !truncated && s.dietViolations.length === 0 && s.avoidViolations.length === 0 && s.countUnitViolations.length === 0;
  return { sc, i, cost, tokens: u.output_tokens, truncated, valid: !!data, kept, s, pass };
}

(async () => {
  console.log(`\nAI Haul eval — model ${MODEL_ID} · ${SCENARIOS.length} scenarios × ${RUNS} run(s)\n`);
  console.log(pad("scenario", 34) + pad("ok", 4) + pad("items", 7) + pad("cover", 9) + pad("diet✗", 7) + pad("avoid✗", 8) + pad("tok", 6) + pad("$", 9) + "notes");
  console.log("─".repeat(96));

  const results = [];
  for (let r = 0; r < RUNS; r++) {
    for (let i = 0; i < SCENARIOS.length; i++) {
      const sc = SCENARIOS[i];
      let res;
      try {
        res = await evalOne(sc, i);
      } catch (e) {
        console.log(pad(`${sc.goal}/${sc.style}`, 34) + pad("ERR", 4) + " " + (e?.message || e));
        results.push({ sc, pass: false, error: true });
        continue;
      }
      results.push(res);
      const cover = `${res.s.macrosCovered ? "PCF" : "p/c/f?"}${res.s.produceCovered ? "+vf" : ""}`;
      const notes = [
        res.truncated ? "TRUNCATED" : "",
        res.valid ? "" : "unparseable/too-few",
        res.s.dietViolations.length ? "diet:" + res.s.dietViolations.join(",") : "",
        res.s.avoidViolations.length ? "avoid:" + res.s.avoidViolations.join(",") : "",
        res.s.countUnitViolations.length ? "count:" + res.s.countUnitViolations.join(",") : "",
      ].filter(Boolean).join(" · ");
      console.log(
        pad(`${sc.goal}/${sc.style}${sc.avoid.length ? " −" + sc.avoid.join("/") : ""}`, 34) +
        pad(res.pass ? "✓" : "✗", 4) + pad(res.kept.length, 7) + pad(cover, 9) +
        pad(res.s.dietViolations.length, 7) + pad(res.s.avoidViolations.length, 8) +
        pad(res.tokens, 6) + pad(usd(res.cost), 9) + notes
      );
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const totalCost = results.reduce((a, r) => a + (r.cost || 0), 0);
  const avgItems = results.filter((r) => r.valid).reduce((a, r) => a + r.kept.length, 0) / Math.max(1, results.filter((r) => r.valid).length);
  console.log("─".repeat(96));
  console.log(`\nPASS ${passed}/${total} · avg ${avgItems.toFixed(1)} items · total ${usd(totalCost)}\n`);
  process.exit(passed === total ? 0 : 1);
})();
