# Deploying a single-container app to Cloud Run (human guide)

Field guide for shipping a web app to **Google Cloud Run**, gated by **Identity-Aware Proxy
(IAP)**, backed by **Cloud SQL (Postgres)**, **Google Cloud Storage**, **Secret Manager**, and
(optionally) **Gemini** / partner Google APIs.

It's written from a real deployment into a Google Workspace org with strict policies, so it
front-loads the **roadblocks** that cost the most time. The platform mechanics here are the same
for any language; the stack-specific bits use the **approved stack** below.

---

## ⛔ Stack policy (read first)

Use only the org-approved stack:

| Layer | ✅ Use | ❌ Prohibited |
| --- | --- | --- |
| **Frontend** | **Lit (preferred)** or React; **Material Design** (e.g. Material Web `@material/web`) | **Tailwind** |
| **Backend / server runtime** | **Python** — vanilla WSGI or **Flask**. **Glue** is also acceptable. | **Node.js, Express**, and **FastAPI** (hard no) |
| **Build tooling** | A JS bundler may run at *build time* only (or ship Lit as buildless ES modules) | A Node.js *server/runtime* |

> The served runtime must be **Python**. Build-time tooling for the Lit/React assets is fine, but
> nothing Node/Express should run in production. Prefer Lit shipped as static ES modules so the
> frontend has no Node dependency at all.
>
> (Note: some existing reference repos use Node/Express or FastAPI — that predates this policy.
> The Cloud Run / IAP / SQL / GCS / Secret Manager steps below are identical regardless; only the
> Dockerfile, the migration tool, and the IAP-trust hook differ by language.)

The target shape: **one container** running a **Python (Flask/WSGI) server** that exposes the
JSON API **and** serves the built **Lit/React** static assets, fronted by **IAP**.

---

## 0. Architecture invariants that make a deploy easy

| Invariant | Why it matters |
| --- | --- |
| **One container, one port** | Cloud Run runs one image and sends traffic to `$PORT` (default 8080). The Python server (e.g. `gunicorn`) must serve both the API *and* the built Lit/React assets. |
| **Stateless** | Instances are ephemeral; the filesystem is read-only except `/tmp`. **No local disk for uploads** → use GCS. No in-process sessions that must persist → DB or stateless token. |
| **Config from env** | Everything (DB URL, secrets, flags) comes from env / Secret Manager, never a committed file. Validate at startup (e.g. `pydantic-settings`) so misconfig fails fast. |
| **Migrations on boot** | Entrypoint runs your migration tool (e.g. **Alembic** `alembic upgrade head`) before `gunicorn`. Idempotent, so a fresh DB self-heals. |
| **Build pinned to a modern runtime** | Dockerfile pins e.g. `python:3.12-slim`. Don't rely on the host's Python/JS versions. |

If the app keeps state on local disk or assumes a long-lived process, fix that *before*
deploying — it will "work" in one instance and silently lose data across cold starts.

### Reference Dockerfile shape (Python server + prebuilt Lit assets)

```dockerfile
# ---- (optional) build the Lit/React assets ----
# FROM node:20-slim AS web    # build-time ONLY; no Node in the final image
# WORKDIR /web ; COPY web/ . ; RUN npm ci && npm run build   # -> /web/dist
# (Or skip entirely and ship Lit as static ES modules under static/.)

# ---- Python runtime ----
FROM python:3.12-slim
RUN apt-get update -y && apt-get install -y --no-install-recommends libpq5 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt . && RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# COPY --from=web /web/dist ./static
ENV PORT=8080
# migrate, then serve API + static assets with gunicorn (Flask/WSGI app)
CMD ["sh", "-c", "alembic upgrade head && gunicorn -b :$PORT -w 2 app:app"]
```
`gcloud run deploy --source .` builds this Dockerfile. (No Dockerfile? Cloud Run buildpacks
detect Python via `requirements.txt`/`Procfile` — but a Dockerfile is more predictable.)

---

## 1. Prerequisites

