# Azure integration (prepared, disabled by default)

NOVA runs entirely locally today. Azure adapters exist behind the same interfaces the local
implementations satisfy, and **nothing in this document is active** until the modes below are
changed by hand. NOVA never auto-detects Azure credentials and never silently calls Azure.

## Switching modes

```
AI_MODE=azure
KNOWLEDGE_MODE=azure
AUTH_MODE=entra
ACTION_MODE=azure
VECTOR_STORE=azure_search
```

There is **no `APP_MODE` variable**. The overall mode is derived from the provider modes
above; if `APP_MODE` is set in the environment and disagrees with the derived mode, startup
fails with a `ConfigError` telling you to remove it. Likewise, a mode variable set to an
unsupported value (for example `VECTOR_STORE=azure` instead of `azure_search`) now throws
instead of silently falling back to the local default.

No code change is required: the provider factories read configuration at startup.
The UI badge becomes **AZURE CONFIGURED** when every Azure-selected component has the real
Azure implementation loaded and all of its required non-secret settings are present. If a
setting is missing or a local implementation is loaded where Azure was selected, the badge
reads **AZURE CONFIGURED - INCOMPLETE**, with a per-component reason in
`health.azureReadiness.components`.

The badge never claims **AZURE CONNECTED**, because `/api/health` performs local
configuration and readiness checks only: it calls no Azure Foundry model, no Azure AI
Search query, and consumes zero tokens (`liveProbe: false` in the payload). Real
connectivity is proven by real application traffic — chat and embedding requests surface
structured `LLMError` / `EmbeddingError` failures — or by the manual
`npm run test:foundry` check below.

## Microsoft Foundry project (NOVA)

The Foundry project and both model deployments already exist. The project name is
lowercase `nova-foundry` everywhere — never `NOVA-Foundry`.

| Setting | Value |
| --- | --- |
| Project | `nova-foundry` |
| Project endpoint | `https://nova-foundry-hn-2376.services.ai.azure.com/api/projects/nova-foundry` |
| Chat deployment | `nova-chat` (GPT-4.1-mini, Global Standard) |
| Embedding deployment | `nova-embedding` (text-embedding-3-small, Global Standard) |

How NOVA calls it:

```
POST <FOUNDRY_ENDPOINT>/openai/v1/chat/completions
POST <FOUNDRY_ENDPOINT>/openai/v1/embeddings

Headers: api-key: <AZURE_API_KEY>        (or Authorization: Bearer <Entra token>)
Body:    { "model": "<deployment name>", ... }
```

- The **deployment name** goes in the body's `model` field — not in the URL.
- The `/openai/v1` route takes **no `api-version` query parameter**; `FOUNDRY_API_VERSION`
  has been removed from the configuration.
- `EMBEDDING_DIM` (default `384`) is sent to `text-embedding-3-small` as `dimensions`, so
  Foundry vectors match NOVA's existing vector width. A mismatch fails loudly rather than
  silently corrupting the index.
- Embeddings produced by `nova-embedding` are **not** comparable with local hashed-lexical
  vectors. Re-index after switching `AI_MODE`.

### Error and status handling

Foundry failures are categorised (`auth`, `rate_limited`, `timeout`, `bad_request`,
`not_found`, `network`, `upstream`) and carry the verbatim upstream HTTP status and request
id internally. What the NOVA API returns to a client is deliberately narrower, so upstream
authentication and resource details are never leaked:

| Upstream / category | NOVA public status |
| --- | --- |
| `rate_limited` (429) | 429 |
| `timeout` | 504 |
| everything else, including 401/403/404 | 502 |

The full category, upstream status and request id are logged server-side and surfaced in
health diagnostics; the client response carries only the safe `category` field.

### Credentials

`AZURE_API_KEY` is a **backend-only** secret, read exclusively from the environment. It is
never committed, never sent to the frontend, never logged, and never printed by tests. The
preferred production path is Microsoft Entra ID against the project endpoint (scope
`https://ai.azure.com/.default`), supplied via `AZURE_ACCESS_TOKEN` or managed identity;
when a token is present it takes precedence over the key.

### Connectivity check (manual, consumes tokens)

```
npm run test:foundry
```

