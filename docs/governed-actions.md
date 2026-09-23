# Governed enterprise actions (Phase 8)

> **Phase 7 is deferred.** Proactive / streaming agent orchestration was
> explicitly skipped, so nothing in this phase is initiated by an agent. Every
> action is **proposed by an authenticated human request and confirmed by an
> authenticated human request**. When Phase 7 is picked up, the only new work is
> letting an agent *suggest* an action id and a draft payload; the propose →
> confirm → re-authorize → execute → audit pipeline described here is the seam
> it will have to go through, unchanged.

Retrieval (Phases 1–6) answers questions. Phase 8 lets NOVA *do* things: raise
an IT ticket, submit an approval, provision an onboarding checklist. Reading a
policy is reversible; writing into a system of record is not. So actions get
their own governance, and it is enforced server-side in one place rather than
per endpoint.

---

## 1. The three actions

Exactly three actions ship. Each one is a real enterprise write with its own
permission, so the authorization model is genuinely exercised rather than
demonstrated once.

| Action id | Name | Required permission | Function route |
| --- | --- | --- | --- |
| `create_it_request` | Create IT support request | `actions.it.create_request` | `POST /api/actions/create-it-request` |
| `submit_approval_request` | Submit approval request | `actions.approval.submit_request` | `POST /api/actions/submit-approval` |
| `create_onboarding_checklist` | Create onboarding checklist | `actions.hr.create_onboarding_checklist` | `POST /api/actions/create-onboarding-checklist` |

All three have `confirmationRequired: true`.

### Input schemas

`create_it_request`

| Field | Type | Required | Bounds |
| --- | --- | --- | --- |
| `subject` | string | yes | 6–160 chars |
| `description` | text | yes | 20–4000 chars |
| `category` | enum | yes | `hardware` `software` `access` `network` `other` |
| `urgency` | enum | yes | `low` `normal` `high` `critical` |
| `assetTag` | string | no | 2–64 chars |

Output: `ticketNumber`, `queue`, `priority`, `slaHours`. Priority and SLA are
derived from `urgency` server-side (`critical`→P1/2h, `high`→P2/8h,
`normal`→P3/24h, `low`→P4/72h).

`submit_approval_request`

| Field | Type | Required | Bounds |
| --- | --- | --- | --- |
| `title` | string | yes | 6–160 chars |
| `requestType` | enum | yes | `purchase` `expense` `travel` `contract` `headcount` |
| `amount` | integer | yes | 1 – 100,000,000 |
| `currency` | enum | yes | `INR` `USD` `EUR` `GBP` |
| `justification` | text | yes | 20–4000 chars |
| `neededBy` | date | no | ISO date |

Output: `approvalId`, `approvalChain`, `stage`, `thresholdBand`. **The approval
chain is derived from the amount, never proposed by the client**, so a
requester cannot shorten their own chain:

| Amount | Band | Chain |
| --- | --- | --- |
| < 50,000 | `manager` | line_manager |
| ≥ 50,000 | `director` | line_manager → department_director |
| ≥ 500,000 | `executive` | + finance_controller |
| ≥ 5,000,000 | `board` | + board_committee |

`create_onboarding_checklist`

| Field | Type | Required | Bounds |
| --- | --- | --- | --- |
| `employeeName` | string | yes | 2–160 chars |
| `employeeEmail` | email | yes | ≤ 320 chars, lower-cased |
| `startDate` | date | yes | ISO date |
| `department` | string | yes | 2–80 chars |
| `template` | enum | yes | `engineering` `operations` `finance` `sales` `general` |
| `needsLaptop` | boolean | no | |

Output: `checklistId`, `taskCount`, `owners`, `firstTaskDue`.

---

## 2. Why a registry

Every action needs the same guarantees: strict validation, server-side
authorization, tenant isolation, explicit confirmation, re-authorization after
that confirmation, and an audit row. Three hand-written endpoints means writing
those guarantees three times — and the fourth action is the one where somebody
forgets the re-check.

So the guarantees live once, in `GovernedActionService`, and an action
contributes only its **description**:

```ts
// backend/src/actions/governed/registry.ts
{
  id: "create_it_request",
  requiredPermission: "actions.it.create_request",
  confirmationRequired: true,
  input: [ /* declarative field schema */ ],
  output: [ /* declared result shape */ ],
  summarize: (input) => "Open an IT ticket: …",   // the confirmation sentence
  runLocally: (input, ctx) => ({ reference, summary, detail }),
  functionRoute: "create-it-request",
}
```

