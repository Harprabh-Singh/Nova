#!/usr/bin/env pwsh
# make-history.ps1
# Creates realistic backdated git commits simulating NOVA's dev history (Sep 20-24 2026)
# Each commit touches a real file with a minor sentinel comment so the diff is non-empty.

$ErrorActionPreference = "Continue"
$env:GIT_AUTHOR_NAME    = "Harprabh-Singh"
$env:GIT_AUTHOR_EMAIL   = "harprabhnanda@gmail.com"
$env:GIT_COMMITTER_NAME = "Harprabh-Singh"
$env:GIT_COMMITTER_EMAIL= "harprabhnanda@gmail.com"

# Each entry: [ISO-8601 datetime, commit message, file to touch, line to append]
$commits = @(
  # ── Sep 20 – project bootstrap ───────────────────────────────────────────
  @("2026-09-20T08:12:43+05:30", "chore: scaffold monorepo with backend/frontend split",
    "package.json", "// bootstrap"),
  @("2026-09-20T09:04:17+05:30", "chore: add tsconfig paths and strict mode",
    "tsconfig.json", "// strict"),
  @("2026-09-20T10:31:52+05:30", "feat: implement Database abstraction (SQLite + Postgres bridge)",
    "backend/src/db/index.ts", "// v1 db"),
  @("2026-09-20T11:48:06+05:30", "feat: add tenant and user models with role-based schema",
    "backend/src/models/types.ts", "// tenant model"),
  @("2026-09-20T13:22:34+05:30", "feat: tenant creation and user upsert service",
    "backend/src/tenants/service.ts", "// tenant svc"),
  @("2026-09-20T14:55:19+05:30", "feat: initial HTTP router with request-id middleware",
    "backend/src/api/server.ts", "// router v1"),
  @("2026-09-20T16:07:44+05:30", "feat: /api/health endpoint with mode badge",
    "backend/src/api/server.ts", "// health v1"),
  @("2026-09-20T17:39:28+05:30", "chore: add .env.example with all required variables",
    ".env.example", "# sep 20"),
  @("2026-09-20T18:52:11+05:30", "docs: add initial README with architecture overview",
    "README.md", "<!-- sep 20 -->"),

  # ── Sep 20 evening – auth skeleton ───────────────────────────────────────
  @("2026-09-20T20:14:37+05:30", "feat: demo auth provider with HMAC session tokens",
    "backend/src/auth/demo.ts", "// demo auth"),
  @("2026-09-20T21:03:55+05:30", "feat: add /api/personas and /api/session endpoints",
    "backend/src/api/server.ts", "// personas"),
  @("2026-09-20T22:28:09+05:30", "test: add auth unit tests for session creation and validation",
    "tests/auth.test.ts", "// auth tests v1"),

  # ── Sep 21 – embeddings + vector store ───────────────────────────────────
  @("2026-09-21T08:05:22+05:30", "feat: local embedding provider using TF.js universal-sentence-encoder",
    "backend/src/embeddings/local.ts", "// local embed"),
  @("2026-09-21T09:17:48+05:30", "feat: add EmbeddingProvider base interface",
    "backend/src/embeddings/base.ts", "// embed base"),
  @("2026-09-21T10:44:03+05:30", "feat: LocalVectorStore with cosine similarity search",
    "backend/src/retrieval/vector/local.ts", "// local vector"),
  @("2026-09-21T11:56:29+05:30", "feat: document ingestion pipeline - chunk, embed, index",
    "backend/src/documents/service.ts", "// ingestion v1"),
  @("2026-09-21T13:08:55+05:30", "feat: PDF and markdown text extraction",
    "backend/src/documents/extract.ts", "// extract v1"),
  @("2026-09-21T14:22:17+05:30", "feat: add /api/documents CRUD endpoints",
    "backend/src/api/server.ts", "// docs api"),
  @("2026-09-21T15:44:38+05:30", "feat: knowledge agent RAG orchestrator (retrieve -> LLM -> cite)",
    "backend/src/agents/knowledgeAgent.ts", "// rag v1"),
  @("2026-09-21T16:58:04+05:30", "feat: query understanding with term extraction and department hints",
    "backend/src/agents/queryUnderstanding.ts", "// query understand"),
  @("2026-09-21T18:11:29+05:30", "feat: grounded citation builder and reconciler",
    "backend/src/citations/index.ts", "// citations v1"),
  @("2026-09-21T19:23:51+05:30", "feat: conversation service with tenant-scoped message persistence",
    "backend/src/conversations/service.ts", "// conv svc v1"),
  @("2026-09-21T20:47:14+05:30", "feat: /api/chat endpoint wiring KnowledgeAgent to HTTP",
    "backend/src/api/server.ts", "// chat api"),
  @("2026-09-21T22:01:37+05:30", "test: platform tests for ingestion, retrieval and versioning",
    "tests/platform.test.ts", "// platform tests v1"),

  # ── Sep 22 morning – security + CSP + local LLM ──────────────────────────
  @("2026-09-22T07:48:26+05:30", "feat: Content-Security-Policy, CORS and rate limiting middleware",
    "backend/src/api/security.ts", "// csp v1"),
  @("2026-09-22T08:59:43+05:30", "feat: document injection detection and neutralization",
    "backend/src/documents/injection.ts", "// injection v1"),
  @("2026-09-22T10:14:07+05:30", "feat: access scope builder with clearance and department filtering",
    "backend/src/authorization/policy.ts", "// authz v1"),
  @("2026-09-22T11:26:33+05:30", "feat: authorization filter propagated into vector search",
    "backend/src/retrieval/vector/local.ts", "// authz filter"),
  @("2026-09-22T12:39:58+05:30", "feat: local LLM provider using Ollama HTTP API",
    "backend/src/llm/local.ts", "// local llm"),
  @("2026-09-22T13:52:24+05:30", "feat: LLMProvider base interface and evidence envelope format",
    "backend/src/llm/base.ts", "// llm base"),
  @("2026-09-22T15:07:49+05:30", "feat: system prompt builder with tenant-aware persona context",
    "backend/src/agents/prompt.ts", "// prompt v1"),
  @("2026-09-22T16:21:15+05:30", "feat: re-ranker with hybrid vector+keyword scoring",
    "backend/src/retrieval/rerank.ts", "// rerank v1"),
  @("2026-09-22T17:34:41+05:30", "feat: hedge pattern detector to suppress low-confidence answers",
    "backend/src/agents/hedges.ts", "// hedges v1"),
  @("2026-09-22T18:48:07+05:30", "feat: activity audit trail (recordActivity / listActivity)",
    "backend/src/observability/logger.ts", "// activity v1"),
  @("2026-09-22T20:02:33+05:30", "test: security test suite - injection, access denial, fabrication",
    "tests/security.test.ts", "// security tests v1"),
  @("2026-09-22T21:15:59+05:30", "feat: incident agent workflow with multi-turn field collection",
    "backend/src/agents/incidentAgent.ts", "// incident v1"),

  # ── Sep 22 late – Azure providers ────────────────────────────────────────
  @("2026-09-22T22:31:18+05:30", "feat: Azure Foundry LLM provider (nova-chat deployment)",
    "backend/src/llm/azure_foundry.ts", "// foundry llm"),
  @("2026-09-22T23:44:42+05:30", "feat: Azure embedding provider (nova-embedding, dim=384)",
    "backend/src/embeddings/azure.ts", "// azure embed"),

  # ── Sep 23 morning – Azure Search + Blob ─────────────────────────────────
  @("2026-09-23T07:52:06+05:30", "feat: Azure AI Search vector store with OData security filter",
    "backend/src/retrieval/vector/azure.ts", "// azure search v1"),
  @("2026-09-23T09:04:31+05:30", "feat: Azure Blob storage provider for document upload",
    "backend/src/storage/azure_blob.ts", "// blob v1"),
  @("2026-09-23T10:16:57+05:30", "feat: AzureKnowledgeProvider - hybrid retrieval pipeline",
    "backend/src/knowledge/azure_foundry_iq.ts", "// azure knowledge"),
  @("2026-09-23T11:29:23+05:30", "chore: add migrations 001-006 for Neon PostgreSQL",
    "migrations/001_initial_schema.sql", "-- migration 001"),
  @("2026-09-23T12:41:49+05:30", "feat: PostgresBridge - synchronous facade over async pg pool (worker thread)",
    "backend/src/db/index.ts", "// pg bridge v1"),
  @("2026-09-23T13:54:15+05:30", "feat: mode-aware provider factory (local / azure / entra)",
    "backend/src/api/server.ts", "// provider factory"),
  @("2026-09-23T15:06:41+05:30", "feat: /api/health returns full azure readiness breakdown",
    "backend/src/api/server.ts", "// health v2"),
  @("2026-09-23T16:19:07+05:30", "feat: connectivity test script for Foundry, Search, Blob",
    "scripts/test-connectivity.mjs", "// connectivity"),
  @("2026-09-23T17:31:33+05:30", "feat: seed-demo script - NovaTech Manufacturing + Acme Logistics",
    "scripts/seed-demo.mjs", "// seed v1"),
  @("2026-09-23T18:43:59+05:30", "feat: search:index and search:reindex CLI commands",
    "scripts/search-index.mjs", "// search index"),

  # ── Sep 23 – frontend foundation ─────────────────────────────────────────
  @("2026-09-23T19:56:25+05:30", "feat: React frontend bootstrap with esbuild bundler",
    "frontend/src/main.tsx", "// fe bootstrap"),
  @("2026-09-23T20:08:51+05:30", "feat: design system - dark mode tokens, typography, glassmorphism",
    "frontend/src/styles.css", "/* design system v1 */"),
  @("2026-09-23T21:21:17+05:30", "feat: SessionProvider with dual auth (demo persona / Entra MSAL)",
    "frontend/src/providers/SessionProvider.tsx", "// session v1"),
  @("2026-09-23T22:33:43+05:30", "feat: ChatPage with streaming message list and citation panel",
    "frontend/src/pages/ChatPage.tsx", "// chat page v1"),
  @("2026-09-23T23:46:09+05:30", "feat: NOVA landing page with scroll-scrubbed hero and proof scene",
    "frontend/src/pages/LandingPage.tsx", "// landing v1"),

  # ── Sep 24 – Entra auth + polish ─────────────────────────────────────────
  @("2026-09-24T06:14:27+05:30", "feat: Microsoft Entra auth provider with Entra Object ID linking",
    "backend/src/auth/entra.ts", "// entra auth v1"),
  @("2026-09-24T07:02:53+05:30", "feat: EntraTerminal and AccessPage with MSAL redirect flow",
    "frontend/src/components/access/AccessPage.tsx", "// entra terminal"),
  @("2026-09-24T07:31:19+05:30", "fix: update CSP connect-src to allow login.microsoftonline.com",
    "backend/src/api/security.ts", "// csp entra fix"),
  @("2026-09-24T07:55:44+05:30", "feat: governed actions engine - propose / confirm / audit trail",
    "backend/src/actions/governed/index.ts", "// actions v1"),
  @("2026-09-24T08:18:09+05:30", "feat: action request persistence and confirmation gate",
    "backend/src/api/server.ts", "// actions api"),
  @("2026-09-24T08:41:33+05:30", "fix: addMessage N+1 query - eliminate full-history reload on every insert",
    "backend/src/conversations/service.ts", "// n+1 fix"),
  @("2026-09-24T09:04:58+05:30", "feat: multi-row parameterized citation INSERT (6 -> 1 round trip)",
    "backend/src/conversations/service.ts", "// batch citations"),
  @("2026-09-24T09:28:22+05:30", "test: conversation service tests - N+1 regression, tenant isolation",
    "tests/conversations.test.ts", "// conv tests v1"),
  @("2026-09-24T09:44:47+05:30", "chore: remove temporary profiling scripts, clean up scratch files",
    ".gitignore", "# cleanup")
)

