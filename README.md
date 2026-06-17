# Play DR Agents

Play DR Agents is a shared, multi-user chat platform for custom Gemini agents. It is built so that knowledge is *collective*: anyone in the organization can see every agent, read its full conversation history, and continue any thread. There are no private chats — each agent owns a single shared, append-only conversation that the whole team builds together. The app ships as a single monolith designed for Google Cloud Run (the Express API serves the bundled React SPA from one container). In production, access is gated by **Identity-Aware Proxy** — restricted to the Monks Workspace, with the app trusting IAP's verified identity for single sign-on — plus app-managed **user/admin roles**; in local development the app runs its own Google OAuth + hosted-domain check. **`allUsers` IAM is never used.**

## Architecture

A single Node container runs everything. The Express server exposes a JSON API under `/api` and also serves the pre-built React/Vite SPA (`client/dist`) as static files, falling back to `index.html` for client-side routing. The only unauthenticated app routes are the OAuth handshake under `/api/auth` and the `/healthz` health check; every other `/api/*` route requires a valid session.

- **Web/API:** Express monolith. Serves the bundled SPA + the JSON API from one process/port.
- **Database:** PostgreSQL accessed through Prisma (Cloud SQL compatible).
- **File storage:** a `FileStorage` abstraction selected by `STORAGE_DRIVER` — local disk in dev (`local`), Google Cloud Storage in prod (`gcs`).
- **LLM:** Google Gemini behind a swappable `LlmProvider` interface (only Gemini is implemented today; the rest of the app depends on the interface).
- **Auth:** Google OAuth 2.0 with the consent screen set to **Internal**, plus a hosted-domain (`hd`) + email-domain check, HTTP-only cookie sessions (signed JWT), and app-managed `USER` / `ADMIN` roles.

```
                          Google OAuth (Internal)
                                   │  ID token (verified: signature, hd, email)
                                   ▼
  Browser ──HTTPS──▶  ┌───────────────────────────────────────────┐
   (SPA on 5173       │            Cloud Run container             │
    in dev, served    │  ┌─────────────────────────────────────┐  │
    by the API in     │  │  Express monolith                    │  │
    prod)             │  │   /healthz, /api/auth   (public)     │  │
                      │  │   /api/*                (session)    │  │
                      │  │   static SPA  (client/dist)          │  │
                      │  └───────┬──────────────┬───────────────┘  │
                      └──────────┼──────────────┼──────────────────┘
                                 │              │
                          Prisma │              │ FileStorage / LlmProvider
                                 ▼              ▼
                          PostgreSQL      GCS bucket  +  Gemini API
                          (Cloud SQL)     (prod)
```

## Tech stack

- **Runtime:** Node.js (verified on Node 20; `engines` requires `>=18.18`), TypeScript.
- **Server:** Express, `cookie-parser`, `zod` (validated env config), `google-auth-library`, `jsonwebtoken` (cookie sessions).
- **Database/ORM:** PostgreSQL + Prisma (`@prisma/client`).
- **Client:** React + Vite SPA, served statically by the API in production.
- **LLM:** Google Gemini via a `LlmProvider` interface.
- **Storage:** local disk or Google Cloud Storage via a `FileStorage` interface.
- **Packaging:** npm workspaces (`server`, `client`), multi-stage Docker, Google Cloud Run + Cloud SQL + GCS.

## Domain model

Defined in [`prisma/schema.prisma`](prisma/schema.prisma):

- **User** — a Workspace user, auto-provisioned on first OAuth login. Has a `role` of `USER` or `ADMIN`.
- **Agent** — a custom agent (a ported Gemini "Gem") with `title`, `description`, and `instructions` (the system prompt). Visible to everyone; editable/deletable by its `owner` only.
- **File** — an uploaded file in the shared, platform-wide library (filename, mime type, size, `storageKey`). Reusable across agents and users.
- **AgentFile** — join table linking an agent to the shared files it references as context.
- **Message** — a single turn in an agent's conversation. `role` is `USER` or `ASSISTANT` (`authorId` is null for assistant turns). `referencedMessageIds` records which prior messages the author explicitly included as context for the prompt.

