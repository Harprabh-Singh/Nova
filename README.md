# NOVA — Enterprise Knowledge Intelligence Platform

> Your company's knowledge. One intelligent interface.

NOVA is a reusable, multi-tenant enterprise knowledge platform. A company brings its own
documents, users, roles and permissions; NOVA provides ingestion, permission-aware retrieval,
grounded answers with citations, and agentic workflows.

The repository ships with a demo tenant (**NovaTech Manufacturing**) and a second tenant
(**Acme Logistics**) that exists purely to prove tenant isolation. Nothing about either company
is hard-coded in business logic — company name, departments, roles, classifications and documents
all come from tenant data.

**Everything runs locally.** No Azure, no Microsoft Foundry, no Azure AI Search, no Entra ID,
no paid API is required or contacted. Azure adapters exist behind interfaces and are disabled.

---

## 1. Quick start (LOCAL_MODE)

```bash
cp .env.example .env       # optional: defaults already run fully locally
npm run seed-demo          # creates tenants, users, roles, documents, vector index
./start-dev                # builds the frontend and starts the server on :4317
```

Open **http://localhost:4317** and click **Enter Demo**.

NOVA serves the API and the frontend from one process over plain HTTP on
loopback — browsers already treat `localhost` as a secure context. Deployments
terminate TLS in front of NOVA; set `HTTPS_ENABLED=true` with `TLS_CERT_FILE`
and `TLS_KEY_FILE` if NOVA should terminate it itself.

Other commands:

| Command | Purpose |
| --- | --- |
| `npm run seed-demo` | Seed/refresh demo data. Safe to rerun (checksum-based, idempotent). |
| `npm run reset-demo` | Delete local database + storage, then reseed from scratch. |
| `npm run storage:status` | Show the active document-storage provider (no remote call). |
| `npm run storage:init` | Create the private Azure Blob container if it does not exist. |
| `npm run storage:validate` | Real Blob round trip: connect, write, read, delete, clean up. |
| `npm test` | Unit + security test suite (23 tests: 14 security + 9 platform). |
| `npm run eval` | 28-question evaluation harness across 10 categories. |
| `npm run typecheck` | Type-checks backend, scripts and tests. |
| `npm run build` | Typecheck + frontend bundle. |
| `npm run lint` / `npm run format` | Prettier check / write. |

Node 22.5+ is required (`node:sqlite` is used as the local database driver — no native deps).

---

## 2. Authentication

Two providers, chosen only by `AUTH_MODE` — nothing is auto-detected:

| `AUTH_MODE` | Provider | Behaviour |
| --- | --- | --- |
| `demo` (default) | `DemoAuthProvider` | Local **DEMO PERSONA** selector, clearly labelled as non-production. No passwords exist. |
| `entra` | `EntraAuthProvider` | Microsoft Entra ID sign-in (Authorization Code + PKCE, single tenant, **no client secret**). |

In Entra mode the split is strict:

```
Microsoft Entra ID -> who the human is
Neon PostgreSQL    -> which NOVA user, tenant, role, department, clearance, documents
```

The backend validates the access token in full (signature against the cached JWKS, issuer,
audience `api://<clientId>`, tenant, expiry, `access_as_user` scope) and then maps the stable
Entra object id to `users.entra_object_id`. An unlinked identity gets **403**, never a default
workspace; a token can never set a tenant, role, department or clearance. There is no fallback
to demo authentication. See `docs/azure-integration.md` and `docs/security.md`.

### Demo personas

| Persona | Email | Role | Sees |
| --- | --- | --- | --- |
| Alex Mendes | `alex@novatech.example` | EMPLOYEE (Manufacturing Operations) | Public + internal only |
| Sarah Iyer | `sarah@novatech.example` | ENGINEERING_MANAGER | + Engineering confidential |
| David Rao | `david@novatech.example` | FINANCE_MANAGER | + Finance/Procurement confidential |
| Priya Nair | `priya@novatech.example` | HR_MANAGER | + Human Resources confidential |
| Admin User | `admin@novatech.example` | ADMIN | Everything in the tenant, admin portal |

Second tenant (isolation proof): `meera@acme.example`, `admin@acme.example`.

---

## 3. Five-minute demo flow

1. **Grounded retrieval** — as Alex: *"What is our machine failure procedure?"* → grounded answer citing
   Machine Failure SOP v2026.2 with sections.
2. **Multi-document reasoning** — *"Can I approve an ₹80,000 equipment purchase?"* → combines Procurement
   Policy and Approval Matrix.
