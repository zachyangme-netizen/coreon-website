import { defineConfig } from "vite";

// Coreon is a multi-page app: each tool is its own HTML entry point, not a
// client-side route. List every page here so Vite bundles each one's module
// graph independently. `api/` is intentionally absent — those are Vercel
// serverless functions, not part of the frontend build.
export default defineConfig({
  appType: "mpa", // no SPA history fallback; unknown paths 404 like today
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        haul: "haul.html",
        runbook: "runbook.html",
        strength: "strength.html",
      },
    },
  },
});