This is the **only** place NOVA deliberately calls Foundry to prove connectivity, and it is
never run automatically — not by `/api/health`, not by `/api/admin/metrics`, and not by any
timer or background task. Calls `nova-chat` (expects the exact reply `NOVA Azure connection works.`) and
`nova-embedding` (prints only `Dimensions: <n>`), and exits non-zero on failure. It uses the
real NOVA providers — there is no second Foundry client in the repository.

## Variables

| Variable | Used by |
| --- | --- |
| `FOUNDRY_ENDPOINT`, `FOUNDRY_PROJECT`, `FOUNDRY_MODEL_DEPLOYMENT` | `llm/azure_foundry.ts` |
| `FOUNDRY_AGENT_ID` | Optional Foundry Agent Service target |
| `AZURE_EMBEDDING_DEPLOYMENT` | `embeddings/azure.ts` |
| `AZURE_SEARCH_ENDPOINT`, `AZURE_SEARCH_INDEX`, `AZURE_SEARCH_API_VERSION` | `retrieval/vector/azure.ts`, `knowledge/azure_foundry_iq.ts` |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_CONTAINER` | Document storage |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_API_ID_URI`, `ENTRA_API_SCOPE`, `ENTRA_AUTHORITY`, `ENTRA_REDIRECT_URI` | `auth/entra.ts`, `auth/entraToken.ts` (public configuration, no secret) |
| `ENTRA_AUTO_PROVISION`, `ENTRA_AUTO_PROVISION_TENANT_ID`, `ENTRA_AUTO_PROVISION_ROLE_KEY`, `ENTRA_AUTO_PROVISION_DEPARTMENT` | First-time Entra user handling (pending, privilege-free) |
| `VITE_ENTRA_*` | Optional build-time fallback for the SPA; normally served by `GET /api/auth/config` |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` | Legacy aliases for `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` |
| `AZURE_API_KEY` | Backend-only Foundry key; alternative to Entra / managed identity |
| `AZURE_ACCESS_TOKEN` | Optional pre-acquired Entra token (`https://ai.azure.com/.default`); wins over `AZURE_API_KEY` |
| `AZURE_ACTION_WORKFLOW_URL`, `AZURE_ACTION_API_KEY` | `actions/azure.ts` (legacy Phase 4 incident workflow) |
| `AZURE_ACTION_FUNCTION_URL`, `AZURE_ACTION_FUNCTION_KEY`, `AZURE_ACTION_FUNCTION_TIMEOUT_MS` | `actions/governed/executors.ts` -> `azure-functions/nova-actions` (Phase 8). `ACTION_MODE=azure` refuses to start without the URL |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Telemetry export |


## Microsoft Entra ID authentication (Phase 6)

`AUTH_MODE=entra` replaces demo persona selection with real Microsoft sign-in. It changes
**who the human is**; it changes nothing about **what they may do inside NOVA**.

```
Microsoft Entra ID  ->  "who is this human?"          (authentication)
Neon PostgreSQL     ->  "which NOVA user, tenant,
                         role, department, clearance,
                         permissions, documents?"      (authorization)
```

### App registration (already created)

| Setting | Value |
| --- | --- |
| Directory (tenant) ID | `191223fe-a651-4b8c-a79d-8b368bba577d` |
| Application (client) ID | `9bb0d161-2be5-4d0c-b5f5-8c54211c0d1d` |
| Application ID URI | `api://9bb0d161-2be5-4d0c-b5f5-8c54211c0d1d` |
| Delegated API scope | `api://9bb0d161-2be5-4d0c-b5f5-8c54211c0d1d/access_as_user` |
| Authority | `https://login.microsoftonline.com/191223fe-a651-4b8c-a79d-8b368bba577d` |
| Platform | Single-page application (SPA) |
| Flow | Authorization Code + PKCE |
| Redirect URI (development) | `http://localhost:4317` |
| Client secret | **none — and none may be created** |

The application is single tenant. `common`, `organizations` and `consumers` authorities are
rejected at startup. Microsoft Graph permissions are **not** required: the display name and
username come from the MSAL account record, and every authorization attribute comes from Neon.

### Redirect URI and the server port

Entra only accepts the exact redirect URI registered on the application. With
`AUTH_MODE=entra` NOVA therefore:

