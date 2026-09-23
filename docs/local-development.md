# Local development

NOVA runs fully locally. No Azure credential, Foundry project, Entra tenant or paid API is used.

## Requirements

- Node.js 22.5 or newer (`node:sqlite` ships with it; there is no native build step)
- No network access is required after checkout

## First run

```bash
cp .env.example .env     # optional, defaults are already local
npm run seed-demo
./start-dev              # equivalent to: npm run build:web && npm start
```

The server listens on `http://localhost:4317` and serves both the API and the built frontend.

### Transport

Local development is plain HTTP on loopback, deliberately: browsers already treat
`localhost` as a secure context (cookies, crypto and service workers all behave), so TLS
would only add certificate warnings to `npm run dev`.

TLS is expected to be terminated in front of NOVA in a real deployment. If NOVA must
terminate it itself, set `HTTPS_ENABLED=true` and point `TLS_CERT_FILE` / `TLS_KEY_FILE` at
a real certificate and key — NOVA never invents one, and an unreadable certificate stops
startup rather than quietly serving HTTP. HSTS is never sent by the local server, since
pinning `localhost` to HTTPS would affect every other project on that hostname.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Build frontend, start the API server |
| `npm run watch:web` | Rebuild the frontend bundle on change |
| `npm run seed-demo` | Idempotent seed of tenants, roles, users, documents and the vector index |
| `npm run reset-demo` | Remove `data/nova.db` and `data/storage/`, then reseed |
| `npm test` | Platform + security tests |
| `npm run eval` | Evaluation harness (28 questions, 10 categories) |
| `npm run typecheck` | Backend/scripts/tests type check |
| `npm run typecheck:web` | Frontend type check (needs `@types/react` installed) |
| `npm run build` | Typecheck + bundle |
| `npm run lint` / `npm run format` | Prettier |

## Configuration

All switches live in `.env` (see `.env.example`). The defaults are:

```
AI_MODE=local
KNOWLEDGE_MODE=local
AUTH_MODE=demo
ACTION_MODE=local
VECTOR_STORE=local
```

Nothing auto-detects Azure. If Azure variables are present but the modes are `local`,
no Azure call is ever made and the UI keeps showing **LOCAL DEMO MODE**. That includes
Microsoft Entra: `ENTRA_*` variables in `.env` do **not** enable Microsoft sign-in, and local
development never requires a Microsoft account. Only `AUTH_MODE=entra` switches the provider,
and it then requires complete Entra configuration (it never falls back to demo auth).

`@azure/msal-browser` is only needed for `AUTH_MODE=entra`. If it is not installed, the
frontend build still succeeds and prints a warning; Microsoft sign-in then fails loudly
instead of degrading to a weaker path. Run `npm install` to enable it.

There is no `APP_MODE` variable: the overall mode is derived from the provider modes.
Setting `APP_MODE` to something that disagrees with the derived mode fails at startup.

## Using a real local model (optional)

With `LOCAL_LLM_BASE_URL` empty, the `LocalLLMProvider` uses a deterministic extractive composer and
the UI labels the answer as a fallback. To use a real model, point the provider at any
OpenAI-compatible server:

```
LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1     # Ollama, LM Studio, vLLM, llama.cpp server...
LOCAL_LLM_MODEL=qwen2.5:7b-instruct
LOCAL_LLM_API_KEY=
```

Embeddings work the same way: leave `LOCAL_EMBEDDING_BASE_URL` empty for the built-in deterministic
hashed-lexical embedding, or point it at an embedding endpoint and set `LOCAL_EMBEDDING_MODEL` and
`EMBEDDING_DIM`. Re-run `npm run reset-demo` after changing the embedding model so the index is rebuilt.

## Local data locations

| Path | Contents |
| --- | --- |
| `data/nova.db` | SQLite database (all tables) |
| `data/storage/tenant/<tenantId>/document/<documentId>/version/<versionId>/` | Original uploaded files (local storage provider) |
| `knowledge/` | Seed corpora used by `seed-demo` |

Both `data/` and `.env` are git-ignored.

## Document storage in local mode

`STORAGE_MODE=local` (the default) keeps document files on disk under
`STORAGE_DIR`, using the same object-key layout as Azure Blob Storage:

```
tenant/<tenantId>/document/<documentId>/version/<versionId>/original.<ext>
```

Switching to Azure changes where the bytes live and nothing else. Blob Storage
is never required for local development, and a connection string is never
auto-detected: `STORAGE_MODE=azure_blob` has to be set by a human, and it fails
loudly if `AZURE_STORAGE_CONNECTION_STRING` or `AZURE_STORAGE_CONTAINER` is
missing rather than quietly writing to disk.

`npm run storage:status` prints the active provider and its location;
`npm run reset-demo` refuses to run unless storage is local, so it can never
delete objects from Azure.

## Troubleshooting

- **`Knowledge base ready.` but no answers** — run `npm run seed-demo`; check `/admin` shows a
  non-zero indexed chunk count. (`/api/health` reports configuration only: it is local-only and
  makes no model, embedding or Search call, so it costs zero tokens and never proves connectivity.)
- **Port in use** — set `PORT` in `.env`.
- **Answers look like bullet extracts** — that is the no-model fallback; configure `LOCAL_LLM_BASE_URL`.
- **Changed seed documents** — `npm run reset-demo` to rebuild cleanly.

> Verification note: the revision that introduced the hidden/reveal console
> rail could not execute these commands (no npm registry network access for
> `npm ci`). See `production-blockers.md` for per-command PASS / FAIL /
> NOT RUN status.

## Database modes

