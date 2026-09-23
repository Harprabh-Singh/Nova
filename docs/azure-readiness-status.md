# Azure readiness - actual state

Companion to `azure-integration.md`, which describes how the Azure adapters are
*configured*. This file records what is actually true today. It separates four
states and never conflates them:

1. **Already coded adapter** - code exists in this repository
2. **Resource required in Azure** - nothing works until it is provisioned
3. **Live subscription verification required** - never exercised against Azure
4. **Production infrastructure still missing** - not implemented at all

| Capability | State | Evidence in repo |
| --- | --- | --- |
| LLM (Microsoft Foundry, `nova-chat`) | 1 + 3 (resource **exists**) | `backend/src/llm/azure_foundry.ts`, `backend/src/azure/foundry.ts` |
| Knowledge (Foundry IQ) | 1 + 2 + 3 | `backend/src/knowledge/azure_foundry_iq.ts` |
| Embeddings (Microsoft Foundry, `nova-embedding`) | 1 + 3 (resource **exists**) | `backend/src/embeddings/azure.ts` |
| Vector store (Azure AI Search) | implemented **and verified live** | `backend/src/retrieval/vector/azure.ts` + `azure-index.ts` + `odata.ts`; index `nova-knowledge` created, 210 real chunks indexed and retrieved during verification |
| Auth (Entra ID) | 1 + 3 (app registration **exists**) | `backend/src/auth/entra.ts`, `backend/src/auth/entraToken.ts`, `frontend/src/auth/entraClient.ts`, migration `005_entra_identity.sql`. Full token validation + Neon identity mapping implemented; no live browser sign-in executed from this revision |
| Actions (legacy incident workflow) | 1 + 2 + 3 | `backend/src/actions/azure.ts` |
| Governed actions (Phase 8) | 1 + 2 + 3 | `backend/src/actions/governed/` (registry, strict validation, authorization, confirmation + re-authorization, audit) and `azure-functions/nova-actions/` (standalone TypeScript Function app). Migration `006_governed_actions.sql`. 40 governance tests + 21 Function-app tests pass locally; the Function app has **not** been deployed or called on a live subscription |
| Azure Blob Storage | 1 + 3 (resource **exists**) | `backend/src/storage/` (provider abstraction, local + Azure implementations) and `backend/src/azure/blob.ts`; account `novastorage2376`, container `documents`. Not executed against the live account from this revision |
| PostgreSQL | implemented **and verified against a live Neon database** | Versioned migrations `001`-`003` applied; the full test suite passes against real Neon (`NOVA_TEST_DB=postgres`). Local/demo remains SQLite (`backend/src/db/index.ts`) |
| Application Insights | 4 | Local redacting logger only (`backend/src/observability/logger.ts`) |
| Managed Identity | 4 | No `DefaultAzureCredential` anywhere in `backend/src` |
| Key Vault | 4 | Secrets are read from environment/config only |
| App Service / Container Apps | 4 | No IaC, pipeline or deployment manifest in the repository |

## Microsoft Foundry connection status

| Item | Status |
| --- | --- |
| Foundry project `nova-foundry` | **DEPLOYED** (exists in Azure) |
| Chat deployment `nova-chat` (GPT-4.1-mini) | **DEPLOYED** |
| Embedding deployment `nova-embedding` (text-embedding-3-small) | **DEPLOYED** |
| NOVA chat adapter against the v1 route | **IMPLEMENTED** |
| NOVA embedding adapter against the v1 route | **IMPLEMENTED** |
| Live chat call to `nova-chat` | **NOT VERIFIED (not run)** |
| Live embedding call to `nova-embedding` | **NOT VERIFIED (not run)** |
| `/api/health` against Foundry | **N/A - health makes no Foundry call (zero-token, local-only)** |
| Azure AI Search (`nova-search`) | **CONNECTED AND VERIFIED** — index `nova-knowledge` created; hybrid retrieval, security trimming, incremental indexing and deletion all executed against the live service |
| Foundry IQ | **NOT USED** — Phase 4 deliberately talks to Azure AI Search directly so NOVA keeps explicit control of authorization |
| Azure Blob Storage (`novastorage2376` / `documents`) | **IMPLEMENTED; NOT VERIFIED LIVE** — provider, deterministic keys, upload/download/delete, lifecycle and tests are complete; no live blob round trip was executed from this revision. Run `npm run storage:validate` to move this row |
| PostgreSQL / Neon | **IMPLEMENTED; MIGRATIONS APPLIED; VERIFIED LIVE** (77/77 tests against a real Neon database, and the server served `/api/health` and `/api/tenants` from Neon) |
| Microsoft Entra ID | **IMPLEMENTED; NOT VERIFIED LIVE** — single-tenant SPA app registration (client `9bb0d161-2be5-4d0c-b5f5-8c54211c0d1d`, tenant `191223fe-a651-4b8c-a79d-8b368bba577d`, scope `access_as_user`, redirect `http://localhost:4317`, no client secret). Token validation, identity mapping and authorization are covered by `tests/auth.test.ts`; a real browser sign-in was **NOT RUN** here |
| NOVA Actions Function app (`azure-functions/nova-actions`) | **IMPLEMENTED; NOT DEPLOYED** — three routes, `authLevel: "function"`, pure unit-tested handlers, schema-drift guard against the NOVA registry. No Function App or storage account provisioned; `ACTION_MODE=azure` refuses to start without `AZURE_ACTION_FUNCTION_URL` rather than simulating |
| Application Insights | **NOT CONNECTED** |

