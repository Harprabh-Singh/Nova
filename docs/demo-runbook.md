# NOVA Phase 8 — live demonstration runbook (Windows / PowerShell)

Target configuration: the **entire** knowledge stack is Azure-backed and the
**only** local component is the governed-action executor.

```
User
 └─ Microsoft Entra ID (AUTH_MODE=entra)
     └─ NOVA
         ├─ Neon PostgreSQL        (DATABASE_URL, postgres only)
         ├─ Azure AI Search        (VECTOR_STORE=azure_search)
         ├─ Azure Blob Storage     (STORAGE_MODE=azure_blob)
         ├─ Microsoft Foundry      (AI_MODE=azure, KNOWLEDGE_MODE=azure)
         └─ Governed actions       (ACTION_MODE=local)
             └─ LocalMockExecutor   <-- the only simulated part
```

The NOVA Actions Azure Function app is **not deployed and not used** for this
presentation. `AZURE_ACTION_FUNCTION_URL` / `AZURE_ACTION_FUNCTION_KEY` are read
only when `ACTION_MODE=azure` and must stay unset.

---

## 1. Source-code changes required: none

The repository already supports this mixed configuration. Each provider is
selected from its own variable, in its own factory:

| Layer | Variable | Demo value | Factory | Provider loaded |
| --- | --- | --- | --- | --- |
| Chat | `AI_MODE` | `azure` | `backend/src/llm/index.ts` | `AzureFoundryLLMProvider` |
| Embeddings | `AI_MODE` | `azure` | `backend/src/embeddings/index.ts` | `AzureEmbeddingProvider` |
| Vector store | `VECTOR_STORE` | `azure_search` | `backend/src/knowledge/index.ts` | `AzureVectorStore` |
| Knowledge | `KNOWLEDGE_MODE` | `azure` | `backend/src/knowledge/index.ts` | `AzureKnowledgeProvider` |
| Files | `STORAGE_MODE` | `azure_blob` | `backend/src/storage/index.ts` | `AzureBlobStorageProvider` |
| Auth | `AUTH_MODE` | `entra` | `backend/src/auth/index.ts` | `EntraAuthProvider` |
| Database | `DATABASE_URL` | Neon URL | `backend/src/config/index.ts` | `postgres` (no SQLite fallback) |
| Governed actions | `ACTION_MODE` | `local` | `backend/src/actions/governed/executors.ts` | `LocalMockExecutor` |

`ACTION_MODE` is read in exactly one place for Phase 8:

```ts
// backend/src/actions/governed/executors.ts
if (config.modes.actionMode !== "azure") return new LocalMockExecutor()
```

`APP_MODE` is **derived** (`appMode: "azure"` while any provider is Azure) and
must not be set. `.env.demo.example` is the placeholders-only template and is
already in the repository. Regression coverage lives in
`tests/providerModes.test.ts` (mixed configuration, executor identity, no
silent fallback, zero-probe health, port pinning) and `tests/actions.test.ts`
(authorization, confirmation, re-authorization, tenant isolation, audit rows).

---

## 2. PowerShell command sequence

Run from the repository root. Nothing below requires Unix `cp`, `export` or `jq`.

```powershell
# 1. Demo env file (only if .env does not already hold the demo values)
Copy-Item .env.demo.example .env

# 2. Fill the secrets locally — in the editor, never in chat
notepad .env
#    DATABASE_URL                     = Neon POOLED connection string
#    AZURE_API_KEY                    = Foundry key (or AZURE_ACCESS_TOKEN instead)
#    AZURE_SEARCH_ADMIN_KEY           = Azure AI Search admin key
#    AZURE_STORAGE_CONNECTION_STRING  = Blob connection string
#    ENTRA_TENANT_ID / ENTRA_CLIENT_ID / ENTRA_API_ID_URI /
#    ENTRA_API_SCOPE / ENTRA_AUTHORITY / ENTRA_REDIRECT_URI  (all public)
#    Leave ENTRA_CLIENT_SECRET and AZURE_CLIENT_SECRET absent — startup fails if present.
#    Leave AZURE_ACTION_FUNCTION_URL / _KEY absent.

# 3. Dependencies
npm install

# 4. Offline regression check (mocks only, no Azure, no tokens)
npm test

# 5. Database — Neon. Run only if migrations are not already applied through 006.
npm run db:migrate
npm run db:status            # expect: up to date, exit code 0

# 6. Azure AI Search schema + vector width
npm run search:validate      # prints index dimensions vs EMBEDDING_DIM

# 7. ONE-TIME forced Azure embedding rebuild  ** consumes embedding tokens **
npm run search:reindex -- --force

# 8. Azure Blob Storage round trip
npm run storage:validate

# 9. Build and start
npm run build:web
npm start                    # serves http://localhost:4317 (from ENTRA_REDIRECT_URI)
```

