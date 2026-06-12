/**
 * Tenant admin CLI (H2/H3). Mints/lists bearer-token tenants and sets a
 * tenant's own LLM provider + (encrypted) API key.
 *
 *   npm run tenant:create -- <tenant-id> [label words...]
 *   npm run tenant:list
 *   npm run tenant:llm    -- <tenant-id> <gemini-cli|openai-compat> [model] [baseUrl]
 *       (the API key is read from the COMMS_TENANT_KEY env var, so it stays out
 *        of shell history; storing it also requires COMMS_SECRET_KEY)
 *
 * The token is printed ONCE on create and is not recoverable — only its hash is
 * stored. Start the backend with COMMS_REQUIRE_AUTH=1 to enforce auth.
 */
import { createTenant, listTenants } from "../src/auth.js";
import { setTenantLLM } from "../src/secrets.js";
import type { ProviderName } from "../src/config.js";

const [, , cmd, ...rest] = process.argv;

function usage(): never {
  console.error(
    [
      "usage:",
      "  npm run tenant:create -- <tenant-id> [label words...]",
      "  npm run tenant:list",
      "  npm run tenant:llm    -- <tenant-id> <gemini-cli|openai-compat> [model] [baseUrl]",
      "      (API key via COMMS_TENANT_KEY env; storing it needs COMMS_SECRET_KEY)",
    ].join("\n"),
  );
  process.exit(1);
}

if (cmd === "create") {
  const id = rest[0];
  if (!id) usage();
  const label = rest.slice(1).join(" ") || undefined;
  try {
    const { id: tid, token } = createTenant(id, label);
    console.log(`\nTenant created: ${tid}${label ? `  (${label})` : ""}`);
    console.log("\nAPI token — shown ONCE, store it now (it is not recoverable):\n");
    console.log("  " + token + "\n");
    console.log("Send it on every request as:");
    console.log(`  Authorization: Bearer ${token}\n`);
    console.log("Enforce auth by starting the backend with COMMS_REQUIRE_AUTH=1.\n");
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
} else if (cmd === "list") {
  const tenants = listTenants();
  if (tenants.length === 0) {
    console.log("No tenants yet. Create one:  npm run tenant:create -- <tenant-id>");
    process.exit(0);
  }
  console.log(`${tenants.length} tenant(s):\n`);
  for (const t of tenants) {
    const label = t.label ? `  (${t.label})` : "";
    console.log(
      `  ${t.id}${label}  created=${t.created_at}  last_seen=${t.last_seen_at ?? "never"}`,
    );
  }
} else if (cmd === "llm") {
  const [id, provider, model, baseUrl] = rest;
  if (!id || !provider) usage();
  if (provider !== "gemini-cli" && provider !== "openai-compat") {
    console.error("provider must be 'gemini-cli' or 'openai-compat'");
    process.exit(1);
  }
  const apiKey = process.env.COMMS_TENANT_KEY ?? "";
  try {
    setTenantLLM(id, {
      provider: provider as ProviderName,
      baseUrl: baseUrl ?? "",
      model: model ?? "",
      temperature: undefined,
      apiKey,
    });
    const keyNote = apiKey ? " (key stored, encrypted)" : " (no key changed)";
    console.log(
      `LLM config saved for tenant '${id}': provider=${provider}` +
        `${model ? ` model=${model}` : ""}${baseUrl ? ` base=${baseUrl}` : ""}${keyNote}`,
    );
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
} else {
  usage();
}
