# Skill: Deploy a single-container app to Cloud Run behind IAP (agent guide)

Operational playbook for an agent deploying a web app to **Google Cloud Run** in a **Google
Workspace org with Domain Restricted Sharing (DRS)**, backed by Cloud SQL (Postgres), GCS,
Secret Manager, and optional Gemini/partner APIs.

Optimized for autonomous execution: enforce the stack policy → gather inputs → run ordered steps
→ branch on known failure signatures → verify. **Prefer the parameterized script
`cloudrun-deploy.sh`**; drop to manual commands only when debugging.

---

## ⛔ Stack policy — enforce before writing/deploying code

| Layer | ✅ Allowed | ❌ Prohibited |
| --- | --- | --- |
| Frontend | **Lit (preferred)** or React; **Material Design** (Material Web) | **Tailwind** |
| Server runtime | **Python** (vanilla WSGI or **Flask**); **Glue** also OK | **Node.js, Express, FastAPI** (hard no) |
| Build tooling | JS bundler at *build time* only, or buildless Lit ES modules | A Node *runtime/server* in production |

The **served runtime is Python**. A Node step may build Lit/React assets in a Docker build stage,
but nothing Node/Express runs in prod. If asked to deploy a Node/Express or FastAPI app, **flag
the policy violation** before proceeding (some legacy repos predate this rule; the platform steps
below are identical, but new work must comply).

The stack-specific anchors used below: container = `python:3.x-slim` + `gunicorn` serving a
Flask/WSGI app + static Lit/React assets; migrations via **Alembic** (`alembic upgrade head`) in
the entrypoint; config validated at startup (e.g. `pydantic-settings`); IAP trust via a Flask
`@app.before_request`.

---

## Preconditions you CANNOT satisfy yourself (stop and ask the human)

- **`gcloud auth login`** — interactive. If you see `Reauthentication failed. cannot prompt during
  non-interactive execution`, STOP and ask the human. You cannot script it.
- **Billing enabled** on the project.
- **Partner API allow-listing** (e.g. Localizer): a human must send the GWCID + dev account to a
  Google PoC. You cannot enable the API until then.
- **The final browser login** (IAP + Google consent) needs a human with a Workspace account.

You CAN do everything else (APIs, SQL, GCS, secrets, IAM, deploy, IAP wiring, verification).

---

## Inputs to collect first

| Var | Example | How to get it |
| --- | --- | --- |
| `PROJECT` | `m-pitch-shaodn-4894` | `gcloud config get-value project` |
| `PROJECT_NUMBER` | `1028543842983` | `gcloud projects describe PROJECT --format='value(projectNumber)'` |
| `REGION` | `us-central1` | ask / `gcloud config get-value run/region` |
| `SERVICE` | `play-dr-agents` | desired URL prefix (becomes `SERVICE-….run.app`) |
| `IAP_DOMAIN` | `monks.com` | the Workspace domain allowed in |
| `RUNTIME_SA` | `PROJECT_NUMBER-compute@developer.gserviceaccount.com` | default Cloud Run SA |
| `PRIVILEGE_SA` | `pipeline-sa@PROJECT.iam.gserviceaccount.com` | only if impersonating for a partner API |

Confirm `gcloud components install beta --quiet` has run (IAP commands need beta).

---

## Procedure (ordered, idempotent)

> Every step is safe to re-run (`describe || create`, `add-iam-policy-binding`). On a known failure,
> see the **Failure signature table**.

**1. Enable APIs.**
```bash
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com \
  iap.googleapis.com iamcredentials.googleapis.com cloudresourcemanager.googleapis.com \
  generativelanguage.googleapis.com --project PROJECT
```
Partner APIs (e.g. `localizer.googleapis.com`) may fail with `AUTH_PERMISSION_DENIED` — expected
pre-allow-listing; continue with that feature in mock mode.

**2. Secrets** — create if missing, else add a version. Read values from `.env`/secret source
(never echo). Build `DATABASE_URL` from the generated DB password.

