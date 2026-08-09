// Local test harness for the AI Haul generator.
//
// Fires ONE real Claude API call using the exact prompt the serverless endpoint
// uses (src/lib/haul-ai-prompt.js) — no Supabase, no Vercel, no auth — then runs
// the response through the same server-side validation and prints the actual
// token usage + cost. Lets you sanity-check the prompt for pocket change.
//
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/try-haul-ai.mjs
//   node scripts/try-haul-ai.mjs --goal lose-fat --diet vegan --avoid nuts,gluten
//
// Flags (all optional): --goal <lose-fat|gain-muscle|fuel-performance>
//                       --diet <omnivore|vegetarian|vegan>  --avoid a,b,c
//                       --model <model-id>   --runs <N>   (repeat N times)

import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  MODEL,
  SYSTEM_PROMPT,
  buildUserMessage,
  parseBasket,
  sanitize,
  CATEGORIES,
} from "../src/lib/haul-ai-prompt.js";
import { computeTargets } from "../src/lib/targets.js";

// Haiku 4.5 list price ($/million tokens). Cache writes cost 1.25x input,
// cache reads 0.1x. Update if you point --model elsewhere.
const PRICE = { in: 1.0, out: 5.0 };

// ── args ──────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  Array.from(process.argv.slice(2).join(" ").matchAll(/--(\w+)\s+([^\s]+)/g), (m) => [m[1], m[2]])
);
const goal = args.goal || "fuel-performance";
const style = args.diet || "omnivore";
const avoid = args.avoid ? args.avoid.split(",").map((s) => s.trim()).filter(Boolean) : [];
const model = args.model || MODEL;
const runs = Math.max(1, parseInt(args.runs || "1", 10));

// Load ANTHROPIC_API_KEY from .env if not already in the environment.
if (!process.env.ANTHROPIC_API_KEY && fs.existsSync(".env")) {
  const m = fs.readFileSync(".env", "utf8").match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/m);
  if (m) process.env.ANTHROPIC_API_KEY = m[1].replace(/^["']|["']$/g, "");
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "\n✖ ANTHROPIC_API_KEY is not set.\n  Run:  ANTHROPIC_API_KEY=sk-ant-... node scripts/try-haul-ai.mjs\n  (or add it to .env)\n"
  );
  process.exit(1);
}

// A realistic runner. computeTargets is the SAME math the wizard + endpoint use.
const state = {
  goal,
  stats: { sex: "male", weightKg: 72, heightCm: 178, age: 30, units: "metric" },
  training: { weeklyKm: 45 },
};
const t = computeTargets(state);
const targets = { target: t.target, protein: t.protein, carbs: t.carbs, fat: t.fat, goal: t.goal, goalLabel: t.goalLabel };
const diet = { style, avoid, planDays: 7 };

const client = new Anthropic();
const usd = (n) => `$${n.toFixed(4)}`;

console.log(`\nModel:   ${model}`);
console.log(`Goal:    ${t.goalLabel}  →  ${t.target} kcal · ${t.protein}P ${t.carbs}C ${t.fat}F per day`);
console.log(`Diet:    ${style}${avoid.length ? ` · avoid: ${avoid.join(", ")}` : ""}`);
console.log(`Runs:    ${runs}\n`);

let totalCost = 0;

for (let i = 1; i <= runs; i++) {
  const started = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: 1600,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage({ targets, diet }) }],
  });
  const ms = Date.now() - started;

  const u = response.usage;
  const cost =
    ((u.input_tokens || 0) * PRICE.in +
      (u.cache_creation_input_tokens || 0) * PRICE.in * 1.25 +
      (u.cache_read_input_tokens || 0) * PRICE.in * 0.1 +
      (u.output_tokens || 0) * PRICE.out) /
    1e6;
  totalCost += cost;

  const text = response.content?.[0]?.text || "";
  const parsed = parseBasket(text);
  const data = parsed ? sanitize(parsed.items, style) : null;
  const rawCount = Array.isArray(parsed?.items) ? parsed.items.length : 0;
  const kept = data ? data.diets[style] : [];

  console.log(`── run ${i}/${runs} ${"─".repeat(40)}`);
  console.log(
    `tokens: ${u.input_tokens} in` +
      (u.cache_read_input_tokens ? ` (+${u.cache_read_input_tokens} cached)` : "") +
      ` / ${u.output_tokens} out · ${ms} ms · ${usd(cost)}`
  );

  if (!data) {
    console.log(`✖ generation REJECTED — endpoint would return 502 (bad_generation).`);
    console.log(`  raw items from model: ${rawCount}`);
    if (!parsed) console.log(`  (could not parse JSON from the response)`);
    console.log(`  first 400 chars of response:\n  ${text.slice(0, 400).replace(/\n/g, "\n  ")}\n`);
    continue;
  }

  const byCat = Object.fromEntries(
    CATEGORIES.map((c) => [c, kept.filter((it) => it.category === c).length])
  );
  console.log(
    `✓ valid basket: ${kept.length} items kept of ${rawCount}` +
      `  (${CATEGORIES.map((c) => `${byCat[c]} ${c}`).join(", ")})`
  );
  console.log(
    "  " +
      kept
        .map((it) => it.name)
        .join(", ")
  );
  console.log("");
}

console.log("─".repeat(52));
console.log(`Total: ${usd(totalCost)} for ${runs} run${runs > 1 ? "s" : ""}` +
  (runs > 1 ? `  (${usd(totalCost / runs)} each)` : ""));
console.log(
  `\nThe deterministic engine then scales this basket to hit the macros exactly —\n` +
    `that step runs client-side and is covered by the Vitest suite.\n`
);
