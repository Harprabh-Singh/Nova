# NOVA Phase 8 — demo quickstart

## 1. One command

```powershell
.\scripts\demo-setup.ps1 -Start
```

First run only: if `.env` does not exist the script creates it from
`.env.demo.example`, tells you to fill the secret placeholders, and exits with
code 2 without touching Azure. Fill `.env` in an editor on your machine
(`notepad .env`), then run the same command again.

Useful switches:

| Command | Effect |
| --- | --- |
| `.\scripts\demo-setup.ps1` | Prepare and validate everything, do **not** start NOVA |
| `.\scripts\demo-setup.ps1 -Start` | Full setup, then `npm start` + a configuration-only health check |
| `.\scripts\demo-setup.ps1 -Start -SkipReindex` | Never touch embeddings in this run |
| `.\scripts\demo-setup.ps1 -Start -SkipTests` | Skip the offline typecheck/test pass |
| `.\scripts\demo-setup.ps1 -ForceReindex` | Deliberately re-run the forced reindex (**costs embedding usage again**) |

The script stops on the first failure. It creates no Azure resource, deploys no
Function, deletes nothing, never rewrites an existing `.env`, and never prints a
secret value.

## 2. Final `.env` mode values

```
AI_MODE=azure
KNOWLEDGE_MODE=azure
AUTH_MODE=entra
VECTOR_STORE=azure_search
STORAGE_MODE=azure_blob
ACTION_MODE=local
EMBEDDING_DIM=384
# APP_MODE is NOT set - NOVA derives it
# AZURE_ACTION_FUNCTION_URL / _KEY are NOT set - the Function app is unused
# ENTRA_CLIENT_SECRET / AZURE_CLIENT_SECRET are NOT set - public client, PKCE
```

Public (non-secret) settings the script requires: `FOUNDRY_ENDPOINT`,
`FOUNDRY_MODEL_DEPLOYMENT`, `AZURE_EMBEDDING_DEPLOYMENT`,
`AZURE_SEARCH_ENDPOINT`, `AZURE_SEARCH_INDEX`, `AZURE_STORAGE_CONTAINER`,
`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_API_ID_URI`, `ENTRA_API_SCOPE`,
`ENTRA_AUTHORITY`, `ENTRA_REDIRECT_URI`.

Secrets (fill in `.env` only — never in a chat, a commit or a screenshot):
`DATABASE_URL`, `AZURE_API_KEY` (or `AZURE_ACCESS_TOKEN`),
`AZURE_SEARCH_ADMIN_KEY`, `AZURE_STORAGE_CONNECTION_STRING`.

## 3. What is Azure-backed

| Component | Backed by |
| --- | --- |
| Authentication | Microsoft Entra ID (single-tenant SPA, PKCE, no secret) |
| Application database | Neon PostgreSQL (no SQLite fallback) |
| Chat | Microsoft Foundry `nova-chat` |
| Embeddings | Microsoft Foundry `nova-embedding` |
| Retrieval | Azure AI Search index `nova-knowledge` |
| Document files | Azure Blob Storage container `documents` |

## 4. What is local

Only the **governed-action executor**: `LocalMockExecutor`, reported by the API
as `"executor": "local_mock"`, `"simulated": true`.

Everything before the write still runs for real: Entra identity → Neon
user/tenant → role/department/permissions → action authorization → strict field
validation → source-document access check → explicit confirmation →
re-authorization from Neon → tenant isolation → `LocalMockExecutor` →
`action_requests` audit row + `activity_logs` entry.

The NOVA Actions Azure Function app is **not deployed and not called**.

## 5. Which command consumes embedding usage

Exactly one setup command:

```powershell
npm run search:reindex -- --force
```

The script runs it **at most once**, guarded by the marker file
`.demo-azure-search-reindexed`:

- marker present → skipped, zero embedding usage
- marker absent → prints *"Azure embedding reindex will consume embedding-model
  usage and is intended to run once."*, runs `search:validate` first, then the
  forced reindex, and creates the marker **only** after it exits successfully
- reindex fails → **no marker**, so the next run retries it

At demo time, each question also consumes usage: one query embedding plus one
`nova-chat` completion.

## 6. Which commands consume no model usage