Adding an action is a registry entry, a permission grant and a Function route.
It is **not** new authorization code.

---

## 3. The state machine

```
propose()                                     confirm()
   |                                              |
   v                                              v
proposed --> awaiting_confirmation --> authorized --> executing --> succeeded
                     |                                    \
                     +--> rejected  (human said no)         +--> failed
```

Every transition is persisted in `action_requests`, **including refusals**, so
the table answers "what was attempted", not merely "what ran".

`authorized` and `executing` are deliberately distinct: a row stuck in
`executing` is the evidence that NOVA handed work downstream and never heard
back, which is materially different from a refusal.

### `propose()`

1. Resolve the action from the registry → `invalid_action`.
2. **Authorize the caller's scope** → `forbidden`. The denial is written to
   `action_requests` and to `activity_logs` before the 403 is returned.
3. **Validate the input strictly** → `invalid_input`.
4. Resolve and access-check the source document/version → `forbidden`.
5. Write the audit row as `awaiting_confirmation`. Nothing has executed.

Authorization runs **before** validation on purpose: an unauthorized caller
must not be able to use validation messages to probe the shape of an action
they may not perform.

### `confirm()`

6. Load the row by `(tenant, id)` from the caller's scope → `tenant_mismatch`.
7. Refuse anything not `awaiting_confirmation`, and refuse a confirmation from
   anyone but the requester → `confirmation_required` / `forbidden`.
8. **Re-authorize** against a scope freshly rebuilt from Neon → `forbidden`.
9. **Re-validate** the frozen input → `invalid_input`.
10. Execute, then record `succeeded` or `failed`.

---

## 4. The two decisions worth arguing about

### Re-authorization after confirmation

The confirmation is a **second request**, seconds or minutes later, and NOVA is
a system where an administrator revokes a grant precisely because they want it
to stop working *now*. If authorization were only checked at propose time, a
proposal held open across a revocation would still execute — a confirmed action
running on a permission its requester no longer has.

So `confirm()` takes the decision again, from the database, using the scope
`requireIdentity()` rebuilt on that request, and the audit row keeps whichever
decision was made last. Test: *"a grant revoked between propose and confirm
stops the action"*.

### The input is not accepted at confirm time

`POST /api/actions/:id/confirm` takes **only** `{ "confirm": true | false }`.
No action id, no tenant, no actor, and above all no input. The payload that
executes is the one frozen at propose time and re-validated from the audit row.

Otherwise "confirm" becomes a second, unreviewed write path: a client could
show a person a ₹5,000 purchase, collect their yes, and submit ₹500,000. Test:
*"the executed payload is the one frozen at propose time"*.

Consent is also never inferred: `undefined`, `null`, `"true"`, `1` and `{}` are
all `confirmation_required`, not a yes.

---

## 5. Authorization model

Action permissions live in their own table, `role_action_permissions`, and are
loaded into the existing `AccessScope` alongside the reading clearances:

```ts
scope.grants            // which classification this role may READ, per department
scope.actionPermissions // which actions this role may PERFORM
```

**Why not reuse the `permissions` table?** That table is a *reading clearance*:
"how classified a document may this role open, in which department?". Being
cleared to read the IT support policy is not permission to raise a ticket
against it. Conflating the two would make every reader a writer.

`decideActionAccess(scope, action, tenantId)` in
`backend/src/authorization/policy.ts` is the single source of truth:

| Outcome | Reason | Meaning |
| --- | --- | --- |
| denied | `tenant_mismatch` | the resource is not in the caller's tenant |
| allowed | `admin_role` | `is_admin` role, no explicit grant needed |
| allowed | `role_action_grant` | an explicit grant exists |
| denied | `action_permission_not_granted` | no grant |

Administrators are allowed without a grant. That is a decision, not an
oversight: an `is_admin` role can already rewrite the grant table, so refusing
here would be theatre. It is audited distinctly (`admin_role`) so a reviewer
can tell a granted action from an administrative one.

**Tenant isolation.** The tenant is *only ever* taken from the verified bearer
token via `requireIdentity()`. No route reads a tenant id from a body, a query
string or a header, and `tenantId` is not a declared field of any action — so a
payload containing one is rejected outright rather than quietly used.

