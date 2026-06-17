#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Play DR Agents — Cloud Run deploy (IAP-gated)
#
# Single-container monolith (API + bundled SPA) on Cloud Run, backed by Cloud
# SQL (Postgres), GCS (uploads), and Secret Manager. Access is gated by
# Identity-Aware Proxy: the org's Domain Restricted Sharing policy blocks
# `allUsers`, so IAP is the front door — users sign in with a Workspace account
# and the app trusts IAP's verified identity (single sign-on; see
# server/src/auth/iap.ts). No IAP grant for `allUsers`, no public IAM.
#
# Re-runnable (secrets/bucket/instance/IAP creation are guarded). Prereqs:
# gcloud authenticated (`gcloud auth login`) with the `beta` component
# (`gcloud components install beta`), billing enabled, and a .env with real
# GEMINI_API_KEY / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
#
#   ./deploy/cloudrun-deploy.sh
# ---------------------------------------------------------------------------
set -euo pipefail

PROJECT="${PROJECT:-m-pitch-shaodn-4894}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-play-dr-agents}"
SQL_INSTANCE="${SQL_INSTANCE:-collective-sql}"
DB_NAME="${DB_NAME:-collective}"
BUCKET="${BUCKET:-${PROJECT}-collective-uploads}"
ALLOWED_DOMAINS="${ALLOWED_DOMAINS:-monks.com}"
ADMIN_EMAILS="${ADMIN_EMAILS:-hector.marrufo@monks.com}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash}"
IAP_DOMAIN="${IAP_DOMAIN:-monks.com}"
# Localizer (Lazarus): leave "mock" until Google allowlists localizer.googleapis.com
# for your GWCID/dev account; then set "lazarus".
TRANSLATE_PROVIDER="${TRANSLATE_PROVIDER:-mock}"
LOCALIZER_PRINCIPAL="${LOCALIZER_PRINCIPAL:-pipeline-sa@m-pitch-shaodn-4894.iam.gserviceaccount.com}"
# Pathways (the whitelisted Monksflow translator). URL comes from .env; the key is a
# secret. Required ONLY when TRANSLATE_PROVIDER=pathways — if either is missing the
# app warns and falls back to the mock translator (it will NOT crash).
PATHWAYS_TRIGGER_URL="${PATHWAYS_TRIGGER_URL:-}"

# Non-secret OAuth client id + secret values come from .env (kept out of the
# Cloud Build upload by .gcloudignore).
set -a; . ./.env; set +a
PROJNUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${PROJNUM}-compute@developer.gserviceaccount.com"

echo "==> Enable APIs"
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com \
  iap.googleapis.com iamcredentials.googleapis.com generativelanguage.googleapis.com --project "$PROJECT"
# Localizer API needs Google to allowlist your GWCID/dev account first; this may fail until then.
gcloud services enable localizer.googleapis.com --project "$PROJECT" \
  || echo "  (localizer.googleapis.com not allowlisted yet — Localizer stays in mock mode)"

put_secret() { # name value
  if gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1; then
    printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project "$PROJECT" >/dev/null
  else
    printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project "$PROJECT" >/dev/null
  fi
}

echo "==> Secrets (Secret Manager)"
gcloud secrets describe SESSION_SECRET --project "$PROJECT" >/dev/null 2>&1 || put_secret SESSION_SECRET "$(openssl rand -hex 32)"
gcloud secrets describe DB_PASSWORD     --project "$PROJECT" >/dev/null 2>&1 || put_secret DB_PASSWORD "$(openssl rand -hex 24)"
put_secret GEMINI_API_KEY      "$GEMINI_API_KEY"
put_secret GOOGLE_CLIENT_SECRET "$GOOGLE_CLIENT_SECRET"
# Store the Pathways key only when present (so re-runs don't blank an existing secret).
[ -n "${PATHWAYS_API_KEY:-}" ] && put_secret PATHWAYS_API_KEY "$PATHWAYS_API_KEY"
DB_PASSWORD="$(gcloud secrets versions access latest --secret=DB_PASSWORD --project "$PROJECT")"

echo "==> GCS bucket"
gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --project "$PROJECT" 2>/dev/null || true

echo "==> Cloud SQL (Postgres 16)"
if ! gcloud sql instances describe "$SQL_INSTANCE" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud sql instances create "$SQL_INSTANCE" \
    --database-version=POSTGRES_16 --edition=ENTERPRISE --tier=db-f1-micro \
    --region="$REGION" --storage-size=10 --storage-type=HDD \
    --availability-type=zonal --root-password="$DB_PASSWORD" --project "$PROJECT"