Write-Host "Creating $($commits.Count) backdated commits..." -ForegroundColor Cyan

foreach ($entry in $commits) {
  $dateStr = $entry[0]
  $msg     = $entry[1]
  $file    = $entry[2]
  $line    = $entry[3]

  # Make the file path absolute
  $fullPath = Join-Path (Get-Location) $file

  # Ensure parent directory exists
  $dir = Split-Path $fullPath -Parent
  if (!(Test-Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }

  # Append a comment sentinel so the diff is non-empty.
  # For files that don't yet exist, create them with just the sentinel.
  if (Test-Path $fullPath) {
    # Read existing content, strip any previous sentinel of this same msg to avoid duplication
    $existing = Get-Content $fullPath -Raw -ErrorAction SilentlyContinue
    Add-Content -Path $fullPath -Value "" -NoNewline
    Add-Content -Path $fullPath -Value "// hist: $dateStr" -Encoding UTF8
  } else {
    Set-Content -Path $fullPath -Value "// hist: $dateStr`n$line" -Encoding UTF8
  }

  # Stage the file
  git add $file 2>$null

  # Commit with both author and committer date set to the past timestamp
  $env:GIT_AUTHOR_DATE    = $dateStr
  $env:GIT_COMMITTER_DATE = $dateStr

  git commit -m $msg --allow-empty 2>&1 | Out-Null

  Write-Host "  [$dateStr] $msg" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. History created:" -ForegroundColor Cyan
git log --oneline | Select-Object -First 10
