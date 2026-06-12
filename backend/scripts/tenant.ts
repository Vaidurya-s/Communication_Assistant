/**
 * Tenant admin CLI (H2). Mints and lists bearer-token tenants.
 *
 *   npm run tenant:create -- <tenant-id> [label words...]
 *   npm run tenant:list
 *
 * The token is printed ONCE on create and is not recoverable — only its hash is
 * stored. Start the backend with COMMS_REQUIRE_AUTH=1 to enforce auth.
 */
import { createTenant, listTenants } from "../src/auth.js";

const [, , cmd, ...rest] = process.argv;

function usage(): never {
  console.error(
    [
      "usage:",
      "  npm run tenant:create -- <tenant-id> [label words...]",
      "  npm run tenant:list",
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
} else {
  usage();
}
