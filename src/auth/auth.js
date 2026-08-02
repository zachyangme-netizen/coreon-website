// Auth helpers — magic-link (passwordless email) sign-in.
//
// Every function is a safe no-op when Supabase isn't configured, so callers
// don't need to guard. `onAuth` fires once with the current session and again
// on every change (sign-in / sign-out / token refresh).

import { supabase } from "../lib/supabase.js";

// Where the magic link returns the user. Same page, minus any hash — Supabase
// appends its own tokens to the URL, which supabase-js consumes on load.
// NOTE: this URL must be listed under Supabase → Authentication → URL
// Configuration → Redirect URLs (add http://localhost:5173 for local dev and
// your production origin).
function redirectTo() {
  return window.location.origin + window.location.pathname;
}

export async function sendMagicLink(email) {
  if (!supabase) throw new Error("Auth is not configured yet.");
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo() },
  });
  if (error) throw error;
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// Subscribe to auth state. Returns an unsubscribe function.
export function onAuth(callback) {
  if (!supabase) {
    callback(null);
    return () => {};
  }
  supabase.auth.getSession().then(({ data }) => callback(data.session));
  const { data: sub } = supabase.auth.onAuthStateChange((_event, session) =>
    callback(session)
  );
  return () => sub.subscription.unsubscribe();
}