Optional, after step 9, if any demo user is not yet linked to an Entra identity:
grant the three action permissions and link identities as described in
`docs/governed-actions.md` (`actions.it.create_request`,
`actions.approval.submit_request`, `actions.hr.create_onboarding_checklist`).

If `npm run search:validate` reports that the index does not exist, create it
first with `npm run search:index`, then run step 7 once.

---

## 3. Token / cost awareness

**No model usage**

- `npm install`
- `npm run typecheck`, `npm run build:web`, `npm run build`
- `npm test` (all providers mocked; no network)
- `npm run db:migrate`, `npm run db:status`
- `npm run storage:validate` (Blob only)
- `npm run search:validate`, `npm run search:status` (Search control plane only)
- `GET /api/health`, `GET /api/admin/metrics` (configuration-only, `liveProbe: false`)

**Model usage**

- `npm run search:reindex -- --force` — regenerates **every** chunk vector
  through the Foundry embedding deployment. **Run exactly once** before the
  demo. Re-running it pays for the same vectors again.
- Each question asked in the UI — one query embedding + one `nova-chat` completion.
- `npm run test:foundry`, if you choose to prove live Foundry connectivity.

`npm run search:index` (without `--force`) makes zero embedding calls: it reuses
vectors already stored in `document_chunks`. That is exactly why the forced run
is needed once — see the next section.

---

## 4. Embedding provenance (the real live-data risk)

`docs/azure-readiness-status.md` records that the live `nova-knowledge` index was
populated by incremental indexing, which reuses the vectors in
`document_chunks`. Those vectors were produced by the **local** hashed-lexical
model (`nova-hashed-lexical-v1`). With `AI_MODE=azure` the *query* vector comes
from Foundry `nova-embedding`. The two are not the same vector space, so hybrid
retrieval would silently degrade to its keyword half.

What is true in the repository today:

1. `EMBEDDING_DIM` is `384` (`.env.demo.example`, `backend/src/config/index.ts`).
2. The index vector field is created at `EMBEDDING_DIM`
   (`buildIndexDefinition` in `backend/src/retrieval/vector/azure-index.ts`), and
   `npm run search:validate` compares the live index dimension against it.
   **The actual live index dimension can only be confirmed by running that
   command on your machine.**
3. `AzureEmbeddingProvider` sends `dimensions: EMBEDDING_DIM` to the configured
   `AZURE_EMBEDDING_DEPLOYMENT` (`nova-embedding`) and verifies the response
   width, so `text-embedding-3-small` returns 384 rather than its default 1536.
   The embedding dimension is **not** changed for this demo.
4. `--force` bypasses the content-hash reuse path, re-embeds every chunk through
   Foundry, persists the new vector and `embedding_model` back to
   `document_chunks`, and re-uploads the document to Search.

So: run `npm run search:validate`, then `npm run search:reindex -- --force`
**once**. Do not repeat it.

---

## 5. Presentation sequence

1. Sign in with Microsoft Entra (single-tenant SPA, PKCE, no client secret).
2. Ask an enterprise knowledge question (e.g. an expense or leave policy question).
3. Point at the retrieval panel — Azure AI Search hybrid retrieval with the
   server-generated security filter.