### Granting permissions

Administrator-only:

```
GET  /api/admin/action-permissions          -> { permissions, roles, grants }
POST /api/admin/action-permissions          { roleKey, actionPermission, granted }
```

Only permission keys the registry actually declares may be granted; an unknown
key is a 400 rather than a row that authorises nothing and misleads the next
reviewer. Revocation takes effect immediately, including for a proposal that is
already open.

---

## 6. Local mock vs Azure Function

| | `ACTION_MODE=local` (default) | `ACTION_MODE=azure` |
| --- | --- | --- |
| Executor | `LocalMockExecutor` | `AzureFunctionExecutor` |
| Runs | the registry's own `runLocally` | `POST {AZURE_ACTION_FUNCTION_URL}/api/actions/<route>` |
| `simulated` | `true` | `false` |
| UI badge | **SIMULATED ACTION** | **LIVE — writes to a real system** |
| Summary text | suffixed "(SIMULATED — no external system of record was written.)" | the Function app's own summary |

**There is no fallback between them.** `ACTION_MODE=azure` without
`AZURE_ACTION_FUNCTION_URL` throws a `ConfigError` at startup:

```
ACTION_MODE=azure requires AZURE_ACTION_FUNCTION_URL (the NOVA Actions Function
app base URL, for example https://nova-actions.azurewebsites.net). There is no
fallback to the local mock executor. See docs/governed-actions.md
```

A non-https URL outside `localhost` is also refused — a function key travelling
over plain HTTP is a leaked credential. The mode is chosen by a human; it is
never inferred from the presence of a URL.

### Error mapping from the Function app

| Function response | NOVA code | HTTP | Meaning |
| --- | --- | --- | --- |
| transport failure / timeout | `function_unavailable` | 503 | nothing was submitted; retry is safe |
| 400 / 422 | `action_failed` | 422 | refused on its merits; retrying identically will not help |
| 401 / 403 | `function_error` | 502 | NOVA is not authorised to call the service |
| other 5xx | `function_error` | 502 | the service broke |
| 2xx without `ok`/`reference` | `function_error` | 502 | **outcome unknown** — check downstream before retrying |

The endpoint, the function key and any upstream response body are **logged**
(`action.function.unreachable`, `action.function.failed`,
`action.function.malformed`) and never returned to a caller.

---

## 7. API contract

All routes require a bearer token. Rate limited on the `action` bucket
(`RATE_LIMIT_ACTION`, default 30/min per identity).

```
GET  /api/actions
  -> { actions: ActionCatalogEntry[], executor: "local_mock"|"azure_function", simulated: boolean }

POST /api/actions/propose
     { actionId, input, conversationId?, sourceDocumentId?, sourceVersionId? }
  -> 201 { request: ActionRequest, confirmation: { required, prompt, warning } }

POST /api/actions/:id/confirm
     { confirm: true | false }
  -> 200 { request: ActionRequest, simulated: boolean }

GET  /api/actions/requests?limit=50[&all=true]
  -> { requests: ActionRequest[], scope: "self" | "tenant" }
```

The catalogue lists **every** action with an `authorized` boolean for the
signed-in principal. Hiding unauthorized actions would make the UI lie about
what the product does; listing them weakens nothing, because the permission is
enforced on propose *and* on confirm. The catalogue is a schema, never data.

`all=true` on `/api/actions/requests` is honoured only for administrators; for
anyone else it is ignored rather than refused, so the flag is not an existence
oracle.

### Error codes

| Code | HTTP | Cause |
| --- | --- | --- |
| `invalid_action` | 404 | no such action id in the registry |
| `invalid_input` | 400 | failed the input schema (carries per-field `fields`) |
| `unauthorized` | 401 | no authenticated principal |
| `forbidden` | 403 | authenticated, but the role lacks the permission |
| `confirmation_required` | 409 | a write action was asked to run without explicit consent |
| `tenant_mismatch` | 403 | the request does not belong to the caller's tenant |
| `function_unavailable` | 503 | `ACTION_MODE=azure` and the Function app is unreachable |
| `function_error` | 502 | the Function app answered with a failure |
| `action_failed` | 422 | the executor ran and refused the action |
| `database_error` | 500 | the audit record could not be written or read |

Example validation failure:

```json
{
  "error": "Create IT support request could not be requested: \"tenantId\" is not an input of create_it_request. …",
  "code": "invalid_input",
  "fields": {
    "tenantId": "\"tenantId\" is not an input of create_it_request.",
    "subject": "Subject must be at least 6 characters."
  }
}
```

---

## 8. Input validation

`backend/src/actions/governed/schema.ts`. Three rules:

1. **Unknown fields are rejected, not stripped.** A payload with a field the
   action does not declare is either a client bug or an attempt to reach a
   parameter the schema does not expose (`tenantId`, `status`, an internal
   flag). Silently dropping it would hide both.
2. **Every declared field is bounded** — type, length, range, enum membership.
   `maxLength` is the ceiling on what NOVA will forward downstream.
3. **The result is a new object** built only from declared fields, so nothing
   from the request body reaches an executor by reference.

Control characters are stripped, emails are lower-cased, booleans are coerced
from `"true"`/`"false"`, and every offending field is reported in one round
trip.

---

## 9. Audit trail

Migration `006_governed_actions.sql` adds two tables.

`role_action_permissions` — `(tenant_id, role_key, action_permission)` unique,
plus `granted_at` / `granted_by`.

`action_requests` — the audit row. Notable columns:

| Column | Why it exists |
| --- | --- |
| `status` | the state machine above |
| `requested_by_*` | copied from the authenticated principal, denormalised so the trail survives a later role change or rename |
| `authorization_decision` / `authorization_reason` | which decision was taken, and on what basis |
| `confirmation_required` / `confirmed_at` | whether a human had to agree, and when they did |
| `input_json` | the validated payload, frozen at propose time |
| `result_json` / `error_code` / `error_message` | the outcome |
| `executor` / `simulated` | local mock or Azure Function, and whether the result was real |
| `source_document_id`, `source_version_id`, `source_document_title`, `source_version_label` | **source attribution** |

### Source attribution

This is the auditable link between "the assistant told me this" and "so I did
that". An action taken on the strength of a policy clause names the document
**and the exact version** it came from — six months later, "who approved this,
on the basis of which version of which policy?" has an answer.

Attribution is access-checked with the same `decideDocumentAccess()` used by
retrieval, so it can never become a read oracle: citing a document you are not
cleared to open is `forbidden`, not a silent success.

A **denied** proposal is stored too, but its payload is not: the input was never
validated, so it is unbounded attacker-controlled text. Only the attempt, the
identity and the reason are kept.

Every transition is also mirrored into `activity_logs` (`resourceType: "action"`)
so governed actions appear in the admin audit feed next to sign-ins and
knowledge changes. `detail` is a short summary — never the input payload, which
can contain personal data (new-hire names, emails, justifications).

---

## 10. The Azure Function app

`azure-functions/nova-actions/` — a separate TypeScript npm package with its
own `package.json`, `tsconfig.json`, `host.json` and tests. See its
[README](../azure-functions/nova-actions/README.md) for the deploy commands.

- `src/handlers.ts` — **pure**, no `@azure/functions` import. All validation and
  behaviour lives here, so the whole app is unit-testable with `node --test`,
  no emulator and no network.
- `src/index.ts` — three `app.http()` registrations, `authLevel: "function"`,
  that do nothing but adapt an `HttpRequest` into a `handle()` call.
- `test/handlers.test.ts` — 15 unit tests.

It re-validates every payload against the same field schema, because it is an
independently addressable HTTPS endpoint: anything holding the function key can
call it. It is a **second** enforcement point, not the first. What it does not
do is re-derive identity — it has no directory of its own, so it trusts NOVA
for `tenantId` and `actor`. That trust is exactly why it must never be exposed
without a function key, API Management or Entra app authentication in front of
it. An optional `NOVA_ACTIONS_ALLOWED_TENANTS` allow-list is provided for
shared hosting.

`tests/azureFunctionHandlers.test.ts` in the NOVA root imports the same handler
module and asserts that the Function app's routes and field schemas match the
NOVA registry **field for field** — a schema-drift guard, so the second
enforcement point can never silently become weaker than the first.

---

## 11. Frontend

`frontend/src/components/console/ActionPanel.tsx`, rendered beside the chat
composer. Deliberately minimal and deliberately two-step:

1. Pick an action (unauthorized ones are disabled, with the permission named),
   fill its declared fields, press **Review**. Nothing happens downstream.
