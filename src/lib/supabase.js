// Single shared Supabase client, created from Vite env vars.
//
// Keys are injected at build time from .env (VITE_* vars are exposed to the
// browser by design — the anon key is public and protected server-side by
// Row-Level Security). If the env vars are absent (e.g. before you've pasted
// your project keys), `supabase` is null and every auth/prefs feature degrades
// to a no-op — the site keeps working exactly as it did before auth existed.

import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase =
  url && anonKey ? createClient(url, anonKey) : null;

if (!supabase) {
  console.info(
    "[coreon] Supabase not configured (no VITE_SUPABASE_URL / _ANON_KEY) — auth + cloud sync disabled."
  );
}