**3. Cloud SQL** — `describe || create` (Postgres 16, smallest tier). **Provisioning ≈ 10 min**;
poll `gcloud sql instances describe SQL_INSTANCE --format='value(state)'` until `RUNNABLE` (run in
the background; don't block). Then `gcloud sql databases create DB_NAME`.

**4. GCS bucket** — `gcloud storage buckets create gs://BUCKET --uniform-bucket-level-access` (ignore "already exists").

**5. IAM for `RUNTIME_SA`:** grant `secretmanager.secretAccessor` + `cloudsql.client` (project),
`storage.objectAdmin` (bucket), and — only if impersonating — `iam.serviceAccountTokenCreator` on
`PRIVILEGE_SA`. Use `--condition=None` on project bindings.

**6. Deploy** (NO `--allow-unauthenticated`). Use **valid placeholder URLs** (startup validation
needs valid URLs; you don't know the service URL yet). Build ≈ 5 min → set Bash timeout ≥ 600000 ms.
```bash
gcloud run deploy SERVICE --source . --region REGION --port 8080 --memory 1Gi \
  --add-cloudsql-instances PROJECT:REGION:SQL_INSTANCE \
  --set-env-vars APP_ENV=production,IAP_ENABLED=true,STORAGE_DRIVER=gcs,GCS_BUCKET=BUCKET,...,APP_BASE_URL=https://placeholder.invalid \
  --set-secrets DATABASE_URL=DATABASE_URL:latest,SESSION_SECRET=SESSION_SECRET:latest,...
```

**7. Enable IAP + grant the domain** (the access gate; `allUsers` is DRS-blocked):
```bash
gcloud beta run services update SERVICE --region REGION --iap
gcloud beta iap web add-iam-policy-binding --resource-type=cloud-run --service=SERVICE \
  --region=REGION --member=domain:IAP_DOMAIN --role=roles/iap.httpsResourceAccessor
```

**8. Two-pass URL fix** — read the canonical URL, patch env (env-only update, no rebuild):
```bash
URL="$(gcloud run services describe SERVICE --region REGION --format='value(status.url)')"
gcloud run services update SERVICE --region REGION --update-env-vars "APP_BASE_URL=${URL}"
```
**Always use `status.url`**, not the URL printed by `deploy` (they can differ; cookie/host
consistency depends on it).

**9. Verify** (below). Only after green: if this was a rename, delete the old service.

---

## Decision points

- **Is the org DRS-locked?** If `--allow-unauthenticated` returns `FAILED_PRECONDITION: ...do not
  belong to a permitted customer`, yes → use IAP (step 7); never retry `allUsers`. Default to IAP
  for any Workspace org.
- **Does the app trust IAP?** Confirm the Python code reads `X-Goog-IAP-JWT-Assertion` /
  `X-Goog-Authenticated-User-Email` and provisions the user when `IAP_ENABLED=true` (a Flask
  `before_request`). If not, users double-login — implement the IAP-trust hook; keep the app's own
  OAuth for local dev only.
- **Partner API allow-listed?** If `gcloud services enable <api>` fails with `110002`, deploy the
  feature in **mock** mode and leave a one-line flip for later.
- **Rename requested?** Service names are immutable → deploy a NEW service, same backends, delete old.

---

## Verification (do all three)

```bash
# A. IAP gate:
curl -sI https://URL/ | grep -iE '^HTTP|x-goog-iap'   # PASS = "HTTP/2 302" + "x-goog-iap-generated-response: true"
# B. Boot + migrations:
gcloud run services logs read SERVICE --region REGION --limit 50 | grep -iE 'alembic|migration|listening|error'
# C. App responds behind IAP (authenticated tunnel):
gcloud run services proxy SERVICE --region REGION --port 8088 &
curl -s localhost:8088/api/<an-endpoint>
```
Caveats: (C) the proxy may return a **Google 404 for `/healthz`** — proxy quirk, not an app
failure; test `/api/...` and rely on (B). A **non-serving revision == a boot crash** → read logs
for a config/secret/migration error.

---

## Failure signature table (symptom → action)

| Signature (substring) | Action |
| --- | --- |
| `Reauthentication failed. cannot prompt` | STOP — ask human to `gcloud auth login`. |
| `command group installed: [beta]` | `gcloud components install beta --quiet`, retry. |
| `Cloud Resource Manager API has not been used` | `gcloud services enable cloudresourcemanager.googleapis.com`, retry. |
| `FAILED_PRECONDITION: ...do not belong to a permitted customer` | DRS blocks `allUsers`. Switch to IAP (step 7); never use `allUsers`/`allAuthenticatedUsers`. |
| `AUTH_PERMISSION_DENIED` + `110002` on `services enable` | Partner API not allow-listed. Ask human re: GWCID/dev account; ship feature in mock mode. |
| Revision deployed but "Routing traffic" stuck / old revision serves | Boot crash. `logs read` → fix env (valid URLs? all secrets present? SA `secretAccessor`? `alembic upgrade` reaches DB?). |
| `Setting IAM policy failed` warning on deploy | The `--allow-unauthenticated` binding was rejected (DRS). Ignore the warning; do IAP instead. |
| 403/404 on the public URL after deploy | IAP not enabled or domain not granted → step 7. |
| Cookies/redirects misbehave; unexpected hostname | `APP_BASE_URL` ≠ `status.url`. Re-run step 8 with `status.url`. |
| impersonation / `serviceAccountTokenCreator` errors | Grant runtime SA Token Creator on the target SA; ensure `iamcredentials.googleapis.com` enabled. |

---

## Hard rules (do not violate)

1. **Stack policy:** Lit/React + Material Design (no Tailwind); **Python (Flask/WSGI) or Glue**.
   **Never Node/Express, never FastAPI.** Flag any request to deploy a prohibited stack.
2. **Never** add `allUsers`/`allAuthenticatedUsers` IAM, and **never** assume `--allow-unauthenticated`
   works in a Workspace org. Access = **IAP + `domain:`**.
3. **Never** commit/upload secrets. Confirm `.gcloudignore` excludes `.env`, `*-key.json`,
   `*service-account*.json`. If a key leaked, tell the human to rotate it.
4. **Provision backends as shared, named resources**; keep the service disposable. Rename = new
   service, same backends, delete old.
5. **Don't block the deploy on a partner approval** — feature-flag it (mock/live env var).
6. **Verify before deleting** anything. Treat a non-serving revision as a boot crash; read logs.
7. Set Bash timeouts ≥ 600000 ms for `deploy`/`sql create`; poll long ops instead of blocking.

---

## Companion files
- [`cloudrun-deploy.sh`](cloudrun-deploy.sh) — executable, parameterized version of this procedure.
- [`deploy.md`](deploy.md) — human narrative with rationale, the Python/Lit reference Dockerfile + IAP hook, and the full roadblock log.
