// Renders the sign-in / sign-out control into the site nav on every page.
// Side-effect module: importing it mounts the control. Does nothing when
// Supabase isn't configured, so the nav looks exactly as before until you add
// your keys.

import { supabase } from "../lib/supabase.js";
import { onAuth, sendMagicLink, signOut } from "./auth.js";

function mount() {
  if (!supabase) return; // auth not configured — leave the nav untouched
  const nav = document.querySelector(".nav-links");
  if (!nav || nav.querySelector(".nav-auth")) return;

  const slot = document.createElement("div");
  slot.className = "nav-auth";
  nav.appendChild(slot);

  const renderSignedOut = () => {
    slot.innerHTML = `<button type="button" class="nav-auth-btn" data-act="open">Sign in</button>`;
    slot.querySelector('[data-act="open"]').addEventListener("click", renderForm);
  };

  const renderForm = () => {
    slot.innerHTML = `
      <form class="nav-auth-form">
        <input type="email" required placeholder="you@email.com" aria-label="Email for sign-in link" />
        <button type="submit" class="nav-auth-btn">Send link</button>
      </form>`;
    const form = slot.querySelector("form");
    const input = slot.querySelector("input");
    input.focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector("button");
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        await sendMagicLink(input.value.trim());
        slot.innerHTML = `<span class="nav-auth-note">Check your email ✉</span>`;
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Send link";
        slot.innerHTML =
          `<span class="nav-auth-note nav-auth-note-error">${err.message}</span>` +
          slot.innerHTML;
      }
    });
  };

  const renderSignedIn = (session) => {
    const email = session.user.email || "Account";
    slot.innerHTML = `
      <span class="nav-auth-email" title="${email}">${email}</span>
      <button type="button" class="nav-auth-btn" data-act="out">Sign out</button>`;
    slot
      .querySelector('[data-act="out"]')
      .addEventListener("click", () => signOut());
  };

  onAuth((session) => {
    if (session) renderSignedIn(session);
    else renderSignedOut();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