3. **Authorization** — as Alex: *"Show me the engineering salary structure."* → `ACCESS DENIED`,
   no document name, no content. Switch to Priya → authorized answer.
4. **Live ingestion** — Admin → Knowledge → Upload a new policy → ask a question that was previously
   unanswerable → the answer now cites the new document. No code changes.
5. **Agentic action** — *"Machine M-204 has malfunctioned. Help me report it."* → the agent explains the SOP,
   collects `machine_id`, `description`, `severity`, `location`, `observed_at`, `reporter`, asks for what is
   missing, and creates `INC-2026-0001` labelled **SIMULATED ACTION**.
6. **Future path** — the same interfaces map to Microsoft Foundry, Foundry IQ, Azure AI Search and Entra ID
   (see `docs/azure-integration.md`). Azure remains off.

---

## 4. Layout

```
backend/src/
  api/            HTTP router + server wiring
  agents/         query understanding, prompt, knowledge agent, incident agent
  knowledge/      KnowledgeProvider: base / local / azure_foundry_iq
  retrieval/      vector store (base/local/azure) + re-ranking
  llm/            LLMProvider: base / local / azure_foundry
  embeddings/     EmbeddingProvider: base / local / azure
  auth/           AuthProvider: base / demo / entra
  authorization/  access scope + document access + ACTION policy (pre-retrieval)
  actions/        legacy incident provider + governed/ (Phase 8 registry, executors, service)
  tenants/ documents/ citations/ conversations/ observability/ models/ config/ db/
azure-functions/
  nova-actions/   standalone TypeScript Azure Functions app that executes governed actions
frontend/src/     components/ pages/ hooks/ services/ providers/ types/ utils/
knowledge/        seed corpora: novatech/<dept>/, acme/
tests/            security + platform tests, eval question set
docs/             architecture, local-development, onboarding, ingestion, security, evaluation, azure, deployment
```

See `docs/architecture.md` for diagrams, `docs/governed-actions.md` for Phase 8 enterprise actions, and
`docs/local-development.md` for day-to-day workflow.

### Demo configuration: Azure knowledge stack, local action executor

`.env.demo.example` is a placeholders-only template for the presentation setup: Entra + Neon +
Foundry + Azure AI Search + Azure Blob Storage, with `ACTION_MODE=local` so only the governed
action executor is simulated. Each provider is selected from its own variable, so `ACTION_MODE`
affects nothing else — pinned by `tests/providerModes.test.ts` and documented in
`docs/governed-actions.md` §12a. The NOVA Actions Azure Function app is not required for it.
`docs/demo-runbook.md` is the Windows/PowerShell runbook for the presentation: command sequence,
which command consumes embedding usage, the presentation flow and the honest status table.

One-command setup on Windows:

```powershell
.\scripts\demo-setup.ps1 -Start
```

`scripts/demo-setup.ps1` validates the toolchain, creates `.env` from `.env.demo.example` when it is
missing (never overwriting an existing one), checks the mode values and the presence — never the
values — of the required settings, installs dependencies only when the lockfile is newer, runs
`db:migrate`/`db:status`, `search:validate`, the **one-time** `search:reindex -- --force` guarded by the
marker file `.demo-azure-search-reindexed`, `storage:validate`, `build:web`, then starts NOVA and reads
`/api/health`. It stops on the first failure rather than continuing into a misleading demo. See
`docs/demo-quickstart.md` for the presentation checklist.

---

## 5. Known limitations

- No local model server is bundled. With `LOCAL_LLM_BASE_URL` empty, answers come from a deterministic
  extractive composer labelled `FALLBACK` in the UI. Point `LOCAL_LLM_BASE_URL` at any OpenAI-compatible
  endpoint (Ollama, LM Studio, vLLM) for fluent answers; retrieval, authorization and citations are unchanged.
- Local embeddings are a deterministic hashed-lexical vector (`nova-hashed-lexical-v1`), not a neural model.
  Swap via `LOCAL_EMBEDDING_BASE_URL` / `LOCAL_EMBEDDING_MODEL`.
- Evaluation currently passes 24/28; the open failures are answer-phrasing and "no data exists" cases that
  need a real model (see `docs/evaluation.md`).
- Azure adapters are implemented against documented REST APIs but are unverified against a live subscription.
- Microsoft Entra sign-in needs `@azure/msal-browser` (`npm install`). Without it the frontend still
  builds for `AUTH_MODE=demo` and Entra sign-in fails loudly rather than degrading.
