# Deploying the Comms Assistant backend

This guide covers hosting the **backend** (the Node/Express server + dashboard).
The Chrome extension stays on each user's machine; it just needs to be pointed
at the deployed URL (see [Point the clients at it](#point-the-clients-at-it)).

> The backend runs **fully local by default**. Everything below is opt-in via
> environment variables — none of it changes the `127.0.0.1:8000` local
> experience unless you set the flags.

---

## What the backend needs from a host

1. **A long-running Node process** (not serverless/edge). It's a stateful
   Express server, not a function.
2. **A persistent disk** for the SQLite database and per-tenant files under
   `/app/data`. Most *free* tiers have an **ephemeral** filesystem — without a
   mounted volume your data is wiped on every redeploy/restart. Hosts with
   volumes: **Fly.io**, **Railway**, **Oracle Cloud** (a real VM). On Render's
   free tier the disk is ephemeral (persistent disk is a paid add-on).
3. **An HTTP LLM provider.** The local `gemini-cli` provider shells out to a
   `gemini` binary that won't exist in the cloud — hosted, use the
   `openai-compat` provider with a per-tenant key (see
   [Provision tenants](#provision-tenants)).

---

## Environment variables

| Var | Purpose | Hosted value |
|---|---|---|
| `PORT` | Listen port | set by most platforms; default `8000` |
| `COMMS_BIND_HOST` | Bind interface | `0.0.0.0` (the Dockerfile sets this) |
| `COMMS_REQUIRE_AUTH` | Require a bearer token on every data route | `1` |
| `COMMS_SECRET_KEY` | Master key that encrypts per-tenant API keys at rest (AES-256-GCM). **Required** to store tenant LLM keys. | a long random string |
| `COMMS_CORS_ORIGINS` | CORS allow-list (comma-separated) instead of `*` | e.g. `https://your-dashboard.example` |
| `COMMS_RATE_LIMIT_PER_MIN` | Per-tenant requests/min on `/analyze` (0 = off) | e.g. `30` |
| `LLM_PROVIDER` / `OPENAI_*` | Global fallback provider for tenants with no own key | optional |

Generate a secret key, for example:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> **Never** commit `COMMS_SECRET_KEY` or any API key. Set them as the platform's
> secrets, not in the image.

---

## Build & run with Docker (local check)

The build context is the `backend/` directory:

```bash
docker build -t comms-backend ./backend

docker run --rm -p 8000:8000 \
  -e COMMS_REQUIRE_AUTH=1 \
  -e COMMS_SECRET_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" \
  -v comms-data:/app/data \
  comms-backend
```

`-v comms-data:/app/data` is what makes SQLite survive restarts. `/health` is
public; every data route now returns `401` without a valid token.

---

## Provision tenants

Tenants are created with the `tenant` CLI **inside the running container** (so it
uses the same database + secret key). Each command prints a token **once**.

```bash
# Mint a tenant + its bearer token (store the printed token now):
docker exec -it <container> npm run tenant:create -- acme "Acme Inc"

# Give that tenant its own (encrypted) LLM key — key via env, not argv:
docker exec -it <container> \
  sh -c 'COMMS_TENANT_KEY=sk-... npm run tenant:llm -- acme openai-compat gpt-4o-mini https://api.openai.com/v1'

docker exec -it <container> npm run tenant:list
```

A tenant with no key of its own falls back to the global `LLM_PROVIDER`/`OPENAI_*`
config, if you set one.

---

## Fly.io (volume-backed, good SQLite fit)

```bash
fly launch --no-deploy            # detects the Dockerfile; pick a region
fly volumes create comms_data --size 1     # 1 GB persistent disk
# In fly.toml, mount it:  [mounts] source = "comms_data"  destination = "/app/data"
fly secrets set COMMS_REQUIRE_AUTH=1 COMMS_SECRET_KEY=<random> COMMS_CORS_ORIGINS=https://...
fly deploy
```

## Railway

1. New project → **Deploy from repo** (it detects the Dockerfile; set the root
   to `backend/` if asked).
2. Add a **Volume** mounted at `/app/data`.
3. Add the variables from the table above (Railway injects `PORT`).
4. Deploy, then `railway run` / the shell to run the `tenant:*` commands.

> Free/trial terms change — confirm current limits when you sign up. Railway is
> credit-based; Fly has a small always-free allowance plus trial credit.

---

## Point the clients at it

Once the backend has a public HTTPS URL and a tenant token:

- **Extension** — open the toolbar popup → set **Backend URL** to the deployed
  origin and paste the **Access token**. (A non-localhost origin triggers a
  one-time host-permission grant.)
- **Dashboard** — open the deployed URL → Settings → **Access token** → paste
  and Save. The page reloads its data through the token.

---

## Notes & follow-ups

- **TLS** is terminated at the platform edge (Fly/Railway give you HTTPS); the
  app itself speaks plain HTTP behind it.
- **Erasure**: `POST /data/purge` with `{ "confirm": "<tenantId>" }` deletes a
  tenant's relational data. Filesystem artefacts (a tenant's `data/tenants/<id>/`
  voice + snapshots) are not yet auto-removed — delete them from the volume if
  you need full erasure.
- **Backups**: snapshot the `/app/data` volume on whatever cadence you need.
- Multi-node scaling would need the in-memory rate limiter swapped for a shared
  store (Redis) — the `checkRate()` contract is designed for that swap.
