# Knowledge ingestion

```
Upload -> Validate -> Extract text -> Detect metadata -> Chunk -> Embed -> Index -> Store metadata -> Searchable
```

Implemented in `backend/src/documents/` (`extract.ts`, `chunk.ts`, `injection.ts`, `service.ts`) and
`backend/src/retrieval/vector/`.

## Supported formats

| Format | Extraction |
| --- | --- |
| Markdown (`.md`) | Read as text, headings preserved as section labels |
| Plain text (`.txt`) | Read as text |
| PDF (`.pdf`) | Text objects extracted from content streams (no external binary) |
| DOCX (`.docx`) | `word/document.xml` unzipped and converted to text |

Validation rejects unsupported types, empty files and files above `MAX_UPLOAD_BYTES` (15 MB) with a
user-safe message. Extraction failures never surface a stack trace.

## Metadata detection

`detectMetadata(text, filename)` reads leading document headers and falls back sensibly:

| Field | Source |
| --- | --- |
| title | `Title:` header, leading title line, first heading, else filename |
| version | `Version:` (e.g. `2026.2`), else auto-incremented `YYYY.n` |
| effective_date | `Effective date: YYYY-MM-DD` |
| department | `Department:` or the value chosen in the upload form |
| category | `Category:` or upload form |
| classification | `Classification:` one of public / internal / confidential / restricted |

Upload-form values always win over document headers, so an administrator can correct a document that
mislabels itself.

Stored per document: `tenant_id, document_id, filename, title, department, category, classification,
version, effective_date, uploaded_at, uploaded_by, allowed_roles, allowed_users, source_type, status`.

## Chunking

`chunkText` splits on heading boundaries then packs paragraphs to ~1100 characters with ~150 characters
of overlap (`CHUNK_TARGET_CHARS`, `CHUNK_OVERLAP_CHARS`). Each chunk keeps its section heading so
citations can say *Machine Failure SOP — Severity classification — v2026.2*.

## Embedding and indexing

Chunks are embedded through `EmbeddingProvider` and written to the `VectorStore` together with their
tenant, department, classification, version and keyword string. Locally this is SQLite; the Azure
implementation targets Azure AI Search. Only active versions of active documents are searchable.

## Injection scanning

Every chunk is scanned at ingestion time (`injection.ts`). Detected payloads are flagged on the chunk,
reported to the uploader as a warning, and neutralised when the chunk is later placed into model context.
Documents are data; their instructions are never executed.

## Versioning lifecycle

```
Upload v2026.1 -> active
Upload v2026.2 -> activate -> v2026.1 automatically superseded (history preserved)
Deactivate     -> chunks excluded from retrieval, rows retained
Delete         -> vector records and chunks removed, audit entry kept
```

Admin actions: `POST /api/knowledge/upload`, `PATCH /api/knowledge/:id`,
`POST /api/knowledge/:id/versions/:versionId/activate|deactivate`, `DELETE /api/knowledge/:id`.
Re-uploading an identical file is a no-op (checksum short-circuit), which is what makes `seed-demo`
safe to rerun.

## Audit

Each ingestion writes a `Knowledge Ingested` activity row with metadata only — title, version,
department, classification and chunk count. Document text is never written to logs.
