# Deployment

## Local / demo (supported today)

Single Node process serving the API and the built frontend, with SQLite and local file storage in demo mode, or Neon PostgreSQL in production/Azure mode.

```bash
npm run build        # typecheck + frontend bundle
npm run seed-demo
npm start            # listens on HOST:PORT (default http://localhost:4317)
```

Persistent state lives in `data/nova.db` and `data/storage/` (local/demo mode; in
production/Azure mode the database is Neon and document files live in Azure Blob Storage). Back up or delete that directory to
snapshot or reset an environment; `npm run reset-demo` does the latter safely.

Recommended process supervision: any standard runner (systemd, pm2, Docker with a Node 22.5+ base
image). Set `HOST=0.0.0.0` only behind a reverse proxy. If that proxy terminates TLS, set
`HTTPS_ENABLED=false`, the default (NOVA then serves plain HTTP on the private network and emits
HSTS based on `x-forwarded-proto`); if NOVA should terminate TLS itself, set `HTTPS_ENABLED=true`
and supply `TLS_CERT_FILE` and `TLS_KEY_FILE`.

## Configuration checklist for a shared environment

| Variable | Why |
| --- | --- |
| `DEMO_SESSION_SECRET` | Must be changed from the default; signs demo session tokens |
| `DATABASE_URL`, `STORAGE_DIR` | Point at durable, backed-up volumes (local/demo mode) |
| `STORAGE_MODE` | `local` = filesystem, `azure_blob` = Azure Blob Storage. No fallback: `azure_blob` with incomplete configuration fails at startup |
| `AZURE_STORAGE_CONNECTION_STRING` | Secret. Environment only, never in `.env`, docs or source control |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_CONTAINER` | `novastorage2376` / `documents` (private container) |
| `MAX_DOCUMENT_SIZE_BYTES` | Upload ceiling, enforced before anything reaches storage |
| `HTTPS_ENABLED` | `false` (default) expects TLS to be terminated in front of NOVA; `true` makes NOVA terminate it |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | Certificate and key, required when `HTTPS_ENABLED=true` |
| `LOG_LEVEL` | `info` in normal operation; logs are structured JSON |
| `LOCAL_LLM_BASE_URL` | Set to a real model endpoint so answers are not the labelled fallback |
| `AUTH_MODE` | `demo` is explicitly not production authentication; production uses `entra` |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_API_ID_URI`, `ENTRA_API_SCOPE`, `ENTRA_AUTHORITY`, `ENTRA_REDIRECT_URI` | Public Entra application configuration. Required (and validated) when `AUTH_MODE=entra` |
| `ENTRA_CLIENT_SECRET` / `AZURE_CLIENT_SECRET` | **Must not exist.** The SPA is a public client (PKCE); startup fails if either is set in Entra mode |

Never commit `.env`; it is git-ignored. Secrets are read from the environment only and are redacted
from logs.

## Production posture

The demo auth provider is a persona selector, not authentication. A production deployment runs
`AUTH_MODE=entra` (Microsoft Entra ID, Phase 6) behind TLS, with
Production/Azure mode uses Neon PostgreSQL; local/demo continues to use SQLite. The data-access layer is already
centralised in `backend/src/db/`, and authorization is expressed as a predicate pushed into the store,
so the security model survives that swap.

## Production redirect URI

`ENTRA_REDIRECT_URI` must match a redirect URI registered on the Entra application exactly,
including scheme, host, port and trailing path. For a real deployment register the public
origin (for example `https://nova.example.com`) alongside the development
`http://localhost:4317`, and set `ENTRA_REDIRECT_URI` per environment.

In Entra mode NOVA binds the port from that URI and **fails to start** if the port is busy or
if `PORT` contradicts it — it never silently moves to an unregistered origin. Behind a proxy
that terminates TLS, keep `HTTPS_ENABLED=false`, bind the internal port, and make the proxy
serve the registered public origin.