- **`gcloud` CLI**, authenticated: `gcloud auth login` (interactive — see Roadblock #1).
- The **beta component**: `gcloud components install beta --quiet` (needed for IAP commands).
- **Billing enabled** (Cloud SQL + Cloud Run are billable).
- A **GCP project** + **region** (we used `us-central1`).
- A `.env` (or your secret source) with real values. It is **never uploaded** — see
  [`.gcloudignore`](../.gcloudignore).

Enable the APIs:
```bash
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com \
  iap.googleapis.com iamcredentials.googleapis.com cloudresourcemanager.googleapis.com \
  generativelanguage.googleapis.com
```

---

## 2. Provision the stateful backends (once)

**Shared, named resources** — independent of the Cloud Run *service name*. This is the key to
painless "renames" and blue/green: a new service pointed at the same backends inherits all data.

1. **Cloud SQL (Postgres)** — smallest tier is fine (`db-f1-micro`, zonal). Provisioning takes
   **~10 minutes** — kick it off and do other work.
   ```bash
   gcloud sql instances create SQL_INSTANCE --database-version=POSTGRES_16 --edition=ENTERPRISE \
     --tier=db-f1-micro --region=REGION --storage-size=10 --storage-type=HDD \
     --availability-type=zonal --root-password="$(openssl rand -hex 24)"
   gcloud sql databases create DB_NAME --instance=SQL_INSTANCE
   ```
   `DATABASE_URL` uses the **socket connector** form (no IP):
   `postgresql+psycopg://USER:PASS@/DB_NAME?host=/cloudsql/PROJECT:REGION:SQL_INSTANCE`
   (SQLAlchemy/psycopg form — adjust the driver prefix to your library), and the service attaches
   the instance with `--add-cloudsql-instances`.
   > ⚠️ The example creates it **without backups**. For real data, add `--backup`
   > `--enable-point-in-time-recovery` (consider regional HA). See Roadblock #11.

2. **GCS bucket** for uploads:
   ```bash
   gcloud storage buckets create gs://BUCKET --location=REGION --uniform-bucket-level-access
   ```

3. **Secret Manager** for every secret (the Python app reads them at boot):
   ```bash
   printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create SESSION_SECRET --data-file=-
   printf '%s' "$GEMINI_API_KEY"        | gcloud secrets create GEMINI_API_KEY  --data-file=-
   # …and DATABASE_URL, OAuth client secret, etc.
   ```

---

## 3. Grant the runtime service account what it needs

Cloud Run uses the **default compute service account**
(`PROJECTNUMBER-compute@developer.gserviceaccount.com`) unless you set `--service-account`. Grant:

| Role | Scope | For |
| --- | --- | --- |
| `roles/secretmanager.secretAccessor` | project | reading secrets at boot |
| `roles/cloudsql.client` | project | connecting to Cloud SQL |
| `roles/storage.objectAdmin` | **the bucket** | reading/writing uploads |
| `roles/iam.serviceAccountTokenCreator` | a **target SA** | only if impersonating for a partner API (§6) |

```bash
SA="PROJECTNUMBER-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding PROJECT --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --condition=None
gcloud projects add-iam-policy-binding PROJECT --member="serviceAccount:$SA" --role=roles/cloudsql.client --condition=None
gcloud storage buckets add-iam-policy-binding gs://BUCKET --member="serviceAccount:$SA" --role=roles/storage.objectAdmin
```

---

## 4. Deploy

Build from source (Cloud Build builds the Dockerfile). **Do not pass `--allow-unauthenticated`**
in a locked-down org — it's rejected (Roadblock #4).

```bash
gcloud run deploy SERVICE --source . --region REGION --port 8080 --memory 1Gi \
  --add-cloudsql-instances PROJECT:REGION:SQL_INSTANCE \
  --set-env-vars APP_ENV=production,IAP_ENABLED=true,STORAGE_DRIVER=gcs,GCS_BUCKET=BUCKET,...,\
APP_BASE_URL=https://placeholder.invalid \
  --set-secrets DATABASE_URL=DATABASE_URL:latest,SESSION_SECRET=SESSION_SECRET:latest,...
```

Note the **placeholder URL**: startup config validation requires a valid URL, but you don't know
the service URL until *after* the first deploy. Deploy with a valid placeholder, then patch it (§5).

---

## 5. Access: Identity-Aware Proxy (the part that surprises everyone)

In a Workspace org with **Domain Restricted Sharing (DRS)** you **cannot** make a Cloud Run
service public the normal way (`--allow-unauthenticated` = an `allUsers` IAM binding) — the policy
rejects any non-domain principal. The deploy *appears* to succeed but the service is unreachable
(Roadblock #4).

The supported pattern (and what sibling services already used) is **direct Cloud Run + IAP** — no
load balancer:

```bash
# 1) Enable IAP on the service (auto-grants the IAP service agent run.invoker)
gcloud beta run services update SERVICE --region REGION --iap

# 2) Allow your whole Workspace domain THROUGH IAP.
#    `domain:` members ARE permitted under DRS — the unlock `allUsers` lacked.
gcloud beta iap web add-iam-policy-binding \
  --resource-type=cloud-run --service=SERVICE --region=REGION \
  --member=domain:YOURDOMAIN.com --role=roles/iap.httpsResourceAccessor
```

Then grab the **canonical URL** and point the app at it (the two-pass fix):
```bash
URL="$(gcloud run services describe SERVICE --region REGION --format='value(status.url)')"
gcloud run services update SERVICE --region REGION --update-env-vars "APP_BASE_URL=${URL}"
```

> ⚠️ Use `status.url`, **not** the URL printed by `gcloud run deploy`. They can differ
> (`SERVICE-PROJECTNUMBER.REGION.run.app` vs `SERVICE-HASH-REGIONCODE.a.run.app`). Pick the
> `status.url` one everywhere so cookies/redirects stay on one host (Roadblock #7).

### Make the app *trust* IAP (or users log in twice)

IAP authenticates the user at the edge and forwards each request with a signed header
(`X-Goog-IAP-JWT-Assertion`, plus `X-Goog-Authenticated-User-Email`). If your app also runs its own
login, the user authenticates **twice**. Have the Python app read IAP's verified identity and
provision/log in the user from it — true single sign-on. In **Flask**:

```python
from flask import request, g, abort
from google.oauth2 import id_token
from google.auth.transport import requests as greq

@app.before_request
def _trust_iap():
    if not IAP_ENABLED:
        return  # local dev: fall back to the app's own OAuth
    assertion = request.headers.get("X-Goog-IAP-JWT-Assertion")
    if assertion and IAP_AUDIENCE:                       # strict: verify the signed JWT
        info = id_token.verify_token(assertion, greq.Request(), audience=IAP_AUDIENCE,
                                     certs_url="https://www.gstatic.com/iap/verify/public_key")
        email = info["email"]
    else:                                                # header trust (safe: only IAP can set it)
        hdr = request.headers.get("X-Goog-Authenticated-User-Email", "")
        email = hdr.split(":")[-1].lower()
    if not email or not email.endswith("@YOURDOMAIN.com"):
        abort(403)
    g.user = get_or_create_user(email)                   # provision on first sight; keep roles in-app
```
Keep the app's own OAuth only for **local development** (where there's no IAP).

---

## 6. Calling an allow-listed Google API via service-account impersonation

If your app calls a partner/internal Google API (we used **Localizer / "Lazarus"**), it likely
needs:
- **Allow-listing** of your Workspace Customer ID (GWCID) + a developer account by a Google PoC
  *before you can even enable the API* (Roadblock #8), and
- a **privilege-bearing service account** you **impersonate** with a specific OAuth scope.

```bash
gcloud services enable iamcredentials.googleapis.com
gcloud iam service-accounts add-iam-policy-binding PRIVILEGE_SA \
  --member="serviceAccount:RUNTIME_SA" --role=roles/iam.serviceAccountTokenCreator
```
In Python, mint a scoped token with `google.auth.impersonated_credentials.Credentials`
(`source_credentials=ADC`, `target_principal=PRIVILEGE_SA`, `target_scopes=[...]`). Ship a
**mock/feature flag** so the feature degrades gracefully until allow-listing completes — don't
block the whole deploy on a partner approval.

---

## 7. Verify

```bash
# A. Public request must be intercepted by IAP (302 to Google login):
curl -sI https://YOUR-URL/ | grep -iE '^HTTP|x-goog-iap'    # expect HTTP/2 302 + x-goog-iap-generated-response: true

# B. Inspect a private/IAP service as yourself (authenticated tunnel):
gcloud run services proxy SERVICE --region REGION --port 8088
#   then curl localhost:8088/api/...  (NOTE: /healthz can return a Google 404 through the proxy —
#   a proxy quirk, not an app bug; test /api routes and the logs instead.)

# C. Confirm boot + migrations:
gcloud run services logs read SERVICE --region REGION --limit 50 | grep -iE 'alembic|migrat|listening|error'
```
A **non-serving revision == a boot crash** — read logs for a config/secret error (Roadblock #6).
The real end-to-end login needs a **human in a browser** with a Workspace account.

---

## 8. Roadblocks & fixes (the troubleshooting table)

| # | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| 1 | `Reauthentication failed. cannot prompt during non-interactive execution` | gcloud session expired | A human runs `gcloud auth login` (interactive; can't be scripted). |
| 2 | `You do not currently have this command group installed: [beta]` / hangs on a prompt | `gcloud beta` missing | `gcloud components install beta --quiet` |
| 3 | `Cloud Resource Manager API has not been used... or it is disabled` (on `gcloud iap web ...`) | API off | `gcloud services enable cloudresourcemanager.googleapis.com` |
| 4 | `Setting IAM policy failed ... FAILED_PRECONDITION: ...do not belong to a permitted customer` after `--allow-unauthenticated` | **DRS org policy** blocks `allUsers` | Don't use `allUsers`. Use **IAP** + grant `domain:` the `iap.httpsResourceAccessor` role (§5). |
| 5 | Service deployed but every request 403/404 | No invoker (allUsers rejected, IAP not set up) | Enable IAP and grant the domain (§5). |
| 6 | New revision "failed"/won't serve, traffic stuck on old | Container **crashed at boot** | Usually config validation. Check logs. Ensure URL-typed vars are valid URLs (use `https://placeholder.invalid` for the two-pass), all secrets exist + the SA can read them, and `alembic upgrade` can reach the DB. |
| 7 | After login, cookies drop / redirect loops; unexpected hostname | Two valid Run URL formats; app pinned to the wrong host | Use `status.url` for `APP_BASE_URL` everywhere; keep users on one host. |
| 8 | `gcloud services enable <partner>.googleapis.com` → `AUTH_PERMISSION_DENIED` (violation `110002`) | Partner API not allow-listed for your GWCID/dev account | Send **GWCID + developer account** to the Google PoC; ship the feature behind a **mock flag** meanwhile. |
| 9 | Want to "rename" the service / change the URL | **Cloud Run service names are immutable** | Deploy a **new** service by the new name pointing at the **same** Cloud SQL/GCS/secrets (data carries over), then delete the old. |
| 10 | Users are asked to log in **twice** | App runs its own auth *behind* IAP | App must trust IAP's identity headers (§5) and skip its own login in prod. |
| 11 | Data loss risk / can't restore | Cloud SQL created with `--no-backup`, zonal | Enable `--backup` + `--enable-point-in-time-recovery`; consider regional HA. |
| 12 | Cloud Build uploaded your `.env` / a key | Missing ignore rules | Add `.env`, `*-key.json`, `*service-account*.json` to **`.gcloudignore`**. Rotate anything that leaked. |
| 13 | IAP enable errors about a missing brand/consent | Project has no IAP OAuth brand | Configure the OAuth consent screen / IAP brand once for the project. |
| 14 | Build fails with cryptic engine/version errors | Host runtime too old | Pin the runtime in the Dockerfile (`python:3.12-slim`); don't depend on the host. |

---

## 9. Day-2 operations

- **Redeploy after a code change:** `gcloud run deploy SERVICE --source . --region REGION` — preserves
  env, secrets, Cloud SQL attachment, and IAP.
- **Rename / new URL:** deploy a new service (Roadblock #9), verify, then `gcloud run services delete OLD --region REGION`.
- **Rotate a secret:** `gcloud secrets versions add NAME --data-file=-`, then redeploy (or it's picked up on the next cold start with `:latest`).
- **Migrations** run on every boot; for big/locking migrations prefer a one-off **Cloud Run Job** against the same DB.
- **Custom domain:** Cloud Run domain mappings, or an external LB.
- **Cost:** Cloud Run scales to zero (~$0 idle); Cloud SQL is always-on (~$8–10/mo smallest tier).

---

## 10. The golden rules

1. **Approved stack only:** Lit/React + Material Design (no Tailwind); Python (Flask/WSGI) or Glue — **never Node/Express, never FastAPI**.
2. **Backends are shared and named; the service is disposable** — makes renames, rollbacks, blue/green trivial.
3. **Access is IAP, not `allUsers`.** In a DRS org, `domain:` through IAP is the only clean path, and the app must trust IAP's identity.
4. **Secrets live in Secret Manager**, never in the repo or build context.
5. **A non-serving revision = a boot crash.** Read the logs first.
6. **Don't block the whole deploy on a partner approval** — feature-flag it.
