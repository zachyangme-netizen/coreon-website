// Cloud sync for wizard preferences.
//
// localStorage stays the synchronous source of truth for an instant, offline
// experience. This layer adds, only when a user is signed in:
//   - pushRemote(key, state): debounced write-through to Supabase on every save
//   - pullRemoteIfSignedIn(key): fetch the saved state (used on load to restore
//     preferences onto a fresh device)
//
// Rows live in the `preferences` table, one per (user_id, key), guarded by RLS
// so a user can only touch their own. Every function is a no-op when Supabase
// isn't configured or nobody is signed in.

import { supabase } from "./supabase.js";

const DEBOUNCE_MS = 800;
const timers = {};

export function pushRemote(key, state) {
  if (!supabase) return;
  clearTimeout(timers[key]);
  timers[key] = setTimeout(async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    const { error } = await supabase.from("preferences").upsert(
      {
        user_id: session.user.id,
        key,
        state,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,key" }
    );
    if (error) console.warn("[coreon] cloud save failed:", error.message);
  }, DEBOUNCE_MS);
}

// How many AI hauls the signed-in user has generated today (UTC), read from the
// `ai_usage` table the endpoint writes. RLS restricts it to the caller's own
// row. Returns 0 when signed in with no usage yet, or null when we can't tell
// (signed out / not configured / error) so the caller can hide the indicator.
export async function getAIUsageToday() {
  if (!supabase) return null;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const { data, error } = await supabase
    .from("ai_usage")
    .select("count")
    .eq("user_id", session.user.id)
    .eq("day", today)
    .maybeSingle();
  if (error) {
    console.warn("[coreon] usage load failed:", error.message);
    return null;
  }
  return data?.count ?? 0;
}

export async function pullRemoteIfSignedIn(key) {
  if (!supabase) return null;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  const { data, error } = await supabase
    .from("preferences")
    .select("state")
    .eq("user_id", session.user.id)
    .eq("key", key)
    .maybeSingle();
  if (error) {
    console.warn("[coreon] cloud load failed:", error.message);
    return null;
  }
  return data?.state ?? null;
}