## Azure deployment path (not active)

1. Provision the resources listed in `docs/azure-integration.md`.
2. Deploy the same container/process to App Service or Container Apps with a managed identity.
3. Set `AI_MODE/KNOWLEDGE_MODE/AUTH_MODE/ACTION_MODE/VECTOR_STORE/STORAGE_MODE` to their Azure
   values (`VECTOR_STORE=azure_search`, `STORAGE_MODE=azure_blob`). There is no `APP_MODE`
   variable; the overall mode is derived.
3a. Run `npm run storage:init` once (creates the private `documents` container if it is absent)
   and `npm run storage:validate` to prove connectivity with a temporary object that is always
   cleaned up. Document files then live in Azure Blob Storage; Neon keeps only the reference.
4. Re-index knowledge into Azure AI Search (embeddings must be regenerated with the Azure embedding
   deployment; embedding models are not interchangeable).
5. Confirm `/api/health` reports **AZURE CONFIGURED** (not `- INCOMPLETE`) for every provider. That
   badge means configuration is complete and the Azure implementations are loaded; it is a local
   check that makes no Azure model call. To prove live connectivity, run `npm run test:foundry`
   once by hand or simply issue a real chat/knowledge request.

Until step 3 is performed by hand, no Azure endpoint is contacted.

## Operations

- **Health** — `GET /api/health` returns mode, badge and per-provider configuration state. It is a
  local-only, zero-model-usage endpoint: no LLM, embedding or Search request is made, so it is safe
  to poll from a load balancer or uptime monitor. `liveProbe` is always `false`.
- **Audit** — `/admin/activity` and `GET /api/admin/activity`; metadata only, never document text.
- **Metrics** — `/admin` shows documents, knowledge sources, users, queries, average latency, citation
  rate, access-denied attempts, incidents and system status.
- **Knowledge lifecycle** — upload a new version and activate it; deactivate or delete removes content
  from retrieval immediately while preserving the audit trail.

## Database selection

Local/demo mode uses SQLite. Production/Azure mode uses Neon PostgreSQL exclusively and requires `DATABASE_URL` at startup; there is no automatic SQLite fallback.

Deploy order:

1. `npm run db:migrate` — applies `001`-`003` (see `docs/local-development.md` for what each does). Safe to re-run; it takes an advisory lock, so concurrent deploys cannot race.
2. `npm run db:status` — exits non-zero if anything is pending or modified. Use it as the gate.
3. Start the backend. It refuses to start and exits 1 with `server.database_unavailable` if Neon is unreachable or a migration is missing; it never degrades to SQLite.
4. Optional one-time data move: `SQLITE_SOURCE=./data/nova.db npm run db:import-sqlite`. IDs and timestamps are copied verbatim inside one transaction, any pre-existing id is a reported conflict rather than a skip or an overwrite, and the whole import rolls back if the post-insert row/column/relationship validation disagrees. `-- --validate-only` re-runs just the comparison.

Operational notes:

- `DATABASE_URL` is a deployment secret. It is never logged, never returned by `/api/health`, and never committed; `.env.example` carries a placeholder only. Rotate it if it has ever been pasted into a chat, ticket or shell history.
- `DATABASE_QUERY_TIMEOUT_MS` (default `30000`) bounds every query.
- Connection errors are redacted before they are logged: password, user and host are stripped.
- Use the pooled Neon URL for the application. The direct/unpooled URL is only needed for `TEST_DATABASE_URL`.
- The synchronous worker bridge serializes queries and blocks the event loop for the duration of each round trip; see the limits section in `docs/local-development.md`.


## Azure AI Search (Phase 4)

Retrieval in production/Azure mode runs against Azure AI Search. Search returns
authorized chunks; Foundry `nova-chat` writes the answer.

Required configuration:

