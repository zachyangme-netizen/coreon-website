// AI-generated Haul basket.
//
// Design: the AI does NOT do the macro arithmetic. It only proposes a realistic,
// varied *basket* of foods (respecting diet + avoid). The client then runs the
// same deterministic engine (generateHaul) that scales each item to hit the
// targets — so macros stay exact and the result is editable like any other haul.
//
// This endpoint is the guardrail layer (audit #1): it is auth-gated (Supabase
// session required) and rate-limited per user per day via the bump_ai_usage RPC.
// Every response — success or failure — carries a short `reqId` that also prints
// in the server logs, so a failure can be traced from one number instead of
// guessing. Failures that only ever reach a signed-in caller also carry a
// `detail` with the underlying error, so the client can show/log it directly.
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
  const reqId = makeReqId();
  try {
    if (req.method !== "POST") return fail(res, reqId, 405, "method_not_allowed");

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnon = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnon) return fail(res, reqId, 503, "auth_unconfigured");

    // 1. Require a valid Supabase session (blocks anonymous internet abuse).
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return fail(res, reqId, 401, "signed_out");

    const supa = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await supa.auth.getUser();
    if (userErr || !userData?.user) {
      return fail(res, reqId, 401, "invalid_session", userErr?.message);
    }

    // 2. Rate limit: atomic per-user daily counter (cost control).
    const { data: usage, error: rpcErr } = await supa.rpc("bump_ai_usage", {
      p_limit: DAILY_LIMIT,
    });
    if (rpcErr) {
      if (rpcErr.code === "P0001" || /rate_limited/.test(rpcErr.message || "")) {
        return fail(res, reqId, 429, "rate_limited", null, { limit: DAILY_LIMIT });
      }
      return fail(res, reqId, 500, "usage_error", rpcErr.message);
    }

    // 3. Validate the request body.
    const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
    const targets = (body && body.targets) || {};
    const diet = (body && body.diet) || {};
    const style = STYLES.includes(diet.style) ? diet.style : "omnivore";
    diet.style = style;
    if (!Array.isArray(diet.avoid)) diet.avoid = [];
    if (!(targets.target > 0) || !(targets.protein > 0)) {
      return fail(res, reqId, 400, "bad_targets");
    }

    // 4. Ask the model for a basket, validate it, hand it back for the engine.
    let response;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 1600,
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: buildUserMessage({ targets, diet }) }],
      });
    } catch (err) {
      // Anthropic call failed (bad/missing key, no credits, overloaded, …).
      // `err.status` is the HTTP status from the API — the key signal.
      return fail(res, reqId, 502, "ai_error", `${err?.status ?? ""} ${err?.name ?? ""}: ${err?.message ?? err}`.trim(), {
        anthropicStatus: err?.status ?? null,
      });
    }

    const text = response.content?.[0]?.text || "";
    const parsed = parseBasket(text);
    const data = parsed ? sanitize(parsed.items, style) : null;
    if (!data) return fail(res, reqId, 502, "bad_generation");

    console.log(`[haul ${reqId}] 200 ok · ${data.diets[style].length} items · usage ${usage}/${DAILY_LIMIT}`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      data,
      source: "ai",
      usage: { count: usage, limit: DAILY_LIMIT },
      reqId,
    });
  } catch (err) {
    // Anything the branches above didn't catch (import/runtime crash, etc.).
    return fail(res, reqId, 500, "handler_crash", err?.stack || err?.message || String(err));
  }
}

// Log the failure with its reqId and return a JSON body carrying the same reqId
// (+ optional detail/extra), so logs and responses correlate one-to-one.
function fail(res, reqId, status, reason, detail, extra) {
  const payload = { ok: false, reason, reqId, ...(extra || {}) };
  if (detail) payload.detail = String(detail).slice(0, 500);
  console.error(`[haul ${reqId}] ${status} ${reason}${detail ? " — " + payload.detail : ""}`);
  return res.status(status).json(payload);
}

// Short, unique-enough id for correlating a log line with a response.
function makeReqId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
