-- NOVA Phase 5: Azure Blob Storage.
--
-- Neon stays the authoritative record of WHERE a document version's bytes live;
-- the bytes themselves move to Azure Blob Storage in production/Azure mode.
-- The database never stores the binary.
--
-- storage_provider    'local' (filesystem) or 'azure_blob'
-- storage_container   Azure container name, or the local storage root label
-- storage_key         deterministic, server-generated object key:
--                     tenant/<tenantId>/document/<documentId>/version/<versionId>/original.<ext>
-- original_filename   the uploader's filename (never part of the object key)
-- mime_type           content type stored with the object
-- size_bytes          byte size of the stored original
--
-- checksum (SHA-256, added in Phase 1) remains NOVA's single content hash; no
-- second hash is introduced. storage_path is preserved for pre-Phase-5 rows.
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'local';
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS storage_container TEXT NOT NULL DEFAULT '';
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS storage_key TEXT;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS original_filename TEXT NOT NULL DEFAULT '';
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT '';
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0;

-- Recovery/reconciliation queries ("which blobs belong to this tenant?") and the
-- orphan sweep both filter on the object key.
CREATE INDEX IF NOT EXISTS idx_versions_storage_key ON document_versions (tenant_id, storage_key);