| Variable | Notes |
| --- | --- |
| `VECTOR_STORE=azure_search` | Selects the Azure retrieval path. |
| `AZURE_SEARCH_ENDPOINT` | Not a secret. |
| `AZURE_SEARCH_ADMIN_KEY` | **Secret.** Deployment environment only; rotate if it has ever been pasted into a chat, ticket or shell history. |
| `AZURE_SEARCH_INDEX` | Defaults to `nova-knowledge`. |
| `AZURE_SEARCH_API_VERSION` | Defaults to the stable `2024-07-01`. |
| `EMBEDDING_DIM` | Must equal the index vector dimension. A mismatch fails loudly rather than truncating or padding. |

Deploy order:

1. `npm run search:index` — creates `nova-knowledge` if absent, then upserts
   incrementally. Safe to run repeatedly. It never drops or recreates an
   existing index; an incompatible index is reported as a configuration error.
2. `npm run search:validate` — exits non-zero on schema drift. Use it as a gate.
3. `npm run search:status` — index existence and document count.

Operational notes:

- The index is never created or modified at application startup.
- Deactivating a version or document, or changing an ACL, updates the index
  through a metadata-only merge: no re-embedding, and the change takes effect
  for retrieval immediately.
- Deleting a document removes its chunks from the index.
- A Search failure in Azure mode is an explicit error. There is no fallback to
  local retrieval.
- `/api/health` and `/api/admin/metrics` make no Search request and no model
  call; `liveProbe` remains `false`. Use `npm run search:status` for
  connectivity checks instead.

---

## Governed enterprise actions (Phase 8)

### Migration

`migrations/006_governed_actions.sql` adds `role_action_permissions` and
`action_requests`. Apply it with the normal path:

```bash
npm run db:migrate
npm run db:status      # expect: database is up to date
```

It is idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`) and additive - no existing
table or column is altered, so it is safe to apply to a live Neon database
before the new code rolls out. Local/demo SQLite gets the same tables from
`SQLITE_SCHEMA` in `backend/src/db/index.ts`.

### Default: local mock

No configuration is needed. `ACTION_MODE` defaults to `local`, the mock
executor runs, and every result is labelled **SIMULATED ACTION** in the UI and
flagged `simulated = 1` in `action_requests`.

### Enabling the Azure Function executor

1. Provision the Function App and publish the app:
   ```bash
   cd azure-functions/nova-actions
   npm ci && npm run build
   func azure functionapp publish nova-actions
   ```
   (Full `az` commands in `azure-functions/nova-actions/README.md`.)
2. Read the function key once and store it as a secret (App Service setting or
   Key Vault reference). Never commit it, and never put it in a URL.
3. Set on the NOVA backend:
   ```
   ACTION_MODE=azure
   AZURE_ACTION_FUNCTION_URL=https://nova-actions.azurewebsites.net
   AZURE_ACTION_FUNCTION_KEY=<key>
   ```
4. Restart. If the URL is missing or not https, **the process refuses to start**
   rather than falling back to the mock. Confirm with
   `GET /api/actions` -> `"executor": "azure_function", "simulated": false`.

### Post-deploy grants

Action permissions default to *nobody* (administrators excepted). Grant them
per role:

```bash
curl -X POST https://<host>/api/admin/action-permissions \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"roleKey":"IT_SUPPORT","actionPermission":"actions.it.create_request","granted":true}'
```

Revocation takes effect immediately, including for proposals already awaiting
confirmation - the confirm step re-authorizes from the database.

### Operational notes

- `/api/health` and `/api/admin/metrics` remain zero-token: the new `actions`
  block in metrics is a plain SQL count over `action_requests`.
- `action_requests` grows one row per attempt, including refusals. It is an
  audit table - plan retention deliberately rather than pruning it casually.
- Watch for `action.function.unreachable`, `action.function.failed` and
  `action.function.malformed` in the structured logs; a row stuck in
  `executing` means NOVA handed work downstream and never heard back.
