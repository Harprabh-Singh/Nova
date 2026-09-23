# NOVA Actions - Azure Functions app

Executes NOVA's three governed enterprise actions when the backend runs with
`ACTION_MODE=azure`. In `ACTION_MODE=local` (the default) this app is not
called at all and NOVA uses its local mock executor, which labels every result
**SIMULATED ACTION**.

## Routes

| Method | Route | NOVA action id |
| --- | --- | --- |
| POST | `/api/actions/create-it-request` | `create_it_request` |
| POST | `/api/actions/submit-approval` | `submit_approval_request` |
| POST | `/api/actions/create-onboarding-checklist` | `create_onboarding_checklist` |

All three use `authLevel: "function"`, so a caller must present
`x-functions-key`. NOVA holds that key in `AZURE_ACTION_FUNCTION_KEY` and never
exposes it to a browser.

## Request envelope

```json
{
  "actionId": "create_it_request",
  "actionRequestId": "areq_<uuid>",
  "tenantId": "ten_<id>",
  "requestId": "req_<id>",
  "actor": { "userId": "usr_1", "name": "...", "email": "...", "roleKey": "...", "department": "..." },
  "source": { "documentId": "...", "versionId": "...", "documentTitle": "...", "versionLabel": "v3" },
  "input": { "subject": "...", "description": "...", "category": "hardware", "urgency": "high" }
}
```

`tenantId` and `actor` are supplied by the NOVA backend from the authenticated
principal. This app has no directory of its own, so it **trusts NOVA for
identity** and enforces everything else itself: the action id must match the
route, the tenant must pass the optional allow-list, and `input` is
re-validated against the same field schema NOVA applied. That makes it a second
enforcement point, not the first - which is exactly why it must never be
exposed without a function key, API Management, or Entra app authentication.

## Responses

Success (HTTP 200):

```json
{ "ok": true, "reference": "ITR-2026-0A1B2C3D", "summary": "...", "detail": { }, "executedAt": "..." }
```

Failure:

```json
{ "ok": false, "error": { "code": "invalid_input", "message": "...", "fields": { "subject": "..." } } }
```

Codes: `invalid_action`, `invalid_input`, `tenant_mismatch`, `action_failed`.
HTTP 400/422 means the action was refused on its merits (NOVA maps this to
`action_failed`); 5xx means the service itself failed (NOVA maps this to
`function_error`). No error body ever contains a stack trace, a file path or an
upstream credential.

## Settings

| Setting | Required | Purpose |
| --- | --- | --- |
| `FUNCTIONS_WORKER_RUNTIME` | yes | `node` |
| `FUNCTIONS_EXTENSION_VERSION` | yes | `~4` |
| `AzureWebJobsStorage` | yes | Functions host requirement |
| `NOVA_ACTIONS_ALLOWED_TENANTS` | no | Comma-separated NOVA tenant ids. Empty = serve any tenant the authenticated caller claims. Set it for shared hosting. |

## Local development

```bash
cd azure-functions/nova-actions
npm install
cp local.settings.json.example local.settings.json
npm test          # unit tests, no host or network needed
npm start         # tsc + func start  (requires Azure Functions Core Tools v4)
```

Then point the backend at it:

```bash
ACTION_MODE=azure AZURE_ACTION_FUNCTION_URL=http://localhost:7071 npm run dev
```

## Deploy

```bash
az group create -n nova-rg -l centralindia
az storage account create -n novaactionsstore -g nova-rg -l centralindia --sku Standard_LRS
az functionapp create -n nova-actions -g nova-rg \
  --storage-account novaactionsstore --consumption-plan-location centralindia \
  --runtime node --runtime-version 20 --functions-version 4

cd azure-functions/nova-actions
npm ci && npm run build
func azure functionapp publish nova-actions

# Read the key once and store it in the NOVA backend's environment/Key Vault.
az functionapp function keys list -g nova-rg -n nova-actions --function-name create-it-request
```

Set on the NOVA backend:

```
ACTION_MODE=azure
AZURE_ACTION_FUNCTION_URL=https://nova-actions.azurewebsites.net
AZURE_ACTION_FUNCTION_KEY=<key from the command above>
```

## Testing

`npm test` runs `test/handlers.test.ts` against the pure handler module. The
same file's module is also imported by `tests/azureFunctionHandlers.test.ts` in
the NOVA repository root, so `npm test` at the root covers this app as well.
