# Production blockers & verification status

This document is deliberately unflattering. It records what is **implemented**,
what is **tested**, what is **unverified**, and what is **planned**, using only
what can be read in this repository.

Rule applied throughout: the presence of an environment variable, a config key
or an adapter file is **not** evidence that a cloud resource exists or works.

---

## 0. Phase 8 (governed enterprise actions) - execution status

Phase 7 (proactive / streaming agent orchestration) was **deliberately skipped**;
Phase 8 was implemented on top of Phase 6 and does not depend on it.

Commands actually executed in this revision, with the toolchain available here
(Node 24, `tsx` + `typescript` present; the project's own `node_modules` was
**not** installed - `pg`, `@types/react` and `@azure/msal-browser` are absent):

| Command | Status | Note |
| --- | --- | --- |
| `npm test` (SQLite, default) | **PASS with 1 environment failure** | 219/220 pass. The single failure is `tests/postgres.test.ts`, which cannot import `pg` because the package is not installed here. It is an environment/setup failure, not a Phase 8 regression: the file is unchanged. |
| `tsx --test tests/actions.test.ts` | **PASS** | 40/40 governance tests. |
| `tsx --test tests/azureFunctionHandlers.test.ts` | **PASS** | 6/6 schema-drift + contract tests. |
| `azure-functions/nova-actions` `npm test` (run with the root `tsx`) | **PASS** | 15/15 Function-app unit tests. |
| `npm run typecheck` | **PASS apart from missing `pg`** | The only remaining diagnostics are `Cannot find module 'pg'` and the two implicit-`any` errors that follow from it (`backend/src/db/migrate.ts:39`, `backend/scripts/db-import-sqlite.ts:84`, `tests/postgres.test.ts:116`). Zero errors in any Phase 8 file. |
| `npm run build:web` | **PASS** | esbuild bundled the new `ActionPanel.tsx` and stylesheet: `app.js` 389.3 kb, `app.css` 219.7 kb. |
| `npm run build` | **PASS apart from the same missing `pg`** | `build` = `typecheck` + `build:web`; the typecheck diagnostics above are the only ones. |
| `npm run typecheck:web` | **FAIL - environment** | `@types/react` is not installed here, so every `.tsx` file reports `TS7016` / `TS7026`. Pre-existing and unrelated to Phase 8; the bundle builds. |
| `npm run lint` (`prettier --check`) | **FAIL - pre-existing** | No prettier config ships with the repository, so the defaults disagree with the codebase's tab indentation. `backend/src/api/server.ts` from the unmodified baseline fails the same check. Not introduced by Phase 8. |
| `npm run db:migrate` (Neon) | **NOT RUN** | No Neon credential available here. `migrations/006_governed_actions.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) and mirrored into `SQLITE_SCHEMA`. |
| `npm run eval` | **NOT RUN** | Unchanged by Phase 8 (no retrieval or prompt path was touched). |
| Live call to the NOVA Actions Function app | **NOT RUN** | The Function App is not provisioned. `ACTION_MODE=azure` without `AZURE_ACTION_FUNCTION_URL` refuses to start; the Azure executor's success, transport-failure, 4xx, 5xx and malformed-response paths are covered by injected-`fetch` tests. |

### Manual end-to-end verification (executed)

The server was started locally on SQLite with seeded demo data and the Phase 8
routes were exercised over HTTP:

| Check | Result |
| --- | --- |
| `GET /api/health` | `ok: true`, `LOCAL DEMO MODE`, `liveProbe: false` - still zero-token |
| `GET /api/actions` as admin | all three actions `authorized: true`, `executor: local_mock`, `simulated: true` |
| `GET /api/actions` as Employee | all three `authorized: false` |
| `POST /api/actions/propose` as Employee, no grant | **403** `forbidden`, naming the required permission |
| `POST /api/admin/action-permissions` as admin | grant written |
| `POST /api/actions/propose` as Employee, granted | **201** `awaiting_confirmation` + the confirmation sentence and `SIMULATED ACTION` warning |
| `POST /api/actions/:id/confirm` with `{}` | **409** `confirmation_required` |
| `POST /api/actions/:id/confirm` with `{"confirm":true}` | **200** `succeeded`, reference `ITR-2026-6CD5F08E`, `simulated: true` |
| Propose with a stray `tenantId` field and a short subject | **400** `invalid_input` with per-field `fields` for all five problems |
| `GET /api/actions/requests` | `scope: self`, 2 rows (`succeeded`, `failed`) |
| `GET /api/admin/metrics` | new `actions` block; still no remote provider call |

### Test counts after Phase 8

| Suite | Count | File |
| --- | --- | --- |
| Governed actions (Phase 8) | 40 | `tests/actions.test.ts` |
| Azure Function contract + schema drift | 6 | `tests/azureFunctionHandlers.test.ts` |
| Azure Function app unit tests (separate package) | 15 | `azure-functions/nova-actions/test/handlers.test.ts` |
| Auth / Entra (Phase 6) | 33 | `tests/auth.test.ts` |
| Search | 41 | `tests/search.test.ts` |
| Storage | 34 | `tests/storage.test.ts` |
| Config / readiness | 24 | `tests/config.test.ts` |
| Security | 14 | `tests/security.test.ts` |
| Health (zero-token) | 12 | `tests/health.test.ts` |
| Platform | 9 | `tests/platform.test.ts` |
| TLS | 6 | `tests/tls.test.ts` |
| PostgreSQL | 1 file (needs `pg` + `TEST_DATABASE_URL`) | `tests/postgres.test.ts` |
| **`npm test` total** | **220 (219 pass, 1 environment failure)** | |

### Phase 8 blockers

- **No Function App exists.** `ACTION_MODE=azure` cannot be used until one is
  provisioned and a key issued. This fails loudly at startup rather than
  simulating; see `azure-functions/nova-actions/README.md`.
- **No real system of record.** Both executors are self-contained. The Function
  app's HTTPS contract is the seam for a per-customer ServiceNow / Dynamics /
  SAP integration, which is not implemented.
- **No idempotency or retry.** A 2xx response without a reference leaves the
  outcome genuinely unknown, and NOVA reports that rather than guessing.
- **Approval chains are computed, not routed.** No approver inbox, no
  notifications, no state past `submitted`.
- **`migrations/006_governed_actions.sql` has not been applied to Neon** from
  this revision.

---

## 1. Test execution status for this revision

Phase 3 (SQLite -> Neon PostgreSQL) **was** executed, including against a real
Neon database. Results:

| Command | Status | Note |
| --- | --- | --- |
| `npm test` (SQLite, default) | **PASS** | 57/57. `tests/postgres.test.ts` database cases skip without `TEST_DATABASE_URL`. |
| `npm test` (`NOVA_TEST_DB=postgres`, real Neon) | **PASS** | 77/77. The entire behavioural suite plus the PostgreSQL-specific suite, against a throwaway migrated schema. |
| `npm run typecheck` | **PASS** | Clean. |
| `npm run build` | **PASS** | Runs `typecheck` + `build:web`. |
| `npm run db:migrate` | **PASS** | `001`, `002`, `003` applied to Neon; re-running skips all three. |
| `npm run db:status` | **PASS** | `database is up to date`. |
| `npm run db:import-sqlite` | **PASS (no data to move)** | The v10 baseline shipped no readable SQLite database (only an orphaned `-wal`/`-shm` pair with no recoverable tables), so there were **0 production rows to migrate**. The importer's conflict detection and validation are covered by tests instead. |
| `npm run eval` | **24/28** | Identical to the pre-migration v10 baseline, category for category. Not a regression; see below. |
| `npm run typecheck:web` | **FAIL (6 errors)** | Pre-existing. Identical errors before and after Phase 3; see below. |
| `npm test` (with Search credentials) | **PASS** | 67/67 in `tests/search.test.ts`, including 7 live authorization-equivalence cases against the real service. |
| `npm run search:validate` | **PASS** | `nova-knowledge`, 29 fields, vector dimension 384 = expected. |
| `npm run search:status` | **PASS** | Index reachable. |
| `npm run search:index` | **PASS** | Created the index; indexed 210 real chunks from 28 documents with 0 embedding calls. |
| `npm run test:foundry` | **NOT RUN** | No Foundry credential available here; no live call was made to `nova-chat` or `nova-embedding`. |

### `typecheck:web` — pre-existing, unrelated to Phase 3

6 errors, all in `frontend/src/pages/`: `Tenant.departments` is missing from the
shared type (`AdminPages.tsx:568`, `UploadPage.tsx:178`), a `MutableRefObject<HTMLElement>`
assigned to a `LegacyRef<HTMLDivElement>` (`AdminPages.tsx:454` and one other),
and an `Argument of type '0 | {...}[]'` at `AdminPages.tsx:72`. The same 6
errors are produced by the unmodified v10 baseline. Phase 3 touched no frontend
file, so these are carried forward, not introduced.

### `npm run eval` — 24/28, unchanged from baseline

The unmodified v10 baseline scores 24/28 with the same per-category breakdown
(unknown questions 0/2, hallucination 1/2, simple retrieval 4/5, everything
else full marks). These are local-LLM answer-quality gaps in the evaluation
harness, not database behaviour.

### Live check against Azure AI Search

The `nova-knowledge` index was created on `nova-search`, 210 chunks from 28 real
NOVA documents were indexed, and retrieval was exercised for all 7 seeded users
across 2 tenants: zero cross-tenant results, zero results above a caller's
clearance, and the inactive version never returned. A second indexing run
reported 210 unchanged chunks, 0 uploads and 0 embedding calls. A metadata-only
change produced 9 metadata merges and 0 embeddings; a chunk with no stored
vector produced exactly 1 embedding, persisted back to the database; a deleted
chunk was removed from the index.

### Live check against Neon

The server was started with a PostgreSQL `DATABASE_URL`, served `GET /api/health`
(zero-token, and confirmed to expose no database information at all) and
`GET /api/tenants`, and shut down cleanly through `closeDb()`.

### Test counts

| Suite | Count | File |
| --- | --- | --- |
| Security tests | 14 | `tests/security.test.ts` |
| Platform tests | 9 | `tests/platform.test.ts` |
| Config / Azure-readiness / database-selection tests | 19 | `tests/config.test.ts` |
| Health (zero-token) tests | 10 | `tests/health.test.ts` |
| PostgreSQL tests (5 always, 15 need `TEST_DATABASE_URL`) | 20 | `tests/postgres.test.ts` |
| **`npm test` total** | **57 offline / 77 with `TEST_DATABASE_URL`** | |
| Evaluation questions | 28 | `tests/eval/questions.json` |

Evaluation categories present in `questions.json`: simple retrieval (5),
semantic retrieval (4), multi-document reasoning (3), authorization (3),
prompt injection (3), unknown questions (2), hallucination (2), document
versioning (2), cross-tenant isolation (2), agentic actions (2). All 10
required categories are covered, so no questions were added or rewritten, and
no second evaluation file was created.

---

## 2. Azure readiness

Full breakdown in `azure-readiness-status.md`. Summary:

- **Coded adapters** exist for LLM, knowledge, embeddings, vector store, auth,
  actions and document storage.
- **Not implemented at all**: Application Insights, Managed Identity, Key
  Vault, and any App Service / Container Apps deployment definition.
- Document files follow `STORAGE_MODE`: the local filesystem in local/demo
  mode, Azure Blob Storage (`novastorage2376` / `documents`) in
  production/Azure mode (`backend/src/storage/`). Local/demo state uses SQLite,
  while production/Azure state uses Neon PostgreSQL (`backend/src/db/index.ts`).
- **No adapter has been exercised against a live Azure subscription.**

NOVA is Azure-pluggable, not Azure-deployed. The connection states
(`LOCAL DEMO MODE`, `AZURE CONFIGURED`, `AZURE CONFIGURED - INCOMPLETE`)
remain distinct and are computed locally in `backend/src/api/health.ts`:
`AZURE CONFIGURED` requires that every Azure-selected component has the real
Azure implementation loaded and all required settings present. A partial or
misconfigured Azure setup reads `- INCOMPLETE`.

The badge deliberately stops short of claiming connectivity. `/api/health` and
`/api/admin/metrics` make **no** model, embedding or Search request, so they
cost zero tokens and cannot assert that Foundry answered. Live connectivity is
evidenced by real application requests or by the manual `npm run test:foundry`
check.

---

## 3. Production blockers

### 3.1 Session strategy - RESOLVED for production mode (Phase 6)

Production/Azure mode (`AUTH_MODE=entra`) now authenticates with Microsoft
Entra ID: Authorization Code + PKCE in a public SPA client, MSAL-held tokens
in `sessionStorage`, and full server-side validation of signature, issuer,
audience, tenant, expiry and the `access_as_user` scope. The NOVA user,
tenant, role, department and clearance come from Neon, never from the token
or the request body. There is no client secret and no silent fallback to demo
authentication.

Local/demo mode still uses the labelled demo persona token in `localStorage`.
That is intentional: it is not production authentication and the UI says so.

Remaining (deliberately not implemented): NOVA stays a bearer-token SPA rather
than moving to `HttpOnly; Secure; SameSite` cookie sessions. Bearer tokens are
not attached automatically by the browser, so classic CSRF does not apply, and
introducing a cookie layer alongside MSAL would create a half-SPA/half-cookie
architecture with two credential paths. Residual risk: an XSS able to run in
the page can ask MSAL for a token, the same exposure any SPA has. Hardening
the CSP further (3.2) is the useful next step.

### 3.2 Content Security Policy - PARTIAL

The policy in `backend/src/api/security.ts` still contains:

- `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`
- `font-src 'self' https://fonts.gstatic.com data:`