- **LOCAL/DEMO**: `DATABASE_URL=file:./data/nova.db` and the existing SQLite path remain the default.
- **PRODUCTION/AZURE**: set the deployment-only `DATABASE_URL` to a Neon PostgreSQL connection string. Azure mode fails at startup if it is missing or is not PostgreSQL; it never falls back to SQLite.

Initialize a new Neon database with:

```bash
npm run db:migrate
npm run db:status
```

If a real SQLite file needs importing, run `SQLITE_SOURCE=./data/nova.db npm run db:import-sqlite`. The importer preserves IDs and fails the transaction on conflicts or errors; add `-- --validate-only` to compare an already-imported database without writing anything. Connection strings are supplied only through the environment and are never stored in this repository.

### Migrations

| File | Purpose |
| --- | --- |
| `001_initial_schema.sql` | Every table from the SQLite schema, same names, same columns, same ids (`TEXT` primary keys), `BYTEA` embeddings. |
| `002_indexes.sql` | The indexes and unique constraints the SQLite schema declares. |
| `003_sqlite_query_compat.sql` | The two SQLite behaviours the shared SQL depends on: a `json_each(TEXT)` overload with SQLite's array semantics (used by the document ACL predicate in `backend/src/authorization/policy.ts`) and a `messages.rowid` identity column plus index (the insertion-order tie-breaker used by `conversations/service.ts`). |

Migration 003 is what lets local/demo and production run the *same* query strings: no
dialect branching in the repository layer, so the authorization predicate that is tested
on SQLite is byte-for-byte the predicate that runs on Neon.

`npm run db:migrate` takes an advisory lock, applies each pending file in its own
transaction, and records a SHA-256 checksum. Re-running skips applied files; editing an
applied file is reported as an error rather than silently re-run. `npm run db:status`
exits non-zero when anything is pending or modified, so it works as a deploy gate.

### Running the test suite against PostgreSQL

```bash
NOVA_TEST_DB=postgres TEST_DATABASE_URL='<direct-neon-url>' npm test
```

This runs the entire behavioural suite (not just the PostgreSQL tests) against a throwaway
`nova_test_<random>` schema, which is migrated on entry and dropped on exit.

`TEST_DATABASE_URL` must be the **direct (unpooled)** Neon URL — the host *without* the
`-pooler` suffix. The pooler rejects the `options=-c search_path=...` startup parameter
that schema isolation relies on. Without `TEST_DATABASE_URL`, `tests/postgres.test.ts`
skips and `npm test` stays fully offline on SQLite.

### Tuning and known limits

- `DATABASE_QUERY_TIMEOUT_MS` (default `30000`) bounds every PostgreSQL round trip. On
  timeout the worker is terminated rather than left hanging.
- The repository layer is synchronous (it was written against `node:sqlite`). PostgreSQL
  access therefore goes through a worker thread with `Atomics.wait`, which keeps the exact
  same synchronous call signatures but means **queries serialize and each round trip blocks
  the event loop**. That is acceptable for NOVA's request volume and was the smallest
  change that preserved behaviour, but converting the repositories to async is the right
  follow-up before high-concurrency production traffic.


## Retrieval modes (Phase 4)

Local/demo development needs no Azure AI Search. `VECTOR_STORE` defaults to
`local`, and the SQLite vector store (BM25 + cosine) serves retrieval exactly as
before. Nothing in local mode contacts Azure.

To work against Azure AI Search locally:

```bash
VECTOR_STORE=azure_search \
AZURE_SEARCH_ENDPOINT=https://<service>.search.windows.net \
AZURE_SEARCH_ADMIN_KEY=<from your own environment, never committed> \
npm run search:validate
```

`AZURE_SEARCH_INDEX` defaults to `nova-knowledge`. Selecting `azure_search`
without an endpoint and admin key is a startup configuration error, and because
`azure_search` is an Azure mode it also requires a PostgreSQL `DATABASE_URL`.

Running the Search tests:

```bash
npm test                                    # offline Search tests only
AZURE_SEARCH_ENDPOINT=... AZURE_SEARCH_ADMIN_KEY=... npm test
```

With credentials present, `tests/search.test.ts` creates a throwaway
`nova-test-<random>` index, verifies the authorization filter against Azure's
own OData engine, and deletes the index afterwards. Those tests use the
deterministic **local** embedding provider, so they cost no Azure model tokens.

---

## Governed enterprise actions (Phase 8)

Nothing to configure: `ACTION_MODE` defaults to `local`, so the three
registered actions run against NOVA's own mock executor and every result is
labelled **SIMULATED ACTION**.

```bash
npm run seed-demo
npm run dev
```

Then, signed in as the Admin persona, grant a capability and try it as an
employee:

```bash
curl -X POST http://localhost:4317/api/admin/action-permissions \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"roleKey":"EMPLOYEE","actionPermission":"actions.it.create_request","granted":true}'
```

Open the assistant and use **Enterprise actions** beside the composer. The
full step-by-step demo (including revoking a grant mid-proposal to show
re-authorization) is in `docs/governed-actions.md` §12.

### Tests

```bash
npx tsx --test tests/actions.test.ts                   # 40 governance tests
npx tsx --test tests/azureFunctionHandlers.test.ts     # Function contract + schema drift
cd azure-functions/nova-actions && npm install && npm test
```

### Pointing at a local Function host

```bash
cd azure-functions/nova-actions && npm install && npm start   # needs Core Tools v4
# in another shell:
ACTION_MODE=azure AZURE_ACTION_FUNCTION_URL=http://localhost:7071 npm run dev
```

`ACTION_MODE=azure` with no URL is a startup error, by design.