2. Read the exact sentence describing what will be done, plus the
   SIMULATED/LIVE warning, then **Confirm and submit** or **Discard**.

The receipt shows the downstream reference, the declared output fields, the
audit row id, and whether the result was simulated.

The component holds **no** authorization logic. `authorized` only greys out a
control so a person is not invited to fail. And because the confirm request
carries only `{confirm: true}`, the panel *cannot* change the payload between
the review and the execution — it does not send one.

---

## 12. Demo walkthrough (over VPN)

Assumes the NOVA server is reachable on the corporate VPN at
`https://nova.internal:4317` (locally: `http://localhost:4317`).

```bash
npm install
npm run seed-demo
npm run dev
```

1. **Sign in as the administrator** (Admin persona in demo mode, or a
   linked Entra identity).
2. **Grant the capability.** As the admin, grant `actions.it.create_request` to
   the `EMPLOYEE` role:
   ```bash
   curl -X POST https://nova.internal:4317/api/admin/action-permissions \
     -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"roleKey":"EMPLOYEE","actionPermission":"actions.it.create_request","granted":true}'
   ```
   (Or leave it ungranted first, to show the refusal in step 4.)
3. **Switch to Alex (Employee)** and open the assistant. Ask
   *"What is our IT support process for a failed laptop?"* — a normal grounded,
   cited answer.
4. **Open "Enterprise actions".** Before the grant, all three cards are
   disabled and name the permission they need. After the grant,
   *Create IT support request* is available; *Submit approval request* and
   *Create onboarding checklist* remain disabled — the permissions are separate.
5. **Fill the form and press Review.** Leave `subject` too short to show the
   per-field validation. Add a stray field with the browser console
   (`isAdmin: true`) to show it is rejected rather than ignored.
6. **Read the confirmation.** The prompt is the literal sentence
   *Open an IT ticket: "Laptop will not boot" (hardware, high urgency)*, with the
   **SIMULATED ACTION** badge in local mode. Nothing has executed yet — check
   **Admin → Activity**: only `Action Proposed` is there.
7. **Show the re-authorization.** In a second browser as the admin, revoke
   `actions.it.create_request` from `EMPLOYEE`. Then press **Confirm and submit**
   as Alex: the action fails with *"Your permission for this action was
   withdrawn before you confirmed it, so nothing was submitted."* and the audit
   row is `failed` / `denied`. Re-grant it.
8. **Confirm.** The receipt shows `ITR-2026-XXXXXXXX`, the derived priority and
   SLA, the audit id, and `simulated`.
9. **Show the audit trail.** **Admin → Activity** now has `Action Proposed`,
   `Action Confirmed` and `Action Executed`. `GET /api/actions/requests` shows
   the full row including `input_json`, the authorization reason and any source
   document/version attribution.
10. **Show tenant isolation.** Sign in as an Acme Logistics user and
    `POST /api/actions/<that same id>/confirm` — `tenant_mismatch`, even though
    the id is real and the request is pending.
11. **Show the approval thresholds.** Grant
    `actions.approval.submit_request`, then submit ₹10,000 (one approver) and
    ₹9,000,000 (four approvers, board band). The chain is derived from the
    amount, not chosen by the requester.
12. **Show the Azure seam honestly.** Set `ACTION_MODE=azure` with no
    `AZURE_ACTION_FUNCTION_URL` and restart: the process refuses to start with
    the message in §6. That is the demonstration — NOVA will not pretend.

---

## 12a. Demo configuration: Azure knowledge stack + local action executor

The presentation configuration keeps the **entire** knowledge stack on Azure and
leaves **only** the governed action executor local:

| Layer | Mode variable | Demo value | Provider actually loaded |
| --- | --- | --- | --- |
| Authentication | `AUTH_MODE` | `entra` | `EntraAuthProvider` |
| Database | `DATABASE_URL` | Neon PostgreSQL URL | `postgres` |
| Chat + embeddings | `AI_MODE` | `azure` | `AzureFoundryLLMProvider`, `AzureEmbeddingProvider` |
| Retrieval | `VECTOR_STORE` | `azure_search` | `AzureVectorStore` |
| Knowledge pipeline | `KNOWLEDGE_MODE` | `azure` | `AzureKnowledgeProvider` |
| Document files | `STORAGE_MODE` | `azure_blob` | `AzureBlobStorageProvider` |
| **Governed actions** | `ACTION_MODE` | **`local`** | **`LocalMockExecutor`** |