What genuinely requires them today:

- **Inline styles**: components set dynamic `style={{...}}` values (animation
  delays, `--fill` meters, column ratios), which React emits as inline style
  attributes.
- **External fonts**: `frontend/index.html` loads Archivo Black, Anton, Inter,
  IBM Plex Mono, Instrument Serif and Caveat from Google Fonts.
- Hero imagery and the frame sequence are same-origin and need no exception.

A nonce-based CSP that removes `'unsafe-inline'` requires a server-rendered
document so a per-response nonce can be injected. This project serves a static
`index.html`, so there is nowhere to mint one. Remaining hardening item:
either self-host the fonts (removes both Google Fonts exceptions) or introduce
server-side rendering of the shell (enables nonces). Neither was attempted
here, because guessing would break font loading or the application itself.

### 3.3 Rate limiting - SCALING LIMITATION, NOT A DEFECT

The limiter is in-process (`backend/src/api/security.ts`).

- Single backend instance: **supported**.
- Multiple backend instances: **requires distributed rate limiting**, because
  each process would otherwise enforce its own independent budget.

No Redis or other distributed dependency was introduced. That is deliberate
for a system that currently runs as a single process.

### 3.4 Durability - partially resolved

Relational state is no longer a blocker: production/Azure mode runs on Neon
PostgreSQL with versioned migrations, so managed backup and point-in-time
restore are available for every table.

Still outstanding:

- **Free Search tier limits.** `nova-search` is on the Free tier: 3 indexes,
  50 MB total storage, no SLA and no semantic ranker. Adequate for the current
  corpus and for a demo, but a paid tier is required before production volume.
- **Uploaded document bytes** are durable in production/Azure mode
  (`STORAGE_MODE=azure_blob` → Azure Blob Storage). With `STORAGE_MODE=local`
  they remain on the machine's filesystem, which does not survive a container
  restart and does not scale horizontally; the server logs a warning when
  Azure providers are enabled alongside local storage. The Azure Blob path has
  not yet been exercised against the live account from this revision
  (`npm run storage:validate` closes that gap).
- **Concurrency.** The repository layer is synchronous, so PostgreSQL access
  runs through a worker thread with `Atomics.wait`. Behaviour is identical and
  the API is unchanged, but queries serialize and each round trip blocks the
  event loop. Fine at NOVA's current single-process request volume; converting
  the repositories to async is the right follow-up before high-concurrency
  production traffic.

---

## 4. Preserved authorization order

Unchanged, and intended to stay that way:

```
identity -> authorization -> retrieval -> LLM
```

Restricted content is excluded from the candidate set before generation. The
model is never asked to keep a secret it has already been shown.