`npm install`, `npm run typecheck`, `npm run build:web`, `npm test` (fully
mocked, offline), `npm run db:migrate`, `npm run db:status`,
`npm run storage:validate`, `npm run search:validate`, `npm run search:status`,
`GET /api/health`, `GET /api/admin/metrics`.

`npm run search:index` without `--force` also makes zero embedding calls — it
reuses the vectors already stored in `document_chunks`, which is precisely why
the one-time forced run is needed.

## 7. Health expectations

`GET /api/health` (the script calls it automatically after `-Start`):

```
appMode              azure
isFullyLocal         false
liveProbe            false
modeBadge            AZURE CONFIGURED
azureReadiness.components.actions.state     local
azureReadiness.incompleteComponents         []
```

`/api/health` and `/api/admin/metrics` are configuration-only: no Foundry,
embedding, Search, Blob or Function call. No probe was added.

## 8. Demo question

Ask a question that the tenant's indexed corpus actually answers, so the
citations are real. Grounded examples from the seed corpus
(`knowledge/novatech/…`):

- "What is the procedure when a production machine fails?" (`manufacturing/machine_failure_sop.md`)
- "How do I report a security incident?" (`security/security_incident_response.md`)
- "What are the expense approval limits?" (`finance/approval_matrix.md`)

⚠ The scripted question *"What is the current IT support procedure for a failed
laptop?"* has **no matching document** in the seed corpus — there is no IT
support/laptop policy under `knowledge/`. If you want to ask it on stage, upload
an IT support policy document for the tenant first (Knowledge → Upload, which
stores the file in Azure Blob and indexes it in Azure AI Search), or use one of
the grounded questions above. NOVA will otherwise correctly answer that it has
no supporting document, which is honest but not the story you want to tell.

## 9. Governed-action demonstration

Action: **Create IT support request** (`create_it_request`), permission
`actions.it.create_request`, reference format `ITR-<year>-<id>`.

Required fields: `subject` (6–160 chars), `description` (20–4000 chars),
`category` (hardware | software | access | network | other), `urgency`
(low | normal | high | critical); optional `assetTag`.

Pre-demo: grant the demo role its action permissions and link the Entra
identities to NOVA users (`ENTRA_AUTO_PROVISION=false` means an unlinked
identity gets a 403). See `docs/governed-actions.md`.

## 10. Wording for simulated execution

Say:

> **"Governed action executed in local/demo mode."**

Never say:

> ~~"Azure Function executed this action."~~

The UI badge reads **SIMULATED ACTION**, the API returns `"simulated": true`,
and the result summary is suffixed *"(SIMULATED — no external system of record
was written.)"*.

## 11. Presentation sequence

1. Sign in with Microsoft Entra.
2. Ask the knowledge question (see §8).
3. Show the Azure AI Search-backed retrieval panel.
4. Show the Microsoft Foundry answer.
5. Show the citation (document, version, section).
6. Ask: *"Create an IT support request for me."*
7. Show that the action needs `actions.it.create_request` — separate from
   reading permission.
8. Fill the fields; show per-field validation, then the review/confirmation step.
9. Show the **SIMULATED ACTION** badge.
10. Confirm — re-authorization against Neon happens here.
11. Show the generated `ITR-…` reference and the simulated-result wording.
12. Open **Admin → Activity**.
13. Show `Action Proposed`, `Action Confirmed`, `Action Executed`.

Narrative: *"Knowledge access and action authorization are separate controls.
NOVA can use enterprise knowledge without automatically giving the user
permission to act on that knowledge."*

## 12. Verification status

| Category | Status |
| --- | --- |
| Code verification | Supported by `tests/providerModes.test.ts` and `tests/actions.test.ts` (read, not executed here) |
| Configuration verification | `.env.demo.example` + the script's mode/secret-presence checks |
| Azure configuration verification | Runs on your machine via `search:validate` / `storage:validate` / `db:status` |
| Azure runtime verification | **Not verified** until you run the script and sign in live |
| Governed action execution | Local/demo mode (`local_mock`, `simulated: true`) |
| Azure Function | Not used, not deployed |

Nothing in this document was executed from the preparation environment.

For the longer narrative and the full risk list see `docs/demo-runbook.md`.