fi
gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE" --project "$PROJECT" 2>/dev/null || true
CONN="$(gcloud sql instances describe "$SQL_INSTANCE" --project "$PROJECT" --format='value(connectionName)')"
put_secret DATABASE_URL "postgresql://postgres:${DB_PASSWORD}@localhost/${DB_NAME}?host=/cloudsql/${CONN}"

echo "==> IAM for runtime service account ($RUNTIME_SA)"
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNTIME_SA" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNTIME_SA" --role=roles/cloudsql.client --condition=None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$RUNTIME_SA" --role=roles/storage.objectAdmin >/dev/null
# Localizer: let the runtime SA impersonate the allowlisted privilege SA.
gcloud iam service-accounts add-iam-policy-binding "$LOCALIZER_PRINCIPAL" \
  --member="serviceAccount:$RUNTIME_SA" --role=roles/iam.serviceAccountTokenCreator --project "$PROJECT" >/dev/null 2>&1 || true

deploy() { # app_base_url
  # Pathways vars are appended ONLY when TRANSLATE_PROVIDER=pathways, so non-pathways
  # deploys don't reference a key that may not exist. Because we use --set-env-vars /
  # --set-secrets (full replace), every var the app needs MUST be listed here —
  # forgetting one (e.g. PATHWAYS_*) is what crashed revision 00006.
  local env_vars="NODE_ENV=production,IAP_ENABLED=true,APP_BASE_URL=$1,GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},GOOGLE_OAUTH_REDIRECT_URI=$1/api/auth/google/callback,ALLOWED_DOMAINS=${ALLOWED_DOMAINS},ADMIN_EMAILS=${ADMIN_EMAILS},STORAGE_DRIVER=gcs,GCS_BUCKET=${BUCKET},GEMINI_MODEL=${GEMINI_MODEL},TRANSLATE_PROVIDER=${TRANSLATE_PROVIDER},LOCALIZER_PRINCIPAL=${LOCALIZER_PRINCIPAL}"
  local secrets="DATABASE_URL=DATABASE_URL:latest,SESSION_SECRET=SESSION_SECRET:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest"
  if [ "$TRANSLATE_PROVIDER" = "pathways" ]; then
    env_vars="${env_vars},PATHWAYS_TRIGGER_URL=${PATHWAYS_TRIGGER_URL}"
    secrets="${secrets},PATHWAYS_API_KEY=PATHWAYS_API_KEY:latest"
  fi
  gcloud run deploy "$SERVICE" --source . --region "$REGION" --project "$PROJECT" --port 8080 \
    --memory 1Gi --cpu 1 --min-instances 0 --max-instances 4 \
    --add-cloudsql-instances "$CONN" \
    --set-env-vars "$env_vars" \
    --set-secrets "$secrets"
}

echo "==> Build + deploy (Cloud Build builds the Dockerfile)"
deploy "https://placeholder.invalid"

echo "==> Enable IAP + grant the domain (the access gate; allUsers is DRS-blocked)"
gcloud beta run services update "$SERVICE" --region "$REGION" --project "$PROJECT" --iap
gcloud beta iap web add-iam-policy-binding --resource-type=cloud-run --service="$SERVICE" \
  --region="$REGION" --project="$PROJECT" --member="domain:${IAP_DOMAIN}" --role=roles/iap.httpsResourceAccessor

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
echo "==> Point APP_BASE_URL / redirect at the real URL (env-only update, no rebuild)"
gcloud run services update "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --update-env-vars "APP_BASE_URL=${URL},GOOGLE_OAUTH_REDIRECT_URI=${URL}/api/auth/google/callback"

echo
echo "DONE → ${URL}"
echo "Users sign in via IAP with a ${IAP_DOMAIN} Google account (single sign-on; the app trusts IAP's identity)."
echo "Migrations run automatically on container start (prisma migrate deploy)."
echo "Localizer is in '${TRANSLATE_PROVIDER}' mode. Once Google allowlists the Localizer API, go live with:"
echo "  gcloud run services update ${SERVICE} --region ${REGION} --update-env-vars TRANSLATE_PROVIDER=lazarus,LOCALIZER_PRINCIPAL=${LOCALIZER_PRINCIPAL}"