The adapters were written against the documented Foundry v1 surface but have
not been executed against the live project from this revision. Run
`npm run test:foundry` locally to move the two **NOT VERIFIED** rows; it
prints `CHAT PASS`, `EMBEDDING PASS` and `RESULT: PASS` and exits non-zero on
any failure.

Entra ID is **not yet implemented end to end** and is deliberately a later
phase. Blob Storage is complete as of Phase 5 in code (storage abstraction,
Azure Blob provider, deterministic tenant/document/version keys, authorized
backend-mediated download, lifecycle-aware deletion, tests) but has not been
executed against the live storage account from this revision. Azure AI Search is complete as of Phase 4: the
`nova-knowledge` index exists, hybrid retrieval runs with a single authoritative
server-generated security filter, and Azure's own OData engine was used to prove
that filter agrees with `decideDocumentAccess()` for every tested scope. Neon/PostgreSQL is complete for
Phase 3: versioned migrations, a no-fallback production configuration, an
explicit conflict-failing SQLite import tool, and the full behavioural suite
executed against a real Neon database. PostgreSQL is therefore the one row
above that is verified live rather than merely implemented.

## Provider abstractions (preserved)

`LLMProvider`, `KnowledgeProvider`, `VectorStore`, `EmbeddingProvider`,
`AuthProvider` and `ActionProvider` remain the only seams between the
application and any backend. Azure configuration stays separate from local
mode, and the model and embedding deployments remain configurable through
`FOUNDRY_MODEL_DEPLOYMENT` and `AZURE_EMBEDDING_DEPLOYMENT`. No model name is
hard-coded into application logic.

## Honest connection status (local-only, zero-token)

The badge is computed by `computeAzureReadiness` in
`backend/src/api/health.ts` (unit-tested in `tests/config.test.ts` and
`tests/health.test.ts`) and served by `backend/src/api/server.ts`. The function
is pure: it reads the selected modes, the `mode` reported by the provider
instances that were actually constructed, and the presence of the required
non-secret settings. It performs no network request of any kind.

- `LOCAL DEMO MODE` - no component is configured for Azure
- `AZURE CONFIGURED` - every Azure-selected component has the real Azure
  implementation loaded and all of its required settings present
- `AZURE CONFIGURED - INCOMPLETE` - at least one Azure-selected component is
  missing required settings, or a local implementation is loaded where Azure
  was selected

Per-component state (`local`, `configured`, `incomplete`, `misconfigured`) is
returned in `health.azureReadiness.components`, with a `detail` that names the
missing settings but never their values.

There is deliberately **no** `AZURE CONNECTED` badge any more. Claiming a live
connection required calling `nova-chat` with a "ping" and `nova-embedding` with
"health" on every health request, which burned model tokens for no operational
benefit. `/api/health` therefore reports `liveProbe: false` and never implies
that a remote request succeeded. Live connectivity is demonstrated by real
chat/embedding traffic, or by running `npm run test:foundry` manually.

## Bottom line

NOVA is **Azure-pluggable, partially Azure-deployed**. Retrieval (Azure AI
Search) and the application database (Neon PostgreSQL) are verified live.
Document storage has a complete Azure Blob implementation awaiting a live
round trip. Telemetry, identity and secret management are still local-mode
implementations. Claiming
"fully Azure ready" would be false until the state-4 rows above are built and
the state-3 rows are verified against a live subscription.

See `production-blockers.md` for session strategy, CSP, rate limiting and the
per-command test verification status.