Copy `.env.demo.example` to `.env` and fill in the placeholders.

**No source change is required for this.** Every provider is selected from its
own variable in its own factory (`llm/index.ts`, `embeddings/index.ts`,
`knowledge/index.ts`, `storage/index.ts`, `auth/index.ts`,
`actions/governed/executors.ts`), and `ACTION_MODE` is read in exactly one
place for Phase 8:

```ts
// backend/src/actions/governed/executors.ts
if (config.modes.actionMode !== "azure") return new LocalMockExecutor()
```

`tests/providerModes.test.ts` pins this down: it builds all seven providers
under the demo environment and asserts the six Azure ones load while only the
executor is local, that flipping `ACTION_MODE` changes *nothing* else, and that
`DATABASE_URL` still refuses SQLite.

### What does NOT change because actions are local

- `appMode` stays `azure` and `isFullyLocal` stays `false`, so the UI never
  shows **LOCAL DEMO MODE**.
- `/api/health` still reports **AZURE CONFIGURED** with
  `incompleteComponents: []`. An intentionally local component is reported as
  `state: "local"`, not as `incomplete` or `misconfigured`.
- `/api/health` and `/api/admin/metrics` remain zero-token: no Foundry, Search,
  embedding, Blob or Function call.
- Nothing requires `AZURE_ACTION_FUNCTION_URL` or `AZURE_ACTION_FUNCTION_KEY`.
  A stale value left in the environment is **ignored** — presence of a
  credential never switches a provider on.

### What is still fully enforced

Local action mode changes the final write and nothing else. The complete
pipeline still runs: Entra authentication → Neon tenant/role/department/
permission resolution → action authorization → strict input validation →
source-document access check → explicit confirmation → **re-authorization from
Neon** → tenant isolation → `LocalMockExecutor` → `action_requests` audit row in
Neon + `activity_logs` entry.

### Terminology

Say *"governed action executed in local/demo mode"*. The API says
`"executor": "local_mock"`, `"simulated": true`; the result summary is suffixed
*"(SIMULATED — no external system of record was written.)"*; the UI badge reads
**SIMULATED ACTION**. The Azure Function app is the future production execution
target and is **not** deployed or required for this demo.

### One pre-demo caveat about embeddings

`npm run search:index` reuses whatever vectors are already stored in
`document_chunks` and makes zero embedding calls. Per
`docs/azure-readiness-status.md` the live `nova-knowledge` index was populated
that way, which means it holds vectors from the **local** hashed-lexical model.
With `AI_MODE=azure` the query vector comes from Foundry `nova-embedding`, and
the two are not in the same vector space — hybrid retrieval would degrade to
its keyword half. Run once, with the demo `.env` in place:

```bash
npm run search:reindex -- --force
```

This regenerates every chunk vector through Foundry, persists it back to
`document_chunks`, and re-uploads it. It **does** consume embedding tokens, so
run it before the demo, not during it. Confirm with `npm run search:validate`
that the index vector dimension equals `EMBEDDING_DIM`.

---

## 13. Limitations

- The local mock is a mock. It writes to `action_requests` and nothing else;
  there is no ServiceNow, no Dynamics, no SAP. Every local result says so.
- The Azure Function app's three actions are also self-contained: they compute
  a reference, a queue, an approval chain or a task list and return them. They
  do not yet call a real system of record. That integration is the Function
  app's job and is a per-customer piece of work; the HTTPS contract in §10 is
  the seam for it.
- There is no retry, idempotency key or compensating transaction. A
  `function_error` on a 2xx-without-reference response leaves the outcome
  genuinely unknown, which is why NOVA says so rather than guessing.
- Approval chains are computed but not routed: nobody is emailed, and there is
  no approver inbox or state machine past `submitted`.
- Only the requester can confirm. There is no delegation and no
  four-eyes/second-approver flow.
- Rate limiting is an in-process counter, so behind more than one instance it
  must move to a shared store (see `docs/security.md`).
- `tests/postgres.test.ts` requires the `pg` package and a live `TEST_DATABASE_URL`
  to run the suite against Neon; the Phase 8 tables are covered by
  migration 006 and by the SQLite mirror in `backend/src/db/index.ts`.