- binds the port taken from `ENTRA_REDIRECT_URI` (4317 by default),
- refuses to start if `PORT` contradicts it, and
- **fails clearly** if that port is busy instead of silently moving to an unregistered
  origin. Demo/local mode keeps its automatic "next free port" behaviour.

MSAL Browser v3/v4 completes the redirect with `handleRedirectPromise()` on the page the
redirect landed on. NOVA's redirect URI is the application origin itself, served by the same
Node server, so **no dedicated redirect/bridge page is required** and none was added.

### Token validation (backend)

`backend/src/auth/entraToken.ts` performs real validation, never a bare decode:

| Check | Rule |
| --- | --- |
| Signature | RS256 against the tenant JWKS from the OIDC discovery document; `alg: none` and HMAC are refused |
| Key cache | Discovery + JWKS cached for `ENTRA_JWKS_CACHE_MS` (1 hour); an unknown `kid` triggers at most one refresh every 5 minutes |
| Issuer | `https://login.microsoftonline.com/<tenant>/v2.0` or `https://sts.windows.net/<tenant>/` |
| Audience | `api://<clientId>` (or the bare client id) — a Microsoft Graph token or a token for any other API is refused |
| Tenant | `tid` must equal the configured directory |
| Expiry | `exp`, and `nbf` when present, with `ENTRA_CLOCK_SKEW_SECONDS` (60s) |
| Scope | `scp` must contain `access_as_user`; an application-permission token has no `scp` and is refused |
| Identity | the stable `oid` object id is required; `name`, `email` and `preferred_username` are never identity |

Failures return a bare `401` with the message `Authentication failed.` — no claims, no
signing keys, no discovery metadata, no raw Entra text, and nothing token-shaped is logged.

### Identity mapping

```
validated oid -> users.entra_object_id -> NOVA user -> tenant / role / department
              -> permissions -> classification clearance -> AccessScope
```

Migration `005_entra_identity.sql` adds `users.entra_object_id` (unique over linked rows),
`users.entra_upn` (display only) and `users.status`. An identity that maps to no NOVA user is
**403**, never a default tenant and never the demo tenant.

First-time users: `ENTRA_AUTO_PROVISION=false` (default) denies them until an administrator
links the identity. With `true`, a `pending`, privilege-free user is created in
`ENTRA_AUTO_PROVISION_TENANT_ID` and stays unusable until an administrator activates it. A
role, department or clearance is never inferred from an email address, domain or display name.

Administrators manage links from **Admin → Users** or directly:

```
POST   /api/admin/users/:id/entra-link   { "entraObjectId": "<GUID>" }
DELETE /api/admin/users/:id/entra-link
POST   /api/admin/users/:id/status       { "status": "active" | "pending" | "disabled" }
```

### Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/auth/config` | public | Public Entra settings for the SPA (client id, authority, scope, redirect URI). No secrets. |
| `GET /api/auth/me` | bearer | Safe NOVA identity: user, tenant, role, clearance. Never a token or raw claim. |
| `POST /api/session` | bearer (Entra mode) | Echoes the resolved NOVA identity; body-supplied tenant/user/email are ignored. |
| `POST /api/onboarding/tenants` | demo only | Disabled in Entra mode (it would mint an admin anonymously). |

`/api/health` is unchanged: local, synchronous, zero-token, and it never contacts Entra.
`/api/admin/metrics` performs no discovery, token or Graph request either.

## Azure resources required

1. **Azure AI Foundry project** with a chat model deployment (for example GPT-4o-mini or GPT-4.1) and
   an embedding deployment (`text-embedding-3-small` or larger).
2. **Azure AI Search** service and an index whose fields mirror the local vector record:
   `chunkId, tenantId, documentId, versionId, contentVector, text, section, seq, keywords,
   documentTitle, department, category, classification, version`. Use a vector profile matching
   `EMBEDDING_DIM` and enable filterable attributes on the tenant/metadata fields — security filters
   must run inside the service, not in application code.
3. **Foundry IQ knowledge source** pointing at that index if you want Foundry-managed retrieval
   instead of direct Search queries.
4. **Azure Blob Storage** account and container for original documents (encryption at rest is on by
   default).
5. **Microsoft Entra ID** app registration exposing an API scope, plus app roles or group claims that
   map to NOVA roles.