- Frontend type-checking requires `@types/react`, which is not installed in this offline environment
  (`npm run typecheck:web` covers it once installed). The frontend bundle builds and runs.
- Governed enterprise actions (Phase 8) run against a local mock by default; every result is labelled
  **SIMULATED ACTION**. `ACTION_MODE=azure` calls the `azure-functions/nova-actions` app, whose three
  actions compute a reference, an approval chain or a task list but do not yet write to a real
  ServiceNow/Dynamics/SAP instance. See `docs/governed-actions.md`.
- **Phase 7 (proactive / streaming agent orchestration) is deferred.** Actions are proposed and
  confirmed by explicit human requests; no agent triggers one.

## Database modes

Local/demo mode uses SQLite. Production/Azure mode uses Neon PostgreSQL through the deployment-only `DATABASE_URL` environment variable, with no SQLite fallback: Azure mode refuses to start without a PostgreSQL URL, and the server exits rather than degrade if Neon is unreachable or a migration is missing.

Run `npm run db:migrate` before starting against a new Neon database; `npm run db:status` reports applied migrations and exits non-zero when any are pending. Migration `003` adds the two SQLite compatibility shims (`json_each(TEXT)` and `messages.rowid`) that let both engines run identical query strings, so the authorization SQL is never forked per dialect.

To run the whole test suite against real PostgreSQL:

```bash
NOVA_TEST_DB=postgres TEST_DATABASE_URL='<direct-neon-url>' npm test
```

Use the **direct (unpooled)** Neon URL there; the pooler rejects the `search_path` startup option the per-run test schema needs. See `docs/local-development.md` and `docs/deployment.md` for details.

No credential belongs in source control, documentation, frontend code, logs, or API responses.

### Retrieval (Phase 4)

Local/demo mode retrieves from the SQLite vector store. Production/Azure mode
(`VECTOR_STORE=azure_search`) retrieves from **Azure AI Search** — one index,
`nova-knowledge`, holding every tenant's chunks with security metadata.

Azure AI Search is the retrieval layer only; Foundry `nova-chat` still writes
the answer. Authorization is enforced *before* the model sees anything: the
server-resolved access scope is compiled into a single OData filter that Azure
applies to the lexical and vector sides of the hybrid query alike. A caller
cannot supply a tenant id or a filter, and there is no fallback to local
retrieval if Search fails.

```bash
npm run search:validate   # compare the live index with the expected schema
npm run search:status     # index existence and document count
npm run search:index      # create if absent, then incremental upsert
npm run search:reindex -- --force   # deliberate full vector rebuild
```

Chunk embeddings are generated once at ingestion and reused, so a normal
indexing run makes zero embedding calls, and `/api/health` remains zero-token
with no Search probe. `AZURE_SEARCH_ADMIN_KEY` is a secret supplied through the
environment only. Full detail in `docs/azure-integration.md`.

### Document storage (Phase 5)

Document **files** follow `STORAGE_MODE`, independently of the retrieval index:

| Mode | Files live in |
| --- | --- |
| `STORAGE_MODE=local` (default) | local filesystem under `STORAGE_DIR` |
| `STORAGE_MODE=azure_blob` | **Azure Blob Storage** — account `novastorage2376`, private container `documents` |

Everything goes through one `StorageProvider` abstraction
(`backend/src/storage/`), so the application never knows where a file
physically is. Object keys are generated server-side and are deterministic:

```
tenant/<tenantId>/document/<documentId>/version/<versionId>/original.<ext>
```

Clients never see or supply a path, container or object key. Downloads go
through `GET /api/knowledge/:id/versions/:versionId/file`, which resolves the
document in Neon, applies the same tenant/ACL/classification decision as
retrieval, and only then streams the blob. The container stays private: no SAS
URL, no public URL, no container listing.

Neon keeps the metadata (ownership, permissions, classification, lifecycle,
storage reference, audit), Blob keeps the bytes, Azure AI Search keeps the
derived chunks and vectors. A blob upload failure never marks a document ready;
a Search failure never deletes the source file; deactivating a version never
deletes its object.

```bash
npm run storage:status     # configuration summary, no remote call
npm run storage:init       # create the private container if it is missing
npm run storage:validate   # connect + write + read + delete round trip
```

`AZURE_STORAGE_CONNECTION_STRING` is a secret supplied through the environment
only, and Azure storage is never auto-detected: if `STORAGE_MODE=azure_blob` is
set without complete configuration, NOVA fails at startup rather than writing
production files to local disk. Full detail in `docs/azure-integration.md`.
// hist: 2026-09-20T18:52:11+05:30
