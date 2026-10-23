import { createHandler, createRpc } from "./receiver.mjs";

// Supabase supplies these backend-only values. No custom secret is required.
let rpc: (name: string, parameters: unknown) => Promise<unknown>;
try {
  const configuredKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
  const modernKey = configuredKeys?.default;
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const modern = typeof modernKey === "string" && modernKey.startsWith("sb_secret_");
  rpc = createRpc({
    url: Deno.env.get("SUPABASE_URL"),
    key: modern ? modernKey : legacyKey,
    legacy: !modern,
  });
} catch {
  rpc = () => Promise.reject(new Error("backend_not_configured"));
}

Deno.serve(createHandler({ rpc }));