6. **Application Insights** workspace if you want telemetry export.
7. **Managed identity** (recommended over client secrets) with `Search Index Data Contributor`,
   `Search Index Data Reader`, `Storage Blob Data Contributor` and `Cognitive Services OpenAI User`
   role assignments.

## Implementation notes

- The Foundry adapters call the OpenAI-compatible v1 routes on the project endpoint
  (`chat/completions`, `embeddings`). The Azure AI Search adapter keeps its own
  `api-version` because Search is a different service. No SDK classes or methods are
  invented, and the deprecated Assistants API is not used.
- Tenant isolation carries over as an OData filter (`tenantId eq '...'` plus classification and
  department predicates) applied by the service, exactly like the local SQL predicate.
- Entra tokens are validated for issuer, audience and signature; the resulting claims are mapped into
  the same `AccessScope` the demo provider produces, so authorization logic is unchanged.
- These adapters have not been executed against a live subscription from this repository. Treat the
  first Azure run as an integration test: verify each health check individually before enabling all
  modes at once.

---

## Actual readiness state

This file documents configuration. For what is actually implemented versus
what still requires Azure resources or live verification, see
`azure-readiness-status.md`. Environment variables alone never mean a
capability is implemented or connected.

---

# Phase 4 — Azure AI Search retrieval layer

Azure AI Search is NOVA's **retrieval** layer. It does not generate answers.
Microsoft Foundry `nova-chat` still writes the final grounded answer; Search
decides *which authorized chunks* that model is allowed to see.

## Resource

| | |
| --- | --- |
| Service | `nova-search` (Free tier, Korea Central) |
| Endpoint | `https://nova-search.search.windows.net` (not a secret) |
| Index | `nova-knowledge` — one index, all tenants |
| API version | `2024-07-01` (stable; no preview features) |
| Admin key | `AZURE_SEARCH_ADMIN_KEY` — **secret**, environment only |

The admin key is never logged, never returned by any API, never written to
`.env.example` or to documentation, and is scrubbed out of upstream error text
before a `SearchError` is constructed.

## Why one index

Security is a per-query filter, not a per-tenant index name. One index keeps the
boundary in a single unit-tested expression instead of spreading it across index
naming and routing, and the Free tier allows only 3 indexes.

## Index schema (29 fields)

| Group | Fields |
| --- | --- |
| Key | `id` (`{tenantId}__{chunkId}`, restricted to the characters Azure allows) |
| Security (filterable) | `tenantId`, `department`, `classification`, `classificationLevel`, `allowedRoles`, `allowedUsers`, `documentActive`, `versionActive`, `documentId`, `versionId` |
| Full text (searchable) | `content`, `title`, `section`, `filename` |
| Citation metadata | `chunkId`, `category`, `sourceType`, `version`, `seq`, `page`, `uploadedBy`, `uploadedAt`, `effectiveDate`, `injectionFlags` |
| Bookkeeping | `contentHash`, `metadataHash`, `schemaVersion` |
| Vector | `contentVector` — `Collection(Edm.Single)`, HNSW, **cosine**, dimension = `EMBEDDING_DIM` (384), `retrievable: false` |

`page` is `null` unless the source actually carries a page number. NOVA's text
extractors do not produce one, so it is reported as null rather than invented.

`contentVector` is not retrievable: vectors never leave Search and never enter
the LLM context.

### Schema versioning

`NOVA_SEARCH_INDEX_VERSION` records the schema this build expects.
`validateIndexDefinition()` compares the live index field by field. Extra fields
from a newer build are tolerated; a missing field, a changed type, a lost
`filterable` flag on a security field, or a vector-dimension mismatch is not.
An incompatible index raises a configuration error — the index is never dropped
or silently rewritten, and it is never created at application startup.

## The security filter

`backend/src/retrieval/vector/odata.ts` is the security boundary. It is the
OData counterpart of `accessSqlFilter()` and reproduces the same policy:

```
tenantId eq '<tenant>'
AND documentActive eq true AND versionActive eq true
AND (                                        -- omitted for admins
      allowedUsers/any(u: u eq '<userId>')   -- explicit user grant wins
      OR (
           (classificationLevel le <wildcardGrant>
            OR (department eq '<dept>' AND classificationLevel le <deptGrant>) ...)
           AND (not allowedRoles/any() OR allowedRoles/any(r: r eq '<roleKey>'))
      )
)
```

