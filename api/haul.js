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
//
// The prompt + server-side validation live in src/lib/haul-ai-prompt.js (pure,
// testable, and reused by scripts/try-haul-ai.mjs).

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import {
  MODEL,
  DAILY_LIMIT,
  STYLES,
  SYSTEM_PROMPT,
  buildUserMessage,
  sanitize,
  parseBasket,
} from "../src/lib/haul-ai-prompt.js";

const client = new Anthropic();

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
    const parsed = parseBasket(text);
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