**Shared, append-only thread per agent:** each agent has exactly one conversation that the whole org reads and contributes to. Messages are only ever appended, so the history is a durable, collective record — anyone can pick up where anyone else left off.

## Prerequisites

- **Node.js >= 18** (the project is verified on **Node 20**). Your machine's default system Node may be older than 18.18 — if so, install and select a recent version with [`nvm`](https://github.com/nvm-sh/nvm) (e.g. `nvm install 20 && nvm use 20`).
- **Docker** (and Docker Compose) — used to run a local PostgreSQL instance.
- A **Google Cloud project** with an **OAuth 2.0 client** (consent screen type Internal). See [Google OAuth (Internal) setup](#google-oauth-internal-setup).
- A **Gemini API key**.

## Local development

1. **Create your env file.** Copy the example and fill in real values:

   ```bash
   cp .env.example .env
   ```

   For **local** development set these two URLs explicitly:

   ```dotenv
   APP_BASE_URL=http://localhost:5173
   GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8080/api/auth/google/callback
   ```

   **Why:** in dev the Vite client runs on **5173** and proxies `/api` to the API server on **8080**. The OAuth *callback* must hit the server (port 8080), but the post-login redirect is built from `APP_BASE_URL`, so it should land you back on the Vite dev client (port 5173). Also set real `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`, and your `ALLOWED_DOMAINS` / `ADMIN_EMAILS` — the placeholders in `.env.example` will not authenticate.

2. **Start PostgreSQL** (matches the dev `DATABASE_URL` in `.env.example`):

   ```bash
   docker compose up -d db
   ```

3. **Install dependencies** (npm workspaces; `postinstall` runs `prisma generate`):

   ```bash
   npm install
   ```

4. **Create and apply the dev migration / schema:**

   ```bash
   npm run prisma:migrate:dev
   ```

5. **Seed the database** (creates the admins listed in `ADMIN_EMAILS`):

   ```bash
   npm run db:seed
   ```

6. **Run the app** (server on 8080 + Vite client on 5173, concurrently):

   ```bash
   npm run dev
   ```

   Then open **http://localhost:5173** and sign in with a Google account in an allowed domain.

## Environment variables

Every variable below comes from [`.env.example`](.env.example). Validation lives in `server/src/config/env.ts` — the server refuses to start if a required value is missing or invalid.

### Runtime

| Variable | Required? | Description |
| --- | --- | --- |
| `NODE_ENV` | No (default `development`) | `development`, `production`, or `test`. |
| `PORT` | No (default `8080`) | Port the server listens on. Cloud Run expects `8080`. |
| `APP_BASE_URL` | No (default `http://localhost:8080`) | Public base URL of the app. Used to build the post-login redirect. Set to `http://localhost:5173` for local dev and to your deployed URL in production. |

### Database

| Variable | Required? | Description |
| --- | --- | --- |
| `DATABASE_URL` | **Yes** | PostgreSQL connection string. For Cloud SQL via the socket connector: `postgresql://USER:PASS@localhost/DB?host=/cloudsql/PROJECT:REGION:INSTANCE`. |

### Sessions & cookies

| Variable | Required? | Description |
| --- | --- | --- |
| `SESSION_SECRET` | **Yes** | Secret used to sign the session JWT. Must be at least 16 characters — use a long random string. |
| `COOKIE_SECURE` | No (default `auto`) | `auto` => secure cookies when `NODE_ENV=production`. Force with `true` / `false`. |
| `SESSION_TTL_DAYS` | No (default `7`) | Session lifetime in days. |

### Google OAuth

| Variable | Required? | Description |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | **Yes** | OAuth 2.0 client ID (consent screen type Internal). |
| `GOOGLE_CLIENT_SECRET` | **Yes** | OAuth 2.0 client secret. |
| `GOOGLE_OAUTH_REDIRECT_URI` | **Yes** | Must exactly match an Authorized redirect URI on the OAuth client (e.g. `http://localhost:8080/api/auth/google/callback`). |

### Access control

| Variable | Required? | Description |
| --- | --- | --- |
| `ALLOWED_DOMAINS` | **Yes** (at least one) | Comma-separated Google Workspace domain(s) allowed to sign in (e.g. `monks.com`). Enforced against the verified `hd` claim and the email domain. |
| `ADMIN_EMAILS` | No | Comma-separated emails granted `ADMIN` on first login / via the seed. |

### Gemini

| Variable | Required? | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | **Yes** | Google Gemini API key. |
| `GEMINI_MODEL` | No (default `gemini-2.0-flash`) | Gemini model name. |

### File storage

| Variable | Required? | Description |
| --- | --- | --- |
| `STORAGE_DRIVER` | No (default `local`) | `local` (dev, disk) or `gcs` (production, Google Cloud Storage). |
| `LOCAL_STORAGE_DIR` | No (default `./data/uploads`) | Directory for uploads when `STORAGE_DRIVER=local`. |
| `GCS_BUCKET` | Required when `STORAGE_DRIVER=gcs` | Target GCS bucket name. |
| `GCS_PROJECT_ID` | No | GCS project ID (uses Application Default Credentials in Cloud Run). |

### Uploads

| Variable | Required? | Description |
| --- | --- | --- |
| `MAX_UPLOAD_MB` | No (default `20`) | Maximum upload size, in megabytes. |

## Google OAuth (Internal) setup

In the [Google Cloud Console](https://console.cloud.google.com/) for your project:

1. **OAuth consent screen** → set **User type = Internal**. This restricts sign-in to accounts within your Google Workspace organization.
2. **Credentials** → **Create Credentials** → **OAuth client ID** → **Application type: Web application**.
3. Add **Authorized redirect URIs** that exactly match `GOOGLE_OAUTH_REDIRECT_URI`:
   - Local: `http://localhost:8080/api/auth/google/callback`
   - Production: `https://YOUR-CLOUD-RUN-URL/api/auth/google/callback`
4. Scopes requested by the app: `openid`, `email`, `profile`.
5. Put the resulting client ID/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

**This OAuth flow is the local-development sign-in path** (and the swappable identity model). The check in `server/src/auth/oauth.ts` cryptographically verifies the Google ID token and requires both the `hd` (hosted-domain) claim **and** the email's domain to be in `ALLOWED_DOMAINS` — never trusting a raw email string, since a personal account can spoof a display name but cannot forge a verified `hd` claim on a signed token. **In production the service sits behind IAP** (see [Deploy to Cloud Run](#deploy-to-cloud-run)), which performs the Workspace sign-in; the app then trusts IAP's verified identity (`server/src/auth/iap.ts`). Either way, app-managed **user/admin roles** are the in-app authorization layer and `allUsers` IAM is never used.

## Access control & roles

- **First-login auto-provisioning:** any user whose verified identity is in `ALLOWED_DOMAINS` is created automatically on first OAuth login (default role `USER`).
- **Bootstrapping admins:** emails listed in `ADMIN_EMAILS` are granted `ADMIN` on first login / via `npm run db:seed`, seeding the first administrators.
- **Promoting others:** existing admins promote/demote other users from the in-app Admin page.
- **All checks are server-side.** Visibility is shared (everyone sees every agent and its full thread), but mutations are guarded: agents are **owner-only** for edit/delete, and **role management is admin-only**. Every `/api/*` route except the OAuth handshake requires a valid session.

## Production build & Docker

Build the client and server bundles:

```bash
npm run build
```

Build the production image (multi-stage; see [`Dockerfile`](Dockerfile)):

```bash
docker build -t collective-brain .
```

Run it (provide real env values; point `DATABASE_URL` at a reachable Postgres):

```bash
docker run --rm -p 8080:8080 \
  -e NODE_ENV=production \
  -e PORT=8080 \
  -e APP_BASE_URL=https://your-deployed-url \
  -e DATABASE_URL="postgresql://USER:PASS@HOST:5432/DB?schema=public" \
  -e SESSION_SECRET="a-long-random-string" \
  -e GOOGLE_CLIENT_ID=... \
  -e GOOGLE_CLIENT_SECRET=... \
  -e GOOGLE_OAUTH_REDIRECT_URI=https://your-deployed-url/api/auth/google/callback \
  -e ALLOWED_DOMAINS=monks.com \
  -e ADMIN_EMAILS=admin@monks.com \
  -e GEMINI_API_KEY=... \
  -e STORAGE_DRIVER=gcs \
  -e GCS_BUCKET=your-bucket \
  collective-brain
```

On start the container runs `prisma migrate deploy` and then launches the server. `migrate deploy` is idempotent and takes an advisory lock, so concurrent cold starts are safe. (To run migrations separately instead, drop the `migrate deploy &&` from the Dockerfile `CMD` and run it from a Cloud Run Job / Cloud Build step.)

## Deploy to Cloud Run

> One command runs everything: [`deploy/cloudrun-deploy.sh`](deploy/cloudrun-deploy.sh)
> enables APIs, provisions Cloud SQL + GCS + Secret Manager, wires IAM, deploys, and turns
> on IAP. It is re-runnable. The steps below explain what it does.

Prereqs: `gcloud auth login`, the `beta` component (`gcloud components install beta`), billing
enabled, and a `.env` with real `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GEMINI_API_KEY`.

1. **Provision Cloud SQL (PostgreSQL)** and create the database/user. Use the Cloud SQL connector form for `DATABASE_URL`:

   ```
   postgresql://USER:PASS@localhost/DB?host=/cloudsql/PROJECT:REGION:INSTANCE
   ```

   Attach the instance to the service with `--add-cloudsql-instances PROJECT:REGION:INSTANCE`.

2. **Create a GCS bucket** for uploads and configure storage:
   - Set `STORAGE_DRIVER=gcs` and `GCS_BUCKET=your-bucket`.
   - Grant the Cloud Run service account `roles/storage.objectAdmin` **on that bucket**.
   - Credentials come from **Application Default Credentials** in Cloud Run — no key file is needed.

3. **Keep secrets in Secret Manager** (e.g. `SESSION_SECRET`, `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`, and the DB password / `DATABASE_URL`) and wire them with `--set-secrets`.

4. **Deploy** from source (Cloud Build builds the Dockerfile), with the env above plus `IAP_ENABLED=true`. Do **not** pass `--allow-unauthenticated` (see IAP below):

   ```bash
   gcloud run deploy play-dr-agents --source . \
     --region REGION --port 8080 \
     --add-cloudsql-instances PROJECT:REGION:INSTANCE \
     --set-env-vars NODE_ENV=production,IAP_ENABLED=true,STORAGE_DRIVER=gcs,GCS_BUCKET=your-bucket,ALLOWED_DOMAINS=monks.com,ADMIN_EMAILS=admin@monks.com,GEMINI_MODEL=gemini-3.5-flash,GOOGLE_CLIENT_ID=...,GOOGLE_OAUTH_REDIRECT_URI=https://placeholder.invalid/api/auth/google/callback,APP_BASE_URL=https://placeholder.invalid \
     --set-secrets DATABASE_URL=DATABASE_URL:latest,SESSION_SECRET=SESSION_SECRET:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest
   ```

5. **Point `APP_BASE_URL` + `GOOGLE_OAUTH_REDIRECT_URI` at the real URL** once the deploy returns it (an env-only `gcloud run services update`, no rebuild). With IAP fronting the app you do **not** register a redirect URI on the OAuth client.

### Access: Identity-Aware Proxy (IAP)

This org enforces **Domain Restricted Sharing**, so `--allow-unauthenticated` (an `allUsers` binding) is rejected: the deploy succeeds but logs `Setting IAM policy failed … FAILED_PRECONDITION: …do not belong to a permitted customer`, leaving the service unreachable. The supported pattern (used by sibling services) is **direct Cloud Run + IAP** — no load balancer:

```bash
# enable IAP on the service (auto-grants the IAP service agent run.invoker)
gcloud beta run services update play-dr-agents --region REGION --iap

# let the whole Workspace domain through IAP (domain members ARE permitted under DRS, unlike allUsers)
gcloud beta iap web add-iam-policy-binding \
  --resource-type=cloud-run --service=play-dr-agents --region=REGION \
  --member=domain:monks.com --role=roles/iap.httpsResourceAccessor
```

A Workspace user hits the URL → signs in once at IAP → lands authenticated. In production the app runs with `IAP_ENABLED=true` and **trusts IAP's verified identity** (`server/src/auth/iap.ts`): it provisions/loads the user from IAP and issues no second login — **single sign-on**. The app's own Google OAuth (the `GOOGLE_*` vars) is the **local-development** sign-in path. App-managed **user/admin roles** apply on top. (Optional hardening: set `IAP_AUDIENCE` to cryptographically verify the IAP JWT instead of trusting its identity header.)

**Migrations** run automatically on container start (`prisma migrate deploy`); or run them as a separate **Cloud Run Job** against the same database.

**Localizer (Lazarus)** ships in `mock` mode until Google allowlists `localizer.googleapis.com` for your GWCID / developer account. The runtime service account already impersonates the privilege SA, so going live is a single update:

```bash
gcloud run services update play-dr-agents --region REGION \
  --update-env-vars TRANSLATE_PROVIDER=lazarus,LOCALIZER_PRINCIPAL=pipeline-sa@PROJECT.iam.gserviceaccount.com
```

## Project structure

```
.
├── Dockerfile                 # multi-stage build; runtime runs `prisma migrate deploy` then starts
├── docker-compose.yml         # local Postgres ("db") service
├── package.json               # npm workspaces (server, client) + scripts
├── tsconfig.base.json
├── .env.example
├── prisma/
│   └── schema.prisma          # User, Agent, File, AgentFile, Message
├── server/
│   └── src/
│       ├── index.ts           # entrypoint (boots the HTTP server)
│       ├── app.ts             # Express app: routes + static SPA
│       ├── config/            # validated env config (env.ts)
│       ├── lib/               # prisma client, errors, logger, validation
│       ├── auth/              # oauth, session, middleware, routes
│       ├── middleware/        # error / 404 handlers
│       ├── storage/           # FileStorage abstraction: index, local, gcs
│       ├── llm/               # LlmProvider abstraction: index, gemini
│       └── modules/           # feature routers (messages, admin, …)
└── client/
    └── src/
        ├── main.tsx           # SPA entry
        ├── App.tsx
        ├── api/               # API client
        ├── auth/              # AuthContext
        ├── components/        # Layout, ProtectedRoute
        └── pages/             # LoginPage, …
```

## npm scripts

From [`package.json`](package.json):

| Script | What it does |
| --- | --- |
| `npm run dev` | Runs the API server and Vite client concurrently (server on 8080, client on 5173). |
| `npm run build` | Builds the client (Vite) and the server (tsc) for production. |
| `npm start` | Starts the built server: `node server/dist/index.js`. |
| `npm run typecheck` | Type-checks both the server and client workspaces. |
| `npm run prisma:generate` | Runs `prisma generate` to (re)generate the Prisma client. |
| `npm run prisma:migrate` | Applies pending migrations in production: `prisma migrate deploy`. |
| `npm run prisma:migrate:dev` | Creates and applies a dev migration: `prisma migrate dev`. |
| `npm run db:seed` | Seeds the database (`prisma/seed.ts`), including the `ADMIN_EMAILS` admins. |

## Security notes

- **HTTP-only cookie sessions.** The session is a signed JWT stored in an HTTP-only cookie with `SameSite` set and the `Secure` flag enabled in production (`COOKIE_SECURE=auto`). Cloud Run terminates TLS at the proxy, so the app trusts the proxy (`trust proxy`) for secure cookies to work.
- **Signed sessions.** Session JWTs are signed with `SESSION_SECRET` (minimum 16 chars; use a long random value).
- **Server-side authorization everywhere.** Every `/api/*` route except the OAuth handshake requires a valid session; ownership (agents) and role (admin) checks are enforced on the server, never the client.
- **Verified OAuth identity.** The Google **ID token is cryptographically verified** (signature + audience), and both the `hd` hosted-domain claim and the email domain must be in `ALLOWED_DOMAINS`. The raw email is never trusted on its own.
- **Upload limits.** Uploads are bounded by type and size (`MAX_UPLOAD_MB`, default 20 MB).
- **No public API surface.** The only unauthenticated endpoints are `/healthz` and the OAuth handshake under `/api/auth`; everything else is gated by the session.