Properties that must not regress:

- **Clearance is per department.** An earlier implementation applied the
  caller's highest clearance in *any* department to *every* department and
  dropped the role and user ACLs entirely. Both were privilege-escalation bugs.
- **One authoritative filter.** It is passed as the request-level `filter`, so
  it governs the lexical and the vector side of a hybrid query alike. Per-vector
  `filterOverride` is deliberately not used: a vector-level override *replaces*
  the global filter and would drop the tenant and ACL predicates.
- **Server-resolved input only.** The filter is built from the `AccessScope`
  that the backend derived from the authenticated identity. `AzureVectorStore`
  refuses to query without a scope and refuses a scope whose tenant disagrees
  with the query. A caller cannot supply a tenant id or a filter.
- **Values are escaped.** Single quotes are doubled; control characters are
  rejected. A department "hint" from the UI is ANDed on top, so it can only
  narrow the result set.

Equivalence with the policy is not asserted by inspection: the live test suite
indexes a document matrix and compares Azure's own results against
`decideDocumentAccess()` for seven different scopes.

## Hybrid retrieval

```
question -> EmbeddingProvider (nova-embedding) -> query vector
                                   |
              lexical query + vector query in ONE Search request
                                   |
                     request-level security filter (prefilter)
                                   |
                  authorized chunks -> rerank -> citations -> nova-chat
```

Top-K comes from `RETRIEVAL_TOP_K` (8) after re-ranking;
`RETRIEVAL_CANDIDATES` (40) bounds what Search returns.

Azure returns a single fused (RRF) relevance score for a hybrid query. It is not
decomposable into separate vector and keyword components, so NOVA reports it
once as `vectorScore` and leaves `keywordScore` at 0 rather than inventing a
split.

## Indexing and embedding cost

| Command | Effect |
| --- | --- |
| `npm run search:validate` | Compares the live index with the expected schema. Exits non-zero on drift. |
| `npm run search:status` | Index existence and document count. |
| `npm run search:index` | Creates the index if absent, then incrementally upserts. |
| `npm run search:reindex -- --force` | Rebuilds every vector deliberately. |

Change detection uses two hashes stored on each Search document:

| Situation | Behaviour |
| --- | --- |
| Chunk unchanged | Skipped. No upload, no embedding. |
| Metadata changed (ACL, classification, flags) | Metadata-only `merge`. **No embedding.** |
| Content changed / new chunk | Full upsert with a vector. |
| Chunk removed from the database | Deleted from the index. |
| Version or document deactivated | `versionActive` / `documentActive` flipped by merge. **No embedding.** |

Chunk vectors are produced **once, during ingestion**, and stored in
`document_chunks.embedding`. `search:index` reuses them, so a normal indexing
run makes **zero** embedding calls. An embedding call happens only when a chunk
has no usable stored vector, or under `--force`; the new vector is written back
to the database so the next run does not pay again.

Azure model usage therefore occurs only for:

1. a new or changed chunk during ingestion, and
2. one query embedding per real user question.

No model call is made by `/api/health`, `/api/admin/metrics`, startup, index
management, or an idle application. `/api/health` also performs **no Azure
Search request**: `AzureVectorStore.healthCheck()` reports configuration only
and `liveProbe` stays `false`. Search queries themselves consume no model tokens.

## Local vs Azure

| | Local/demo | Production/Azure |
| --- | --- | --- |
| Retrieval | SQLite vector store (BM25 + cosine) | Azure AI Search hybrid |
| Database | SQLite | Neon PostgreSQL |
| LLM / embeddings | Local providers | Foundry `nova-chat` / `nova-embedding` |

Local mode never contacts Azure AI Search. In Azure mode a Search failure is an
explicit `SearchError` — there is no silent fallback to local retrieval, because
falling back would answer from a store the deployment did not authorize and
could not have kept in sync.

`VECTOR_STORE=azure_search` requires `AZURE_SEARCH_ENDPOINT` and
`AZURE_SEARCH_ADMIN_KEY`; configuration fails fast if either is missing.

