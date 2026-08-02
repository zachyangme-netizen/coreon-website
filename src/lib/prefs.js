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