4. Show the Microsoft Foundry answer (`nova-chat`).
5. Show the citations with document, version and section.
6. Open **Enterprise Actions**.
7. Show that reading permission and action permission are separate controls — a
   user who can read the policy still needs `actions.*` to act on it.
8. Select an action (e.g. IT request).
9. Show per-field validation rejecting bad input.
10. Show the review/confirmation step with the frozen payload.
11. Show the **SIMULATED ACTION** badge.
12. Confirm — re-authorization happens against Neon at this point.
13. Show the generated request ID and the "(SIMULATED — no external system of
    record was written.)" suffix.
14. Open **Admin → Activity**.
15. Show `Action Proposed`, `Action Confirmed`, `Action Executed` with actor,
    tenant, input and source attribution.

Narrative line: *"Knowledge access and action authorization are separate
controls. NOVA can use enterprise knowledge without automatically giving the
user permission to act on that knowledge."*

Terminology: **"Governed action executed in local/demo mode."** Never say an
Azure Function executed it.

---

## 6. What `ACTION_MODE=local` does and does not do

It changes the **final write only**. The full pipeline still runs:

Entra identity → Neon principal → tenant → role → department → action
permission → strict input validation → source-document access check → explicit
confirmation → **re-authorization from Neon** → tenant isolation →
`LocalMockExecutor` → `action_requests` audit row + `activity_logs` entry.

It does **not** switch Foundry, Azure AI Search, Azure Blob Storage, Entra or
PostgreSQL to local, and it does **not** make the app report itself as local:
`appMode` stays `azure`, `isFullyLocal` stays `false`, `/api/health` stays
**AZURE CONFIGURED** with `incompleteComponents: []`, and actions are reported
as `state: "local"` — intentionally local, not incomplete.

---

## 7. Honest status for this preparation stage

| Category | Status |
| --- | --- |
| CODE VERIFIED | **Yes** — provider factories, config guards, governed pipeline and executor selection read and supported by `tests/providerModes.test.ts` and `tests/actions.test.ts` |
| CONFIGURATION VERIFIED | **Yes** — `.env.demo.example` uses the repository's real variable names, placeholders only, no Function URL/key, no client secret |
| LOCAL TEST VERIFIED | **Where evidence exists** — the test files above encode the behaviour; no test run was executed from this preparation pass |
| AZURE INFRASTRUCTURE PROVISIONED | **Provisioned** per `docs/azure-readiness-status.md` (Foundry project + `nova-chat` + `nova-embedding`, `nova-search`/`nova-knowledge`, `novastorage2376`/`documents`, Neon, Entra app registration) |
| AZURE RUNTIME VERIFIED | **Not verified** — requires you to run `search:validate`, `search:reindex --force`, `storage:validate` and a live sign-in on your machine |
| GOVERNED ACTION EXECUTION | **Local/demo mode** (`executor: local_mock`, `simulated: true`) |
| AZURE FUNCTION | **Not used for this presentation** and not deployed |

No command in this runbook was executed as part of preparing it.

---

## 8. Remaining risks

1. **Index vector provenance** — until `search:reindex -- --force` completes with
   `AI_MODE=azure`, the Search index may hold hashed-lexical vectors and vector
   retrieval will underperform. Highest-priority pre-demo step.
2. **Live Azure runtime is unproven from this revision** — Foundry chat,
   Foundry embeddings, Blob round trip and browser sign-in have not been
   executed here.
3. **Entra user linking** — with `ENTRA_AUTO_PROVISION=false`, an unlinked
   identity is denied with 403. Link every demo user before the presentation.
4. **Port** — Entra mode binds the port from `ENTRA_REDIRECT_URI`
   (`http://localhost:4317`) and disables port fallback. If that port is busy,
   NOVA fails rather than moving; free the port instead of changing the URI.
5. **Action permissions** — the three `actions.*` grants must exist for the demo
   roles, or step 8 of the presentation shows a denial instead of a form.
6. **Frontend type-check** — `npm run typecheck:web` needs `@types/react`
   installed; the bundle still builds.
7. **Cost** — every demo question consumes Foundry tokens; the forced reindex is
   a one-time embedding cost.