## Errors

`SearchError` carries `category`, `statusCode`, `upstreamStatus` and the Azure
`request-id`. Upstream 401/403/404 map to 502 (they indicate NOVA
misconfiguration, not a caller problem), 429 maps to 429 and a timeout to 504.
Retries are bounded and exponential, and apply only to 429, 5xx and network or
timeout failures — never to a malformed request, an auth failure or a bad
filter. Errors never contain the admin key, the endpoint credentials, raw Azure
payloads, or unauthorized document names.


---

# Phase 5 — Azure Blob Storage for document files

Azure Blob Storage is NOVA's **document file** layer. It holds the original
uploaded binaries and nothing else. It is not an application database, not an
authorization source and not a search index.

## Responsibility split (production/Azure)

| System | Owns |
| --- | --- |
| Neon PostgreSQL | tenants, users, roles, documents, versions, ownership, permissions, classification, lifecycle state, storage references, audit |
| Azure Blob Storage | the original PDF/DOCX/TXT/Markdown files, one object per document version |
| Azure AI Search (`nova-knowledge`) | extracted chunks, embeddings, searchable + ACL metadata |
| Azure Foundry | `nova-embedding` (vectors) and `nova-chat` (final grounded answer) |

The database never stores a document binary, and Blob metadata is never used to
make an authorization decision.

## Resource

| Item | Value |
| --- | --- |
| Storage account | `novastorage2376` |
| Region | Korea Central |
| Resource group | `rg-harprabhnanda-2376` |
| Container | `documents` (**private**, anonymous access off) |

## Configuration

```bash
STORAGE_MODE=azure_blob
AZURE_STORAGE_ACCOUNT=novastorage2376
AZURE_STORAGE_CONTAINER=documents
AZURE_STORAGE_CONNECTION_STRING=<supplied-through-the-environment>
MAX_DOCUMENT_SIZE_BYTES=15728640
```

`AZURE_STORAGE_CONNECTION_STRING` is a **secret**. It is never logged, never
returned by an API, never sent to the frontend and never written to
`.env.example`, documentation or tests. `.env.example` carries a placeholder
only.

Mode selection is explicit, exactly like every other provider: the presence of
a connection string never switches storage to Azure by itself. If
`STORAGE_MODE=azure_blob` and the connection string or container is missing,
NOVA **fails at startup**. It never falls back to local disk.

## Object key design

```
tenant/<tenantId>/document/<documentId>/version/<versionId>/original.<ext>
```

Example:

```
tenant/ten_8f2c.../document/doc_91ab.../version/ver_77de.../original.pdf
```

- generated server-side from database identifiers only;
- deterministic, so an interrupted upload is retried onto the same object
  instead of orphaning a second one;
- the tenant, document and version are part of the path, so an object can
  always be proved to belong to the row that references it;
- the original filename is never the identity of the object. Only an
  allowlisted extension survives (`.md`, `.markdown`, `.txt`, `.docx`, `.pdf`);
- traversal input (`../`, `..\`, `/etc/passwd`, `C:\secret.txt`,
  `tenant/../../other`) can never shape a key, and any structurally unsafe key
  is rejected before a request is made.

Each version has its **own** object: a new version never overwrites the
previous version's file.

## Why REST instead of `@azure/storage-blob`

NOVA ships with a single runtime dependency (`pg`). Foundry and Azure AI Search
are already thin `fetch` clients in `backend/src/azure/`, and the repository is
installed in environments without registry access. `backend/src/azure/blob.ts`
therefore implements Shared Key authorization directly, in the same shape as
the Search client: structured errors, bounded retries on transient failures
only, scrubbed diagnostics, and no credential in any URL, log line or error.

## Upload lifecycle

```
validate (filename, extension, declared MIME, size)
  -> extract text -> detect metadata
  -> upsert document row (Neon)
  -> insert version row, ingest_status = 'pending'  (Neon)
  -> PUT original                                   (Blob)
  -> chunk -> embed new chunks -> index             (Foundry + Search)
  -> ingest_status = 'indexed'                      (Neon)
  -> activate version (supersedes the previous one)
```

Blob Storage and Neon cannot share a transaction, so the database records the
intent before the bytes exist:

- **Blob upload fails** → the half-written object is deleted, the version is
  marked `failed`, and the API reports failure. Nothing is marked ready.
- **Indexing fails** → the stored original is *kept* (Search is derived data),
  the version is marked `failed` with the error, and the same bytes can be
  re-uploaded to retry.
- A retry of identical bytes whose earlier attempt never reached `indexed`
  discards that abandoned version (rows + object) and starts clean.
- Identical bytes that *did* reach `indexed` are reused: no second object, no
  re-extraction, no re-embedding.

## Download

```
request -> bearer token -> tenant resolution -> Neon document + ACL decision
        -> version lookup -> key proved to match tenant/document/version
        -> Blob stream -> response
```

`GET /api/knowledge/:id/versions/:versionId/file` accepts **identifiers only**.
A client can never submit a storage path, container or object key; there is no
SAS URL, no public URL and no container listing. An unauthorized or
cross-tenant request returns the same `404` as a missing document.

## Deletion vs deactivation

| Action | Neon | Search | Blob |
| --- | --- | --- | --- |
| Deactivate version | `status = 'inactive'` | `versionActive = false` | **retained** |
| Deactivate document | `status = 'inactive'` | `documentActive = false` | **retained** |
| Delete document | rows removed last | cleared first | every version's object removed |

A version becoming inactive never deletes its source file.

## Model usage

Blob Storage never calls a model. `nova-embedding` runs only for new or changed
chunks during ingestion and once per user query; `nova-chat` runs only to write
an answer. Reading a blob, checking health, or loading admin metrics generates
no embedding and no completion.

## Commands

```bash
npm run storage:status     # configuration summary, no remote call
npm run storage:init       # create the private container if it does not exist
npm run storage:validate   # real connect + container + write/read/delete round trip
```

`storage:validate` writes a temporary object under a `diagnostics/` prefix and
always removes it again. It is a deliberate administrative diagnostic — which
is exactly why `/api/health` and `/api/admin/metrics` do none of this.


---

# Phase 8 - NOVA Actions Azure Function app

`ACTION_MODE=azure` routes governed enterprise actions to a dedicated TypeScript Azure
Functions app that lives in this repository at `azure-functions/nova-actions/`. It is a
separate npm package with its own `package.json`, `tsconfig.json`, `host.json` and unit
tests, so it builds and deploys independently of the NOVA backend.

## Routes

| Method | Route | NOVA action id |
| --- | --- | --- |
| POST | `/api/actions/create-it-request` | `create_it_request` |
| POST | `/api/actions/submit-approval` | `submit_approval_request` |
| POST | `/api/actions/create-onboarding-checklist` | `create_onboarding_checklist` |

All three are `authLevel: "function"`. NOVA appends `/api/actions/<route>` to
`AZURE_ACTION_FUNCTION_URL`, so that variable is the app **origin**, not a single route.

## Configuration

```
ACTION_MODE=azure
AZURE_ACTION_FUNCTION_URL=https://nova-actions.azurewebsites.net
AZURE_ACTION_FUNCTION_KEY=<function key - environment/Key Vault only>
```

There is **no fallback to the local mock**: `ACTION_MODE=azure` without the URL throws a
`ConfigError` at startup, and a non-https URL outside localhost is refused. The key is sent
as an `x-functions-key` header, never in the URL.

## Resources required

| Resource | Purpose | State |
| --- | --- | --- |
| Function App (Node 20, Functions v4, Linux consumption) | hosts the three routes | **NOT PROVISIONED** |
| Storage account for `AzureWebJobsStorage` | Functions host requirement | **NOT PROVISIONED** |
| Function key (or APIM / Entra app auth in front) | authenticates NOVA to the app | **NOT PROVISIONED** |

Deploy commands are in `azure-functions/nova-actions/README.md`. Behaviour, error mapping
and the governance pipeline are documented in `docs/governed-actions.md`.

## Readiness

The app and its contract are implemented and unit-tested (15 tests in its own package, plus
a schema-drift guard in the root suite). It has **not** been deployed to or executed against
a live Azure subscription from this revision, and its three actions do not yet write to a
real ServiceNow/Dynamics/SAP instance - they compute and return a reference, an approval
chain or a task list. That downstream integration is per-customer work against the HTTPS
contract above.
